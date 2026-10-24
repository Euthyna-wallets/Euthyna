//! # OmniRoles conditions
//!
//! Permission engine of the OmniRoles vault: the NEAR contract that holds the
//! company wallets (addresses derived through Chain Signatures) checks every
//! call an agent requests against the role the DAO granted it, and only then
//! asks the MPC network to sign.
//!
//! Permissions use the Zodiac Roles v3 condition format (flattened trees of
//! `{parent, paramType, operator, compValue}`), so they can be authored with the
//! Roles SDK tooling. Evaluation happens in the vault, not on the target chain.
//!
//! Supported: `Pass`, `And`, `Or`, `Empty`, `Matches` (tuples, parameter lists,
//! nested ABI data in `bytes`), `ArraySome`, `ArrayEvery`, `EqualToAvatar`,
//! `EqualTo`, `GreaterThan`, `LessThan`, signed comparisons, `Bitmask`,
//! `WithinAllowance` (parameter or native value) and `CallWithinAllowance`.
//! Other operators are rejected when a tree is validated, never ignored.
//!
//! Signature scoping ([`signature`]): EIP-712 typed data (x402 / EIP-3009,
//! Permit2...) and Monerium orders are checked by the same conditions and
//! allowances, on the values the vault hashes itself.
//!
//! The crate is pure (no NEAR SDK): the vault reads scopes and allowances from
//! its storage through [`permission::ScopeSource`] and
//! [`evaluate::AllowanceSource`], and persists the returned
//! [`types::Consumption`]s once the call is executed.

pub mod abi;
pub mod eip712;
pub mod encode;
pub mod evaluate;
pub mod monerium;
pub mod permission;
pub mod presets;
pub mod signature;
pub mod tree;
pub mod types;

pub use evaluate::{AllowanceSource, Context, evaluate};
pub use permission::{
    Call, Clearance, Environment, FunctionScope, RoleScope, ScopeSource, TargetScope, check_call,
};
pub use signature::{
    MessageKind, SignatureApproval, SignatureScope, SignatureScopeSource, check_monerium_order,
    check_typed_data,
};
pub use tree::{IntegrityError, Tree, validate};
pub use types::{
    Allowance, ConditionFlat, Consumption, Encoding, ExecutionOptions, Operation, Operator, Status,
};
