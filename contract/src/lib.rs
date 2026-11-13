pub mod eip3009;

use near_sdk::near;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_contract_name() {
        let contract = Stipend::default();
        assert_eq!(contract.ping(), "stipend");
    }
}
