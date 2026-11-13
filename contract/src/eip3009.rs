use near_sdk::env;

// EIP-712 type strings for the token domain and the transfer message
const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const TRANSFER_TYPE: &str = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

// EIP-712 domain of an EIP-3009 token such as USDC
pub struct TokenDomain {
    pub name: String,
    pub version: String,
    pub chain_id: u64,
    pub token: [u8; 20],
}

// Fields of an EIP-3009 TransferWithAuthorization message
pub struct TransferWithAuthorization {
    pub from: [u8; 20],
    pub to: [u8; 20],
    pub value: u128,
    pub valid_after: u64,
    pub valid_before: u64,
    pub nonce: [u8; 32],
}

// EIP-712 digest of a transfer, the hash the payer signs
pub fn transfer_digest(domain: &TokenDomain, transfer: &TransferWithAuthorization) -> [u8; 32] {
    let mut message = Vec::with_capacity(66);
    message.extend_from_slice(&[0x19, 0x01]);
    message.extend_from_slice(&domain_separator(domain));
    message.extend_from_slice(&transfer_struct_hash(transfer));
    env::keccak256_array(message)
}

pub fn domain_separator(domain: &TokenDomain) -> [u8; 32] {
    hash_words(&[
        env::keccak256_array(DOMAIN_TYPE),
        env::keccak256_array(&domain.name),
        env::keccak256_array(&domain.version),
        uint_word(domain.chain_id.into()),
        address_word(&domain.token),
    ])
}

pub fn transfer_struct_hash(transfer: &TransferWithAuthorization) -> [u8; 32] {
    hash_words(&[
        env::keccak256_array(TRANSFER_TYPE),
        address_word(&transfer.from),
        address_word(&transfer.to),
        uint_word(transfer.value),
        uint_word(transfer.valid_after.into()),
        uint_word(transfer.valid_before.into()),
        transfer.nonce,
    ])
}

// Hashes 32-byte words back to back, the EIP-712 encoding of static fields
fn hash_words(words: &[[u8; 32]]) -> [u8; 32] {
    env::keccak256_array(words.concat())
}

// Big-endian unsigned integer, left-padded to 32 bytes
fn uint_word(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

// Address left-padded to 32 bytes
fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_from_hex<const LENGTH: usize>(hex: &str) -> [u8; LENGTH] {
        let digits = hex.trim_start_matches("0x");
        assert_eq!(digits.len(), LENGTH * 2, "wrong hex length: {hex}");
        let mut bytes = [0u8; LENGTH];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }

    fn base_sepolia_usdc() -> TokenDomain {
        TokenDomain {
            name: "USDC".to_string(),
            version: "2".to_string(),
            chain_id: 84532,
            token: bytes_from_hex("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
        }
    }

    #[test]
    fn transfer_type_hash_matches_usdc() {
        // TRANSFER_WITH_AUTHORIZATION_TYPEHASH() of USDC on Base Sepolia
        let expected: [u8; 32] =
            bytes_from_hex("0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267");
        assert_eq!(env::keccak256_array(TRANSFER_TYPE), expected);
    }

    #[test]
    fn domain_separator_matches_usdc_on_base_sepolia() {
        // DOMAIN_SEPARATOR() of USDC on Base Sepolia
        let expected: [u8; 32] =
            bytes_from_hex("0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818");
        assert_eq!(domain_separator(&base_sepolia_usdc()), expected);
    }

    #[test]
    fn payment_digest_matches_viem() {
        let transfer = TransferWithAuthorization {
            from: bytes_from_hex("0x90a9d41B34E0D076EB65D7A0D547f34d4beFECdF"),
            to: bytes_from_hex("0x9081F51AD866C6d4c6F7Ad758Dea7FC43a7649e6"),
            value: 10_000,
            valid_after: 0,
            valid_before: 1_794_560_000,
            nonce: bytes_from_hex(
                "0x0102030405060708091011121314151617181920212223242526272829303132",
            ),
        };
        // Expected hashes from viem hashStruct and hashTypedData for the same fields
        let expected_struct_hash: [u8; 32] =
            bytes_from_hex("0x069d162f157080e805bc3eec52cc00c9b833c74d990dc69440669a53869d0ddb");
        let expected_digest: [u8; 32] =
            bytes_from_hex("0x6e383c6419ff701e12ac63761147863c4c6aae757b78a42fa16fd02bfbd92168");
        assert_eq!(transfer_struct_hash(&transfer), expected_struct_hash);
        assert_eq!(
            transfer_digest(&base_sepolia_usdc(), &transfer),
            expected_digest
        );
    }

    #[test]
    fn edge_value_digest_matches_viem() {
        let base_mainnet_usdc = TokenDomain {
            name: "USD Coin".to_string(),
            version: "2".to_string(),
            chain_id: 8453,
            token: bytes_from_hex("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
        };
        let transfer = TransferWithAuthorization {
            from: [0xff; 20],
            to: bytes_from_hex("0x0000000000000000000000000000000000000001"),
            value: u128::MAX,
            valid_after: 1_794_550_000,
            valid_before: u64::MAX,
            nonce: [0xff; 32],
        };
        // DOMAIN_SEPARATOR() of USDC on Base mainnet, and viem hashTypedData for the same fields
        let expected_domain_separator: [u8; 32] =
            bytes_from_hex("0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f");
        let expected_digest: [u8; 32] =
            bytes_from_hex("0x4bdcaa81087d82f80efcb3d7903e8b049a1007e3bc465e7ba88725882672d04f");
        assert_eq!(
            domain_separator(&base_mainnet_usdc),
            expected_domain_separator
        );
        assert_eq!(
            transfer_digest(&base_mainnet_usdc, &transfer),
            expected_digest
        );
    }
}
