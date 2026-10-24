//! Role scopes: which targets and functions a role may call, and how.
//!
//! Resolution order for a call to `to` with selector `sel`:
//! 1. the target is cleared as a whole (`Clearance::Target`): its options and
//!    optional target-wide conditions apply;
//! 2. the target is scoped per function (`Clearance::Function`): the entry for
//!    `(to, sel)` applies, otherwise a global entry for `sel` (OmniRoles
//!    extension: the same function allowed on any target, still subject to
//!    its conditions), otherwise the call is refused;
//! 3. an unknown target may only match a global function entry.
//!
//! Calldata shorter than a selector is refused, except empty calldata (plain
//! native transfer), which is resolved with the selector `0x00000000`.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};

use crate::evaluate::{AllowanceSource, Context, evaluate};
use crate::types::{ConditionFlat, Consumption, ExecutionOptions, Operation, Status};

pub type Address = [u8; 20];
pub type Selector = [u8; 4];

/// Selector used to resolve a call with empty calldata.
pub const EMPTY_CALLDATA_SELECTOR: Selector = [0; 4];

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Clearance {
    /// Any function of the target.
    Target = 1,
    /// Only the functions scoped for this target.
    Function = 2,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct TargetScope {
    pub clearance: Clearance,
    /// Used with `Clearance::Target`.
    pub options: ExecutionOptions,
    /// Target-wide conditions, used with `Clearance::Target`.
    pub conditions: Option<Vec<ConditionFlat>>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct FunctionScope {
    pub options: ExecutionOptions,
    /// `None`: any parameters (wildcarded function).
    pub conditions: Option<Vec<ConditionFlat>>,
}

/// Where a role's scopes are read from (vault storage, tests).
pub trait ScopeSource {
    fn target(&self, to: &Address) -> Option<TargetScope>;
    fn function(&self, to: &Address, selector: &Selector) -> Option<FunctionScope>;
    fn global_function(&self, selector: &Selector) -> Option<FunctionScope>;
}

/// In-memory role scope.
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct RoleScope {
    pub targets: BTreeMap<Address, TargetScope>,
    pub functions: BTreeMap<(Address, Selector), FunctionScope>,
    pub global_functions: BTreeMap<Selector, FunctionScope>,
    /// EIP-712 scopes keyed by (domain separator, primary type hash).
    pub typed_data: BTreeMap<([u8; 32], [u8; 32]), crate::signature::SignatureScope>,
    /// `personal_sign` scopes keyed by message kind.
    pub messages: BTreeMap<crate::signature::MessageKind, crate::signature::SignatureScope>,
}

impl ScopeSource for RoleScope {
    fn target(&self, to: &Address) -> Option<TargetScope> {
        self.targets.get(to).cloned()
    }
    fn function(&self, to: &Address, selector: &Selector) -> Option<FunctionScope> {
        self.functions.get(&(*to, *selector)).cloned()
    }
    fn global_function(&self, selector: &Selector) -> Option<FunctionScope> {
        self.global_functions.get(selector).cloned()
    }
}

/// One call a role member wants the wallet to make.
pub struct Call<'a> {
    pub to: Address,
    pub value: u128,
    pub data: &'a [u8],
    pub operation: Operation,
}

/// Wallet-level facts the check needs.
pub struct Environment<'a> {
    pub avatar: Address,
    pub now: u64,
    pub allowances: &'a dyn AllowanceSource,
}

/// Check a call against a role. On success, returns the allowance
/// consumptions to persist once the call is executed.
pub fn check_call(
    scope: &dyn ScopeSource,
    call: &Call,
    environment: &Environment,
) -> Result<Vec<Consumption>, Status> {
    let selector = selector_of(call.data)?;
    let (options, conditions) = resolve(scope, &call.to, &selector)?;
    if call.operation == Operation::DelegateCall && !options.allows_delegate_call() {
        return Err(Status::DelegateCallNotAllowed);
    }
    if call.value > 0 && !options.allows_send() {
        return Err(Status::SendNotAllowed);
    }
    let Some(conditions) = conditions else {
        return Ok(Vec::new());
    };
    let context = Context {
        calldata: call.data,
        value: call.value,
        avatar: environment.avatar,
        now: environment.now,
        allowances: environment.allowances,
    };
    evaluate(&conditions, &context)
}

fn selector_of(data: &[u8]) -> Result<Selector, Status> {
    match data.len() {
        0 => Ok(EMPTY_CALLDATA_SELECTOR),
        1..=3 => Err(Status::CalldataTooShort),
        _ => Ok(data[..4].try_into().expect("4 bytes")),
    }
}

fn resolve(
    scope: &dyn ScopeSource,
    to: &Address,
    selector: &Selector,
) -> Result<(ExecutionOptions, Option<Vec<ConditionFlat>>), Status> {
    let function = |scope: &dyn ScopeSource| {
        scope
            .function(to, selector)
            .or_else(|| scope.global_function(selector))
    };
    match scope.target(to) {
        Some(TargetScope {
            clearance: Clearance::Target,
            options,
            conditions,
        }) => Ok((options, conditions)),
        Some(TargetScope {
            clearance: Clearance::Function,
            ..
        }) => function(scope)
            .map(|entry| (entry.options, entry.conditions))
            .ok_or(Status::FunctionNotAllowed),
        None => scope
            .global_function(selector)
            .map(|entry| (entry.options, entry.conditions))
            .ok_or(Status::TargetNotAllowed),
    }
}
