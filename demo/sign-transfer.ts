// Asks the contract for an MPC signature on a test USDC transfer and checks it recovers to the pot
import { createHash, randomBytes } from "node:crypto";
import {
  Account,
  JsonRpcProvider,
  actions,
  baseEncode,
  getTransactionLastResult,
  type KeyPairString,
} from "near-api-js";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { deriveEvmAddress } from "../sdk/address.ts";

const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const CALL_GAS = 100_000_000_000_000n;
const PAYMENT_VALUE = 10_000n;
const AUTHORIZATION_TIMEOUT_SECONDS = 300;
const STATUS_ATTEMPTS = 10;
const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type TransactionOutcome = Awaited<ReturnType<JsonRpcProvider["viewTransactionStatus"]>>;
type MpcSignature = { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

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
async function waitForOutcome(
  provider: JsonRpcProvider,
  txHash: string,
  accountId: string,
): Promise<TransactionOutcome> {
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt++) {
    try {
      return await provider.viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" });
    } catch (error) {
      console.log(`Waiting for the MPC reply (attempt ${attempt}): ${(error as Error).message}`);
    }
  }
  throw new Error(`No outcome for ${txHash}`);
}

// Usage: npm run sign-transfer -- [path]
async function main(): Promise<void> {
  const path = process.argv[2] ?? "budget/0";
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY } = process.env;
  const { USDC_ADDRESS, PAID_API_PAY_TO } = process.env;
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env");
  }
  if (!USDC_ADDRESS || !PAID_API_PAY_TO) {
    throw new Error("Set USDC_ADDRESS and PAID_API_PAY_TO in .env");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const contractAccount = new Account(STIPEND_CONTRACT_ID, provider, STIPEND_CONTRACT_KEY as KeyPairString);
  const potAddress = await deriveEvmAddress(provider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path);

  const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TIMEOUT_SECONDS);
  const nonce: Hex = `0x${randomBytes(32).toString("hex")}`;
  const transfer = {
    from: potAddress,
    to: PAID_API_PAY_TO,
    value: PAYMENT_VALUE.toString(),
    valid_after: "0",
    valid_before: validBefore.toString(),
    nonce,
  };

  const signedTx = await contractAccount.createSignedTransaction({
    receiverId: STIPEND_CONTRACT_ID,
    actions: [actions.functionCall("sign_transfer", { path, transfer }, CALL_GAS, 0n)],
  });
  const txHash = baseEncode(createHash("sha256").update(signedTx.transaction.encode()).digest());
  console.log(`Transaction: ${EXPLORER_TX_URL}/${txHash}`);
  await provider.sendTransactionUntil(signedTx, "INCLUDED");
  const outcome = await waitForOutcome(provider, txHash, STIPEND_CONTRACT_ID);
  if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) {
    throw new Error(`Transaction failed: ${JSON.stringify(outcome.status.Failure)}`);
  }

  const mpcSignature = getTransactionLastResult(outcome) as MpcSignature;
  console.log(`MPC reply: ${JSON.stringify(mpcSignature)}`);
  const signature = toEvmSignature(mpcSignature);
  const recoveredAddress = await recoverTypedDataAddress({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_ADDRESS as Address },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: potAddress,
      to: PAID_API_PAY_TO as Address,
      value: PAYMENT_VALUE,
      validAfter: 0n,
      validBefore,
      nonce,
    },
    signature,
  });
  console.log(`Signature: ${signature}`);
  console.log(`Recovered ${recoveredAddress}, pot ${potAddress}: ${recoveredAddress === potAddress ? "match" : "MISMATCH"}`);
}

await main();
