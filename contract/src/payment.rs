use near_sdk::json_types::{U64, U128};
use near_sdk::{env, near, require};

use crate::eip3009::TransferArgs;
use crate::{Stipend, StipendExt, block_time_sec, hex};

const MAX_RESOURCE_BYTES: usize = 512;
const MAX_PAGE_SIZE: u32 = 100;

// A seat's part of a budget, reserved at the per-agent cap on the seat's first payment
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Share {
    pub reserved: U128,
    pub spent: U128,
}

// A payment from a budget's pot, counted as spent once recorded
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Payment {
    pub seat_id: String,
    // Transfer fields as the session sent them
    pub from: String,
    pub to: String,
    pub value: U128,
    pub nonce: String,
    pub valid_before: U64,
    // URL the agent paid for, as the agent stated it
    pub resource: String,
    // Unix time in seconds when the payment was recorded
    pub created_at: U64,
}

impl Stipend {
    // Checks the payment rules for the calling session, then debits the seat's share and logs the
    // payment. Returns the payment's index in the budget's log.
    pub fn record_payment(
        &mut self,
        budget_id: u64,
        transfer: &TransferArgs,
        resource: String,
    ) -> u32 {
        let block_time = block_time_sec();
        let Some(session) = self.sessions.get(&env::predecessor_account_id()) else {
            env::panic_str("Caller has no session");
        };
        require!(session.is_live(block_time), "Session has expired");
        let Some(budget) = self.budgets.get_mut(&budget_id) else {
            env::panic_str("No budget with this id");
        };
        require!(budget.is_open(block_time), "Budget is closed or expired");
        require!(
            budget.job_id == session.job_id,
            "Session is for another job"
        );

        // A seat's first payment reserves its share, if the budget has room for one more
        let share = self
            .shares
            .entry((budget_id, session.seat_id.clone()))
            .or_default();
        if share.reserved.0 == 0 {
            let per_agent_cap = budget.limits.per_agent_cap.0;
            require!(
                budget.reserved_total.0 + per_agent_cap <= budget.limits.total.0,
                "Budget is full"
            );
            share.reserved = U128(per_agent_cap);
            budget.reserved_total = U128(budget.reserved_total.0 + per_agent_cap);
        }

        let fields = transfer.parse();
        require!(fields.value > 0, "Value must be above zero");
        require!(
            fields.value <= budget.limits.per_payment_max.0,
            "Value is above the per-payment max"
        );
        require!(
            share.spent.0 + fields.value <= share.reserved.0,
            "Value is above the seat's remaining share"
        );
        if let Some(payees) = &budget.payees {
            require!(
                payees
                    .iter()
                    .any(|payee| hex::decode_field::<20>(payee, "payee") == fields.to),
                "Payee is not on the budget's list"
            );
        }
        // The authorization must be usable now and expire within the payment window
        require!(
            fields.valid_after <= block_time,
            "Authorization is not valid yet"
        );
        require!(
            fields.valid_before > block_time,
            "Authorization has already expired"
        );
        require!(
            fields.valid_before <= block_time + u64::from(self.config.max_window_sec),
            "Authorization window is longer than the limit"
        );
        require!(
            resource.len() <= MAX_RESOURCE_BYTES,
            "Resource is longer than 512 bytes"
        );

        share.spent = U128(share.spent.0 + fields.value);
        budget.spent_total = U128(budget.spent_total.0 + fields.value);
        let payment_index = budget.payment_count;
        budget.payment_count += 1;
        let payment = Payment {
            seat_id: session.seat_id.clone(),
            from: transfer.from.clone(),
            to: transfer.to.clone(),
            value: transfer.value,
            nonce: transfer.nonce.clone(),
            valid_before: transfer.valid_before,
            resource,
            created_at: U64(block_time),
        };
        self.payments.insert((budget_id, payment_index), payment);
        payment_index
    }
}

#[near]
impl Stipend {
    pub fn get_share(&self, budget_id: U64, seat_id: String) -> Option<Share> {
        self.shares.get(&(budget_id.0, seat_id)).cloned()
    }

    // Payments of a budget starting at from_index, at most 100 per call
    pub fn get_payments(&self, budget_id: U64, from_index: u32, limit: u32) -> Vec<Payment> {
        let Some(budget) = self.budgets.get(&budget_id.0) else {
            return Vec::new();
        };
        let end_index = from_index
            .saturating_add(limit.min(MAX_PAGE_SIZE))
            .min(budget.payment_count);
        (from_index..end_index)
            .filter_map(|payment_index| self.payments.get(&(budget_id.0, payment_index)).cloned())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::Budget;
    use crate::testing::{
        AGENT_ID, BLOCK_TIME_SEC, FUNDER_ID, JOB_ID, NO_DEPOSIT, ONE_YOCTO, ORACLE_ID, PAYEE,
        SEAT_ID, STORAGE_DEPOSIT, call_as, call_at, contract_with_usdc, create_budget,
        sample_budget,
    };

    const POT: &str = "0x90a9d41B34E0D076EB65D7A0D547f34d4beFECdF";
    const NONCE: &str = "0x0102030405060708091011121314151617181920212223242526272829303132";
    const RESOURCE: &str = "http://localhost:4021/prices/coingecko:near";
    const SESSION_SEC: u64 = 3_600;
    const PAYMENT_VALUE: u128 = 10_000;

    // Contract with the budget as budget 0 and AGENT_ID on SEAT_ID for JOB_ID, called next by AGENT_ID
    fn contract_with_agent(budget: Budget) -> Stipend {
        let mut contract = contract_with_usdc();
        call_as(FUNDER_ID, STORAGE_DEPOSIT);
        create_budget(&mut contract, budget);
        assign(&mut contract, AGENT_ID, SEAT_ID, JOB_ID);
        call_as(AGENT_ID, NO_DEPOSIT);
        contract
    }

    fn assign(contract: &mut Stipend, session_account: &str, seat_id: &str, job_id: &str) {
        call_as(ORACLE_ID, ONE_YOCTO);
        contract.assign(
            job_id.to_string(),
            seat_id.to_string(),
            session_account.parse().unwrap(),
            U64(BLOCK_TIME_SEC + SESSION_SEC),
        );
    }

    // Transfer from the pot to PAYEE, valid for 5 minutes
    fn transfer(value: u128) -> TransferArgs {
        TransferArgs {
            from: POT.to_string(),
            to: PAYEE.to_string(),
            value: U128(value),
            valid_after: U64(0),
            valid_before: U64(BLOCK_TIME_SEC + 300),
            nonce: NONCE.to_string(),
        }
    }

    // Records a payment from budget 0 in the current call context
    fn pay(contract: &mut Stipend, transfer: TransferArgs) -> u32 {
        contract.record_payment(0, &transfer, RESOURCE.to_string())
    }

    fn seat_share(contract: &Stipend, seat_id: &str) -> Option<Share> {
        contract.get_share(U64(0), seat_id.to_string())
    }

    #[test]
    fn record_payment_debits_the_share_and_logs_the_payment() {
        let mut contract = contract_with_agent(sample_budget());
        assert_eq!(pay(&mut contract, transfer(PAYMENT_VALUE)), 0);

        let expected_share = Share {
            reserved: U128(250_000),
            spent: U128(PAYMENT_VALUE),
        };
        assert_eq!(seat_share(&contract, SEAT_ID), Some(expected_share));
        let budget = contract.get_budget(U64(0)).unwrap();
        assert_eq!(budget.reserved_total, U128(250_000));
        assert_eq!(budget.spent_total, U128(PAYMENT_VALUE));
        assert_eq!(budget.payment_count, 1);
        let expected_payment = Payment {
            seat_id: SEAT_ID.to_string(),
            from: POT.to_string(),
            to: PAYEE.to_string(),
            value: U128(PAYMENT_VALUE),
            nonce: NONCE.to_string(),
            valid_before: U64(BLOCK_TIME_SEC + 300),
            resource: RESOURCE.to_string(),
            created_at: U64(BLOCK_TIME_SEC),
        };
        assert_eq!(contract.get_payments(U64(0), 0, 10), vec![expected_payment]);
    }

    #[test]
    fn record_payment_reserves_a_share_once_per_seat() {
        let mut contract = contract_with_agent(sample_budget());
        pay(&mut contract, transfer(PAYMENT_VALUE));
        pay(&mut contract, transfer(PAYMENT_VALUE));
        assign(&mut contract, "agent-two.testnet", "8", JOB_ID);
        call_as("agent-two.testnet", NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));

        assert_eq!(seat_share(&contract, SEAT_ID).unwrap().spent, U128(20_000));
        assert_eq!(seat_share(&contract, "8").unwrap().reserved, U128(250_000));
        let budget = contract.get_budget(U64(0)).unwrap();
        assert_eq!(budget.reserved_total, U128(500_000));
        assert_eq!(budget.spent_total, U128(30_000));
        assert_eq!(budget.payment_count, 3);
    }

    #[test]
    #[should_panic(expected = "Budget is full")]
    fn record_payment_rejects_a_seat_when_the_budget_is_full() {
        let mut contract = contract_with_agent(sample_budget());
        pay(&mut contract, transfer(PAYMENT_VALUE));
        assign(&mut contract, "agent-two.testnet", "8", JOB_ID);
        call_as("agent-two.testnet", NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));
        assign(&mut contract, "agent-three.testnet", "9", JOB_ID);
        call_as("agent-three.testnet", NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    #[should_panic(expected = "Payee is not on the budget's list")]
    fn record_payment_rejects_a_payee_not_on_the_list() {
        let mut contract = contract_with_agent(sample_budget());
        let mut other_payee = transfer(PAYMENT_VALUE);
        other_payee.to = POT.to_string();
        pay(&mut contract, other_payee);
    }

    #[test]
    fn record_payment_accepts_any_payee_without_a_list() {
        let mut budget = sample_budget();
        budget.payees = None;
        let mut contract = contract_with_agent(budget);
        let mut other_payee = transfer(PAYMENT_VALUE);
        other_payee.to = POT.to_string();
        pay(&mut contract, other_payee);
        assert_eq!(contract.get_payments(U64(0), 0, 10)[0].to, POT);
    }

    #[test]
    #[should_panic(expected = "Value is above the per-payment max")]
    fn record_payment_rejects_a_value_above_the_payment_max() {
        let mut contract = contract_with_agent(sample_budget());
        pay(&mut contract, transfer(PAYMENT_VALUE + 1));
    }

    #[test]
    #[should_panic(expected = "Value is above the seat's remaining share")]
    fn record_payment_rejects_a_value_above_the_remaining_share() {
        let mut budget = sample_budget();
        budget.limits.per_agent_cap = U128(15_000);
        let mut contract = contract_with_agent(budget);
        pay(&mut contract, transfer(10_000));
        pay(&mut contract, transfer(5_000));
        pay(&mut contract, transfer(1));
    }

    #[test]
    #[should_panic(expected = "Value must be above zero")]
    fn record_payment_rejects_a_zero_value() {
        let mut contract = contract_with_agent(sample_budget());
        pay(&mut contract, transfer(0));
    }

    #[test]
    #[should_panic(expected = "Caller has no session")]
    fn record_payment_rejects_a_caller_without_a_session() {
        let mut contract = contract_with_agent(sample_budget());
        call_as("stranger.testnet", NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    #[should_panic(expected = "Session has expired")]
    fn record_payment_rejects_an_expired_session() {
        let mut contract = contract_with_agent(sample_budget());
        call_at(AGENT_ID, NO_DEPOSIT, BLOCK_TIME_SEC + SESSION_SEC);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    #[should_panic(expected = "Budget is closed or expired")]
    fn record_payment_rejects_a_closed_budget() {
        let mut contract = contract_with_agent(sample_budget());
        call_as(FUNDER_ID, ONE_YOCTO);
        contract.close_budget(U64(0));
        call_as(AGENT_ID, NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    #[should_panic(expected = "Budget is closed or expired")]
    fn record_payment_rejects_an_expired_budget() {
        let mut budget = sample_budget();
        budget.expires_at = U64(BLOCK_TIME_SEC + 100);
        let mut contract = contract_with_agent(budget);
        call_at(AGENT_ID, NO_DEPOSIT, BLOCK_TIME_SEC + 100);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    #[should_panic(expected = "Session is for another job")]
    fn record_payment_rejects_a_session_for_another_job() {
        let mut contract = contract_with_agent(sample_budget());
        assign(&mut contract, AGENT_ID, SEAT_ID, "job-2");
        call_as(AGENT_ID, NO_DEPOSIT);
        pay(&mut contract, transfer(PAYMENT_VALUE));
    }

    #[test]
    fn record_payment_accepts_the_longest_window() {
        let mut contract = contract_with_agent(sample_budget());
        let mut longest_window = transfer(PAYMENT_VALUE);
        longest_window.valid_before = U64(BLOCK_TIME_SEC + 900);
        assert_eq!(pay(&mut contract, longest_window), 0);
    }

    #[test]
    #[should_panic(expected = "Authorization window is longer than the limit")]
    fn record_payment_rejects_a_window_over_the_limit() {
        let mut contract = contract_with_agent(sample_budget());
        let mut long_window = transfer(PAYMENT_VALUE);
        long_window.valid_before = U64(BLOCK_TIME_SEC + 901);
        pay(&mut contract, long_window);
    }

    #[test]
    #[should_panic(expected = "Authorization is not valid yet")]
    fn record_payment_rejects_an_authorization_not_valid_yet() {
        let mut contract = contract_with_agent(sample_budget());
        let mut later_start = transfer(PAYMENT_VALUE);
        later_start.valid_after = U64(BLOCK_TIME_SEC + 1);
        pay(&mut contract, later_start);
    }

    #[test]
    #[should_panic(expected = "Authorization has already expired")]
    fn record_payment_rejects_an_expired_authorization() {
        let mut contract = contract_with_agent(sample_budget());
        let mut expired = transfer(PAYMENT_VALUE);
        expired.valid_before = U64(BLOCK_TIME_SEC);
        pay(&mut contract, expired);
    }

    #[test]
    #[should_panic(expected = "Resource is longer than 512 bytes")]
    fn record_payment_rejects_a_long_resource() {
        let mut contract = contract_with_agent(sample_budget());
        contract.record_payment(0, &transfer(PAYMENT_VALUE), "a".repeat(513));
    }

    #[test]
    #[should_panic(expected = "No budget with this id")]
    fn record_payment_rejects_an_unknown_budget() {
        let mut contract = contract_with_agent(sample_budget());
        contract.record_payment(1, &transfer(PAYMENT_VALUE), RESOURCE.to_string());
    }

    #[test]
    fn get_payments_returns_a_page_of_the_log() {
        let mut contract = contract_with_agent(sample_budget());
        for value in [1_000, 2_000, 3_000] {
            pay(&mut contract, transfer(value));
        }
        let page = contract.get_payments(U64(0), 1, 1);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].value, U128(2_000));
        assert_eq!(contract.get_payments(U64(0), 0, 10).len(), 3);
        assert!(contract.get_payments(U64(0), 3, 10).is_empty());
        assert!(contract.get_payments(U64(1), 0, 10).is_empty());
    }

    #[test]
    fn get_share_returns_none_before_the_first_payment() {
        let contract = contract_with_agent(sample_budget());
        assert_eq!(seat_share(&contract, SEAT_ID), None);
    }
}
