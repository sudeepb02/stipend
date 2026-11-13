// Paid data API: serves DefiLlama token prices behind an x402 paywall on Base Sepolia
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import express from "express";

const BASE_SEPOLIA = "eip155:84532";
const PRICE_PER_CALL = "$0.01";
const DEFILLAMA_PRICES_URL = "https://coins.llama.fi/prices/current";
// Comma-separated DefiLlama coin ids, such as coingecko:near or base:0x833589fC...
const COINS_PATTERN = /^[\w.-]+:[\w.-]+(,[\w.-]+:[\w.-]+)*$/;

// Usage: npm run paid-api
function main(): void {
  const { PAID_API_PAY_TO, PAID_API_PORT, X402_FACILITATOR_URL } = process.env;
  if (!PAID_API_PAY_TO || !PAID_API_PORT || !X402_FACILITATOR_URL) {
    throw new Error("Set PAID_API_PAY_TO, PAID_API_PORT and X402_FACILITATOR_URL in .env");
  }
  const facilitator = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator).register(
    BASE_SEPOLIA,
    new ExactEvmScheme(),
  );

  const app = express();
  // Answers 402 until paid, and settles the payment only after a successful response
  app.use(
    paymentMiddleware(
      {
        "GET /prices/:coins": {
          accepts: [
            { scheme: "exact", price: PRICE_PER_CALL, network: BASE_SEPOLIA, payTo: PAID_API_PAY_TO },
          ],
          description: "Current token prices from DefiLlama",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.get("/prices/:coins", async (request, response) => {
    const { coins } = request.params;
    if (!COINS_PATTERN.test(coins)) {
      response.status(400).json({ error: "Use comma-separated coin ids, such as coingecko:near" });
      return;
    }
    const upstream = await fetch(`${DEFILLAMA_PRICES_URL}/${coins}`);
    if (!upstream.ok) {
      response.status(502).json({ error: `DefiLlama answered ${upstream.status}` });
      return;
    }
    response.json(await upstream.json());
  });

  app.listen(Number(PAID_API_PORT), () => {
    console.log(`Paid API on http://localhost:${PAID_API_PORT}, ${PRICE_PER_CALL} per call`);
  });
}

main();
