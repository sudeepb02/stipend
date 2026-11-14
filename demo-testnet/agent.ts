// Scripted research agent that follows skill/SKILL.md with the stipend CLI: it checks what its seat
// can spend, buys token and protocol data from the paid API, and writes a markdown report that ends
// with its spend list
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { formatUnits, parseUnits } from "viem";
import { runScript, type ScriptResult } from "./run-script.ts";

const USAGE =
  "Usage: npm run agent -- --session <file> --budget <id> --coin <coin> --protocol <slug> --out <file> [--api <url>]";
// Enough digits to subtract any amount the status command prints
const AMOUNT_DECIMALS = 18;

// A paid URL with the CLI's receipt, and the reason when the data was not bought
type Purchase = {
  url: string;
  content?: unknown;
  amount?: string;
  nearTxUrl?: string;
  baseTxUrl?: string;
  refusal?: string;
};

// The seat's amounts under one budget in the status output
type SeatAmounts = { spent: string; canSpend: string; unit: string };

type PriceData = { coins?: Record<string, { symbol: string; price: number; timestamp: number; confidence: number }> };
type ChartData = { coins?: Record<string, { prices: { timestamp: number; price: number }[] }> };
type TvlData = { protocol: string; tvl_usd: number };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

// Runs the stipend CLI from the repository root, as the skill tells an agent to
function stipend(args: string[]): Promise<ScriptResult> {
  return runScript("cli/stipend.ts", args);
}

// Reads "  seat 1: spent 0.03 USDC, can spend 0.22 USDC", two lines below the budget's line
function seatAmounts(status: string, budgetId: string): SeatAmounts | undefined {
  const lines = status.split("\n");
  const budgetIndex = lines.findIndex((line) => line.startsWith(`Budget ${budgetId}:`));
  if (budgetIndex < 0) {
    return undefined;
  }
  const match = lines[budgetIndex + 2]?.match(/spent ([\d.]+) (\S+), can spend ([\d.]+) /);
  return match ? { spent: match[1], unit: match[2], canSpend: match[3] } : undefined;
}

// Fetches a paid URL through the CLI and reads the receipt lines from its stderr. A payment the API
// did not accept still has a signed amount, which counts as spent.
async function buy(url: string, walletArgs: string[]): Promise<Purchase> {
  const result = await stipend(["fetch", url, ...walletArgs]);
  const signed = result.stderr.match(/^Signed (.+) on NEAR: (\S+)$/m);
  const settled = result.stderr.match(/^Paid from .+: (\S+)$/m);
  const receipt = { url, amount: signed?.[1], nearTxUrl: signed?.[2], baseTxUrl: settled?.[1] };
  if (!result.ok) {
    // A contract refusal names the rule, other failures end with an API reason, an error or a status
    const refusal =
      result.stderr.match(/Smart contract panicked: ([^"\\]+)/)?.[1] ??
      result.stderr.match(/^Payment not accepted: .+$/m)?.[0] ??
      result.stderr.match(/^Error: (.+)$/m)?.[1] ??
      result.stderr.match(/^HTTP \d+$/m)?.[0] ??
      "unknown error";
    console.log(`Not bought ${url}: ${refusal}`);
    return { ...receipt, refusal };
  }
  console.log(`Paid ${receipt.amount ?? "nothing"} for ${url}`);
  return { ...receipt, content: JSON.parse(result.stdout) };
}

function dateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace(".000Z", "Z");
}

function notBought(purchase: Purchase): string[] {
  return [`Not bought: ${purchase.refusal ?? "no data in the answer"}.`];
}

function priceSection(coin: string, purchase: Purchase): string[] {
  const quote = (purchase.content as PriceData | undefined)?.coins?.[coin];
  if (!quote) {
    return notBought(purchase);
  }
  const quoted = `${dateTime(quote.timestamp)}, confidence ${quote.confidence}`;
  return [`${quote.symbol} is at ${usd.format(quote.price)} (${quoted}).`];
}

function chartSection(coin: string, purchase: Purchase): string[] {
  const prices = (purchase.content as ChartData | undefined)?.coins?.[coin]?.prices;
  if (!prices || prices.length < 2) {
    return notBought(purchase);
  }
  const firstPrice = prices[0].price;
  const lastPrice = prices[prices.length - 1].price;
  const change = ((lastPrice - firstPrice) / firstPrice) * 100;
  return [
    "| Day | Price |",
    "| --- | --- |",
    ...prices.map((point) => `| ${dateTime(point.timestamp).slice(0, 10)} | ${usd.format(point.price)} |`),
    "",
    `Change over the period: ${change >= 0 ? "+" : ""}${change.toFixed(1)}%.`,
  ];
}

function tvlSection(purchase: Purchase): string[] {
  const data = purchase.content as TvlData | undefined;
  if (data?.tvl_usd === undefined) {
    return notBought(purchase);
  }
  return [`${data.protocol} holds ${compactUsd.format(data.tvl_usd)} in total value locked.`];
}

function link(url: string | undefined): string {
  return url ? `[transaction](${url})` : "";
}

// Each URL with the amount signed, the result and both receipts, then what the task spent according
// to status
function spendSection(purchases: Purchase[], before: SeatAmounts, after: SeatAmounts | undefined): string[] {
  const rows = purchases.map((purchase) => {
    const result = purchase.refusal ? `not bought: ${purchase.refusal}` : "bought";
    const receipts = `${link(purchase.nearTxUrl)} | ${link(purchase.baseTxUrl)}`;
    return `| ${purchase.url} | ${purchase.amount ?? "none"} | ${result} | ${receipts} |`;
  });
  const lines = [
    "| URL | Amount signed | Result | Signed on NEAR | Settled on Base |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ];
  if (after) {
    const taskSpent = formatUnits(
      parseUnits(after.spent, AMOUNT_DECIMALS) - parseUnits(before.spent, AMOUNT_DECIMALS),
      AMOUNT_DECIMALS,
    );
    const left = `The seat can still spend ${after.canSpend} ${after.unit}.`;
    lines.push("", `This task spent ${taskSpent} ${after.unit}. ${left}`);
  }
  return lines;
}

// Usage: npm run agent -- --session <file> --budget <id> --coin <coin> --protocol <slug> --out <file> [--api <url>]
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      budget: { type: "string" },
      coin: { type: "string" },
      protocol: { type: "string" },
      out: { type: "string" },
      api: { type: "string" },
    },
  });
  const { session: sessionFile, budget: budgetId, coin, protocol, out } = values;
  const apiUrl = values.api ?? (process.env.PAID_API_PORT && `http://localhost:${process.env.PAID_API_PORT}`);
  if (!sessionFile || !budgetId || !coin || !protocol || !out || !apiUrl) {
    throw new Error(USAGE);
  }

  // The skill's first rule: check what the seat can spend before paying
  const statusBefore = await stipend(["status", "--session", sessionFile]);
  console.log(statusBefore.stdout.trimEnd());
  const before = seatAmounts(statusBefore.stdout, budgetId);
  if (!statusBefore.ok || !before || Number(before.canSpend) === 0) {
    throw new Error(`The seat cannot spend from budget ${budgetId}. ${statusBefore.stderr.trim()}`);
  }
  const seat = statusBefore.stdout.match(/^(Seat .+ on job \S+),/m)?.[1] ?? "Unknown seat";

  // One purchase at a time: each pay transaction uses the session key's next nonce
  const walletArgs = ["--budget", budgetId, "--session", sessionFile];
  const price = await buy(`${apiUrl}/prices/${coin}`, walletArgs);
  const chart = await buy(`${apiUrl}/chart/${coin}`, walletArgs);
  const tvl = await buy(`${apiUrl}/tvl/${protocol}`, walletArgs);

  const statusAfter = await stipend(["status", "--session", sessionFile]);
  const report = [
    `# Research report: ${coin} and ${protocol}`,
    "",
    `${seat}, budget ${budgetId}. Written ${new Date().toISOString()} with DefiLlama data bought through the paid API.`,
    "",
    "## Price",
    "",
    ...priceSection(coin, price),
    "",
    "## Last 7 days",
    "",
    ...chartSection(coin, chart),
    "",
    "## Protocol",
    "",
    ...tvlSection(tvl),
    "",
    "## Spend",
    "",
    ...spendSection([price, chart, tvl], before, seatAmounts(statusAfter.stdout, budgetId)),
    "",
  ].join("\n");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  console.log(`Report written to ${out}`);
}

await main();
