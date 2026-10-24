use near_sdk::AccountId;

use crate::types::EvmAddress;

/// Stable boundary between the OmniRoles vault and the condition engine built in
/// `contracts/omniroles-conditions`. The boundary intentionally contains only
/// primitive, chain-independent values so the evaluator crate can be integrated
/// without coupling it to vault storage.
#[derive(Clone, Debug)]
pub(crate) struct EvaluationContext<'a> {
    pub member: &'a AccountId,
    pub role: &'a str,
    pub chain_id: u64,
    pub wallet: EvmAddress,
    pub target: EvmAddress,
    pub value: u128,
    pub block_timestamp_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EvaluationError {
    EngineUnavailable,
}

/// Evaluates a flattened Roles-compatible condition tree against raw calldata.
///
/// Task 1a supports unconditional permissions only. Non-empty condition trees
/// fail closed until task 1b wires `omniroles-conditions::evaluate` here. This is
/// a security boundary, not a permissive placeholder.
pub(crate) fn evaluate(
    conditions: &[u8],
    _calldata: &[u8],
    context: &EvaluationContext<'_>,
) -> Result<bool, EvaluationError> {
    let _ = (
        context.member,
        context.role,
        context.chain_id,
        context.wallet,
        context.target,
        context.value,
        context.block_timestamp_ns,
    );
    if conditions.is_empty() {
        Ok(true)
    } else {
        Err(EvaluationError::EngineUnavailable)
    }
}
