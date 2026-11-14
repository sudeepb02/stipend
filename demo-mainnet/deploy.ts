// Deploys the contract wasm to the Stipend account on NEAR mainnet and checks that the live code
// matches it. The first deploy also initializes the contract and registers USDC on Base.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, actions, baseEncode, type KeyPairString } from "near-api-js";
import { createPublicClient, domainSeparator, http, parseAbi } from "viem";
import {
  BASE_CHAIN,
  MPC_SIGNER_ID,
  NEAR_EXPLORER_URL,
  NEAR_RPC_URL,
  USDC_ADDRESS,
  USDC_ASSET_ID,
} from "./network.ts";

const WASM_PATH = new URL(
  "../contract/target/wasm32-unknown-unknown/release/stipend.wasm",
  import.meta.url,
);
const EXPLORER_TX_URL = `${NEAR_EXPLORER_URL}/txns`;
const SETUP_CALL_GAS = 30_000_000_000_000n;
const ONE_YOCTO = 1n;
const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

// Contract config, or undefined while the contract is not initialized
async function readConfig(provider: JsonRpcProvider, contractId: string): Promise<unknown> {
  try {
    return await provider.callFunction({ contractId, method: "get_config", args: {} });
  } catch {
    return undefined;
  }
}

// USDC as the contract registers it, with the EIP-712 name and version read from the token. An
// asset never changes once registered, so the token's own domain separator must match the fields.
async function readUsdcAsset() {
  const baseClient = createPublicClient({ chain: BASE_CHAIN, transport: http() });
  const [name, version, decimals, tokenSeparator] = await Promise.all([
    baseClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "name" }),
    baseClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "version" }),
    baseClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "decimals" }),
    baseClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "DOMAIN_SEPARATOR" }),
  ]);
  const assetSeparator = domainSeparator({
    domain: { name, version, chainId: BASE_CHAIN.id, verifyingContract: USDC_ADDRESS },
  });
  if (assetSeparator !== tokenSeparator) {
    throw new Error(`USDC has domain separator ${tokenSeparator}, but the asset fields give ${assetSeparator}`);
  }
  return { chain_id: String(BASE_CHAIN.id), token: USDC_ADDRESS, name, version, decimals };
}

// Usage: npm run mainnet:deploy
async function main(): Promise<void> {
  const { STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY, ORACLE_ID } = process.env;
  if (!STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY || !ORACLE_ID) {
    throw new Error("Set STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY and ORACLE_ID in .env.mainnet");
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
          { owner: STIPEND_CONTRACT_ID, oracle: ORACLE_ID, mpc_signer_id: MPC_SIGNER_ID },
          SETUP_CALL_GAS,
          0n,
        ),
        actions.functionCall(
          "register_asset",
          { asset_id: USDC_ASSET_ID, asset: await readUsdcAsset() },
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
