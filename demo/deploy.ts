// Deploys the contract wasm to the Stipend account and checks that the live code matches it
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, baseEncode, type KeyPairString } from "near-api-js";

const WASM_PATH = new URL(
  "../contract/target/wasm32-unknown-unknown/release/stipend.wasm",
  import.meta.url,
);
const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";

// Usage: npm run deploy
async function main(): Promise<void> {
  const { NEAR_RPC_URL, STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY } = process.env;
  if (!NEAR_RPC_URL || !STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set NEAR_RPC_URL, STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const contractAccount = new Account(
    STIPEND_CONTRACT_ID,
    provider,
    STIPEND_CONTRACT_KEY as KeyPairString,
  );

  const wasmBytes = readFileSync(WASM_PATH);
  const deployOutcome = await contractAccount.deployContract(wasmBytes);
  console.log(`Deployed ${wasmBytes.length} bytes to ${STIPEND_CONTRACT_ID}`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${deployOutcome.transaction.hash}`);

  // NEAR reports the code hash as the base58 sha256 of the wasm
  const localCodeHash = baseEncode(createHash("sha256").update(wasmBytes).digest());
  const { codeHash } = await contractAccount.getState();
  if (codeHash !== localCodeHash) {
    throw new Error(`Live code hash ${codeHash} does not match local wasm ${localCodeHash}`);
  }

  const pingReply = await provider.callFunction<string>({
    contractId: STIPEND_CONTRACT_ID,
    method: "ping",
    args: {},
  });
  console.log(`Code hash matches. ping returned: ${pingReply}`);
}

await main();
