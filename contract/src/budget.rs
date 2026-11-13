use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, assert_one_yocto, env, near, require};

use crate::{Stipend, StipendExt, block_time_sec, charge_storage, hex};

const MAX_PAYEES: usize = 10;

// Derivation path of the key that controls a budget's pot
pub fn budget_path(budget_id: u64) -> String {
    format!("budget/{budget_id}")
}

// Funds for one IMD job, paid from the pot at path budget/<id>
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Budget {
    pub job_id: String,
    // Account that created the budget
    pub funder: AccountId,
    pub asset_id: String,
    pub limits: BudgetLimits,
    // EVM addresses the budget may pay, or any address when absent
    pub payees: Option<Vec<String>>,
    // Unix time in seconds when the budget stops paying
    pub expires_at: U64,
    // Unix time in seconds when the funder closed the budget early
    pub closed_at: Option<U64>,
    // Sum of the shares reserved for seats
    pub reserved_total: U128,
    // Sum of the payments signed for all seats
    pub spent_total: U128,
    // Number of payments in the budget's log
    pub payment_count: u32,
}

// Spending limits in the token's smallest unit
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetLimits {
    pub total: U128,
    pub per_agent_cap: U128,
    pub per_payment_max: U128,
}

impl Budget {
    // True until the budget expires or its funder closes it
    pub fn is_open(&self, block_time: u64) -> bool {
        self.closed_at.is_none() && block_time < self.expires_at.0
    }
}

#[near]
impl Stipend {
    // Opens a budget for a job with the caller as funder, who pays for the storage it uses
    #[payable]
    pub fn create_task_budget(
        &mut self,
        job_id: String,
        asset_id: String,
        limits: BudgetLimits,
        payees: Option<Vec<String>>,
        expires_at: U64,
    ) -> U64 {
        require!(
            self.assets.contains_key(&asset_id),
            "Asset is not registered"
        );
        require!(limits.per_payment_max.0 > 0, "Amounts must be above zero");
        require!(
            limits.per_payment_max.0 <= limits.per_agent_cap.0,
            "Per-payment max is above the per-agent cap"
        );
        require!(
            limits.per_agent_cap.0 <= limits.total.0,
            "Per-agent cap is above the total"
        );
        require!(
            expires_at.0 > block_time_sec(),
            "Budget must end in the future"
        );
        if let Some(payees) = &payees {
            require!(!payees.is_empty(), "Payee list is empty");
            require!(payees.len() <= MAX_PAYEES, "Too many payees");
            for payee in payees {
                hex::decode_field::<20>(payee, "payee");
            }
        }

        let storage_before = env::storage_usage();
        let budget_id = self.next_budget_id;
        self.next_budget_id += 1;
        self.job_budgets
            .entry(job_id.clone())
            .or_default()
            .push(budget_id);
        let budget = Budget {
            job_id,
            funder: env::predecessor_account_id(),
            asset_id,
            limits,
            payees,
            expires_at,
            closed_at: None,
            reserved_total: U128(0),
            spent_total: U128(0),
            payment_count: 0,
        };
        self.budgets.insert(budget_id, budget);
        // Writes the new entries now, so their storage can be measured
        self.budgets.flush();
        self.job_budgets.flush();
        charge_storage(env::storage_usage() - storage_before);
        U64(budget_id)
    }

    // Stops new payments before the budget expires
    #[payable]
    pub fn close_budget(&mut self, budget_id: U64) {
        assert_one_yocto();
        let block_time = block_time_sec();
        let Some(budget) = self.budgets.get_mut(&budget_id.0) else {
            env::panic_str("No budget with this id");
        };
        require!(
            env::predecessor_account_id() == budget.funder,
            "Only the funder can close the budget"
        );
        require!(
            budget.is_open(block_time),
            "Budget is already closed or expired"
        );
        budget.closed_at = Some(U64(block_time));
    }

    pub fn get_budget(&self, budget_id: U64) -> Option<Budget> {
        self.budgets.get(&budget_id.0).cloned()
    }

    pub fn get_budgets_for_job(&self, job_id: String) -> Vec<U64> {
        self.job_budgets
            .get(&job_id)
            .map(|budget_ids| budget_ids.iter().map(|&budget_id| U64(budget_id)).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{
        BLOCK_TIME_SEC, FUNDER_ID, NO_DEPOSIT, ONE_YOCTO, PAYEE, STORAGE_DEPOSIT, call_as,
        contract_with_usdc, create_budget, sample_budget,
    };
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;

    // Contract with USDC registered, whose next calls come from the funder with a storage deposit
    fn contract_for_funder() -> Stipend {
        let contract = contract_with_usdc();
        call_as(FUNDER_ID, STORAGE_DEPOSIT);
        contract
    }

    // Funder's contract with the sample budget created and the next call from the funder with 1 yoctoNEAR
    fn contract_with_budget() -> Stipend {
        let mut contract = contract_for_funder();
        create_budget(&mut contract, sample_budget());
        call_as(FUNDER_ID, ONE_YOCTO);
        contract
    }

    #[test]
    fn create_task_budget_stores_the_budget() {
        let mut contract = contract_for_funder();
        assert_eq!(create_budget(&mut contract, sample_budget()), U64(0));
        assert_eq!(contract.get_budget(U64(0)), Some(sample_budget()));
    }

    #[test]
    fn create_task_budget_accepts_any_payee_without_a_list() {
        let mut contract = contract_for_funder();
        let mut budget = sample_budget();
        budget.payees = None;
        create_budget(&mut contract, budget.clone());
        assert_eq!(contract.get_budget(U64(0)), Some(budget));
    }

    #[test]
    fn create_task_budget_lists_budgets_by_job() {
        let mut contract = contract_for_funder();
        create_budget(&mut contract, sample_budget());
        let mut other_job = sample_budget();
        other_job.job_id = "job-2".to_string();
        create_budget(&mut contract, other_job);
        create_budget(&mut contract, sample_budget());
        assert_eq!(
            contract.get_budgets_for_job("job-1".to_string()),
            vec![U64(0), U64(2)]
        );
        assert_eq!(
            contract.get_budgets_for_job("job-2".to_string()),
            vec![U64(1)]
        );
        assert!(contract.get_budgets_for_job("job-3".to_string()).is_empty());
    }

    #[test]
    fn create_task_budget_refunds_the_unused_deposit() {
        let mut contract = contract_for_funder();
        let storage_before = env::storage_usage();
        create_budget(&mut contract, sample_budget());
        let bytes_used = env::storage_usage() - storage_before;
        let storage_cost = env::storage_byte_cost().saturating_mul(u128::from(bytes_used));

        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id.as_str(), FUNDER_ID);
        let MockAction::Transfer { deposit, .. } = receipts[0].actions[0] else {
            panic!("expected a transfer");
        };
        assert!(bytes_used > 0);
        assert_eq!(deposit, STORAGE_DEPOSIT.saturating_sub(storage_cost));
    }

    #[test]
    #[should_panic(expected = "yoctoNEAR for storage")]
    fn create_task_budget_requires_a_storage_deposit() {
        let mut contract = contract_with_usdc();
        call_as(FUNDER_ID, ONE_YOCTO);
        create_budget(&mut contract, sample_budget());
    }

    #[test]
    #[should_panic(expected = "Asset is not registered")]
    fn create_task_budget_rejects_an_unknown_asset() {
        let mut budget = sample_budget();
        budget.asset_id = "unknown".to_string();
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Amounts must be above zero")]
    fn create_task_budget_rejects_zero_amounts() {
        let mut budget = sample_budget();
        budget.limits.per_payment_max = U128(0);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Per-payment max is above the per-agent cap")]
    fn create_task_budget_rejects_a_payment_max_above_the_cap() {
        let mut budget = sample_budget();
        budget.limits.per_payment_max = U128(250_001);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Per-agent cap is above the total")]
    fn create_task_budget_rejects_a_cap_above_the_total() {
        let mut budget = sample_budget();
        budget.limits.per_agent_cap = U128(500_001);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Budget must end in the future")]
    fn create_task_budget_rejects_a_past_end() {
        let mut budget = sample_budget();
        budget.expires_at = U64(BLOCK_TIME_SEC);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Payee list is empty")]
    fn create_task_budget_rejects_an_empty_payee_list() {
        let mut budget = sample_budget();
        budget.payees = Some(vec![]);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "Too many payees")]
    fn create_task_budget_rejects_too_many_payees() {
        let mut budget = sample_budget();
        budget.payees = Some(vec![PAYEE.to_string(); MAX_PAYEES + 1]);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    #[should_panic(expected = "payee must be 0x hex of 20 bytes")]
    fn create_task_budget_rejects_a_malformed_payee() {
        let mut budget = sample_budget();
        budget.payees = Some(vec!["0x9081F51A".to_string()]);
        create_budget(&mut contract_for_funder(), budget);
    }

    #[test]
    fn close_budget_stops_the_budget() {
        let mut contract = contract_with_budget();
        contract.close_budget(U64(0));
        let budget = contract.get_budget(U64(0)).unwrap();
        assert_eq!(budget.closed_at, Some(U64(BLOCK_TIME_SEC)));
        assert!(!budget.is_open(BLOCK_TIME_SEC));
    }

    #[test]
    #[should_panic(expected = "Only the funder can close the budget")]
    fn close_budget_rejects_other_callers() {
        let mut contract = contract_with_budget();
        call_as("someone.testnet", ONE_YOCTO);
        contract.close_budget(U64(0));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn close_budget_requires_one_yocto() {
        let mut contract = contract_with_budget();
        call_as(FUNDER_ID, NO_DEPOSIT);
        contract.close_budget(U64(0));
    }

    #[test]
    #[should_panic(expected = "Budget is already closed or expired")]
    fn close_budget_rejects_a_closed_budget() {
        let mut contract = contract_with_budget();
        contract.close_budget(U64(0));
        contract.close_budget(U64(0));
    }

    #[test]
    #[should_panic(expected = "No budget with this id")]
    fn close_budget_rejects_an_unknown_id() {
        let mut contract = contract_with_budget();
        contract.close_budget(U64(1));
    }

    #[test]
    fn get_budget_returns_none_for_an_unknown_id() {
        assert_eq!(contract_with_usdc().get_budget(U64(0)), None);
    }

    #[test]
    fn budget_is_open_until_it_expires() {
        let budget = sample_budget();
        assert!(budget.is_open(budget.expires_at.0 - 1));
        assert!(!budget.is_open(budget.expires_at.0));
    }
}
