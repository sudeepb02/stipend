// Prints the evidence for every budget of a Stipend contract without any key: budgets, seat shares
// and payments read from NEAR, and from the token on Base whether each signed payment and refund was
// used. It also checks that the contract's totals add up.
import { parseArgs } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { createPublicClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { deriveEvmAddress } from "../sdk/address.ts";
import { readAsset, type Asset, type Budget } from "../sdk/budget.ts";
import { refundNonce } from "../sdk/refund.ts";

const NEAR_EXPLORER_URL = "https://testnet.nearblocks.io/address";
const BASE_EXPLORER_URL = "https://sepolia.basescan.org/address";
const PAGE_SIZE = 100;
const USAGE = "Usage: npm run verify -- [--contract <account id>]";
const TOKEN_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

type Config = { mpc_signer_id: string; max_window_sec: number };
type Payment = { seat_id: string; value: string; nonce: string; resource: string; status: string };
type Share = { reserved: string; spent: string };
type Check = { name: string; isMet: boolean };

function isoTime(unixSec: string): string {
  return new Date(Number(unixSec) * 1000).toISOString();
}

function budgetState(budget: Budget): string {
  if (budget.closed_at !== null) {
    return `closed ${isoTime(budget.closed_at)}`;
  }
  const isOpen = Date.now() / 1000 < Number(budget.expires_at);
  return `${isOpen ? "open until" : "expired"} ${isoTime(budget.expires_at)}`;
}

// Usage: npm run verify -- [--contract <account id>]
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { contract: { type: "string" } } });
  const contractId = values.contract ?? process.env.STIPEND_CONTRACT_ID;
  const { NEAR_RPC_URL, BASE_RPC_URL } = process.env;
  if (!contractId || !NEAR_RPC_URL || !BASE_RPC_URL) {
    throw new Error(`${USAGE}. NEAR_RPC_URL and BASE_RPC_URL come from .env.example or .env.`);
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const baseClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC_URL) });
  const view = <T>(method: string, args: Record<string, unknown>) =>
    provider.callFunction({ contractId, method, args }) as Promise<T>;
  const config = await view<Config>("get_config", {});
  console.log(`Contract ${contractId}: ${NEAR_EXPLORER_URL}/${contractId}`);
  console.log(`MPC signer ${config.mpc_signer_id}, payment window ${config.max_window_sec} s`);

  const assets = new Map<string, Asset>();
  const failedChecks: string[] = [];
  // Budget ids count up from 0, so the first missing id ends the list
  for (let budgetNumber = 0; ; budgetNumber++) {
    const budgetId = String(budgetNumber);
    const budget = await view<Budget | null>("get_budget", { budget_id: budgetId });
    if (!budget) {
      break;
    }
    if (!assets.has(budget.asset_id)) {
      assets.set(budget.asset_id, await readAsset(provider, contractId, budget.asset_id));
    }
    const asset = assets.get(budget.asset_id) as Asset;
    const amount = (value: string | bigint) => `${formatUnits(BigInt(value), asset.decimals)} ${asset.name}`;
    const pot = await deriveEvmAddress(provider, config.mpc_signer_id, contractId, `budget/${budgetId}`);
    const isUsed = (nonce: Hex) =>
      baseClient.readContract({
        address: asset.token,
        abi: TOKEN_ABI,
        functionName: "authorizationState",
        args: [pot, nonce],
      });

    const payments: Payment[] = [];
    for (let fromIndex = 0; fromIndex < budget.payment_count; fromIndex += PAGE_SIZE) {
      const pageArgs = { budget_id: budgetId, from_index: fromIndex, limit: PAGE_SIZE };
      payments.push(...(await view<Payment[]>("get_payments", pageArgs)));
    }
    const seatIds = [...new Set(payments.map((payment) => payment.seat_id))];
    const shares = await Promise.all(
      seatIds.map((seatId) => view<Share | null>("get_share", { budget_id: budgetId, seat_id: seatId })),
    );
    const potBalance = await baseClient.readContract({
      address: asset.token,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [pot as Address],
    });
    const isRefunded = await isUsed(refundNonce(budgetId));

    console.log(`\nBudget ${budgetId}: job ${budget.job_id}, ${budgetState(budget)}`);
    console.log(`  funder ${budget.funder}, payees ${budget.payees?.join(", ") ?? "any"}`);
    console.log(
      `  limits: ${amount(budget.limits.total)} total, ${amount(budget.limits.per_agent_cap)} per agent, ` +
        `${amount(budget.limits.per_payment_max)} per payment`,
    );
    console.log(`  pot ${pot} holds ${amount(potBalance)}: ${BASE_EXPLORER_URL}/${pot}`);
    console.log(`  refund settled: ${isRefunded ? "yes" : "no"}`);
    seatIds.forEach((seatId, index) => {
      const share = shares[index];
      console.log(`  seat ${seatId}: spent ${amount(share?.spent ?? "0")} of ${amount(share?.reserved ?? "0")}`);
    });

    // A used nonce means the token moved the payment: only the pot can sign, and only through the contract
    let isSettledOnlyWhenSigned = true;
    for (const [index, payment] of payments.entries()) {
      const isSettled = await isUsed(payment.nonce as Hex);
      isSettledOnlyWhenSigned &&= !isSettled || payment.status === "Signed";
      const result = `${payment.status}, ${isSettled ? "settled" : "not settled"}`;
      console.log(`  #${index} seat ${payment.seat_id} ${amount(payment.value)} ${result}, ${payment.resource}`);
    }

    // A failed signature is credited back, so it is not part of the spent totals
    const countedSpent = payments
      .filter((payment) => payment.status !== "Failed")
      .reduce((total, payment) => total + BigInt(payment.value), 0n);
    const sharesSpent = shares.reduce((total, share) => total + BigInt(share?.spent ?? "0"), 0n);
    const sharesReserved = shares.reduce((total, share) => total + BigInt(share?.reserved ?? "0"), 0n);
    const checks: Check[] = [
      { name: "spent total equals the payments in the log", isMet: BigInt(budget.spent_total) === countedSpent },
      { name: "spent total equals the seats' spent shares", isMet: BigInt(budget.spent_total) === sharesSpent },
      { name: "reserved total equals the seats' shares", isMet: BigInt(budget.reserved_total) === sharesReserved },
      { name: "only signed payments settled on Base", isMet: isSettledOnlyWhenSigned },
    ];
    for (const check of checks) {
      console.log(`  ${check.isMet ? "OK" : "FAILED"}: ${check.name}`);
      if (!check.isMet) {
        failedChecks.push(`budget ${budgetId}: ${check.name}`);
      }
    }
  }

  console.log(failedChecks.length === 0 ? "\nAll checks passed" : `\nFailed checks:\n  ${failedChecks.join("\n  ")}`);
  if (failedChecks.length > 0) {
    process.exitCode = 1;
  }
}

await main();
