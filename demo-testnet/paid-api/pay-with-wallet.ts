// Pays for one paid API call from the funder wallet, like any x402 client
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_SEPOLIA = "eip155:84532";
const MAX_PAYMENT = "$0.01";
const EXPLORER_TX_URL = "https://sepolia.basescan.org/tx";

// Usage: npm run pay-with-wallet -- [coins]
async function main(): Promise<void> {
  const coins = process.argv[2] ?? "coingecko:near";
  const { FUNDER_PRIVATE_KEY, PAID_API_PORT } = process.env;
  if (!FUNDER_PRIVATE_KEY || !PAID_API_PORT) {
    throw new Error("Set FUNDER_PRIVATE_KEY and PAID_API_PORT in .env");
  }
  const funder = privateKeyToAccount(FUNDER_PRIVATE_KEY as `0x${string}`);
  const client = new x402Client()
    .register(BASE_SEPOLIA, new ExactEvmScheme(funder))
    .setSpendControls({ maxAmountPerPayment: MAX_PAYMENT });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(`http://localhost:${PAID_API_PORT}/prices/${coins}`);
  console.log(`HTTP ${response.status}: ${JSON.stringify(await response.json())}`);
  const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentHeader) {
    const settlement = decodePaymentResponseHeader(paymentHeader);
    console.log(`Paid by ${settlement.payer}: ${EXPLORER_TX_URL}/${settlement.transaction}`);
  }
}

await main();
