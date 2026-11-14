// Pays from a Stipend budget: the contract checks the payment rules and returns the MPC signature
import type { Account } from "near-api-js";
import type { Hex } from "viem";
import { sendCall } from "./transaction.ts";

// Covers pay, the MPC sign call (30 Tgas) and the callback that returns the signature
const PAY_GAS = 100_000_000_000_000n;
// 0.01 NEAR for the storage a payment uses, the contract refunds the rest
const STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;

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

// Sends one pay call from a session account and returns the EVM signature of the transfer
export async function payFromBudget(
  account: Account,
  contractId: string,
  budgetId: string,
  transfer: TransferFields,
  resource: string,
): Promise<SignedPayment> {
  const { result, transactionHash } = await sendCall(account, {
    contractId,
    methodName: "pay",
    args: { budget_id: budgetId, transfer, resource },
    gas: PAY_GAS,
    deposit: STORAGE_DEPOSIT,
  });
  // The contract returns null when it has no usable signature
  const signature = result as Hex | null;
  if (!signature) {
    throw new Error(`Transaction ${transactionHash} returned no signature`);
  }
  return { signature, transactionHash };
}
