pub mod asset;
pub mod budget;
pub mod eip3009;
pub mod hex;
pub mod mpc;
pub mod payment;
pub mod session;
#[cfg(test)]
mod testing;

use asset::Asset;
use budget::Budget;
use near_sdk::state::ContractState;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, PanicOnDefault, Promise, assert_one_yocto, env, near, require};
use payment::{Payment, Share};
use session::Session;

// Longest validity of a signed payment, and longest agent session
const MAX_WINDOW_SEC: u32 = 900;
const MAX_SESSION_SEC: u32 = 21_600;

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
    budgets: LookupMap<u64, Budget>,
    // Budget ids of each job
    job_budgets: LookupMap<String, Vec<u64>>,
    next_budget_id: u64,
    // Share of each seat in a budget, by budget id and seat id
    shares: LookupMap<(u64, String), Share>,
    // Payment log, by budget id and index in the budget
    payments: LookupMap<(u64, u32), Payment>,
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
            budgets: LookupMap::new(b"b"),
            job_budgets: LookupMap::new(b"j"),
            next_budget_id: 0,
            shares: LookupMap::new(b"h"),
            payments: LookupMap::new(b"p"),
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

// Takes the storage cost from the attached deposit and refunds the rest to the caller
fn charge_storage(bytes_used: u64) {
    let storage_cost = env::storage_byte_cost().saturating_mul(u128::from(bytes_used));
    let deposit = env::attached_deposit();
    require!(
        deposit >= storage_cost,
        format!(
            "Attach at least {} yoctoNEAR for storage",
            storage_cost.as_yoctonear()
        )
    );
    let refund = deposit.saturating_sub(storage_cost);
    if !refund.is_zero() {
        Promise::new(env::predecessor_account_id())
            .transfer(refund)
            .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{
        CONTRACT_ID, MPC_SIGNER_ID, NO_DEPOSIT, ONE_YOCTO, ORACLE_ID, call_as, init_contract,
        new_contract,
    };

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
}
