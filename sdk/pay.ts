// Pays from a Stipend budget: the contract checks the payment rules and returns the MPC signature
import { createHash } from "node:crypto";
import { actions, baseEncode, getTransactionLastResult, type Account } from "near-api-js";
import type { Hex } from "viem";

// Covers pay, the MPC sign call (30 Tgas) and the callback that returns the signature
const PAY_GAS = 100_000_000_000_000n;
// 0.01 NEAR for the storage a payment uses, the contract refunds the rest
const STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;
const STATUS_ATTEMPTS = 10;

// Transfer fields as the contract reads them: addresses and nonce in 0x hex, numbers as strings
export type TransferFields = {
  from: string;
  to: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
};

export type SignedPayment = { signature: Hex; transactionHash: string };

type TransactionOutcome = Awaited<ReturnType<Account["provider"]["viewTransactionStatus"]>>;

// Sends one pay call from a session account and returns the EVM signature of the transfer
export async function payFromBudget(
  account: Account,
  contractId: string,
  budgetId: string,
  transfer: TransferFields,
  resource: string,
): Promise<SignedPayment> {
  const signedTx = await account.createSignedTransaction({
    receiverId: contractId,
    actions: [
      actions.functionCall("pay", { budget_id: budgetId, transfer, resource }, PAY_GAS, STORAGE_DEPOSIT),
    ],
  });
  const transactionHash = baseEncode(createHash("sha256").update(signedTx.transaction.encode()).digest());
  await account.provider.sendTransactionUntil(signedTx, "INCLUDED");
  const outcome = await waitForOutcome(account, transactionHash);
  if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) {
    throw new Error(`Transaction ${transactionHash} failed: ${JSON.stringify(outcome.status.Failure)}`);
  }
  // The contract returns null when it has no usable signature
  const signature = getTransactionLastResult(outcome) as Hex | null;
  if (!signature) {
    throw new Error(`Transaction ${transactionHash} returned no signature`);
  }
  return { signature, transactionHash };
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
