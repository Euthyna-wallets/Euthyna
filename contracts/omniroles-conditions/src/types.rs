//! Core types of the OmniRoles permission engine.
//!
//! The numeric values of [`Encoding`] and [`Operator`] follow the public
//! Zodiac Roles v3 condition format (see the Roles documentation, "Conditions"),
//! so that permissions authored with the Zodiac Roles SDK can be flattened and
//! evaluated here. This crate is an independent implementation: it does not
//! contain code from the Roles contracts.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// How the value in scope is decoded.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(try_from = "u8", into = "u8")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Encoding {
    /// Logical node: children address the same scope.
    None = 0,
    /// One 32-byte word.
    Static = 1,
    /// `bytes` / `string`: offset to `length || data`.
    Dynamic = 2,
    /// Tuple; children describe the fields.
    Tuple = 3,
    /// Dynamic array; exactly one child describes the element type.
    Array = 4,
    /// ABI-encoded parameter list (function arguments, or ABI data inside `bytes`).
    AbiEncoded = 5,
    /// The native value sent with the call. Non-structural.
    EtherValue = 6,
}

impl TryFrom<u8> for Encoding {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Ok(match value {
            0 => Self::None,
            1 => Self::Static,
            2 => Self::Dynamic,
            3 => Self::Tuple,
            4 => Self::Array,
            5 => Self::AbiEncoded,
            6 => Self::EtherValue,
            other => return Err(format!("unknown encoding {other}")),
        })
    }
}

impl From<Encoding> for u8 {
    fn from(value: Encoding) -> Self {
        value as u8
    }
}

/// Condition operator.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(try_from = "u8", into = "u8")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Operator {
    Pass = 0,
    And = 1,
    Or = 2,
    Empty = 4,
    Matches = 5,
    ArraySome = 6,
    ArrayEvery = 7,
    ArrayTailMatches = 8,
    ZipSome = 10,
    ZipEvery = 11,
    Slice = 13,
    Pluck = 14,
    EqualToAvatar = 15,
    EqualTo = 16,
    GreaterThan = 17,
    LessThan = 18,
    SignedIntGreaterThan = 19,
    SignedIntLessThan = 20,
    Bitmask = 21,
    Custom = 22,
    WithinRatio = 23,
    WithinAllowance = 28,
    CallWithinAllowance = 30,
}

impl TryFrom<u8> for Operator {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Ok(match value {
            0 => Self::Pass,
            1 => Self::And,
            2 => Self::Or,
            4 => Self::Empty,
            5 => Self::Matches,
            6 => Self::ArraySome,
            7 => Self::ArrayEvery,
            8 => Self::ArrayTailMatches,
            10 => Self::ZipSome,
            11 => Self::ZipEvery,
            13 => Self::Slice,
            14 => Self::Pluck,
            15 => Self::EqualToAvatar,
            16 => Self::EqualTo,
            17 => Self::GreaterThan,
            18 => Self::LessThan,
            19 => Self::SignedIntGreaterThan,
            20 => Self::SignedIntLessThan,
            21 => Self::Bitmask,
            22 => Self::Custom,
            23 => Self::WithinRatio,
            28 => Self::WithinAllowance,
            30 => Self::CallWithinAllowance,
            other => return Err(format!("unknown operator {other}")),
        })
    }
}

impl From<Operator> for u8 {
    fn from(value: Operator) -> Self {
        value as u8
    }
}

/// One node of a condition tree, flattened in breadth-first order.
///
/// The root is at index 0 and is its own parent (`parent == 0`). Every other
/// node points to an earlier node, and parents are non-decreasing.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[cfg_attr(feature = "abi", derive(schemars::JsonSchema, borsh::BorshSchema))]
#[serde(rename_all = "camelCase")]
pub struct ConditionFlat {
    pub parent: u16,
    pub param_type: Encoding,
    pub operator: Operator,
    #[serde(with = "hex_bytes", default)]
    #[cfg_attr(feature = "abi", schemars(with = "String"))]
    pub comp_value: Vec<u8>,
}

/// Schemas for ABI generation: both enums are serialized as their numeric value.
#[cfg(feature = "abi")]
mod abi_schema {
    use super::{Encoding, Operator};
    use borsh::schema::{Declaration, Definition};
    use std::collections::BTreeMap;

    macro_rules! numeric_schema {
        ($ty:ty, $name:literal) => {
            impl schemars::JsonSchema for $ty {
                fn schema_name() -> String {
                    $name.to_string()
                }
                fn json_schema(
                    generator: &mut schemars::r#gen::SchemaGenerator,
                ) -> schemars::schema::Schema {
                    <u8 as schemars::JsonSchema>::json_schema(generator)
                }
            }
            impl borsh::BorshSchema for $ty {
                fn add_definitions_recursively(
                    definitions: &mut BTreeMap<Declaration, Definition>,
                ) {
                    <u8 as borsh::BorshSchema>::add_definitions_recursively(definitions);
                }
                fn declaration() -> Declaration {
                    <u8 as borsh::BorshSchema>::declaration()
                }
            }
        };
    }
    numeric_schema!(Encoding, "Encoding");
    numeric_schema!(Operator, "Operator");
}

/// Which kinds of execution a permission allows.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "camelCase")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ExecutionOptions {
    /// Plain calls without native value.
    #[default]
    None = 0,
    /// Calls that may carry native value.
    Send = 1,
    /// Delegate calls (without native value).
    DelegateCall = 2,
    /// Both.
    Both = 3,
}

impl ExecutionOptions {
    pub fn allows_send(self) -> bool {
        matches!(self, Self::Send | Self::Both)
    }
    pub fn allows_delegate_call(self) -> bool {
        matches!(self, Self::DelegateCall | Self::Both)
    }
}

/// Call or delegate call.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Operation {
    Call = 0,
    DelegateCall = 1,
}

/// Periodic quota (token amount, native value or number of calls).
///
/// Same fields and accrual rule as Zodiac allowances: every elapsed `period`
/// adds `refill` to `balance`, up to `max_refill`; `period == 0` means a one-time
/// allowance.
#[derive(
    Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub struct Allowance {
    #[serde(with = "u128_string")]
    pub refill: u128,
    #[serde(with = "u128_string")]
    pub max_refill: u128,
    /// Seconds.
    pub period: u64,
    #[serde(with = "u128_string")]
    pub balance: u128,
    /// Seconds since epoch of the last accrued interval.
    pub timestamp: u64,
}

impl Allowance {
    /// Balance and timestamp after accruing every full period elapsed until `now`.
    pub fn accrued(&self, now: u64) -> (u128, u64) {
        if self.period == 0 || now < self.timestamp.saturating_add(self.period) {
            return (self.balance, self.timestamp);
        }
        let elapsed = (now - self.timestamp) / self.period;
        let timestamp = self.timestamp + elapsed * self.period;
        if self.balance >= self.max_refill {
            return (self.balance, timestamp);
        }
        let added = self.refill.saturating_mul(elapsed as u128);
        let balance = self.balance.saturating_add(added).min(self.max_refill);
        (balance, timestamp)
    }
}

/// Amount consumed from one allowance by an approved transaction.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consumption {
    #[serde(with = "hex_bytes")]
    pub key: Vec<u8>,
    /// Accrued balance before this transaction.
    #[serde(with = "u128_string")]
    pub balance: u128,
    /// Accrued interval timestamp to persist.
    pub timestamp: u64,
    #[serde(with = "u128_string")]
    pub consumed: u128,
    /// Only `CallWithinAllowance` charged this key: `consumed` counts calls,
    /// not an amount of value.
    #[serde(default)]
    pub calls_only: bool,
}

impl Consumption {
    /// Balance to persist once the transaction is executed.
    pub fn balance_after(&self) -> u128 {
        self.balance - self.consumed
    }
}

/// Why a transaction is refused. Returned to the caller so refusals can be
/// explained to humans (console, escalations).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Status {
    TargetNotAllowed,
    FunctionNotAllowed,
    SendNotAllowed,
    DelegateCallNotAllowed,
    /// Stored conditions fail the integrity check (fail closed).
    ConditionsInvalid,
    /// No signature scope of the role matches this domain / type / message kind.
    SignatureNotAllowed,
    /// EIP-712 typed data that cannot be hashed unambiguously.
    TypedDataInvalid {
        reason: String,
    },
    /// A personal message that does not follow its expected format.
    MessageInvalid {
        reason: String,
    },
    CalldataTooShort,
    CalldataOutOfBounds,
    ParameterNotAllowed {
        node: u16,
    },
    ParameterLessThanAllowed {
        node: u16,
    },
    ParameterGreaterThanAllowed {
        node: u16,
    },
    ParameterNotOneOfAllowed {
        node: u16,
    },
    NotEveryArrayElementPasses {
        node: u16,
    },
    NoArrayElementPasses {
        node: u16,
    },
    BitmaskNotAllowed {
        node: u16,
    },
    NotEmpty {
        node: u16,
    },
    AllowanceExceeded {
        node: u16,
        key: String,
    },
    UnknownAllowance {
        node: u16,
        key: String,
    },
}

pub(crate) mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("0x{}", hex::encode(value)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        let stripped = text.strip_prefix("0x").unwrap_or(&text);
        hex::decode(stripped).map_err(serde::de::Error::custom)
    }
}

pub(crate) mod u128_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}
