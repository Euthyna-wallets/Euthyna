use near_sdk::AccountId;
use near_sdk::store::LookupMap;
use omniroles_conditions::{
    Allowance as EngineAllowance, AllowanceSource, ConditionFlat, Consumption, Context, Status,
};

use crate::Vault;
use crate::types::{Allowance, AllowanceKey, EvmAddress};

/// Boundary between the OmniRoles vault and the condition engine
/// (`contracts/omniroles-conditions`). Only primitive, chain-independent values
/// cross it, so the engine stays independent of vault storage.
#[derive(Clone)]
pub(crate) struct EvaluationContext<'a> {
    pub member: &'a AccountId,
    pub role: &'a str,
    pub chain_id: u64,
    pub wallet: EvmAddress,
    pub target: EvmAddress,
    pub address_lists: &'a dyn omniroles_conditions::AddressListSource,
    pub value: u128,
    pub block_timestamp_ns: u64,
}

/// Allowances as the engine sees them: refilled up to `now`, minus what pending
/// operations already reserved. The engine never accrues them itself (period 0).
pub(crate) struct ReservedAllowances<'a> {
    pub allowances: &'a LookupMap<AllowanceKey, Allowance>,
    pub now: u64,
    pub own: &'a [crate::AllowanceConsumption],
}

impl AllowanceSource for ReservedAllowances<'_> {
    fn allowance(&self, key: &[u8; 32]) -> Option<EngineAllowance> {
        let mut allowance = self.allowances.get(key)?.clone();
        Vault::refill_allowance(&mut allowance, self.now);
        Some(EngineAllowance {
            refill: 0,
            max_refill: 0,
            period: 0,
            balance: allowance
                .balance
                .0
                .saturating_sub(allowance.reserved.0)
                .saturating_add(
                    self.own
                        .iter()
                        .filter(|c| &c.key == key)
                        .map(|c| c.amount.0)
                        .sum::<u128>(),
                ),
            timestamp: 0,
        })
    }
}

/// Evaluate a flattened OmniRoles condition tree on the exact calldata
/// and value. Empty conditions are unconditional. On success, returns the
/// allowance consumptions the vault must reserve.
pub(crate) fn evaluate(
    conditions: &[ConditionFlat],
    calldata: &[u8],
    context: &EvaluationContext<'_>,
    allowances: &dyn AllowanceSource,
) -> Result<Vec<Consumption>, Status> {
    let _ = (
        context.member,
        context.role,
        context.chain_id,
        context.target,
    );
    if conditions.is_empty() {
        return Ok(Vec::new());
    }
    omniroles_conditions::evaluate(
        conditions,
        &Context {
            calldata,
            value: context.value,
            avatar: context.wallet,
            now: context.block_timestamp_ns,
            allowances,
            address_lists: context.address_lists,
        },
    )
}

impl omniroles_conditions::AddressListSource for crate::Vault {
    fn contains(&self, list: &[u8], address: &[u8; 20]) -> bool {
        std::str::from_utf8(list)
            .ok()
            .and_then(|name| self.address_lists.get(name))
            .is_some_and(|entries| entries.iter().any(|entry| &entry.address == address))
    }
}
