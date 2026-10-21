use near_sdk::{env, json_types::U128, require};
use omni_transaction::evm::types::Signature;
use omni_transaction::{EVM, TransactionBuilder, TxBuilder};

use crate::types::{
    Digest, Eip1559Transaction, EvmAddress, MpcSignature, PaymentIntent, RoleConfig,
};

const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const EXEC_TRANSACTION_WITH_ROLE_SELECTOR: [u8; 4] = [0xc6, 0xfe, 0x87, 0x47];
const EXEC_HEAD_SIZE: usize = 6 * 32;

pub(crate) fn build_transaction(
    chain_id: u64,
    role: &RoleConfig,
    nonce: u64,
    intent: &PaymentIntent,
) -> (Eip1559Transaction, Digest) {
    require!(intent.token == role.token, "ERR_TOKEN_NOT_ALLOWED");
    require!(
        role.allowed_recipients.contains(&intent.recipient),
        "ERR_RECIPIENT_NOT_ALLOWED"
    );
    require!(intent.amount.0 <= role.max_per_tx.0, "ERR_MAX_PER_TX");
    require!(intent.gas_limit.0 <= role.gas_limit.0, "ERR_GAS_LIMIT");
    require!(
        intent.max_fee_per_gas.0 <= role.max_fee_per_gas.0,
        "ERR_MAX_FEE_PER_GAS"
    );
    require!(
        intent.max_priority_fee_per_gas.0 <= role.max_priority_fee_per_gas.0,
        "ERR_MAX_PRIORITY_FEE"
    );
    require!(
        intent.max_priority_fee_per_gas.0 <= intent.max_fee_per_gas.0,
        "ERR_PRIORITY_ABOVE_MAX_FEE"
    );
    let maximum_cost = intent
        .max_fee_per_gas
        .0
        .checked_mul(intent.gas_limit.0)
        .unwrap_or_else(|| env::panic_str("ERR_FEE_OVERFLOW"));
    require!(maximum_cost <= role.max_total_fee.0, "ERR_MAX_TOTAL_FEE");

    let input = encode_exec_transaction_with_role(role, intent);
    let transaction = Eip1559Transaction {
        chain_id,
        nonce,
        to: role.roles_modifier,
        value: 0.into(),
        input,
        gas_limit: intent.gas_limit,
        max_fee_per_gas: intent.max_fee_per_gas,
        max_priority_fee_per_gas: intent.max_priority_fee_per_gas,
    };
    let digest = signing_digest(&transaction);
    (transaction, digest)
}

pub(crate) fn build_cancellation_transaction(
    chain_id: u64,
    role: &RoleConfig,
    nonce: u64,
    sender: EvmAddress,
    original_max_fee_per_gas: u128,
    gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
) -> (Eip1559Transaction, Digest) {
    require!(gas_limit.0 >= 21_000, "ERR_CANCEL_GAS_TOO_LOW");
    require!(gas_limit.0 <= role.gas_limit.0, "ERR_GAS_LIMIT");
    require!(
        max_fee_per_gas.0 > original_max_fee_per_gas,
        "ERR_CANCEL_FEE_NOT_HIGHER"
    );
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
    let transaction = Eip1559Transaction {
        chain_id,
        nonce,
        to: sender,
        value: 0.into(),
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

fn encode_exec_transaction_with_role(role: &RoleConfig, intent: &PaymentIntent) -> Vec<u8> {
    let transfer = encode_erc20_transfer(intent.recipient, intent.amount.0);
    let padded_transfer_len = transfer.len().div_ceil(32) * 32;
    let mut data = Vec::with_capacity(4 + EXEC_HEAD_SIZE + 32 + padded_transfer_len);
    data.extend_from_slice(&EXEC_TRANSACTION_WITH_ROLE_SELECTOR);
    push_address_word(&mut data, &role.token);
    push_u128_word(&mut data, 0);
    push_u128_word(&mut data, EXEC_HEAD_SIZE as u128);
    push_u128_word(&mut data, 0);
    data.extend_from_slice(&role.role_key);
    push_u128_word(&mut data, 1);
    push_u128_word(&mut data, transfer.len() as u128);
    data.extend_from_slice(&transfer);
    data.resize(4 + EXEC_HEAD_SIZE + 32 + padded_transfer_len, 0);
    data
}

fn encode_erc20_transfer(recipient: EvmAddress, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    push_address_word(&mut data, &recipient);
    push_u128_word(&mut data, amount);
    data
}

fn push_address_word(output: &mut Vec<u8>, address: &EvmAddress) {
    output.extend_from_slice(&[0u8; 12]);
    output.extend_from_slice(address);
}

fn push_u128_word(output: &mut Vec<u8>, value: u128) {
    output.extend_from_slice(&[0u8; 16]);
    output.extend_from_slice(&value.to_be_bytes());
}
