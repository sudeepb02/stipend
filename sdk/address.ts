// Derives the EVM address the MPC signer controls for a contract and path
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, PublicKey } from "near-api-js";
import { getAddress, keccak256, type Address } from "viem";

const SECP256K1_DOMAIN_ID = 0;

export async function deriveEvmAddress(
  provider: JsonRpcProvider,
  signerId: string,
  contractId: string,
  path: string,
): Promise<Address> {
  const derivedKey = await provider.callFunction<string>({
    contractId: signerId,
    method: "derived_public_key",
    args: { path, predecessor: contractId, domain_id: SECP256K1_DOMAIN_ID },
  });
  if (!derivedKey) {
    throw new Error(`No derived key for ${contractId} and path ${path}`);
  }
  // Key data is the 64-byte curve point without the 0x04 prefix
  const keyBytes = PublicKey.fromString(derivedKey).data;
  const keyHash = keccak256(keyBytes);
  return getAddress(`0x${keyHash.slice(-40)}`);
}

// Usage: node --env-file=.env sdk/address.ts <path>
async function main(): Promise<void> {
  const path = process.argv[2];
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID } = process.env;
  if (!path || !NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID) {
    throw new Error("Usage: node --env-file=.env sdk/address.ts <path>");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const address = await deriveEvmAddress(provider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path);
  console.log(address);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
