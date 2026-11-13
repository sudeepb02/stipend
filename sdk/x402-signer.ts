// x402 signer that pays from a Stipend budget's pot, with each signature from the contract's pay method
import type { ClientEvmSigner } from "@x402/evm";
import type { Account } from "near-api-js";
import type { Address } from "viem";
import type { TokenDomain } from "./budget.ts";
import { payFromBudget } from "./pay.ts";

export type X402SignerOptions = {
  // Session account that calls pay
  account: Account;
  contractId: string;
  budgetId: string;
  // EVM address of the budget's pot, and the domain of the token the budget pays in
  address: Address;
  domain: TokenDomain;
  // URL the payments are for, logged with each payment
  resource: string;
  // Receives the hash of each NEAR transaction that signs a payment
  onSigned?: (transactionHash: string) => void;
};

// Plugs into ExactEvmScheme from @x402/evm, which asks for one signature per payment
export function createX402Signer(options: X402SignerOptions): ClientEvmSigner {
  const { account, contractId, budgetId, address, domain: budgetDomain, resource, onSigned } = options;
  return {
    address,
    async signTypedData({ domain, primaryType, message }) {
      // The contract signs only transfers in the budget's token, so anything else fails before a transaction
      const isSupported =
        primaryType === "TransferWithAuthorization" &&
        domain.name === budgetDomain.name &&
        domain.version === budgetDomain.version &&
        Number(domain.chainId) === budgetDomain.chainId &&
        String(domain.verifyingContract).toLowerCase() === budgetDomain.verifyingContract.toLowerCase() &&
        String(message.from).toLowerCase() === address.toLowerCase();
      if (!isSupported) {
        throw new Error(
          `Only ${budgetDomain.name} transfers on chain ${budgetDomain.chainId} from ${address} can be signed`,
        );
      }
      const transfer = {
        from: String(message.from),
        to: String(message.to),
        value: String(message.value),
        valid_after: String(message.validAfter),
        valid_before: String(message.validBefore),
        nonce: String(message.nonce),
      };
      const { signature, transactionHash } = await payFromBudget(account, contractId, budgetId, transfer, resource);
      onSigned?.(transactionHash);
      return signature;
    },
  };
}
