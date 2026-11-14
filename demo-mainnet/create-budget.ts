// Creates a task budget for a job, paid in USDC on Base, and prints its pot address
import { parseArgs } from "node:util";
import {
  Account,
  JsonRpcProvider,
  getTransactionLastResult,
  type KeyPairString,
} from "near-api-js";
import { isAddress, parseUnits } from "viem";
import { NEAR_EXPLORER_URL, NEAR_RPC_URL, USDC_ASSET_ID, readPotAddress } from "./network.ts";

const EXPLORER_TX_URL = `${NEAR_EXPLORER_URL}/txns`;
// More than a budget needs for storage; the contract refunds the rest
const STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;
const CALL_GAS = 30_000_000_000_000n;
const USAGE =
  "Usage: npm run mainnet:create-budget -- <job_id> <total> <per_agent_cap> <per_payment_max> " +
  "[--hours <hours>] [--payee <address>]...";

// Usage: npm run mainnet:create-budget -- <job_id> <total> <per_agent_cap> <per_payment_max>
//   [--hours <hours>] [--payee <address>]...
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hours: { type: "string", default: "24" },
      // Address the budget may pay, given once per payee
      payee: { type: "string", multiple: true },
    },
  });
  const [jobId, total, perAgentCap, perPaymentMax] = positionals;
  const hours = Number(values.hours);
  if (!jobId || !total || !perAgentCap || !perPaymentMax || !(hours > 0)) {
    throw new Error(USAGE);
  }
  const { STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY, PAID_API_PAY_TO } = process.env;
  if (!STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env.mainnet");
  }
  // Only the named payees may be paid from the budget, or the paid API when none is named
  const payees = values.payee ?? (PAID_API_PAY_TO ? [PAID_API_PAY_TO] : []);
  if (payees.length === 0 || !payees.every((payee) => isAddress(payee))) {
    throw new Error("Name each payee with --payee <address>, or set PAID_API_PAY_TO in .env.mainnet");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  // The contract account acts as the funder
  const funder = new Account(STIPEND_CONTRACT_ID, provider, STIPEND_CONTRACT_KEY as KeyPairString);

  const asset = await provider.callFunction<{ decimals: number }>({
    contractId: STIPEND_CONTRACT_ID,
    method: "get_asset",
    args: { asset_id: USDC_ASSET_ID },
  });
  if (!asset) {
    throw new Error(`Asset ${USDC_ASSET_ID} is not registered`);
  }
  const toUnits = (amount: string) => parseUnits(amount, asset.decimals).toString();
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);

  const outcome = await funder.callFunctionRaw({
    contractId: STIPEND_CONTRACT_ID,
    methodName: "create_task_budget",
    args: {
      job_id: jobId,
      asset_id: USDC_ASSET_ID,
      limits: {
        total: toUnits(total),
        per_agent_cap: toUnits(perAgentCap),
        per_payment_max: toUnits(perPaymentMax),
      },
      payees,
      expires_at: String(expiresAt),
    },
    deposit: STORAGE_DEPOSIT,
    gas: CALL_GAS,
    waitUntil: "FINAL",
  });
  const budgetId = getTransactionLastResult(outcome) as string;
  const path = `budget/${budgetId}`;
  const potAddress = await readPotAddress(provider, STIPEND_CONTRACT_ID, budgetId);
  console.log(`Budget ${budgetId} for job ${jobId}, pot ${potAddress} (${path})`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${outcome.transaction.hash}`);
  const budget = await provider.callFunction({
    contractId: STIPEND_CONTRACT_ID,
    method: "get_budget",
    args: { budget_id: budgetId },
  });
  console.log(JSON.stringify(budget, null, 2));
}

await main();
