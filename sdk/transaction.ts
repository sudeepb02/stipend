// Sends Stipend calls whose result arrives after the MPC network signs
import { createHash } from "node:crypto";
import { actions, baseEncode, getTransactionLastResult, type Account } from "near-api-js";

const STATUS_ATTEMPTS = 10;

export type ContractCall = {
  contractId: string;
  methodName: string;
  args: object;
  gas: bigint;
  deposit: bigint;
};

type TransactionOutcome = Awaited<ReturnType<Account["provider"]["viewTransactionStatus"]>>;

export type CallResult = { result: unknown; transactionHash: string };

// Sends one call and returns the value its last receipt returned, with the transaction hash
export async function sendCall(account: Account, call: ContractCall): Promise<CallResult> {
  const signedTx = await account.createSignedTransaction({
    receiverId: call.contractId,
    actions: [actions.functionCall(call.methodName, call.args, call.gas, call.deposit)],
  });
  const transactionHash = baseEncode(createHash("sha256").update(signedTx.transaction.encode()).digest());
  await account.provider.sendTransactionUntil(signedTx, "INCLUDED");
  const outcome = await waitForOutcome(account, transactionHash);
  if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) {
    throw new Error(`Transaction ${transactionHash} failed: ${JSON.stringify(outcome.status.Failure)}`);
  }
  return { result: getTransactionLastResult(outcome), transactionHash };
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
