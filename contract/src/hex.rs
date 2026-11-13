use near_sdk::env;

// Decodes 0x-prefixed hex into exactly LENGTH bytes
pub fn decode_fixed<const LENGTH: usize>(hex: &str) -> Option<[u8; LENGTH]> {
    let digits = hex.strip_prefix("0x")?;
    if digits.len() != LENGTH * 2 || !digits.bytes().all(|digit| digit.is_ascii_hexdigit()) {
        return None;
    }
    let mut bytes = [0u8; LENGTH];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(bytes)
}

// Decodes the 0x hex of a named field, panicking when it is malformed
pub fn decode_field<const LENGTH: usize>(value: &str, field: &str) -> [u8; LENGTH] {
    decode_fixed(value)
        .unwrap_or_else(|| env::panic_str(&format!("{field} must be 0x hex of {LENGTH} bytes")))
}

// Encodes bytes as lowercase hex without a prefix
pub fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_mixed_case_hex() {
        assert_eq!(decode_fixed::<3>("0x0aFf10"), Some([0x0a, 0xff, 0x10]));
    }

    #[test]
    fn rejects_malformed_hex() {
        assert_eq!(decode_fixed::<2>("0aff"), None);
        assert_eq!(decode_fixed::<2>("0x0aff10"), None);
        assert_eq!(decode_fixed::<2>("0x0+ff"), None);
        assert_eq!(decode_fixed::<2>("0x0g10"), None);
    }

    #[test]
    fn encodes_lowercase_without_prefix() {
        assert_eq!(encode(&[0x0a, 0xff, 0x10]), "0aff10");
    }
}
