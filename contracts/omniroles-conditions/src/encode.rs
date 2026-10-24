//! Minimal Solidity ABI encoder and 256-bit integer parsing.
//!
//! Signed messages (EIP-712 typed data, Monerium orders) are re-encoded as ABI
//! data so the same condition trees and allowances apply to them as to calls.

use crate::abi::Word;

/// A value to ABI-encode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AbiValue {
    /// Any static 32-byte value (uintN, intN, address, bool, bytesN).
    Word(Word),
    /// `bytes` or `string`.
    Bytes(Vec<u8>),
    /// Dynamic array `T[]`.
    Array(Vec<AbiValue>),
    /// Struct, or fixed-size array `T[k]`.
    Tuple(Vec<AbiValue>),
}

impl AbiValue {
    fn is_dynamic(&self) -> bool {
        match self {
            AbiValue::Word(_) => false,
            AbiValue::Bytes(_) | AbiValue::Array(_) => true,
            AbiValue::Tuple(items) => items.iter().any(AbiValue::is_dynamic),
        }
    }

    fn head_size(&self) -> usize {
        match self {
            AbiValue::Tuple(items) if !self.is_dynamic() => {
                items.iter().map(AbiValue::head_size).sum()
            }
            _ => 32,
        }
    }
}

/// `abi.encode(items...)`.
pub fn encode_params(items: &[AbiValue]) -> Vec<u8> {
    let heads_size: usize = items.iter().map(AbiValue::head_size).sum();
    let mut head = Vec::with_capacity(heads_size);
    let mut tail = Vec::new();
    for item in items {
        if item.is_dynamic() {
            head.extend_from_slice(&usize_word(heads_size + tail.len()));
            tail.extend(encode_value(item));
        } else {
            head.extend(encode_value(item));
        }
    }
    head.extend(tail);
    head
}

fn encode_value(value: &AbiValue) -> Vec<u8> {
    match value {
        AbiValue::Word(word) => word.to_vec(),
        AbiValue::Bytes(bytes) => {
            let mut out = usize_word(bytes.len()).to_vec();
            out.extend_from_slice(bytes);
            out.resize(32 + bytes.len().div_ceil(32) * 32, 0);
            out
        }
        AbiValue::Array(items) => {
            let mut out = usize_word(items.len()).to_vec();
            out.extend(encode_params(items));
            out
        }
        AbiValue::Tuple(items) => encode_params(items),
    }
}

pub fn usize_word(value: usize) -> Word {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&(value as u64).to_be_bytes());
    out
}

/// Parse a non-negative decimal or `0x` hexadecimal integer into a big-endian word.
pub fn parse_unsigned(text: &str) -> Option<Word> {
    if let Some(hex_digits) = text.strip_prefix("0x") {
        if hex_digits.is_empty()
            || hex_digits.len() > 64
            || !hex_digits.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        let padded = format!("{hex_digits:0>64}");
        return hex::decode(padded).ok()?.try_into().ok();
    }
    if text.is_empty() || text.len() > 78 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    let mut word = [0u8; 32];
    for digit in text.bytes() {
        // word = word * 10 + digit, failing on overflow.
        let mut carry = u32::from(digit - b'0');
        for byte in word.iter_mut().rev() {
            let value = u32::from(*byte) * 10 + carry;
            *byte = value as u8;
            carry = value >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(word)
}

/// Number of significant bits.
pub fn bit_length(word: &Word) -> u32 {
    for (index, byte) in word.iter().enumerate() {
        if *byte != 0 {
            return (32 - index as u32) * 8 - byte.leading_zeros();
        }
    }
    0
}

/// Two's complement negation.
pub fn negate(word: &Word) -> Word {
    let mut out = [0u8; 32];
    let mut carry = 1u16;
    for index in (0..32).rev() {
        let value = u16::from(!word[index]) + carry;
        out[index] = value as u8;
        carry = value >> 8;
    }
    out
}

/// Parse an integer for `uintN` (`signed == false`) or `intN`, checking its range.
pub fn parse_integer(text: &str, bits: u32, signed: bool) -> Option<Word> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) if signed => (true, rest),
        Some(_) => return None,
        None => (false, text),
    };
    let magnitude = parse_unsigned(digits)?;
    let length = bit_length(&magnitude);
    if !signed {
        return (length <= bits).then_some(magnitude);
    }
    if negative {
        // Smallest value is -2^(bits-1).
        let is_min = length == bits && magnitude.iter().map(|b| b.count_ones()).sum::<u32>() == 1;
        if length > bits - 1 && !is_min {
            return None;
        }
        if length == 0 {
            return Some(magnitude);
        }
        Some(negate(&magnitude))
    } else {
        (length < bits).then_some(magnitude)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers() {
        assert_eq!(parse_unsigned("0").unwrap(), [0u8; 32]);
        assert_eq!(parse_unsigned("256").unwrap()[30..], [1, 0]);
        assert_eq!(parse_unsigned("0x0100").unwrap()[30..], [1, 0]);
        let max = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
        assert_eq!(parse_unsigned(max).unwrap(), [0xff; 32]);
        assert!(
            parse_unsigned(
                "115792089237316195423570985008687907853269984665640564039457584007913129639936"
            )
            .is_none()
        );
        assert!(
            parse_unsigned("01").is_none()
                && parse_unsigned("1.5").is_none()
                && parse_unsigned("").is_none()
        );
        assert!(
            parse_integer("255", 8, false).is_some() && parse_integer("256", 8, false).is_none()
        );
        assert!(parse_integer("127", 8, true).is_some() && parse_integer("128", 8, true).is_none());
        assert_eq!(parse_integer("-128", 8, true).unwrap(), {
            let mut w = [0xff; 32];
            w[31] = 0x80;
            w
        });
        assert!(parse_integer("-129", 8, true).is_none());
        assert_eq!(parse_integer("-1", 256, true).unwrap(), [0xff; 32]);
        assert!(parse_integer("-1", 256, false).is_none());
        assert_eq!(parse_integer("-0", 8, true).unwrap(), [0; 32]);
    }
}
