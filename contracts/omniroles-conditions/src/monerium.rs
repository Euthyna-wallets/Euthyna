//! Monerium orders signed with `personal_sign`.
//!
//! Format (Monerium SDK `placeOrderMessage`):
//! `Send {CURRENCY} {AMOUNT} to {RECEIVER} at {RFC3339 DATE}` (redeem to an IBAN), or
//! `Send {CURRENCY} {AMOUNT} to {ADDRESS} on {CHAIN} at {RFC3339 DATE}` (cross-chain).
//!
//! The order is parsed strictly and re-encoded as ABI data shaped like a call to
//! `MoneriumOrder(string currency,uint256 amount,string receiver,string chain,uint256 timestamp)`
//! (selector = first 4 bytes of the keccak of that signature), so the role's
//! conditions decide which IBANs, chains and amounts are allowed. The amount
//! is scaled to 18 decimals, like EURe, so one allowance can cover both
//! on-chain EURe transfers and SEPA redemptions.

use sha3::{Digest, Keccak256};

use crate::abi::Word;
use crate::encode::{AbiValue, encode_params, usize_word};

pub const ORDER_SIGNATURE: &str =
    "MoneriumOrder(string currency,uint256 amount,string receiver,string chain,uint256 timestamp)";

/// Orders dated further than this from the vault clock are refused (seconds).
pub const MAX_CLOCK_SKEW: u64 = 5 * 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MoneriumOrder {
    pub currency: String,
    /// Amount with 18 decimals.
    pub amount: u128,
    /// IBAN (no spaces, upper case) or lower-case `0x` address.
    pub receiver: String,
    /// Empty for a redemption to an IBAN.
    pub chain: String,
    pub timestamp: u64,
}

impl MoneriumOrder {
    /// Condition input: selector || abi.encode(fields).
    pub fn calldata(&self) -> Vec<u8> {
        let selector = keccak(ORDER_SIGNATURE.as_bytes());
        let mut amount = [0u8; 32];
        amount[16..].copy_from_slice(&self.amount.to_be_bytes());
        let mut out = selector[..4].to_vec();
        out.extend(encode_params(&[
            AbiValue::Bytes(self.currency.as_bytes().to_vec()),
            AbiValue::Word(amount),
            AbiValue::Bytes(self.receiver.as_bytes().to_vec()),
            AbiValue::Bytes(self.chain.as_bytes().to_vec()),
            AbiValue::Word(usize_word(self.timestamp as usize)),
        ]));
        out
    }
}

/// Parse an order and check its date against `now` (seconds since epoch).
pub fn parse_order(message: &str, now: u64) -> Result<MoneriumOrder, String> {
    let rest = message
        .strip_prefix("Send ")
        .ok_or("order must start with \"Send \"")?;
    let (currency, rest) = rest.split_once(' ').ok_or("missing currency")?;
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err("currency must be three upper-case letters".into());
    }
    let (amount_text, rest) = rest.split_once(" to ").ok_or("missing amount")?;
    let amount = parse_amount(amount_text)?;
    let (target, date) = rest.rsplit_once(" at ").ok_or("missing date")?;
    let (receiver, chain) = match target.split_once(" on ") {
        Some((receiver, chain)) => (receiver, chain),
        None => (target, ""),
    };
    let receiver = if chain.is_empty() {
        if !valid_iban(receiver) {
            return Err("receiver is not a valid IBAN".into());
        }
        receiver.to_string()
    } else {
        if !chain.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') || chain.is_empty() {
            return Err("bad chain name".into());
        }
        let digits = receiver
            .strip_prefix("0x")
            .ok_or("cross-chain receiver must be an address")?;
        if digits.len() != 40 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("cross-chain receiver must be an address".into());
        }
        receiver.to_ascii_lowercase()
    };
    let timestamp = parse_rfc3339(date).ok_or("date is not RFC 3339")?;
    if timestamp.abs_diff(now) > MAX_CLOCK_SKEW {
        return Err("order date is too far from the current time".into());
    }
    Ok(MoneriumOrder {
        currency: currency.to_string(),
        amount,
        receiver,
        chain: chain.to_string(),
        timestamp,
    })
}

/// Decimal amount ("1", "10.5") to 18 decimals.
fn parse_amount(text: &str) -> Result<u128, String> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits_ok = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || !digits_ok(whole)
        || !digits_ok(fraction)
        || fraction.len() > 18
        || (text.contains('.') && fraction.is_empty())
    {
        return Err(format!("bad amount {text}"));
    }
    if whole.len() > 1 && whole.starts_with('0') {
        return Err(format!("bad amount {text}"));
    }
    let scaled = format!("{whole}{fraction:0<18}");
    let amount: u128 = scaled
        .parse()
        .map_err(|_| format!("amount too large {text}"))?;
    if amount == 0 {
        return Err("amount must be positive".into());
    }
    Ok(amount)
}

/// ISO 13616 IBAN: format and mod-97 checksum.
pub fn valid_iban(iban: &str) -> bool {
    let bytes = iban.as_bytes();
    if !(15..=34).contains(&bytes.len())
        || !bytes[..2].iter().all(u8::is_ascii_uppercase)
        || !bytes[2..4].iter().all(u8::is_ascii_digit)
        || !bytes[4..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return false;
    }
    let mut remainder = 0u32;
    for byte in bytes[4..].iter().chain(&bytes[..4]) {
        let value = if byte.is_ascii_digit() {
            u32::from(byte - b'0')
        } else {
            u32::from(byte - b'A') + 10
        };
        remainder = if value >= 10 {
            (remainder * 100 + value) % 97
        } else {
            (remainder * 10 + value) % 97
        };
    }
    remainder == 1
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` to seconds since epoch.
pub fn parse_rfc3339(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            if rest.len() != 6 || rest.as_bytes()[3] != b':' {
                return None;
            }
            let hours: i64 = rest[1..3].parse().ok().filter(|h| *h <= 23)?;
            let minutes: i64 = rest[4..6].parse().ok().filter(|m| *m <= 59)?;
            sign * (hours * 3600 + minutes * 60)
        }
    };
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds).ok()
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (proleptic Gregorian calendar).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// EIP-191 `personal_sign` digest of a UTF-8 message.
pub fn personal_message_digest(message: &str) -> Word {
    let mut preimage = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    preimage.extend_from_slice(message.as_bytes());
    keccak(&preimage)
}

fn keccak(data: &[u8]) -> Word {
    Keccak256::digest(data).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2023-04-30T12:00:00+01:00"),
            Some(1_682_852_400)
        );
        assert_eq!(
            parse_rfc3339("2024-02-29T00:00:00.123Z"),
            Some(1_709_164_800)
        );
        assert_eq!(parse_rfc3339("2023-02-29T00:00:00Z"), None);
        assert_eq!(parse_rfc3339("2023-04-30 12:00:00Z"), None);
        assert_eq!(parse_rfc3339("2023-04-30T12:00:00"), None);
    }

    #[test]
    fn ibans() {
        assert!(valid_iban("GB82WEST12345698765432"));
        assert!(valid_iban("DE89370400440532013000"));
        assert!(!valid_iban("GB82WEST12345698765433"));
        assert!(!valid_iban("gb82WEST12345698765432"));
        assert!(!valid_iban("GB82 WEST 1234 5698 7654 32"));
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_amount("1"), Ok(1_000_000_000_000_000_000));
        assert_eq!(parse_amount("10.5"), Ok(10_500_000_000_000_000_000));
        assert!(
            parse_amount("0").is_err()
                && parse_amount("1.").is_err()
                && parse_amount(".5").is_err()
        );
        assert!(
            parse_amount("01").is_err()
                && parse_amount("1,5").is_err()
                && parse_amount("-1").is_err()
        );
    }
}
