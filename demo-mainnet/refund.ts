// Refunds what is left in a budget's pot after the budget ended and every payment authorization
// expired: the funder asks the contract for the signed transfer, and the x402 facilitator settles it
// on Base
import { parseArgs } from "node:util";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readAsset, readBudget } from "../sdk/budget.ts";
import { refundNonce, requestRefund } from "../sdk/refund.ts";
import { BASE_CHAIN, BASE_EXPLORER_URL, NEAR_EXPLORER_URL, NEAR_RPC_URL, readPotAddress } from "./network.ts";

const NEAR_EXPLORER_TX_URL = `${NEAR_EXPLORER_URL}/txns`;
const BASE_EXPLORER_TX_URL = `${BASE_EXPLORER_URL}/tx`;
const USAGE = "Usage: npm run mainnet:refund -- <budget_id> [--to <address>]";
const USDC_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

// Usage: npm run mainnet:refund -- <budget_id> [--to <address>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { to: { type: "string" } } });
  const [budgetId] = positionals;
  if (!budgetId || !/^\d+$/.test(budgetId) || (values.to !== undefined && !isAddress(values.to))) {
    throw new Error(USAGE);
  }
  const { STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY, X402_FACILITATOR_URL, FUNDER_PRIVATE_KEY } = process.env;
  if (!STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env.mainnet");
  }
  if (!X402_FACILITATOR_URL || (!values.to && !FUNDER_PRIVATE_KEY)) {
    throw new Error("Set X402_FACILITATOR_URL and, without --to, FUNDER_PRIVATE_KEY in .env.mainnet");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  // The contract account acts as the funder of the demo budgets
  const funder = new Account(STIPEND_CONTRACT_ID, provider, STIPEND_CONTRACT_KEY as KeyPairString);
  const budget = await readBudget(provider, STIPEND_CONTRACT_ID, budgetId);
  if (budget.funder !== funder.accountId) {
    throw new Error(`Budget ${budgetId} belongs to funder ${budget.funder}, not ${funder.accountId}`);
  }

  // Refunds start max_window_sec after the budget ends, when no payment authorization is valid
  const config = await provider.callFunction<{ max_window_sec: number }>({
    contractId: STIPEND_CONTRACT_ID,
    method: "get_config",
    args: {},
  });
  const refundStart = Number(budget.closed_at ?? budget.expires_at) + (config?.max_window_sec ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < refundStart) {
    console.log(`Refunds of budget ${budgetId} start at ${new Date(refundStart * 1000).toISOString()}`);
    process.exitCode = 1;
    return;
  }

  const asset = await readAsset(provider, STIPEND_CONTRACT_ID, budget.asset_id);
  if (Number(asset.chain_id) !== BASE_CHAIN.id) {
    throw new Error(`Budget ${budgetId} pays on chain ${asset.chain_id}, and this script refunds on Base`);
  }
  const baseClient = createPublicClient({ chain: BASE_CHAIN, transport: http() });
  const balanceOf = (holder: Address) =>
    baseClient.readContract({ address: asset.token, abi: USDC_ABI, functionName: "balanceOf", args: [holder] });
  const pot = await readPotAddress(provider, STIPEND_CONTRACT_ID, budgetId);
  const [potBalance, isRefunded] = await Promise.all([
    balanceOf(pot),
    baseClient.readContract({
      address: asset.token,
      abi: USDC_ABI,
      functionName: "authorizationState",
      args: [pot, refundNonce(budgetId)],
    }),
  ]);
  if (isRefunded) {
    console.log(`Budget ${budgetId} was already refunded`);
    return;
  }
  if (potBalance === 0n) {
    console.log(`The pot of budget ${budgetId} is empty`);
    return;
  }

  const to = values.to ? getAddress(values.to) : privateKeyToAccount(FUNDER_PRIVATE_KEY as Hex).address;
  const formatAmount = (value: bigint) => `${formatUnits(value, asset.decimals)} ${asset.name}`;
  console.log(`Refunding ${formatAmount(potBalance)} from budget/${budgetId} (${pot}) to ${to}`);
  const signed = await requestRefund(funder, STIPEND_CONTRACT_ID, budgetId, { from: pot, to, amount: potBalance });
  console.log(`Signed on NEAR: ${NEAR_EXPLORER_TX_URL}/${signed.transactionHash}`);

  // The facilitator settles any EIP-3009 authorization it can verify, so the pot needs no ETH
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: `eip155:${asset.chain_id}`,
    asset: asset.token,
    amount: signed.transfer.value,
    payTo: to,
    maxTimeoutSeconds: Number(signed.transfer.valid_before) - nowSec,
    extra: { name: asset.name, version: asset.version },
  };
  const authorization = {
    from: signed.transfer.from,
    to: signed.transfer.to,
    value: signed.transfer.value,
    validAfter: signed.transfer.valid_after,
    validBefore: signed.transfer.valid_before,
    nonce: signed.transfer.nonce,
  };
  const paymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { signature: signed.signature, authorization },
  };
  const facilitator = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
  const verification = await facilitator.verify(paymentPayload, requirements);
  if (!verification.isValid) {
    throw new Error(`Facilitator rejected the refund: ${verification.invalidReason}`);
  }
  const settlement = await facilitator.settle(paymentPayload, requirements);
  if (!settlement.success) {
    throw new Error(`Settlement failed: ${settlement.errorReason}`);
  }
  const receipt = await baseClient.waitForTransactionReceipt({ hash: settlement.transaction as Hex });
  if (receipt.status !== "success") {
    throw new Error(`Refund reverted: ${BASE_EXPLORER_TX_URL}/${settlement.transaction}`);
  }
  console.log(`Refunded on Base: ${BASE_EXPLORER_TX_URL}/${settlement.transaction}`);
  console.log(`Pot balance: ${formatAmount(await balanceOf(pot))}`);
}

await main();
