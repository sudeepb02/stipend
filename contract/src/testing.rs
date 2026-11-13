// Shared setup for unit tests
use near_sdk::json_types::U64;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{NearToken, testing_env};

use crate::Stipend;
use crate::asset::Asset;

pub const CONTRACT_ID: &str = "stipend.testnet";
pub const ORACLE_ID: &str = "oracle.testnet";
pub const MPC_SIGNER_ID: &str = "v1.signer-prod.testnet";
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

// Sets the caller and the attached deposit for the next contract call
pub fn call_as(caller: &str, deposit: NearToken) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT_ID.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .build()
    );
}

// Calls new with the test accounts, with the owner being the contract account
pub fn init_contract() -> Stipend {
    Stipend::new(
        CONTRACT_ID.parse().unwrap(),
        ORACLE_ID.parse().unwrap(),
        MPC_SIGNER_ID.parse().unwrap(),
    )
}

// Contract initialized by its own account
pub fn new_contract() -> Stipend {
    call_as(CONTRACT_ID, NO_DEPOSIT);
    init_contract()
}

// USDC on Base Sepolia
pub fn usdc_asset() -> Asset {
    Asset {
        chain_id: U64(84532),
        token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e".to_string(),
        name: "USDC".to_string(),
        version: "2".to_string(),
        decimals: 6,
    }
}
