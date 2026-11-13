// Requests MPC signatures for USDC transfers through the Stipend contract
import { createHash } from "node:crypto";
import { actions, baseEncode, getTransactionLastResult, type Account } from "near-api-js";
import type { Hex } from "viem";

const CALL_GAS = 100_000_000_000_000n;
const STATUS_ATTEMPTS = 10;

// Token domain the contract signs transfers for: USDC on Base Sepolia
export const BASE_SEPOLIA_USDC = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
} as const;

// Transfer fields as the contract reads them: addresses and nonce in 0x hex, numbers as strings
export type TransferFields = {
  from: string;
  to: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
};

export type SignedTransfer = { signature: Hex; transactionHash: string };

type TransactionOutcome = Awaited<ReturnType<Account["provider"]["viewTransactionStatus"]>>;
type MpcSignature = { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

// Sends one sign_transfer call and returns the EVM signature from the MPC reply
export async function signTransfer(
  account: Account,
  contractId: string,
  path: string,
  transfer: TransferFields,
): Promise<SignedTransfer> {
  const signedTx = await account.createSignedTransaction({
    receiverId: contractId,
    actions: [actions.functionCall("sign_transfer", { path, transfer }, CALL_GAS, 0n)],
  });
  const transactionHash = baseEncode(createHash("sha256").update(signedTx.transaction.encode()).digest());
  await account.provider.sendTransactionUntil(signedTx, "INCLUDED");
  const outcome = await waitForOutcome(account, transactionHash);
  if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) {
    throw new Error(`Transaction ${transactionHash} failed: ${JSON.stringify(outcome.status.Failure)}`);
  }
  const signature = toEvmSignature(getTransactionLastResult(outcome) as MpcSignature);
  return { signature, transactionHash };
}

// r is the x coordinate of big_r: bytes 1..33 of its compressed form
function toEvmSignature(mpcSignature: MpcSignature): Hex {
  const r = mpcSignature.big_r.affine_point.slice(2);
  const s = mpcSignature.s.scalar;
  if (r.length !== 64 || s.length !== 64) {
    throw new Error(`Unexpected MPC signature: ${JSON.stringify(mpcSignature)}`);
  }
  return `0x${r}${s}${(27 + mpcSignature.recovery_id).toString(16)}`;
}

// The MPC reply arrives a few blocks later, so status reads can time out and are retried
async function waitForOutcome(account: Account, txHash: string): Promise<TransactionOutcome> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt++) {
    try {
      return await account.provider.viewTransactionStatus({
        txHash,
        accountId: account.accountId,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No outcome for ${txHash}: ${(lastError as Error).message}`);
}
