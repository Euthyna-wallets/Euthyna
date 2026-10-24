use near_sdk::{env, json_types::U128, require};
use omni_transaction::evm::types::Signature;
use omni_transaction::{EVM, TransactionBuilder, TxBuilder};

use crate::types::{
    Digest, Eip1559Transaction, EvmAddress, MpcSignature, OperationRequest, RoleConfig,
};

const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

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

pub(crate) fn build_cancellation_transaction(
    role: &RoleConfig,
    chain_id: u64,
    nonce: u64,
    sender: EvmAddress,
    original_max_fee_per_gas: u128,
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
) -> (Eip1559Transaction, Digest) {
    require!(gas_limit.0 >= 21_000, "ERR_CANCEL_GAS_TOO_LOW");
    require!(
        max_fee_per_gas.0 > original_max_fee_per_gas,
        "ERR_CANCEL_FEE_NOT_HIGHER"
    );
    validate_gas(role, gas_limit, max_fee_per_gas, max_priority_fee_per_gas);
    let transaction = Eip1559Transaction {
        chain_id,
        nonce,
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

/// Returns `(recipient, amount)` for canonical ERC-20 `transfer(address,uint256)`
/// calldata when the amount fits OmniRoles' u128 accounting domain.
pub(crate) fn decode_erc20_transfer(calldata: &[u8]) -> Option<(EvmAddress, u128)> {
    if calldata.len() != 68 || calldata[..4] != ERC20_TRANSFER_SELECTOR {
        return None;
    }
    if calldata[4..16].iter().any(|byte| *byte != 0)
        || calldata[36..52].iter().any(|byte| *byte != 0)
    {
        return None;
    }
    let recipient = calldata[16..36].try_into().ok()?;
    let amount = u128::from_be_bytes(calldata[52..68].try_into().ok()?);
    Some((recipient, amount))
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
