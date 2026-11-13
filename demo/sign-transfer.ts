// Asks the contract for an MPC signature on a test USDC transfer and checks it recovers to the pot
import { randomBytes } from "node:crypto";
import { authorizationTypes } from "@x402/evm";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { deriveEvmAddress } from "../sdk/address.ts";
import { BASE_SEPOLIA_USDC, signTransfer } from "../sdk/sign-transfer.ts";

const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const PAYMENT_VALUE = 10_000n;
const AUTHORIZATION_TIMEOUT_SECONDS = 300;

// Usage: npm run sign-transfer -- [path]
async function main(): Promise<void> {
  const path = process.argv[2] ?? "budget/0";
  const { NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, STIPEND_CONTRACT_KEY } = process.env;
  const { PAID_API_PAY_TO } = process.env;
  if (!NEAR_RPC_URL || !NEAR_SIGNER_ID || !STIPEND_CONTRACT_ID || !STIPEND_CONTRACT_KEY) {
    throw new Error("Set NEAR_RPC_URL, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID and STIPEND_CONTRACT_KEY in .env");
  }
  if (!PAID_API_PAY_TO) {
    throw new Error("Set PAID_API_PAY_TO in .env");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const contractAccount = new Account(STIPEND_CONTRACT_ID, provider, STIPEND_CONTRACT_KEY as KeyPairString);
  const potAddress = await deriveEvmAddress(provider, NEAR_SIGNER_ID, STIPEND_CONTRACT_ID, path);

  const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TIMEOUT_SECONDS);
  const nonce: Hex = `0x${randomBytes(32).toString("hex")}`;
  const transfer = {
    from: potAddress,
    to: PAID_API_PAY_TO,
    value: PAYMENT_VALUE.toString(),
    valid_after: "0",
    valid_before: validBefore.toString(),
    nonce,
  };

  const { signature, transactionHash } = await signTransfer(contractAccount, STIPEND_CONTRACT_ID, path, transfer);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${transactionHash}`);
  const recoveredAddress = await recoverTypedDataAddress({
    domain: BASE_SEPOLIA_USDC,
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: potAddress,
      to: PAID_API_PAY_TO as Address,
      value: PAYMENT_VALUE,
      validAfter: 0n,
      validBefore,
      nonce,
    },
    signature,
  });
  console.log(`Signature: ${signature}`);
  console.log(`Recovered ${recoveredAddress}, pot ${potAddress}: ${recoveredAddress === potAddress ? "match" : "MISMATCH"}`);
}

await main();
