// Asks the Stipend contract for the signed refund of what is left in a budget's pot
import type { Account } from "near-api-js";
import { encodePacked, keccak256, type Hex } from "viem";
import type { TransferFields } from "./pay.ts";
import { sendCall } from "./transaction.ts";

// Covers refund, the MPC sign call (30 Tgas) and the callback that returns the signed transfer
const REFUND_GAS = 100_000_000_000_000n;
const ONE_YOCTO = 1n;

export type SignedRefund = { transfer: TransferFields; signature: Hex; transactionHash: string };

// Nonce of a budget's refund, as the contract builds it. USDC accepts it once, so at most one refund of
// a budget settles.
export function refundNonce(budgetId: string): Hex {
  return keccak256(encodePacked(["string", "uint64"], ["stipend:refund", BigInt(budgetId)]));
}

// Sends one refund call as the budget's funder and returns the transfer the contract signed
export async function requestRefund(
  account: Account,
  contractId: string,
  budgetId: string,
  refund: { from: string; to: string; amount: bigint },
): Promise<SignedRefund> {
  const { result, transactionHash } = await sendCall(account, {
    contractId,
    methodName: "refund",
    args: { budget_id: budgetId, from: refund.from, to: refund.to, amount: refund.amount.toString() },
    gas: REFUND_GAS,
    deposit: ONE_YOCTO,
  });
  // The contract returns null when it has no usable signature
  const signed = result as { transfer: TransferFields; signature: Hex } | null;
  if (!signed) {
    throw new Error(`Transaction ${transactionHash} returned no signed refund`);
  }
  return { ...signed, transactionHash };
}
