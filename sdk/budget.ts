// Reads the token a Stipend budget pays in
import type { JsonRpcProvider } from "near-api-js";
import type { Address } from "viem";

// EIP-712 domain of a token, in the form x402 signers receive it
export type TokenDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

// Asset fields as the contract returns them
type Asset = { chain_id: string; token: Address; name: string; version: string };

// Domain of the budget's registered asset, the only domain the contract signs the budget's transfers in
export async function readBudgetDomain(
  provider: JsonRpcProvider,
  contractId: string,
  budgetId: string,
): Promise<TokenDomain> {
  const budget = await provider.callFunction<{ asset_id: string }>({
    contractId,
    method: "get_budget",
    args: { budget_id: budgetId },
  });
  if (!budget) {
    throw new Error(`No budget ${budgetId} on ${contractId}`);
  }
  const asset = await provider.callFunction<Asset>({
    contractId,
    method: "get_asset",
    args: { asset_id: budget.asset_id },
  });
  if (!asset) {
    throw new Error(`Asset ${budget.asset_id} is not registered on ${contractId}`);
  }
  return {
    name: asset.name,
    version: asset.version,
    chainId: Number(asset.chain_id),
    verifyingContract: asset.token,
  };
}
