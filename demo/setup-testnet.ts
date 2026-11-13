// Creates test accounts and keys for development and writes them to .env
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const FAUCET_URL = "https://helper.testnet.near.org/account";
const ENV_PATH = new URL("../.env", import.meta.url);
const ENV_EXAMPLE_PATH = new URL("../.env.example", import.meta.url);

type NearAccount = { accountId: string; secretKey: string };

// Creates a funded testnet account through the faucet helper
async function createNearAccount(namePrefix: string): Promise<NearAccount> {
  const keyPair = KeyPair.fromRandom("ed25519");
  const accountId = `${namePrefix}-${randomBytes(4).toString("hex")}.testnet`;
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Faucet refused ${accountId}: ${response.status} ${await response.text()}`);
  }
  return { accountId, secretKey: keyPair.toString() };
}

// Sets the value of one KEY=value line
function setEnvValue(envText: string, key: string, value: string): string {
  const linePattern = new RegExp(`^${key}=.*$`, "m");
  if (!linePattern.test(envText)) {
    throw new Error(`Missing ${key} in .env.example`);
  }
  return envText.replace(linePattern, `${key}=${value}`);
}

async function main(): Promise<void> {
  if (existsSync(ENV_PATH)) {
    throw new Error(".env already exists. Remove it to create new accounts.");
  }

  const contractAccount = await createNearAccount("stipend");
  const oracleAccount = await createNearAccount("stipend-oracle");
  const funderKey = generatePrivateKey();
  const paidApiKey = generatePrivateKey();
  const funderAddress = privateKeyToAccount(funderKey).address;
  const paidApiAddress = privateKeyToAccount(paidApiKey).address;

  const envValues: Record<string, string> = {
    STIPEND_CONTRACT_ID: contractAccount.accountId,
    STIPEND_CONTRACT_KEY: contractAccount.secretKey,
    ORACLE_ID: oracleAccount.accountId,
    ORACLE_KEY: oracleAccount.secretKey,
    FUNDER_PRIVATE_KEY: funderKey,
    PAID_API_PRIVATE_KEY: paidApiKey,
    PAID_API_PAY_TO: paidApiAddress,
  };
  let envText = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  for (const [key, value] of Object.entries(envValues)) {
    envText = setEnvValue(envText, key, value);
  }
  writeFileSync(ENV_PATH, envText, { mode: 0o600 });

  console.log("Wrote .env");
  console.log(`Contract account: ${contractAccount.accountId}`);
  console.log(`Oracle account:   ${oracleAccount.accountId}`);
  console.log(`Paid API payee:   ${paidApiAddress}`);
  console.log(`Funder address:   ${funderAddress}`);
  console.log("Send test USDC to the funder address: https://faucet.circle.com");
}

await main();
