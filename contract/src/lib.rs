pub mod asset;
pub mod eip3009;
pub mod hex;
pub mod session;
#[cfg(test)]
mod testing;

use asset::Asset;
use eip3009::{TokenDomain, TransferArgs};
use near_sdk::state::ContractState;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near, require,
    serde_json,
};
use session::Session;

// Secp256k1 key domain of the MPC signer
const SECP256K1_DOMAIN_ID: u32 = 0;
// The MPC contract requires at least 1 yoctoNEAR and 10 Tgas
const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const MPC_SIGN_GAS: Gas = Gas::from_tgas(30);
// Longest validity of a signed payment, and longest agent session
const MAX_WINDOW_SEC: u32 = 900;
const MAX_SESSION_SEC: u32 = 21_600;
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

// Accounts the contract trusts, and limits for payments and sessions
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Config {
    // Registers assets and sets the oracle
    pub owner: AccountId,
    // Control plane account that assigns agents to jobs
    pub oracle: AccountId,
    // MPC signer contract, such as v1.signer-prod.testnet
    pub mpc_signer_id: AccountId,
    pub max_window_sec: u32,
    pub max_session_sec: u32,
}

// Stipend contract state
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stipend {
    config: Config,
    assets: LookupMap<String, Asset>,
    sessions: LookupMap<AccountId, Session>,
}

#[near]
impl Stipend {
    // Runs once, called by the contract account on a new account or over an empty state
    #[init(ignore_state)]
    pub fn new(owner: AccountId, oracle: AccountId, mpc_signer_id: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the contract account can initialize"
        );
        require!(
            env::storage_read(Self::state_key()).is_none_or(|state| state.is_empty()),
            "Already initialized"
        );
        Self {
            config: Config {
                owner,
                oracle,
                mpc_signer_id,
                max_window_sec: MAX_WINDOW_SEC,
                max_session_sec: MAX_SESSION_SEC,
            },
            assets: LookupMap::new(b"a"),
            sessions: LookupMap::new(b"s"),
        }
    }

    // Returns the contract name, used as a liveness check
    pub fn ping(&self) -> String {
        "stipend".to_string()
    }

    // Replaces the control plane account
    #[payable]
    pub fn set_oracle(&mut self, oracle: AccountId) {
        assert_one_yocto();
        self.require_owner();
        self.config.oracle = oracle;
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
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
        Promise::new(self.config.mpc_signer_id.clone()).function_call(
            "sign".to_string(),
            serde_json::to_vec(&sign_args).unwrap(),
            MPC_SIGN_DEPOSIT,
            MPC_SIGN_GAS,
        )
    }
}

impl Stipend {
    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner,
            "Only the owner can call this method"
        );
    }

    fn require_oracle(&self) {
        require!(
            env::predecessor_account_id() == self.config.oracle,
            "Only the oracle can call this method"
        );
    }
}

// Current block time in Unix seconds, the unit EIP-3009 uses
fn block_time_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
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
    use crate::testing::{
        CONTRACT_ID, MPC_SIGNER_ID, NO_DEPOSIT, ONE_YOCTO, ORACLE_ID, call_as, init_contract,
        new_contract,
    };
    use near_sdk::json_types::{U64, U128};
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::Value;
    use near_sdk::test_utils::get_created_receipts;

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
    fn new_sets_accounts_and_limits() {
        let config = new_contract().get_config();
        assert_eq!(config.owner.as_str(), CONTRACT_ID);
        assert_eq!(config.oracle.as_str(), ORACLE_ID);
        assert_eq!(config.mpc_signer_id.as_str(), MPC_SIGNER_ID);
        assert_eq!(config.max_window_sec, 900);
        assert_eq!(config.max_session_sec, 21_600);
    }

    #[test]
    #[should_panic(expected = "Only the contract account can initialize")]
    fn new_rejects_other_callers() {
        call_as("someone.testnet", NO_DEPOSIT);
        init_contract();
    }

    #[test]
    fn new_accepts_an_empty_state() {
        call_as(CONTRACT_ID, NO_DEPOSIT);
        env::storage_write(Stipend::state_key(), &[]);
        assert_eq!(init_contract().get_config().owner.as_str(), CONTRACT_ID);
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn new_rejects_an_initialized_state() {
        new_contract().state_write();
        init_contract();
    }

    #[test]
    fn set_oracle_replaces_the_oracle() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, ONE_YOCTO);
        contract.set_oracle("new-oracle.testnet".parse().unwrap());
        assert_eq!(contract.get_config().oracle.as_str(), "new-oracle.testnet");
    }

    #[test]
    #[should_panic(expected = "Only the owner can call this method")]
    fn set_oracle_rejects_other_callers() {
        let mut contract = new_contract();
        call_as(ORACLE_ID, ONE_YOCTO);
        contract.set_oracle(ORACLE_ID.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn set_oracle_requires_one_yocto() {
        let mut contract = new_contract();
        contract.set_oracle("new-oracle.testnet".parse().unwrap());
    }

    #[test]
    fn ping_returns_contract_name() {
        assert_eq!(new_contract().ping(), "stipend");
    }

    #[test]
    fn sign_transfer_calls_mpc_with_the_transfer_digest() {
        let _ = new_contract().sign_transfer("budget/0".to_string(), sample_transfer());

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
        let mut contract = new_contract();
        call_as("someone.testnet", NO_DEPOSIT);
        let _ = contract.sign_transfer("budget/0".to_string(), sample_transfer());
    }

    #[test]
    #[should_panic(expected = "from must be 0x hex of 20 bytes")]
    fn sign_transfer_rejects_malformed_addresses() {
        let mut transfer = sample_transfer();
        transfer.from = "0x1234".to_string();
        let _ = new_contract().sign_transfer("budget/0".to_string(), transfer);
    }
}
