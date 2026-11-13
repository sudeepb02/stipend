use near_sdk::json_types::U64;
use near_sdk::{AccountId, assert_one_yocto, near, require};

use crate::{Stipend, StipendExt, block_time_sec};

// An agent's seat on a job, held by the agent's session account
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub job_id: String,
    // Token id of the agent's IMD seat NFT
    pub seat_id: String,
    // Unix time in seconds when the session ends
    pub expires_at: U64,
}

impl Session {
    pub fn is_live(&self, block_time: u64) -> bool {
        block_time < self.expires_at.0
    }
}

#[near]
impl Stipend {
    // Puts an agent on a job by naming its session account, replacing any earlier session of it
    #[payable]
    pub fn assign(
        &mut self,
        job_id: String,
        seat_id: String,
        session_account: AccountId,
        expires_at: U64,
    ) {
        assert_one_yocto();
        self.require_oracle();
        let block_time = block_time_sec();
        require!(
            expires_at.0 > block_time,
            "Session must expire in the future"
        );
        require!(
            expires_at.0 <= block_time + u64::from(self.config.max_session_sec),
            "Session is longer than the limit"
        );
        let session = Session {
            job_id,
            seat_id,
            expires_at,
        };
        self.sessions.insert(session_account, session);
    }

    // Ends a session before it expires
    #[payable]
    pub fn unassign(&mut self, session_account: AccountId) {
        assert_one_yocto();
        self.require_oracle();
        require!(
            self.sessions.remove(&session_account).is_some(),
            "No session for this account"
        );
    }

    pub fn get_session(&self, session_account: AccountId) -> Option<Session> {
        self.sessions.get(&session_account).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{
        BLOCK_TIME_SEC, CONTRACT_ID, NO_DEPOSIT, ONE_YOCTO, ORACLE_ID, call_as, new_contract,
    };

    const AGENT_ID: &str = "agent.testnet";
    const SESSION_SEC: u64 = 3_600;

    fn session_until(expires_at: u64) -> Session {
        Session {
            job_id: "job-1".to_string(),
            seat_id: "7".to_string(),
            expires_at: U64(expires_at),
        }
    }

    // Contract whose next call comes from the oracle with 1 yoctoNEAR
    fn contract_for_oracle() -> Stipend {
        let contract = new_contract();
        call_as(ORACLE_ID, ONE_YOCTO);
        contract
    }

    fn assign_agent(contract: &mut Stipend, session: Session) {
        contract.assign(
            session.job_id,
            session.seat_id,
            AGENT_ID.parse().unwrap(),
            session.expires_at,
        );
    }

    fn agent_session(contract: &Stipend) -> Option<Session> {
        contract.get_session(AGENT_ID.parse().unwrap())
    }

    #[test]
    fn assign_stores_the_session() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
        assert_eq!(
            agent_session(&contract),
            Some(session_until(BLOCK_TIME_SEC + SESSION_SEC))
        );
    }

    #[test]
    fn assign_replaces_an_earlier_session() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
        let mut next_job = session_until(BLOCK_TIME_SEC + 2 * SESSION_SEC);
        next_job.job_id = "job-2".to_string();
        assign_agent(&mut contract, next_job.clone());
        assert_eq!(agent_session(&contract), Some(next_job));
    }

    #[test]
    fn assign_accepts_the_longest_session() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + 21_600));
        assert!(agent_session(&contract).is_some());
    }

    #[test]
    #[should_panic(expected = "Session is longer than the limit")]
    fn assign_rejects_a_session_over_the_limit() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + 21_601));
    }

    #[test]
    #[should_panic(expected = "Session must expire in the future")]
    fn assign_rejects_a_past_expiry() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC));
    }

    #[test]
    #[should_panic(expected = "Only the oracle can call this method")]
    fn assign_rejects_other_callers() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, ONE_YOCTO);
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn assign_requires_one_yocto() {
        let mut contract = new_contract();
        call_as(ORACLE_ID, NO_DEPOSIT);
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
    }

    #[test]
    fn unassign_removes_the_session() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
        contract.unassign(AGENT_ID.parse().unwrap());
        assert_eq!(agent_session(&contract), None);
    }

    #[test]
    #[should_panic(expected = "No session for this account")]
    fn unassign_rejects_an_unknown_account() {
        let mut contract = contract_for_oracle();
        contract.unassign(AGENT_ID.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "Only the oracle can call this method")]
    fn unassign_rejects_other_callers() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
        call_as(AGENT_ID, ONE_YOCTO);
        contract.unassign(AGENT_ID.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn unassign_requires_one_yocto() {
        let mut contract = contract_for_oracle();
        assign_agent(&mut contract, session_until(BLOCK_TIME_SEC + SESSION_SEC));
        call_as(ORACLE_ID, NO_DEPOSIT);
        contract.unassign(AGENT_ID.parse().unwrap());
    }

    #[test]
    fn get_session_returns_none_for_an_unknown_account() {
        assert_eq!(agent_session(&new_contract()), None);
    }

    #[test]
    fn session_is_live_only_before_it_expires() {
        let session = session_until(BLOCK_TIME_SEC + SESSION_SEC);
        assert!(session.is_live(BLOCK_TIME_SEC + SESSION_SEC - 1));
        assert!(!session.is_live(BLOCK_TIME_SEC + SESSION_SEC));
    }
}
