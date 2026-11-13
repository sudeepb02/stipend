use near_sdk::{AccountId, Gas, NearToken, Promise, near, serde_json};

use crate::hex;

// Secp256k1 key domain of the MPC signer
const SECP256K1_DOMAIN_ID: u32 = 0;
// The MPC contract requires at least 1 yoctoNEAR and 10 Tgas
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
pub const SIGN_GAS: Gas = Gas::from_tgas(30);

// Arguments of the MPC contract's sign method
#[near(serializers = [json])]
struct SignArgs {
    request: SignRequest,
}

#[near(serializers = [json])]
struct SignRequest {
    payload_v2: SignPayload,
    path: String,
    domain_id: u32,
}

#[near(serializers = [json])]
enum SignPayload {
    Ecdsa(String),
}

// Reply of the MPC contract's sign method for a secp256k1 key
#[near(serializers = [json])]
pub struct MpcSignature {
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
pub struct AffinePoint {
    // Compressed curve point in hex
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

impl MpcSignature {
    // 65-byte EVM signature r || s || v in 0x hex, or None when the reply has an unexpected shape.
    // r is the x coordinate of big_r: its compressed form without the first byte.
    pub fn to_evm_signature(&self) -> Option<String> {
        let r = self.big_r.affine_point.get(2..)?;
        let s = &self.s.scalar;
        if r.len() != 64 || s.len() != 64 || self.recovery_id > 1 {
            return None;
        }
        Some(format!("0x{r}{s}{:02x}", 27 + self.recovery_id))
    }
}

// Asks the MPC signer for a signature of a 32-byte hash with the key derived from a path
pub fn request_signature(mpc_signer_id: AccountId, path: String, digest: &[u8; 32]) -> Promise {
    let sign_args = SignArgs {
        request: SignRequest {
            payload_v2: SignPayload::Ecdsa(hex::encode(digest)),
            path,
            domain_id: SECP256K1_DOMAIN_ID,
        },
    };
    Promise::new(mpc_signer_id).function_call(
        "sign".to_string(),
        serde_json::to_vec(&sign_args).unwrap(),
        SIGN_DEPOSIT,
        SIGN_GAS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reply to a sign request for budget/0 on testnet. The EVM signature below recovers to that
    // pot's address for the signed transfer.
    const TESTNET_REPLY: &str = r#"{"scheme":"Secp256k1","big_r":{"affine_point":"031a5db396d8c42ee453964460be11b50d740fa5bf5957987d3b45b164c67ab466"},"s":{"scalar":"13ee314b3bc377f1ae3ffb35ddf9b9377320c602e88562e4d74862ef5d4122a2"},"recovery_id":0}"#;
    const TESTNET_SIGNATURE: &str = "0x1a5db396d8c42ee453964460be11b50d740fa5bf5957987d3b45b164c67ab46613ee314b3bc377f1ae3ffb35ddf9b9377320c602e88562e4d74862ef5d4122a21b";

    fn testnet_reply() -> MpcSignature {
        serde_json::from_str(TESTNET_REPLY).unwrap()
    }

    #[test]
    fn converts_a_testnet_reply_to_its_evm_signature() {
        assert_eq!(
            testnet_reply().to_evm_signature().as_deref(),
            Some(TESTNET_SIGNATURE)
        );
    }

    #[test]
    fn sets_v_from_the_recovery_id() {
        let mut reply = testnet_reply();
        reply.recovery_id = 1;
        assert!(reply.to_evm_signature().unwrap().ends_with("1c"));
    }

    #[test]
    fn rejects_replies_with_an_unexpected_shape() {
        let mut short_point = testnet_reply();
        short_point.big_r.affine_point.truncate(64);
        assert_eq!(short_point.to_evm_signature(), None);

        let mut short_scalar = testnet_reply();
        short_scalar.s.scalar.truncate(62);
        assert_eq!(short_scalar.to_evm_signature(), None);

        let mut unusable_recovery_id = testnet_reply();
        unusable_recovery_id.recovery_id = 2;
        assert_eq!(unusable_recovery_id.to_evm_signature(), None);
    }
}
