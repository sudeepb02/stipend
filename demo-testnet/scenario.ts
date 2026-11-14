// Runs the reference example on the testnets with one command. A funder opens a 0.5 USDC budget, the
// control plane assigns two agents, each agent buys DefiLlama data through x402, payments that break
// the rules are refused without a signature, and the balances on NEAR and Base are checked against
// each other.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { readAsset, readBudget } from "../sdk/budget.ts";
import { payFromBudget } from "../sdk/pay.ts";
import { REPO_DIR, runScript } from "./run-script.ts";

const BUDGET_TOTAL = "0.5";
const PER_AGENT_CAP = "0.25";
const PER_PAYMENT_MAX = "0.01";
// Above the budget's per-payment max
const OVERPRICED_AMOUNT = "0.05";
const BUDGET_HOURS = "2";
const SESSION_HOURS = "1";
// Each agent's research topic: a coin and a DeFi protocol on DefiLlama
const AGENTS = [
  { seatId: "1", coin: "coingecko:near", protocol: "ref-finance" },
  { seatId: "2", coin: "coingecko:ethereum", protocol: "aave-v3" },
];
const ENV_NAMES = [
  "NEAR_RPC_URL",
  "STIPEND_CONTRACT_ID",
  "STIPEND_CONTRACT_KEY",
  "ORACLE_ID",
  "ORACLE_KEY",
  "BASE_RPC_URL",
  "USDC_ADDRESS",
  "PAID_API_PAY_TO",
  "PAID_API_PORT",
] as const;
const USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

type Env = Record<(typeof ENV_NAMES)[number], string>;
type Payment = { value: string; nonce: string };

function readEnv(): Env {
  const missing = ENV_NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(", ")} in .env`);
  }
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]])) as Env;
}

function printStep(title: string): void {
  console.log(`\n== ${title}`);
}

function printIndented(text: string): void {
  for (const line of text.trimEnd().split("\n")) {
    console.log(`   ${line}`);
  }
}

// Runs a script that must succeed, prints its output and returns it
async function runStep(script: string, args: string[]): Promise<string> {
  const result = await runScript(script, args);
  const output = `${result.stdout}${result.stderr}`;
  printIndented(output);
  if (!result.ok) {
    throw new Error(`${script} failed`);
  }
  return output;
}

async function isAnswering(apiUrl: string): Promise<boolean> {
  try {
    await fetch(`${apiUrl}/prices/coingecko:near`);
    return true;
  } catch {
    return false;
  }
}

// Starts the paid API unless one already answers, and returns the process it started
async function startPaidApi(apiUrl: string): Promise<ChildProcess | undefined> {
  if (await isAnswering(apiUrl)) {
    return undefined;
  }
  const server = spawn("node", ["--env-file=.env", "demo-testnet/paid-api/server.ts"], { cwd: REPO_DIR, stdio: "ignore" });
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    if (await isAnswering(apiUrl)) {
      return server;
    }
  }
  server.kill();
  throw new Error("The paid API did not start");
}

// Session account of a key file the control plane wrote
function sessionAccount(provider: JsonRpcProvider, keyFile: string): Account {
  const { STIPEND_SESSION_KEY } = parseEnv(readFileSync(keyFile, "utf8")) as Record<string, string | undefined>;
  if (!STIPEND_SESSION_KEY) {
    throw new Error(`No session key in ${keyFile}`);
  }
  const sessionKey = KeyPair.fromString(STIPEND_SESSION_KEY as KeyPairString);
  const sessionAccountId = Buffer.from(sessionKey.getPublicKey().data).toString("hex");
  return new Account(sessionAccountId, provider, STIPEND_SESSION_KEY as KeyPairString);
}

// Sends pay straight to the contract, as an agent that skips the CLI could, and returns the result
async function payDirectly(
  account: Account,
  contractId: string,
  budgetId: string,
  transfer: { from: string; to: string; value: bigint },
): Promise<string> {
  try {
    await payFromBudget(
      account,
      contractId,
      budgetId,
      {
        from: transfer.from,
        to: transfer.to,
        value: transfer.value.toString(),
        valid_after: "0",
        valid_before: String(Math.floor(Date.now() / 1000) + 300),
        nonce: `0x${randomBytes(32).toString("hex")}`,
      },
      "direct pay call from the scenario",
    );
    return "signed";
  } catch (error) {
    return (error as Error).message;
  }
}

// Usage: npm run scenario
async function main(): Promise<void> {
  const env = readEnv();
  const contractId = env.STIPEND_CONTRACT_ID;
  const provider = new JsonRpcProvider({ url: env.NEAR_RPC_URL });
  const funder = new Account(contractId, provider, env.STIPEND_CONTRACT_KEY as KeyPairString);
  const oracle = new Account(env.ORACLE_ID, provider, env.ORACLE_KEY as KeyPairString);
  const base = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_RPC_URL) });
  const usdc = env.USDC_ADDRESS as Address;
  const payTo = env.PAID_API_PAY_TO as Address;
  const usdcBalance = (holder: Address) =>
    base.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [holder] });

  const jobId = `scenario-${Math.floor(Date.now() / 1000)}`;
  const sessionDir = join("sessions", jobId);
  const keyFile = (seatId: string) => join(sessionDir, `.env.session.${seatId}`);
  const apiUrl = `http://localhost:${env.PAID_API_PORT}`;
  const server = await startPaidApi(apiUrl);
  try {
    printStep(`1. The funder opens a ${BUDGET_TOTAL} USDC budget for job ${jobId}`);
    const created = await runStep("demo-testnet/create-budget.ts", [
      jobId,
      BUDGET_TOTAL,
      PER_AGENT_CAP,
      PER_PAYMENT_MAX,
      "--hours",
      BUDGET_HOURS,
    ]);
    const createdMatch = created.match(/^Budget (\d+) for job \S+, pot (0x[0-9a-fA-F]{40})/m);
    if (!createdMatch) {
      throw new Error("No budget id in the create-budget output");
    }
    const [, budgetId, potText] = createdMatch;
    const pot = potText as Address;
    const asset = await readAsset(provider, contractId, (await readBudget(provider, contractId, budgetId)).asset_id);
    const toUnits = (amount: string) => parseUnits(amount, asset.decimals);
    const formatAmount = (value: bigint) => `${formatUnits(value, asset.decimals)} ${asset.name}`;
    const [potBefore, payeeBefore] = await Promise.all([usdcBalance(pot), usdcBalance(payTo)]);

    printStep(`2. The funder moves ${BUDGET_TOTAL} test USDC into the budget's pot`);
    await runStep("demo-testnet/fund-pot.ts", [`budget/${budgetId}`, BUDGET_TOTAL]);

    printStep("3. The control plane assigns two agents to the job");
    const seatIds = AGENTS.map((agent) => agent.seatId);
    await runStep("demo-testnet/control-plane.ts", [jobId, ...seatIds, "--hours", SESSION_HOURS, "--dir", sessionDir]);

    printStep("4. Each agent researches its topic and pays through the CLI");
    for (const agent of AGENTS) {
      const reportFile = join("reports", `${jobId}-seat-${agent.seatId}.md`);
      const walletArgs = ["--session", keyFile(agent.seatId), "--budget", budgetId];
      const topicArgs = ["--coin", agent.coin, "--protocol", agent.protocol, "--out", reportFile];
      await runStep("demo-testnet/agent.ts", [...walletArgs, ...topicArgs]);
    }

    printStep("5. Payments that break the rules");
    const fetchAsSeat = async (seatId: string, path: string) => {
      const args = ["fetch", `${apiUrl}${path}`, "--budget", budgetId, "--session", keyFile(seatId)];
      return (await runScript("cli/stipend.ts", args)).stderr;
    };
    // A refusal must carry the expected message and leave the payment log as it was: nothing signed
    const checkRefusal = async (name: string, expected: string, attempt: () => Promise<string>) => {
      const countBefore = (await readBudget(provider, contractId, budgetId)).payment_count;
      const output = await attempt();
      const countAfter = (await readBudget(provider, contractId, budgetId)).payment_count;
      const isRefused = output.includes(expected) && countAfter === countBefore;
      console.log(`   ${isRefused ? "Refused" : "NOT REFUSED"}: ${name}`);
      console.log(`      ${isRefused ? expected : output.trim().slice(0, 300)}`);
      return isRefused;
    };
    const seatOne = sessionAccount(provider, keyFile("1"));
    const refusals = [
      await checkRefusal(
        "an API that asks more than the per-payment max, through the CLI",
        "rejected by spendControls.maxAmountPerPayment",
        () => fetchAsSeat("1", "/overpriced/prices/coingecko:near"),
      ),
      await checkRefusal(
        "the same overpriced payment sent straight to the contract, skipping the CLI",
        "Value is above the per-payment max",
        () => payDirectly(seatOne, contractId, budgetId, { from: pot, to: payTo, value: toUnits(OVERPRICED_AMOUNT) }),
      ),
      await checkRefusal(
        "an API whose payee is not on the budget's list",
        "Payee is not on the budget's list",
        () => fetchAsSeat("1", "/unlisted-payee/prices/coingecko:near"),
      ),
      await checkRefusal(
        "an account with no session on the job: the oracle",
        "Caller has no session",
        () => payDirectly(oracle, contractId, budgetId, { from: pot, to: payTo, value: toUnits(PER_PAYMENT_MAX) }),
      ),
    ];
    await funder.callFunctionRaw({
      contractId,
      methodName: "close_budget",
      args: { budget_id: budgetId },
      deposit: 1n,
      gas: 30_000_000_000_000n,
      waitUntil: "FINAL",
    });
    console.log("   The funder closed the budget");
    refusals.push(
      await checkRefusal("a purchase after the funder closed the budget", "Budget is closed or expired", () =>
        fetchAsSeat("2", "/prices/coingecko:near"),
      ),
    );

    printStep("6. Balances on NEAR and Base");
    const budget = await readBudget(provider, contractId, budgetId);
    const payments = await provider.callFunction<Payment[]>({
      contractId,
      method: "get_payments",
      args: { budget_id: budgetId, from_index: 0, limit: 100 },
    });
    let signedTotal = 0n;
    let settledTotal = 0n;
    for (const payment of payments ?? []) {
      signedTotal += BigInt(payment.value);
      const isSettled = await base.readContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: "authorizationState",
        args: [pot, payment.nonce as Hex],
      });
      settledTotal += isSettled ? BigInt(payment.value) : 0n;
    }
    const [potAfter, payeeAfter] = await Promise.all([usdcBalance(pot), usdcBalance(payTo)]);
    const funded = toUnits(BUDGET_TOTAL);
    const spentTotal = BigInt(budget.spent_total);
    const signedCount = payments?.length ?? 0;
    const potShare = `${formatAmount(funded)} funded minus ${formatAmount(settledTotal)} settled on Base`;
    const checks = [
      {
        name: `The contract counts ${formatAmount(spentTotal)} spent: the ${signedCount} signed payments in its log`,
        isMet: spentTotal === signedTotal,
      },
      {
        name: `The pot holds ${formatAmount(potAfter)}: ${potShare}`,
        isMet: potAfter === potBefore + funded - settledTotal,
      },
      {
        name: `The paid API received ${formatAmount(payeeAfter - payeeBefore)}: what settled from the pot`,
        isMet: payeeAfter - payeeBefore === settledTotal,
      },
    ];
    for (const check of checks) {
      console.log(`   ${check.isMet ? "OK" : "FAILED"}: ${check.name}`);
    }

    const config = await provider.callFunction<{ max_window_sec: number }>({
      contractId,
      method: "get_config",
      args: {},
    });
    const refundStart = Number(budget.closed_at) + (config?.max_window_sec ?? 0);
    const refusedCount = refusals.filter(Boolean).length;
    const passedCount = checks.filter((check) => check.isMet).length;
    printStep("Result");
    console.log(`   Refusals as expected: ${refusedCount} of ${refusals.length}`);
    console.log(`   Balance checks passed: ${passedCount} of ${checks.length}`);
    console.log(`   Reports: reports/${jobId}-seat-*.md`);
    const refundTime = new Date(refundStart * 1000).toISOString();
    console.log(`   The funder can ask for a refund of budget ${budgetId} from ${refundTime}`);
    if (refusedCount < refusals.length || passedCount < checks.length) {
      process.exitCode = 1;
    }
  } finally {
    server?.kill();
  }
}

await main();
