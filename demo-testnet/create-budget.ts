// Creates a task budget for a job, paid in USDC on Base Sepolia, and prints its pot address
import { parseArgs } from "node:util";
import {
  Account,
  JsonRpcProvider,
  getTransactionLastResult,
  type KeyPairString,
} from "near-api-js";
import { parseUnits } from "viem";
import { deriveEvmAddress } from "../sdk/address.ts";

const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const USDC_ASSET_ID = "usdc-base-sepolia";
// More than a budget needs for storage; the contract refunds the rest
const STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;
const CALL_GAS = 30_000_000_000_000n;
const USAGE =
  "Usage: npm run create-budget -- <job_id> <total> <per_agent_cap> <per_payment_max> [--hours <hours>]";

// Usage: npm run create-budget -- <job_id> <total> <per_agent_cap> <per_payment_max> [--hours <hours>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { hours: { type: "string", default: "24" } },
  });
  const [jobId, total, perAgentCap, perPaymentMax] = positionals;
  const hours = Number(values.hours);
  if (!jobId || !total || !perAgentCap || !perPaymentMax || !(hours > 0)) {
    throw new Error(USAGE);
  }
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY } = process.env;
  const { PAID_API_PAY_TO } = process.env;
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env");
  }
  if (!PAID_API_PAY_TO) {
    throw new Error("Set PAID_API_PAY_TO in .env");
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
      // Only the paid API may be paid from the budget
      payees: [PAID_API_PAY_TO],
      expires_at: String(expiresAt),
    },
    deposit: STORAGE_DEPOSIT,
    gas: CALL_GAS,
    waitUntil: "FINAL",
  });
  const budgetId = getTransactionLastResult(outcome) as string;
  const path = `budget/${budgetId}`;
  const potAddress = await deriveEvmAddress(provider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path);
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
