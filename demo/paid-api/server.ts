// Paid data API: serves DefiLlama data behind an x402 paywall on Base Sepolia. Two more routes ask
// for payments a budget refuses: one is overpriced, the other pays an address no budget lists.
import { HTTPFacilitatorClient, type RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import express, { type Request, type Response } from "express";

const BASE_SEPOLIA = "eip155:84532";
const PRICE_PER_CALL = "$0.01";
// Above the per-payment max of the demo budgets
const OVERPRICED_PRICE = "$0.05";
// Burn address, on no budget's payee list
const UNLISTED_PAY_TO = "0x000000000000000000000000000000000000dEaD";
const DEFILLAMA_COINS_URL = "https://coins.llama.fi";
const DEFILLAMA_API_URL = "https://api.llama.fi";
// Daily prices of the last 7 days
const CHART_QUERY = "span=7&period=1d";
// Comma-separated DefiLlama coin ids, such as coingecko:near or base:0x833589fC...
const COINS_PATTERN = /^[\w.-]+:[\w.-]+(,[\w.-]+:[\w.-]+)*$/;
// DefiLlama protocol slug, such as aave-v3
const PROTOCOL_PATTERN = /^[a-z0-9.-]+$/;

// x402 terms of a route: one USDC payment on Base Sepolia
function paidRoute(price: string, payTo: string, description: string): RouteConfig {
  return {
    accepts: [{ scheme: "exact", price, network: BASE_SEPOLIA, payTo }],
    description,
    mimeType: "application/json",
  };
}

// Returns DefiLlama's JSON, or answers 502 and returns undefined. A payment settles only after a
// successful response, so a failed upstream call costs the caller nothing.
async function fetchDefiLlama(response: Response, url: string): Promise<unknown> {
  const upstream = await fetch(url);
  if (!upstream.ok) {
    response.status(502).json({ error: `DefiLlama answered ${upstream.status}` });
    return undefined;
  }
  return upstream.json();
}

// Coin ids of the request, or undefined after answering 400
function readCoins(request: Request, response: Response): string | undefined {
  const coins = String(request.params.coins);
  if (!COINS_PATTERN.test(coins)) {
    response.status(400).json({ error: "Use comma-separated coin ids, such as coingecko:near" });
    return undefined;
  }
  return coins;
}

async function sendPrices(request: Request, response: Response): Promise<void> {
  const coins = readCoins(request, response);
  const prices = coins && (await fetchDefiLlama(response, `${DEFILLAMA_COINS_URL}/prices/current/${coins}`));
  if (prices) {
    response.json(prices);
  }
}

async function sendChart(request: Request, response: Response): Promise<void> {
  const coins = readCoins(request, response);
  const chart = coins && (await fetchDefiLlama(response, `${DEFILLAMA_COINS_URL}/chart/${coins}?${CHART_QUERY}`));
  if (chart) {
    response.json(chart);
  }
}

async function sendTvl(request: Request, response: Response): Promise<void> {
  const protocol = String(request.params.protocol);
  if (!PROTOCOL_PATTERN.test(protocol)) {
    response.status(400).json({ error: "Use a DefiLlama protocol slug, such as aave-v3" });
    return;
  }
  const tvl = await fetchDefiLlama(response, `${DEFILLAMA_API_URL}/tvl/${protocol}`);
  if (tvl !== undefined) {
    response.json({ protocol, tvl_usd: tvl });
  }
}

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
        "GET /prices/:coins": paidRoute(PRICE_PER_CALL, PAID_API_PAY_TO, "Current token prices from DefiLlama"),
        "GET /chart/:coins": paidRoute(PRICE_PER_CALL, PAID_API_PAY_TO, "Daily token prices of the last 7 days"),
        "GET /tvl/:protocol": paidRoute(PRICE_PER_CALL, PAID_API_PAY_TO, "Total value locked of a DeFi protocol"),
        "GET /overpriced/prices/:coins": paidRoute(
          OVERPRICED_PRICE,
          PAID_API_PAY_TO,
          "Current token prices, at five times the price",
        ),
        "GET /unlisted-payee/prices/:coins": paidRoute(
          PRICE_PER_CALL,
          UNLISTED_PAY_TO,
          "Current token prices, paid to an address no budget lists",
        ),
      },
      resourceServer,
    ),
  );

  app.get("/prices/:coins", sendPrices);
  app.get("/chart/:coins", sendChart);
  app.get("/tvl/:protocol", sendTvl);
  app.get("/overpriced/prices/:coins", sendPrices);
  app.get("/unlisted-payee/prices/:coins", sendPrices);

  app.listen(Number(PAID_API_PORT), () => {
    console.log(`Paid API on http://localhost:${PAID_API_PORT}, ${PRICE_PER_CALL} per call`);
  });
}

main();
