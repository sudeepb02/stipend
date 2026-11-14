// Agent wallet CLI: shows the agent's budgets and fetches x402-paid URLs, paying from a Stipend
// budget as the agent's session account
import { parseArgs } from "node:util";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { formatUnits } from "viem";
import { deriveEvmAddress } from "../sdk/address.ts";
import { readAsset, readBudget, readBudgetDomain, type Budget } from "../sdk/budget.ts";
import { createX402Signer } from "../sdk/x402-signer.ts";

const MAX_PAYMENT = "$0.01";
const NEAR_EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const BASE_EXPLORER_TX_URL = "https://sepolia.basescan.org/tx";
const USAGE = "Usage: npm run stipend -- status | fetch <url> [--budget <id>]";

type Session = { job_id: string; seat_id: string; expires_at: string };
type Share = { reserved: string; spent: string };

// Contract and MPC signer ids, and the session account that signs payments
type Wallet = { provider: JsonRpcProvider; contractId: string; signerId: string; account: Account };

function loadWallet(): Wallet {
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, STIPEND_SESSION_KEY } = process.env;
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID and STIPEND_CONTRACT_ID in .env");
  }
  if (!STIPEND_SESSION_KEY) {
    throw new Error("Set STIPEND_SESSION_KEY, or run npm run control-plane to create .env.session");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  // A session account is an implicit account: its id is the hex of its ed25519 public key
  const sessionKey = KeyPair.fromString(STIPEND_SESSION_KEY as KeyPairString);
  const sessionAccountId = Buffer.from(sessionKey.getPublicKey().data).toString("hex");
  const account = new Account(sessionAccountId, provider, STIPEND_SESSION_KEY as KeyPairString);
  return { provider, contractId: STIPEND_CONTRACT_ID, signerId: NEAR_SIGNER_ID, account };
}

function isoTime(unixSec: string | bigint): string {
  return new Date(Number(unixSec) * 1000).toISOString();
}

function isBudgetOpen(budget: Budget, nowSec: number): boolean {
  return budget.closed_at === null && nowSec < Number(budget.expires_at);
}

function budgetState(budget: Budget, nowSec: number): string {
  if (budget.closed_at !== null) {
    return `closed ${isoTime(budget.closed_at)}`;
  }
  const verb = isBudgetOpen(budget, nowSec) ? "open until" : "expired";
  return `${verb} ${isoTime(budget.expires_at)}`;
}

// Unspent part of the seat's share, or a new share at the per-agent cap if the budget has room
function amountLeft(budget: Budget, share: Share | undefined): bigint {
  if (share) {
    return BigInt(share.reserved) - BigInt(share.spent);
  }
  const cap = BigInt(budget.limits.per_agent_cap);
  return BigInt(budget.reserved_total) + cap <= BigInt(budget.limits.total) ? cap : 0n;
}

// Prints the session and, for each budget of its job, the limits, what the seat spent and what it
// can spend now
async function statusCommand(wallet: Wallet): Promise<void> {
  const { provider, contractId, account } = wallet;
  const session = await provider.callFunction<Session>({
    contractId,
    method: "get_session",
    args: { session_account: account.accountId },
  });
  if (!session) {
    throw new Error(`No session for ${account.accountId}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const isSessionLive = nowSec < Number(session.expires_at);
  const sessionState = isSessionLive ? "live until" : "expired";
  console.log(`Session ${account.accountId}`);
  console.log(`Seat ${session.seat_id} on job ${session.job_id}, ${sessionState} ${isoTime(session.expires_at)}`);

  const budgetIds =
    (await provider.callFunction<string[]>({
      contractId,
      method: "get_budgets_for_job",
      args: { job_id: session.job_id },
    })) ?? [];
  if (budgetIds.length === 0) {
    console.log("No budgets for this job");
  }
  for (const budgetId of budgetIds) {
    const budget = await readBudget(provider, contractId, budgetId);
    const asset = await readAsset(provider, contractId, budget.asset_id);
    const share = await provider.callFunction<Share>({
      contractId,
      method: "get_share",
      args: { budget_id: budgetId, seat_id: session.seat_id },
    });
    const amount = (value: string | bigint) => `${formatUnits(BigInt(value), asset.decimals)} ${asset.name}`;
    const spent = share ? share.spent : "0";
    console.log(`Budget ${budgetId}: ${budgetState(budget, nowSec)}`);
    console.log(
      `  limits: ${amount(budget.limits.total)} total, ${amount(budget.limits.per_agent_cap)} per agent, ` +
        `${amount(budget.limits.per_payment_max)} per payment`,
    );
    // Payments need a live session and an open budget
    const canSpend = isSessionLive && isBudgetOpen(budget, nowSec) ? amountLeft(budget, share) : 0n;
    console.log(`  seat ${session.seat_id}: spent ${amount(spent)}, can spend ${amount(canSpend)}`);
  }
}

// Pays if the URL answers 402, then prints the content to stdout and the receipt to stderr
async function fetchCommand(wallet: Wallet, url: string, budgetId: string): Promise<void> {
  const { provider, contractId, signerId, account } = wallet;
  const path = `budget/${budgetId}`;
  const [address, domain] = await Promise.all([
    deriveEvmAddress(provider, signerId, contractId, path),
    readBudgetDomain(provider, contractId, budgetId),
  ]);

  const signer = createX402Signer({
    account,
    contractId,
    budgetId,
    address,
    domain,
    resource: url,
    onSigned: (transactionHash) => console.error(`Signed on NEAR: ${NEAR_EXPLORER_TX_URL}/${transactionHash}`),
  });
  // Pays only on the chain of the budget's token
  const client = new x402Client()
    .register(`eip155:${domain.chainId}`, new ExactEvmScheme(signer))
    .setSpendControls({ maxAmountPerPayment: MAX_PAYMENT });
  const response = await wrapFetchWithPayment(fetch, client)(url);

  console.log(await response.text());
  console.error(`HTTP ${response.status}`);
  const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentHeader) {
    const settlement = decodePaymentResponseHeader(paymentHeader);
    console.error(`Paid from ${path} (${settlement.payer}): ${BASE_EXPLORER_TX_URL}/${settlement.transaction}`);
  }
  if (!response.ok) {
    process.exitCode = 1;
  }
}

// Usage: npm run stipend -- status | fetch <url> [--budget <id>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { budget: { type: "string", default: "0" } },
  });
  const [command, url] = positionals;
  if (command === "status" && positionals.length === 1) {
    await statusCommand(loadWallet());
  } else if (command === "fetch" && url && /^\d+$/.test(values.budget)) {
    await fetchCommand(loadWallet(), url, values.budget);
  } else {
    throw new Error(USAGE);
  }
}

await main();
