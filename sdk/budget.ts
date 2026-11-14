// Reads Stipend budgets and the token they pay in
import type { JsonRpcProvider } from "near-api-js";
import type { Address } from "viem";

// EIP-712 domain of a token, in the form x402 signers receive it
export type TokenDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

// Budget fields as the contract returns them, amounts in the token's smallest unit
export type Budget = {
  job_id: string;
  funder: string;
  asset_id: string;
  limits: { total: string; per_agent_cap: string; per_payment_max: string };
  payees: string[] | null;
  expires_at: string;
  closed_at: string | null;
  reserved_total: string;
  spent_total: string;
  payment_count: number;
};

export type Asset = { chain_id: string; token: Address; name: string; version: string; decimals: number };

export async function readBudget(provider: JsonRpcProvider, contractId: string, budgetId: string): Promise<Budget> {
  const budget = await provider.callFunction<Budget>({
    contractId,
    method: "get_budget",
    args: { budget_id: budgetId },
  });
  if (!budget) {
    throw new Error(`No budget ${budgetId} on ${contractId}`);
  }
  return budget;
}

export async function readAsset(provider: JsonRpcProvider, contractId: string, assetId: string): Promise<Asset> {
  const asset = await provider.callFunction<Asset>({ contractId, method: "get_asset", args: { asset_id: assetId } });
  if (!asset) {
    throw new Error(`Asset ${assetId} is not registered on ${contractId}`);
  }
  return asset;
}

// EIP-712 domain of an asset. The contract signs a budget's transfers only in its asset's domain.
export function tokenDomain(asset: Asset): TokenDomain {
  return {
    name: asset.name,
    version: asset.version,
    chainId: Number(asset.chain_id),
    verifyingContract: asset.token,
  };
}
