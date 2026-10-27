use near_sdk::{env, json_types::U128, require};
use omni_transaction::evm::types::Signature;
use omni_transaction::{EVM, TransactionBuilder, TxBuilder};

use crate::types::{
    Digest, Eip1559Transaction, EvmAddress, MpcSignature, OperationRequest, RoleConfig,
};

pub(crate) fn build_transaction(
    role: &RoleConfig,
    nonce: u64,
    request: &OperationRequest,
) -> (Eip1559Transaction, Digest) {
    validate_gas(
        role,
        request.gas_limit,
        request.max_fee_per_gas,
        request.max_priority_fee_per_gas,
    );
    let transaction = Eip1559Transaction {
        chain_id: request.chain_id,
        nonce,
        to: request.target,
        value: request.value,
        input: request.calldata.clone(),
        gas_limit: request.gas_limit,
        max_fee_per_gas: request.max_fee_per_gas,
        max_priority_fee_per_gas: request.max_priority_fee_per_gas,
    };
    let digest = signing_digest(&transaction);
    (transaction, digest)
}

/// Deterministic replacement fees: double both original fee fields, bounded by policy.
/// If policy cannot accommodate at least a 12.5% bump of both fields, fail before signing.
pub(crate) fn build_cancellation_transaction(
    role: &RoleConfig,
    original: &Eip1559Transaction,
    sender: EvmAddress,
) -> (Eip1559Transaction, Digest) {
    let gas_limit = U128(21_000);
    let cap = role
        .max_fee_per_gas
        .0
        .min(role.max_total_fee.0 / gas_limit.0);
    let bump = |value: u128, limit: u128| {
        let minimum = value
            .checked_add(value.div_ceil(8).max(1))
            .expect("ERR_CANCEL_FEE_OVERFLOW");
        let chosen = value.saturating_mul(2).max(1).min(limit);
        require!(chosen >= minimum, "ERR_CANCEL_FEE_CAP");
        chosen
    };
    let max_fee_per_gas = U128(bump(original.max_fee_per_gas.0, cap));
    let max_priority_fee_per_gas = U128(bump(
        original.max_priority_fee_per_gas.0,
        role.max_priority_fee_per_gas.0.min(max_fee_per_gas.0),
    ));
    validate_gas(role, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
    let transaction = Eip1559Transaction {
        chain_id: original.chain_id,
        nonce: original.nonce,
        to: sender,
        value: U128(0),
        input: Vec::new(),
        gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
    };
    let digest = signing_digest(&transaction);
    (transaction, digest)
}

pub(crate) fn signing_digest(transaction: &Eip1559Transaction) -> Digest {
    env::keccak256_array(unsigned_transaction(transaction).build_for_signing())
}

pub(crate) fn signed_transaction(
    transaction: &Eip1559Transaction,
    signature: &MpcSignature,
) -> Vec<u8> {
    unsigned_transaction(transaction).build_with_signature(&Signature {
        v: u64::from(signature.recovery_id),
        r: signature.big_r[1..].to_vec(),
        s: signature.s.to_vec(),
    })
}

fn validate_gas(
    role: &RoleConfig,
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
) {
    require!(gas_limit.0 <= role.gas_limit.0, "ERR_GAS_LIMIT");
    require!(
        max_fee_per_gas.0 <= role.max_fee_per_gas.0,
        "ERR_MAX_FEE_PER_GAS"
    );
    require!(
        max_priority_fee_per_gas.0 <= role.max_priority_fee_per_gas.0,
        "ERR_MAX_PRIORITY_FEE"
    );
    require!(
        max_priority_fee_per_gas.0 <= max_fee_per_gas.0,
        "ERR_PRIORITY_ABOVE_MAX_FEE"
    );
    let maximum_cost = max_fee_per_gas
        .0
        .checked_mul(gas_limit.0)
        .unwrap_or_else(|| env::panic_str("ERR_FEE_OVERFLOW"));
    require!(maximum_cost <= role.max_total_fee.0, "ERR_MAX_TOTAL_FEE");
}

fn unsigned_transaction(transaction: &Eip1559Transaction) -> omni_transaction::evm::EVMTransaction {
    TransactionBuilder::new::<EVM>()
        .chain_id(transaction.chain_id)
        .nonce(transaction.nonce)
        .to(transaction.to)
        .value(transaction.value.0)
        .input(transaction.input.clone())
        .gas_limit(transaction.gas_limit.0)
        .max_fee_per_gas(transaction.max_fee_per_gas.0)
        .max_priority_fee_per_gas(transaction.max_priority_fee_per_gas.0)
        .access_list(vec![])
        .build()
}
