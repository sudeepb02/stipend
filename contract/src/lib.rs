pub mod eip3009;
pub mod hex;

use eip3009::{TokenDomain, TransferArgs};
use near_sdk::{AccountId, Gas, NearToken, Promise, env, near, require, serde_json};

// MPC signer on NEAR testnet and its secp256k1 key domain
const MPC_SIGNER_ID: &str = "v1.signer-prod.testnet";
const SECP256K1_DOMAIN_ID: u32 = 0;
// The MPC contract requires at least 1 yoctoNEAR and 10 Tgas
const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const MPC_SIGN_GAS: Gas = Gas::from_tgas(30);
// USDC on Base Sepolia
const USDC_ADDRESS: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;

// Arguments of the MPC contract's sign method
#[near(serializers = [json])]
struct SignArgs {
    request: SignRequest,
}

#[near(serializers = [json])]
struct SignRequest {
    payload_v2: SignPayload,
    path: String,
    domain_id: u32,
}

#[near(serializers = [json])]
enum SignPayload {
    Ecdsa(String),
}

// Stipend contract state
#[near(contract_state)]
#[derive(Default)]
pub struct Stipend {}

#[near]
impl Stipend {
    // Returns the contract name, used as a liveness check
    pub fn ping(&self) -> String {
        "stipend".to_string()
    }

    // Asks the MPC network to sign a USDC transfer from the address of a wallet path
    pub fn sign_transfer(&mut self, path: String, transfer: TransferArgs) -> Promise {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the contract account can request signatures"
        );
        let digest = eip3009::transfer_digest(&base_sepolia_usdc(), &transfer.parse());
        let sign_args = SignArgs {
            request: SignRequest {
                payload_v2: SignPayload::Ecdsa(hex::encode(&digest)),
                path,
                domain_id: SECP256K1_DOMAIN_ID,
            },
        };
        let mpc_signer: AccountId = MPC_SIGNER_ID.parse().unwrap();
        Promise::new(mpc_signer).function_call(
            "sign".to_string(),
            serde_json::to_vec(&sign_args).unwrap(),
            MPC_SIGN_DEPOSIT,
            MPC_SIGN_GAS,
        )
    }
}

fn base_sepolia_usdc() -> TokenDomain {
    TokenDomain {
        name: "USDC".to_string(),
        version: "2".to_string(),
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        token: hex::decode_fixed(USDC_ADDRESS).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::{U64, U128};
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::Value;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
    use near_sdk::testing_env;

    const CONTRACT_ID: &str = "stipend.testnet";

    fn called_by(caller: &str) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(CONTRACT_ID.parse().unwrap())
                .predecessor_account_id(caller.parse().unwrap())
                .build()
        );
    }

    fn sample_transfer() -> TransferArgs {
        TransferArgs {
            from: "0x90a9d41B34E0D076EB65D7A0D547f34d4beFECdF".to_string(),
            to: "0x9081F51AD866C6d4c6F7Ad758Dea7FC43a7649e6".to_string(),
            value: U128(10_000),
            valid_after: U64(0),
            valid_before: U64(1_794_560_000),
            nonce: "0x0102030405060708091011121314151617181920212223242526272829303132".to_string(),
        }
    }

    #[test]
    fn ping_returns_contract_name() {
        let contract = Stipend::default();
        assert_eq!(contract.ping(), "stipend");
    }

    #[test]
    fn sign_transfer_calls_mpc_with_the_transfer_digest() {
        called_by(CONTRACT_ID);
        let _ = Stipend::default().sign_transfer("budget/0".to_string(), sample_transfer());

        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), MPC_SIGNER_ID);
        let MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            prepaid_gas,
            ..
        } = &receipts[0].actions[0]
        else {
            panic!("expected a function call");
        };
        assert_eq!(method_name.as_slice(), b"sign");
        assert_eq!(*attached_deposit, MPC_SIGN_DEPOSIT);
        assert_eq!(*prepaid_gas, MPC_SIGN_GAS);

        let sent: Value = serde_json::from_slice(args).unwrap();
        // Digest of the same fields from viem hashTypedData
        assert_eq!(
            sent["request"]["payload_v2"]["Ecdsa"],
            "6e383c6419ff701e12ac63761147863c4c6aae757b78a42fa16fd02bfbd92168"
        );
        assert_eq!(sent["request"]["path"], "budget/0");
        assert_eq!(sent["request"]["domain_id"], 0);
    }

    #[test]
    #[should_panic(expected = "Only the contract account can request signatures")]
    fn sign_transfer_rejects_other_callers() {
        called_by("someone.testnet");
        let _ = Stipend::default().sign_transfer("budget/0".to_string(), sample_transfer());
    }

    #[test]
    #[should_panic(expected = "from must be 0x hex of 20 bytes")]
    fn sign_transfer_rejects_malformed_addresses() {
        called_by(CONTRACT_ID);
        let mut transfer = sample_transfer();
        transfer.from = "0x1234".to_string();
        let _ = Stipend::default().sign_transfer("budget/0".to_string(), transfer);
    }
}
