// Mainnet settings of the demo: NEAR mainnet, and USDC on Base
import type { JsonRpcProvider } from "near-api-js";
import type { Address } from "viem";
import { base } from "viem/chains";
import { deriveEvmAddress } from "../sdk/address.ts";

export const NEAR_RPC_URL = "https://free.rpc.fastnear.com";
export const NEAR_EXPLORER_URL = "https://nearblocks.io";
// MPC signer contract of NEAR mainnet
export const MPC_SIGNER_ID = "v1.signer";
export const BASE_CHAIN = base;
export const BASE_EXPLORER_URL = "https://basescan.org";
// x402 network id of Base
export const X402_NETWORK = `eip155:${base.id}` as const;
export const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Id the contract registers USDC on Base under
export const USDC_ASSET_ID = "usdc-base";

// Pot address of a budget. Fails unless the contract answers on NEAR mainnet and signs through
// MPC_SIGNER_ID, so no address is derived for a contract that cannot sign for it.
export async function readPotAddress(
  provider: JsonRpcProvider,
  contractId: string,
  budgetId: string,
): Promise<Address> {
  const config = await provider.callFunction<{ mpc_signer_id: string }>({
    contractId,
    method: "get_config",
    args: {},
  });
  if (config?.mpc_signer_id !== MPC_SIGNER_ID) {
    throw new Error(`${contractId} does not sign through ${MPC_SIGNER_ID}`);
  }
  return deriveEvmAddress(provider, MPC_SIGNER_ID, contractId, `budget/${budgetId}`);
}
