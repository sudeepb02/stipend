use near_sdk::json_types::{U64, U128};
use near_sdk::{Promise, PromiseError, assert_one_yocto, env, near, require};

use crate::budget::budget_path;
use crate::eip3009::TransferArgs;
use crate::mpc::{self, MpcSignature};
use crate::payment::StipendEvent;
use crate::{Stipend, StipendExt, block_time_sec, hex};

// Nonce of a budget's refund authorization. USDC accepts a nonce once per payer, so at most one
// refund of a budget can settle.
pub fn refund_nonce(budget_id: u64) -> [u8; 32] {
    env::keccak256_array([b"stipend:refund".as_slice(), &budget_id.to_be_bytes()].concat())
}

// A transfer authorization with its EVM signature, ready to submit on the token's chain
#[near(serializers = [json])]
pub struct SignedTransfer {
    pub transfer: TransferArgs,
    pub signature: String,
}

#[near]
impl Stipend {
    // Signs a transfer from a budget's pot to an address the funder names. Allowed once
    // max_window_sec has passed since the budget ended, when every payment authorization has
    // expired. Only one refund of a budget can settle, so the amount should be the pot's balance.
    #[payable]
    pub fn refund(&mut self, budget_id: U64, from: String, to: String, amount: U128) -> Promise {
        assert_one_yocto();
        let block_time = block_time_sec();
        let Some(budget) = self.budgets.get(&budget_id.0) else {
            env::panic_str("No budget with this id");
        };
        require!(
            env::predecessor_account_id() == budget.funder,
            "Only the funder can ask for a refund"
        );
        let max_window_sec = u64::from(self.config.max_window_sec);
        let refund_start = budget.ended_at().saturating_add(max_window_sec);
        require!(
            block_time >= refund_start,
            format!("Refunds start {max_window_sec} seconds after the budget ends")
        );
        require!(amount.0 > 0, "Amount must be above zero");

        // On the token's chain the refund becomes valid only after refund_start by that chain's
        // clock, when every payment authorization there has expired
        let transfer = TransferArgs {
            from,
            to,
            value: amount,
            valid_after: U64(refund_start),
            valid_before: U64(block_time + max_window_sec),
            nonce: format!("0x{}", hex::encode(&refund_nonce(budget_id.0))),
        };
        let digest = self.budget_transfer_digest(budget_id.0, &transfer);
        mpc::request_signature(
            self.config.mpc_signer_id.clone(),
            budget_path(budget_id.0),
            &digest,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::CALLBACK_GAS)
                .on_refund_signed(budget_id, transfer),
        )
    }

    // Returns the signed refund, or None when the MPC network gave no usable signature
    #[private]
    pub fn on_refund_signed(
        &self,
        budget_id: U64,
        transfer: TransferArgs,
        #[callback_result] result: Result<MpcSignature, PromiseError>,
    ) -> Option<SignedTransfer> {
        let signature = result.ok()?.to_evm_signature()?;
        StipendEvent::Refund {
            budget_id,
            to: transfer.to.clone(),
            value: transfer.value,
        }
        .emit();
        Some(SignedTransfer {
            transfer,
            signature,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eip3009;
    use crate::testing::{
        BLOCK_TIME_SEC, CONTRACT_ID, FUNDER_ID, MPC_SIGNER_ID, NO_DEPOSIT, ONE_YOCTO,
        STORAGE_DEPOSIT, call_as, call_at, contract_with_usdc, create_budget, function_call,
        receipt_to, sample_budget, sample_reply, usdc_asset,
    };
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs};

    const POT: &str = "0x90a9d41B34E0D076EB65D7A0D547f34d4beFECdF";
    const FUNDER_WALLET: &str = "0x0ac15458d00273B4C8e3790c7c73EdBba43e54A2";
    const LEFTOVER: u128 = 490_000;
    // First refund time of a budget closed at BLOCK_TIME_SEC
    const REFUND_START: u64 = BLOCK_TIME_SEC + 900;

    // Contract with the sample budget as budget 0, before anyone closes it
    fn contract_with_budget() -> Stipend {
        let mut contract = contract_with_usdc();
        call_as(FUNDER_ID, STORAGE_DEPOSIT);
        create_budget(&mut contract, sample_budget());
        contract
    }

    // Contract with budget 0 closed by its funder at BLOCK_TIME_SEC
    fn contract_with_closed_budget() -> Stipend {
        let mut contract = contract_with_budget();
        call_as(FUNDER_ID, ONE_YOCTO);
        contract.close_budget(U64(0));
        contract
    }

    // Asks for a refund of LEFTOVER from budget 0 to the funder's wallet
    fn refund(contract: &mut Stipend) {
        let _ = contract.refund(
            U64(0),
            POT.to_string(),
            FUNDER_WALLET.to_string(),
            U128(LEFTOVER),
        );
    }

    // Refund authorization of LEFTOVER from budget 0, as the contract builds it
    fn refund_transfer(refund_start: u64, block_time: u64) -> Value {
        serde_json::json!({
            "from": POT,
            "to": FUNDER_WALLET,
            "value": LEFTOVER.to_string(),
            "valid_after": refund_start.to_string(),
            "valid_before": (block_time + 900).to_string(),
            "nonce": format!("0x{}", hex::encode(&refund_nonce(0))),
        })
    }

    #[test]
    fn refund_asks_the_mpc_signer_to_sign_for_the_budget_pot() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, ONE_YOCTO, REFUND_START);
        refund(&mut contract);
        let receipts = get_created_receipts();

        let expected_transfer = refund_transfer(REFUND_START, REFUND_START);
        let transfer: TransferArgs = serde_json::from_value(expected_transfer.clone()).unwrap();
        let digest = eip3009::transfer_digest(&usdc_asset().domain(), &transfer.parse());
        let (method, args, deposit, gas) = function_call(receipt_to(&receipts, MPC_SIGNER_ID));
        assert_eq!(method, "sign");
        assert_eq!(args["request"]["payload_v2"]["Ecdsa"], hex::encode(&digest));
        assert_eq!(args["request"]["path"], "budget/0");
        assert_eq!((deposit, gas), (mpc::SIGN_DEPOSIT, mpc::SIGN_GAS));

        let (method, args, _, gas) = function_call(receipt_to(&receipts, CONTRACT_ID));
        assert_eq!(method, "on_refund_signed");
        assert_eq!(
            args,
            serde_json::json!({ "budget_id": "0", "transfer": expected_transfer })
        );
        assert_eq!(gas, mpc::CALLBACK_GAS);
    }

    #[test]
    fn refund_starts_after_an_expired_budget_ends() {
        let mut contract = contract_with_budget();
        let refund_start = sample_budget().expires_at.0 + 900;
        call_at(FUNDER_ID, ONE_YOCTO, refund_start + 60);
        refund(&mut contract);
        let receipts = get_created_receipts();
        let (_, args, _, _) = function_call(receipt_to(&receipts, CONTRACT_ID));
        assert_eq!(
            args["transfer"],
            refund_transfer(refund_start, refund_start + 60)
        );
    }

    #[test]
    #[should_panic(expected = "Refunds start 900 seconds after the budget ends")]
    fn refund_rejects_a_call_before_the_grace_period_ends() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, ONE_YOCTO, REFUND_START - 1);
        refund(&mut contract);
    }

    #[test]
    #[should_panic(expected = "Refunds start 900 seconds after the budget ends")]
    fn refund_rejects_an_open_budget() {
        let mut contract = contract_with_budget();
        call_as(FUNDER_ID, ONE_YOCTO);
        refund(&mut contract);
    }

    #[test]
    #[should_panic(expected = "Only the funder can ask for a refund")]
    fn refund_rejects_other_callers() {
        let mut contract = contract_with_closed_budget();
        call_at("someone.testnet", ONE_YOCTO, REFUND_START);
        refund(&mut contract);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn refund_requires_one_yocto() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, NO_DEPOSIT, REFUND_START);
        refund(&mut contract);
    }

    #[test]
    #[should_panic(expected = "Amount must be above zero")]
    fn refund_rejects_a_zero_amount() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, ONE_YOCTO, REFUND_START);
        let _ = contract.refund(U64(0), POT.to_string(), FUNDER_WALLET.to_string(), U128(0));
    }

    #[test]
    #[should_panic(expected = "No budget with this id")]
    fn refund_rejects_an_unknown_budget() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, ONE_YOCTO, REFUND_START);
        let _ = contract.refund(
            U64(1),
            POT.to_string(),
            FUNDER_WALLET.to_string(),
            U128(LEFTOVER),
        );
    }

    #[test]
    #[should_panic(expected = "to must be 0x hex of 20 bytes")]
    fn refund_rejects_a_malformed_address() {
        let mut contract = contract_with_closed_budget();
        call_at(FUNDER_ID, ONE_YOCTO, REFUND_START);
        let _ = contract.refund(
            U64(0),
            POT.to_string(),
            "0x0ac1".to_string(),
            U128(LEFTOVER),
        );
    }

    #[test]
    fn on_refund_signed_returns_the_signed_transfer() {
        let contract = contract_with_closed_budget();
        call_as(CONTRACT_ID, NO_DEPOSIT);
        let transfer = serde_json::from_value(refund_transfer(REFUND_START, REFUND_START)).unwrap();
        let signed = contract
            .on_refund_signed(U64(0), transfer, Ok(sample_reply()))
            .unwrap();
        assert_eq!(
            signed.signature,
            format!("0x{}{}1b", "11".repeat(32), "22".repeat(32))
        );
        assert_eq!(signed.transfer.to, FUNDER_WALLET);
        assert_eq!(
            get_logs(),
            vec![format!(
                r#"EVENT_JSON:{{"standard":"stipend","version":"1.0.0","event":"refund","data":{{"budget_id":"0","to":"{FUNDER_WALLET}","value":"490000"}}}}"#
            )]
        );
    }

    #[test]
    fn on_refund_signed_returns_none_when_signing_fails() {
        let contract = contract_with_closed_budget();
        call_as(CONTRACT_ID, NO_DEPOSIT);
        let transfer = serde_json::from_value(refund_transfer(REFUND_START, REFUND_START)).unwrap();
        let signed = contract.on_refund_signed(U64(0), transfer, Err(PromiseError::Failed));
        assert!(signed.is_none());
        assert!(get_logs().is_empty());
    }

    #[test]
    fn refund_nonce_matches_viem() {
        // keccak256(encodePacked(["string", "uint64"], ["stipend:refund", budgetId])) from viem
        assert_eq!(
            hex::encode(&refund_nonce(0)),
            "f454fdcd3eca3e328b5e74b6981cf1c38973e0eb28cdd5293eb5c453144e4aee"
        );
        assert_eq!(
            hex::encode(&refund_nonce(7)),
            "c590a54bd70c52ec1ba8ac96a376d34859bf4716ab4db387d85ab55d1a7c7681"
        );
    }
}
