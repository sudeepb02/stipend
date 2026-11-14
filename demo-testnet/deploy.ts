// Deploys the contract wasm to the Stipend account and checks that the live code matches it.
// The first deploy also initializes the contract and registers USDC on Base Sepolia.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, actions, baseEncode, type KeyPairString } from "near-api-js";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { baseSepolia } from "viem/chains";

const WASM_PATH = new URL(
  "../contract/target/wasm32-unknown-unknown/release/stipend.wasm",
  import.meta.url,
);
const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const USDC_ASSET_ID = "usdc-base-sepolia";
const SETUP_CALL_GAS = 30_000_000_000_000n;
const ONE_YOCTO = 1n;
const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// Contract config, or undefined while the contract is not initialized
async function readConfig(provider: JsonRpcProvider, contractId: string): Promise<unknown> {
  try {
    return await provider.callFunction({ contractId, method: "get_config", args: {} });
  } catch {
    return undefined;
  }
}

// USDC as the contract registers it, with the EIP-712 name and version read from the token
async function readUsdcAsset(baseRpcUrl: string, usdcAddress: Address) {
  const baseClient = createPublicClient({ chain: baseSepolia, transport: http(baseRpcUrl) });
  const [name, version, decimals] = await Promise.all([
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "name" }),
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "version" }),
    baseClient.readContract({ address: usdcAddress, abi: USDC_ABI, functionName: "decimals" }),
  ]);
  return { chain_id: String(baseSepolia.id), token: usdcAddress, name, version, decimals };
}

// Usage: npm run deploy
async function main(): Promise<void> {
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY } = process.env;
  const { ORACLE_ID, BASE_RPC_URL, USDC_ADDRESS } = process.env;
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env");
  }
  if (!ORACLE_ID || !BASE_RPC_URL || !USDC_ADDRESS) {
    throw new Error("Set ORACLE_ID, BASE_RPC_URL and USDC_ADDRESS in .env");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const contractAccount = new Account(
    STIPEND_CONTRACT_ID,
    provider,
    STIPEND_CONTRACT_KEY as KeyPairString,
  );

  const wasmBytes = readFileSync(WASM_PATH);
  const isInitialized = (await readConfig(provider, STIPEND_CONTRACT_ID)) !== undefined;
  // On the first deploy the same transaction initializes the contract and registers USDC
  const setupActions = isInitialized
    ? []
    : [
        actions.functionCall(
          "new",
          { owner: STIPEND_CONTRACT_ID, oracle: ORACLE_ID, mpc_signer_id: NEAR_SIGNER_ID },
          SETUP_CALL_GAS,
          0n,
        ),
        actions.functionCall(
          "register_asset",
          { asset_id: USDC_ASSET_ID, asset: await readUsdcAsset(BASE_RPC_URL, USDC_ADDRESS as Address) },
          SETUP_CALL_GAS,
          ONE_YOCTO,
        ),
      ];
  const deployOutcome = await contractAccount.signAndSendTransaction({
    receiverId: STIPEND_CONTRACT_ID,
    actions: [actions.deployContract(wasmBytes), ...setupActions],
    waitUntil: "FINAL",
  });
  const setupNote = isInitialized ? "" : ", initialized it and registered USDC";
  console.log(`Deployed ${wasmBytes.length} bytes to ${STIPEND_CONTRACT_ID}${setupNote}`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${deployOutcome.transaction.hash}`);

  // NEAR reports the code hash as the base58 sha256 of the wasm
  const localCodeHash = baseEncode(createHash("sha256").update(wasmBytes).digest());
  const { codeHash } = await contractAccount.getState();
  if (codeHash !== localCodeHash) {
    throw new Error(`Live code hash ${codeHash} does not match local wasm ${localCodeHash}`);
  }
  const asset = await provider.callFunction({
    contractId: STIPEND_CONTRACT_ID,
    method: "get_asset",
    args: { asset_id: USDC_ASSET_ID },
  });
  console.log("Code hash matches");
  console.log(`Config: ${JSON.stringify(await readConfig(provider, STIPEND_CONTRACT_ID))}`);
  console.log(`Asset ${USDC_ASSET_ID}: ${JSON.stringify(asset)}`);
}

await main();
