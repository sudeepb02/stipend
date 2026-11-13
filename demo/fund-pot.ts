// Moves test USDC from the funder to the address of a wallet path, settled by the x402 facilitator
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { JsonRpcProvider } from "near-api-js";
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { deriveEvmAddress } from "../sdk/address.ts";

const BASE_SEPOLIA = "eip155:84532";
const EXPLORER_TX_URL = "https://sepolia.basescan.org/tx";
const AUTHORIZATION_TIMEOUT_SECONDS = 300;
const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

// Usage: npm run fund-pot -- <path> <amount>
async function main(): Promise<void> {
  const [path, amount] = process.argv.slice(2);
  const env = process.env;
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, BASE_RPC_URL } = env;
  const { USDC_ADDRESS, FUNDER_PRIVATE_KEY, X402_FACILITATOR_URL } = env;
  if (!path || !amount) {
    throw new Error("Usage: npm run fund-pot -- <path> <amount>");
  }
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID || !BASE_RPC_URL) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID and BASE_RPC_URL in .env");
  }
  if (!USDC_ADDRESS || !FUNDER_PRIVATE_KEY || !X402_FACILITATOR_URL) {
    throw new Error("Set USDC_ADDRESS, FUNDER_PRIVATE_KEY and X402_FACILITATOR_URL in .env");
  }

  const nearProvider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const potAddress = await deriveEvmAddress(nearProvider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path);
  const baseClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC_URL) });
  const usdcAddress = USDC_ADDRESS as Address;

  // The authorization is signed over the token's own EIP-712 name and version
  const [tokenName, tokenVersion, decimals] = await Promise.all([
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "name" }),
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "version" }),
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "decimals" }),
  ]);
  const value = parseUnits(amount, decimals);
  if (value <= 0n) {
    throw new Error("Amount must be above zero");
  }

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: BASE_SEPOLIA,
    asset: usdcAddress,
    amount: value.toString(),
    payTo: potAddress,
    maxTimeoutSeconds: AUTHORIZATION_TIMEOUT_SECONDS,
    extra: { name: tokenName, version: tokenVersion },
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
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [potAddress],
  });
  console.log(`Sent ${amount} USDC from ${funder.address} to ${path} (${potAddress})`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${settlement.transaction}`);
  console.log(`Pot balance: ${formatUnits(potBalance, decimals)} USDC`);
}

await main();
