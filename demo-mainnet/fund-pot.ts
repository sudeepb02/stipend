// Moves USDC from the funder to the pot of an open budget, settled by the x402 facilitator
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { JsonRpcProvider } from "near-api-js";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readAsset, readBudget } from "../sdk/budget.ts";
import {
  BASE_CHAIN,
  BASE_EXPLORER_URL,
  NEAR_RPC_URL,
  USDC_ADDRESS,
  USDC_ASSET_ID,
  X402_NETWORK,
  readPotAddress,
} from "./network.ts";

const EXPLORER_TX_URL = `${BASE_EXPLORER_URL}/tx`;
const AUTHORIZATION_TIMEOUT_SECONDS = 300;
// Path of a budget's pot, with the id in plain decimal as the contract writes it
const POT_PATH_PATTERN = /^budget\/(0|[1-9]\d*)$/;
const USAGE = "Usage: npm run mainnet:fund-pot -- budget/<id> <amount>";
const USDC_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

// Usage: npm run mainnet:fund-pot -- budget/<id> <amount>
async function main(): Promise<void> {
  const [path, amount] = process.argv.slice(2);
  const budgetId = path?.match(POT_PATH_PATTERN)?.[1];
  if (!budgetId || !amount) {
    throw new Error(USAGE);
  }
  const { STIPEND_CONTRACT_ID, FUNDER_PRIVATE_KEY, X402_FACILITATOR_URL } = process.env;
  if (!STIPEND_CONTRACT_ID || !FUNDER_PRIVATE_KEY || !X402_FACILITATOR_URL) {
    throw new Error("Set STIPEND_CONTRACT_ID, FUNDER_PRIVATE_KEY and X402_FACILITATOR_URL in .env.mainnet");
  }

  const nearProvider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  // USDC goes only to an open budget of this deployment's funder that pays in USDC on Base. The
  // funder of any other budget could refund the transfer to itself.
  const budget = await readBudget(nearProvider, STIPEND_CONTRACT_ID, budgetId);
  if (budget.closed_at !== null || Date.now() / 1000 >= Number(budget.expires_at)) {
    throw new Error(`Budget ${budgetId} is closed or expired`);
  }
  if (budget.funder !== STIPEND_CONTRACT_ID) {
    throw new Error(`Budget ${budgetId} belongs to funder ${budget.funder}, not ${STIPEND_CONTRACT_ID}`);
  }
  const asset = await readAsset(nearProvider, STIPEND_CONTRACT_ID, budget.asset_id);
  const isUsdcOnBase =
    budget.asset_id === USDC_ASSET_ID &&
    Number(asset.chain_id) === BASE_CHAIN.id &&
    asset.token.toLowerCase() === USDC_ADDRESS.toLowerCase();
  if (!isUsdcOnBase) {
    throw new Error(`Budget ${budgetId} pays in ${budget.asset_id}, not in USDC on Base`);
  }
  const potAddress = await readPotAddress(nearProvider, STIPEND_CONTRACT_ID, budgetId);
  const baseClient = createPublicClient({ chain: BASE_CHAIN, transport: http() });

  const value = parseUnits(amount, asset.decimals);
  if (value <= 0n) {
    throw new Error("Amount must be above zero");
  }

  // The authorization is signed over the token's own EIP-712 name and version
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: X402_NETWORK,
    asset: asset.token,
    amount: value.toString(),
    payTo: potAddress,
    maxTimeoutSeconds: AUTHORIZATION_TIMEOUT_SECONDS,
    extra: { name: asset.name, version: asset.version },
  };
  const funder = privateKeyToAccount(FUNDER_PRIVATE_KEY as Hex);
  const signedPayment = await new ExactEvmScheme(funder).createPaymentPayload(2, requirements);
  const paymentPayload = { x402Version: 2, accepted: requirements, payload: signedPayment.payload };

  const facilitator = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
  const verification = await facilitator.verify(paymentPayload, requirements);
  if (!verification.isValid) {
    throw new Error(`Facilitator rejected the transfer: ${verification.invalidReason}`);
  }
  const settlement = await facilitator.settle(paymentPayload, requirements);
  if (!settlement.success) {
    throw new Error(`Settlement failed: ${settlement.errorReason}`);
  }

  const receipt = await baseClient.waitForTransactionReceipt({ hash: settlement.transaction as Hex });
  if (receipt.status !== "success") {
    throw new Error(`Transfer reverted: ${EXPLORER_TX_URL}/${settlement.transaction}`);
  }
  const potBalance = await baseClient.readContract({
    address: asset.token,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [potAddress],
  });
  console.log(`Sent ${amount} USDC from ${funder.address} to ${path} (${potAddress})`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${settlement.transaction}`);
  console.log(`Pot balance: ${formatUnits(potBalance, asset.decimals)} USDC`);
}

await main();
