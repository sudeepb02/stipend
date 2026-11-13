use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, near, require};

use crate::eip3009::TokenDomain;
use crate::hex;
use crate::{Stipend, StipendExt};

// EIP-3009 token, such as USDC, that the contract signs transfers of
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    pub chain_id: U64,
    // Token contract address in 0x hex
    pub token: String,
    // EIP-712 domain name and version of the token
    pub name: String,
    pub version: String,
    pub decimals: u8,
}

impl Asset {
    // EIP-712 domain that transfers of this token are signed over
    pub fn domain(&self) -> TokenDomain {
        TokenDomain {
            name: self.name.clone(),
            version: self.version.clone(),
            chain_id: self.chain_id.0,
            token: hex::decode_field(&self.token, "token"),
        }
    }
}

#[near]
impl Stipend {
    // Adds a token under a new id. Assets never change once registered.
    #[payable]
    pub fn register_asset(&mut self, asset_id: String, asset: Asset) {
        assert_one_yocto();
        self.require_owner();
        require!(
            !self.assets.contains_key(&asset_id),
            "Asset id is already registered"
        );
        // Panics when the token is not a 20-byte address
        hex::decode_field::<20>(&asset.token, "token");
        self.assets.insert(asset_id, asset);
    }

    pub fn get_asset(&self, asset_id: String) -> Option<Asset> {
        self.assets.get(&asset_id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eip3009;
    use crate::testing::{
        CONTRACT_ID, NO_DEPOSIT, ONE_YOCTO, USDC_ASSET_ID, call_as, new_contract, usdc_asset,
    };

    #[test]
    fn register_asset_stores_the_asset() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, ONE_YOCTO);
        contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
        assert_eq!(
            contract.get_asset(USDC_ASSET_ID.to_string()),
            Some(usdc_asset())
        );
    }

    #[test]
    fn get_asset_returns_none_for_an_unknown_id() {
        let contract = new_contract();
        assert_eq!(contract.get_asset("unknown".to_string()), None);
    }

    #[test]
    #[should_panic(expected = "Only the owner can call this method")]
    fn register_asset_rejects_other_callers() {
        let mut contract = new_contract();
        call_as("someone.testnet", ONE_YOCTO);
        contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn register_asset_requires_one_yocto() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, NO_DEPOSIT);
        contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
    }

    #[test]
    #[should_panic(expected = "Asset id is already registered")]
    fn register_asset_rejects_a_used_id() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, ONE_YOCTO);
        contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
        contract.register_asset(USDC_ASSET_ID.to_string(), usdc_asset());
    }

    #[test]
    #[should_panic(expected = "token must be 0x hex of 20 bytes")]
    fn register_asset_rejects_a_malformed_token() {
        let mut contract = new_contract();
        call_as(CONTRACT_ID, ONE_YOCTO);
        let mut asset = usdc_asset();
        asset.token = "0x036CbD53".to_string();
        contract.register_asset(USDC_ASSET_ID.to_string(), asset);
    }

    #[test]
    fn asset_domain_matches_usdc_on_base_sepolia() {
        // DOMAIN_SEPARATOR() read from the USDC contract on Base Sepolia
        let expected: [u8; 32] =
            hex::decode_fixed("0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818")
                .unwrap();
        assert_eq!(eip3009::domain_separator(&usdc_asset().domain()), expected);
    }
}
