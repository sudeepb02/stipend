// Shared setup for unit tests
use near_sdk::json_types::{U64, U128};
use near_sdk::mock::{MockAction, Receipt};
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{Gas, NearToken, testing_env};

use crate::Stipend;
use crate::asset::Asset;
use crate::budget::{Budget, BudgetLimits};
use crate::mpc::{AffinePoint, MpcSignature, Scalar};

pub const CONTRACT_ID: &str = "stipend.testnet";
pub const ORACLE_ID: &str = "oracle.testnet";
pub const MPC_SIGNER_ID: &str = "v1.signer-prod.testnet";
pub const FUNDER_ID: &str = "funder.testnet";
pub const AGENT_ID: &str = "agent.testnet";
pub const USDC_ASSET_ID: &str = "usdc-base-sepolia";
pub const JOB_ID: &str = "job-1";
pub const SEAT_ID: &str = "7";
pub const PAYEE: &str = "0x9081F51AD866C6d4c6F7Ad758Dea7FC43a7649e6";
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// More than a budget needs for storage
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(100);
// Block time of test calls unless a test sets another, in Unix seconds
pub const BLOCK_TIME_SEC: u64 = 1_794_500_000;

// Sets the caller and the attached deposit for the next contract call
pub fn call_as(caller: &str, deposit: NearToken) {
    call_at(caller, deposit, BLOCK_TIME_SEC);
}

// Sets the caller, the attached deposit and the block time for the next contract call
pub fn call_at(caller: &str, deposit: NearToken, block_time: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT_ID.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .block_timestamp(block_time * 1_000_000_000)
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

// Contract with USDC on Base Sepolia registered by the owner
pub fn contract_with_usdc() -> Stipend {
    let mut contract = new_contract();
    call_as(CONTRACT_ID, ONE_YOCTO);
    contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
    contract
}

// 0.5 USDC for JOB_ID, at most 0.25 per agent and 0.01 per payment to PAYEE, open for a day
pub fn sample_budget() -> Budget {
    Budget {
        job_id: JOB_ID.to_string(),
        funder: FUNDER_ID.parse().unwrap(),
        asset_id: USDC_ASSET_ID.to_string(),
        limits: BudgetLimits {
            total: U128(500_000),
            per_agent_cap: U128(250_000),
            per_payment_max: U128(10_000),
        },
        payees: Some(vec![PAYEE.to_string()]),
        expires_at: U64(BLOCK_TIME_SEC + 86_400),
        closed_at: None,
        reserved_total: U128(0),
        spent_total: U128(0),
        payment_count: 0,
    }
}

// Calls create_task_budget with the fields of a budget
pub fn create_budget(contract: &mut Stipend, budget: Budget) -> U64 {
    contract.create_task_budget(
        budget.job_id,
        budget.asset_id,
        budget.limits,
        budget.payees,
        budget.expires_at,
    )
}

// Method name, JSON arguments, deposit and gas of a receipt's function call
pub fn function_call(receipt: &Receipt) -> (String, Value, NearToken, Gas) {
    let MockAction::FunctionCallWeight {
        method_name,
        args,
        attached_deposit,
        prepaid_gas,
        ..
    } = &receipt.actions[0]
    else {
        panic!("expected a function call");
    };
    let method = String::from_utf8(method_name.clone()).unwrap();
    (
        method,
        serde_json::from_slice(args).unwrap(),
        *attached_deposit,
        *prepaid_gas,
    )
}

// Receipt sent to an account
pub fn receipt_to<'a>(receipts: &'a [Receipt], receiver: &str) -> &'a Receipt {
    receipts
        .iter()
        .find(|receipt| receipt.receiver_id.as_str() == receiver)
        .unwrap()
}

// MPC sign reply with r = 0x1111.. and s = 0x2222..
pub fn sample_reply() -> MpcSignature {
    MpcSignature {
        big_r: AffinePoint {
            affine_point: format!("03{}", "11".repeat(32)),
        },
        s: Scalar {
            scalar: "22".repeat(32),
        },
        recovery_id: 0,
    }
}
