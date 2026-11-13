// x402 signer that pays from the address of a wallet path, with signatures from the Stipend contract
import type { ClientEvmSigner } from "@x402/evm";
import type { Account } from "near-api-js";
import type { Address } from "viem";
import { BASE_SEPOLIA_USDC, signTransfer } from "./sign-transfer.ts";

export type X402SignerOptions = {
  // NEAR account that calls the contract
  account: Account;
  contractId: string;
  // Wallet path, such as budget/0, and its EVM address
  path: string;
  address: Address;
  // Receives the hash of each NEAR transaction that signs a payment
  onSigned?: (transactionHash: string) => void;
};

// Plugs into ExactEvmScheme from @x402/evm, which asks for one signature per payment
export function createX402Signer(options: X402SignerOptions): ClientEvmSigner {
  const { account, contractId, path, address, onSigned } = options;
  return {
    address,
    async signTypedData({ domain, primaryType, message }) {
      // The contract signs only USDC transfers on Base Sepolia, so anything else fails before a transaction
      const isSupported =
        primaryType === "TransferWithAuthorization" &&
        domain.name === BASE_SEPOLIA_USDC.name &&
        domain.version === BASE_SEPOLIA_USDC.version &&
        Number(domain.chainId) === BASE_SEPOLIA_USDC.chainId &&
        String(domain.verifyingContract).toLowerCase() === BASE_SEPOLIA_USDC.verifyingContract.toLowerCase() &&
        String(message.from).toLowerCase() === address.toLowerCase();
      if (!isSupported) {
        throw new Error(`Only USDC transfers on Base Sepolia from ${address} can be signed`);
      }
      const { signature, transactionHash } = await signTransfer(account, contractId, path, {
        from: String(message.from),
        to: String(message.to),
        value: String(message.value),
        valid_after: String(message.validAfter),
        valid_before: String(message.validBefore),
        nonce: String(message.nonce),
      });
      onSigned?.(transactionHash);
      return signature;
    },
  };
}
