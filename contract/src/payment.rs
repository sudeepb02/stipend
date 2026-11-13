use near_sdk::json_types::{U64, U128};
use near_sdk::{Promise, PromiseError, env, near, require};

use crate::budget::budget_path;
use crate::eip3009::{self, TransferArgs};
use crate::mpc::{self, MpcSignature};
use crate::refund::refund_nonce;
use crate::{Stipend, StipendExt, block_time_sec, charge_storage, hex};

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
    pub status: PaymentStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PaymentStatus {
    // Waiting for the MPC signature
    Pending,
    Signed,
    // Signing failed and the value went back to the seat's share
    Failed,
}

// NEP-297 events of the contract
#[near(event_json(standard = "stipend"))]
pub enum StipendEvent {
    // Result of signing a payment
    #[event_version("1.0.0")]
    Payment {
        budget_id: U64,
        payment_index: u32,
        seat_id: String,
        value: U128,
        status: PaymentStatus,
    },
    // Signed refund of a budget's leftover
    #[event_version("1.0.0")]
    Refund {
        budget_id: U64,
        to: String,
        value: U128,
    },
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
            fields.nonce != refund_nonce(budget_id),
            "Nonce is reserved for the budget's refund"
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
            status: PaymentStatus::Pending,
        };
        self.payments.insert((budget_id, payment_index), payment);
        payment_index
    }

    // EIP-712 hash of a transfer in the token of a budget
    pub fn budget_transfer_digest(&self, budget_id: u64, transfer: &TransferArgs) -> [u8; 32] {
        let budget = &self.budgets[&budget_id];
        let asset = &self.assets[&budget.asset_id];
        eip3009::transfer_digest(&asset.domain(), &transfer.parse())
    }
}

#[near]
impl Stipend {
    // Pays from a budget's pot for the calling session: after the payment rules pass, the MPC
    // network signs the transfer and the callback returns the EVM signature. The caller attaches
    // NEAR for the storage the payment uses and gets the rest back.
    #[payable]
    pub fn pay(&mut self, budget_id: U64, transfer: TransferArgs, resource: String) -> Promise {
        let storage_before = env::storage_usage();
        let payment_index = self.record_payment(budget_id.0, &transfer, resource);
        // Writes the changes now, so their storage can be measured
        self.budgets.flush();
        self.shares.flush();
        self.payments.flush();
        charge_storage(env::storage_usage() - storage_before);

        let digest = self.budget_transfer_digest(budget_id.0, &transfer);
        mpc::request_signature(
            self.config.mpc_signer_id.clone(),
            budget_path(budget_id.0),
            &digest,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::CALLBACK_GAS)
                .on_payment_signed(budget_id, payment_index),
        )
    }

    // Records the MPC result of a payment and returns its EVM signature. When signing failed it
    // credits the value back to the seat's share. The body never panics, so a credit-back is
    // never rolled back.
    #[private]
    pub fn on_payment_signed(
        &mut self,
        budget_id: U64,
        payment_index: u32,
        #[callback_result] result: Result<MpcSignature, PromiseError>,
    ) -> Option<String> {
        let payment = self.payments.get_mut(&(budget_id.0, payment_index))?;
        let evm_signature = match result {
            Ok(mpc_signature) => {
                payment.status = PaymentStatus::Signed;
                mpc_signature.to_evm_signature()
            }
            Err(PromiseError::Failed) => {
                payment.status = PaymentStatus::Failed;
                if let Some(share) = self.shares.get_mut(&(budget_id.0, payment.seat_id.clone())) {
                    share.spent = U128(share.spent.0.saturating_sub(payment.value.0));
                }
                if let Some(budget) = self.budgets.get_mut(&budget_id.0) {
                    budget.spent_total = U128(budget.spent_total.0.saturating_sub(payment.value.0));
                }
                None
            }
            // The MPC call succeeded with a reply too long to read, so a signature may exist
            Err(_) => {
                payment.status = PaymentStatus::Signed;
                None
            }
        };
        StipendEvent::Payment {
            budget_id,
            payment_index,
            seat_id: payment.seat_id.clone(),
            value: payment.value,
            status: payment.status,
        }
        .emit();
        evm_signature
    }

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
        AGENT_ID, BLOCK_TIME_SEC, CONTRACT_ID, FUNDER_ID, JOB_ID, MPC_SIGNER_ID, NO_DEPOSIT,
        ONE_YOCTO, ORACLE_ID, PAYEE, SEAT_ID, STORAGE_DEPOSIT, call_as, call_at,
        contract_with_usdc, create_budget, function_call, receipt_to, sample_budget, sample_reply,
        usdc_asset,
    };
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json;
    use near_sdk::test_utils::{get_created_receipts, get_logs};

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
            status: PaymentStatus::Pending,
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
    #[should_panic(expected = "Nonce is reserved for the budget's refund")]
    fn record_payment_rejects_the_refund_nonce() {
        let mut contract = contract_with_agent(sample_budget());
        let mut refund_nonce_payment = transfer(PAYMENT_VALUE);
        refund_nonce_payment.nonce = format!("0x{}", hex::encode(&refund_nonce(0)));
        pay(&mut contract, refund_nonce_payment);
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

    // Pays from budget 0 as the agent, attaching the storage deposit
    fn pay_as_agent(contract: &mut Stipend) {
        call_as(AGENT_ID, STORAGE_DEPOSIT);
        let _ = contract.pay(U64(0), transfer(PAYMENT_VALUE), RESOURCE.to_string());
    }

    // Contract after the agent's payment, called next by itself with the MPC result
    fn contract_waiting_for_signature() -> Stipend {
        let mut contract = contract_with_agent(sample_budget());
        pay_as_agent(&mut contract);
        call_as(CONTRACT_ID, NO_DEPOSIT);
        contract
    }

    fn payment_status(contract: &Stipend) -> PaymentStatus {
        contract.get_payments(U64(0), 0, 1)[0].status
    }

    #[test]
    fn pay_asks_the_mpc_signer_to_sign_for_the_budget_pot() {
        let mut contract = contract_with_agent(sample_budget());
        pay_as_agent(&mut contract);
        let receipts = get_created_receipts();

        let (method, args, deposit, gas) = function_call(receipt_to(&receipts, MPC_SIGNER_ID));
        let digest =
            eip3009::transfer_digest(&usdc_asset().domain(), &transfer(PAYMENT_VALUE).parse());
        assert_eq!(method, "sign");
        assert_eq!(args["request"]["payload_v2"]["Ecdsa"], hex::encode(&digest));
        assert_eq!(args["request"]["path"], "budget/0");
        assert_eq!(args["request"]["domain_id"], 0);
        assert_eq!((deposit, gas), (mpc::SIGN_DEPOSIT, mpc::SIGN_GAS));

        let (method, args, _, gas) = function_call(receipt_to(&receipts, CONTRACT_ID));
        assert_eq!(method, "on_payment_signed");
        assert_eq!(
            args,
            serde_json::json!({ "budget_id": "0", "payment_index": 0 })
        );
        assert_eq!(gas, mpc::CALLBACK_GAS);
        assert_eq!(payment_status(&contract), PaymentStatus::Pending);
    }

    #[test]
    fn pay_charges_the_payment_storage_and_refunds_the_rest() {
        let mut contract = contract_with_agent(sample_budget());
        call_as(AGENT_ID, STORAGE_DEPOSIT);
        let storage_before = env::storage_usage();
        let _ = contract.pay(U64(0), transfer(PAYMENT_VALUE), RESOURCE.to_string());
        let bytes_used = env::storage_usage() - storage_before;
        let storage_cost = env::storage_byte_cost().saturating_mul(u128::from(bytes_used));

        let receipts = get_created_receipts();
        let MockAction::Transfer { deposit, .. } = receipt_to(&receipts, AGENT_ID).actions[0]
        else {
            panic!("expected a transfer");
        };
        assert!(bytes_used > 0);
        assert_eq!(deposit, STORAGE_DEPOSIT.saturating_sub(storage_cost));
    }

    #[test]
    #[should_panic(expected = "yoctoNEAR for storage")]
    fn pay_requires_a_storage_deposit() {
        let mut contract = contract_with_agent(sample_budget());
        call_as(AGENT_ID, ONE_YOCTO);
        let _ = contract.pay(U64(0), transfer(PAYMENT_VALUE), RESOURCE.to_string());
    }

    #[test]
    #[should_panic(expected = "Caller has no session")]
    fn pay_applies_the_payment_rules() {
        let mut contract = contract_with_agent(sample_budget());
        call_as("stranger.testnet", STORAGE_DEPOSIT);
        let _ = contract.pay(U64(0), transfer(PAYMENT_VALUE), RESOURCE.to_string());
    }

    #[test]
    fn on_payment_signed_returns_the_evm_signature() {
        let mut contract = contract_waiting_for_signature();
        let evm_signature = contract.on_payment_signed(U64(0), 0, Ok(sample_reply()));
        assert_eq!(
            evm_signature,
            Some(format!("0x{}{}1b", "11".repeat(32), "22".repeat(32)))
        );
        assert_eq!(payment_status(&contract), PaymentStatus::Signed);
        assert_eq!(
            seat_share(&contract, SEAT_ID).unwrap().spent,
            U128(PAYMENT_VALUE)
        );
        assert_eq!(
            get_logs(),
            vec![
                r#"EVENT_JSON:{"standard":"stipend","version":"1.0.0","event":"payment","data":{"budget_id":"0","payment_index":0,"seat_id":"7","value":"10000","status":"Signed"}}"#
            ]
        );
    }

    #[test]
    fn on_payment_signed_credits_the_value_back_when_signing_fails() {
        let mut contract = contract_waiting_for_signature();
        let evm_signature = contract.on_payment_signed(U64(0), 0, Err(PromiseError::Failed));
        assert_eq!(evm_signature, None);
        assert_eq!(payment_status(&contract), PaymentStatus::Failed);
        let share = seat_share(&contract, SEAT_ID).unwrap();
        assert_eq!((share.reserved, share.spent), (U128(250_000), U128(0)));
        assert_eq!(contract.get_budget(U64(0)).unwrap().spent_total, U128(0));
        assert!(get_logs()[0].contains(r#""status":"Failed""#));
    }

    #[test]
    fn on_payment_signed_keeps_the_value_spent_for_an_unreadable_reply() {
        let mut contract = contract_waiting_for_signature();
        let evm_signature = contract.on_payment_signed(U64(0), 0, Err(PromiseError::TooLong(0)));
        assert_eq!(evm_signature, None);
        assert_eq!(payment_status(&contract), PaymentStatus::Signed);
        assert_eq!(
            seat_share(&contract, SEAT_ID).unwrap().spent,
            U128(PAYMENT_VALUE)
        );
    }

    #[test]
    fn on_payment_signed_keeps_the_value_spent_for_an_unusable_signature() {
        let mut contract = contract_waiting_for_signature();
        let mut reply = sample_reply();
        reply.recovery_id = 2;
        assert_eq!(contract.on_payment_signed(U64(0), 0, Ok(reply)), None);
        assert_eq!(payment_status(&contract), PaymentStatus::Signed);
        assert_eq!(
            seat_share(&contract, SEAT_ID).unwrap().spent,
            U128(PAYMENT_VALUE)
        );
    }
}
