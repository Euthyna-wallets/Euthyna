use near_sdk::{env, json_types::U128, require};
use omni_transaction::evm::types::Signature;
use omni_transaction::{EVM, TransactionBuilder, TxBuilder};

use crate::types::{Digest, Eip1559Transaction, EvmAddress, MpcSignature};

const EXEC_FROM_MODULE_SELECTOR: [u8; 4] = [0x46, 0x87, 0x21, 0xa7];
const DELAY_HEAD_SIZE: usize = 4 * 32;

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_delay_transaction(
    chain_id: u64,
    delay: EvmAddress,
    nonce: u64,
    target: EvmAddress,
    value: U128,
    data: &[u8],
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
    max_gas_limit: U128,
    max_fee_cap: U128,
    max_priority_fee_cap: U128,
    max_total_fee: U128,
) -> (Eip1559Transaction, Digest) {
    validate_fees(
        gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        max_gas_limit,
        max_fee_cap,
        max_priority_fee_cap,
        max_total_fee,
    );
    let transaction = Eip1559Transaction {
        chain_id,
        nonce,
        to: delay,
        value: U128(0),
        input: encode_delay_call(target, value.0, data),
        gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
    };
    let digest = signing_digest(&transaction);
    (transaction, digest)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_cancellation_transaction(
    chain_id: u64,
    nonce: u64,
    sender: EvmAddress,
    previous_fee: u128,
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
    max_gas_limit: U128,
    max_fee_cap: U128,
    max_priority_fee_cap: U128,
    max_total_fee: U128,
) -> (Eip1559Transaction, Digest) {
    require!(gas_limit.0 >= 21_000, "ERR_CANCEL_GAS_TOO_LOW");
    require!(
        max_fee_per_gas.0 > previous_fee,
        "ERR_CANCEL_FEE_NOT_HIGHER"
    );
    validate_fees(
        gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        max_gas_limit,
        max_fee_cap,
        max_priority_fee_cap,
        max_total_fee,
    );
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

fn validate_fees(
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
    max_gas_limit: U128,
    max_fee_cap: U128,
    max_priority_fee_cap: U128,
    max_total_fee: U128,
) {
    require!(gas_limit.0 <= max_gas_limit.0, "ERR_GAS_LIMIT");
    require!(max_fee_per_gas.0 <= max_fee_cap.0, "ERR_MAX_FEE_PER_GAS");
    require!(
        max_priority_fee_per_gas.0 <= max_priority_fee_cap.0,
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
    require!(maximum_cost <= max_total_fee.0, "ERR_MAX_TOTAL_FEE");
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

fn encode_delay_call(target: EvmAddress, value: u128, data: &[u8]) -> Vec<u8> {
    let padded_data_len = data.len().div_ceil(32) * 32;
    let mut encoded = Vec::with_capacity(4 + DELAY_HEAD_SIZE + 32 + padded_data_len);
    encoded.extend_from_slice(&EXEC_FROM_MODULE_SELECTOR);
    encoded.extend_from_slice(&word_address(target));
    encoded.extend_from_slice(&word_u128(value));
    encoded.extend_from_slice(&word_u128(DELAY_HEAD_SIZE as u128));
    encoded.extend_from_slice(&[0u8; 32]);
    encoded.extend_from_slice(&word_u128(data.len() as u128));
    encoded.extend_from_slice(data);
    encoded.resize(4 + DELAY_HEAD_SIZE + 32 + padded_data_len, 0);
    encoded
}

fn word_address(address: EvmAddress) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(&address);
    word
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}
