// Agent wallet CLI: fetches x402-paid URLs and pays from a Stipend budget as the agent's session account
import { parseArgs } from "node:util";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { deriveEvmAddress } from "../sdk/address.ts";
import { readBudgetDomain } from "../sdk/budget.ts";
import { createX402Signer } from "../sdk/x402-signer.ts";

const MAX_PAYMENT = "$0.01";
const NEAR_EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const BASE_EXPLORER_TX_URL = "https://sepolia.basescan.org/tx";
const USAGE = "Usage: npm run stipend -- fetch <url> [--budget <id>]";

// Pays if the URL answers 402, then prints the content to stdout and the receipt to stderr
async function fetchCommand(url: string, budgetId: string): Promise<void> {
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
  const path = `budget/${budgetId}`;
  const [address, domain] = await Promise.all([
    deriveEvmAddress(provider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path),
    readBudgetDomain(provider, STIPEND_CONTRACT_ID, budgetId),
  ]);

  const signer = createX402Signer({
    account,
    contractId: STIPEND_CONTRACT_ID,
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

// Usage: npm run stipend -- fetch <url> [--budget <id>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { budget: { type: "string", default: "0" } },
  });
  const [command, url] = positionals;
  if (command !== "fetch" || !url || !/^\d+$/.test(values.budget)) {
    throw new Error(USAGE);
  }
  await fetchCommand(url, values.budget);
}

await main();
