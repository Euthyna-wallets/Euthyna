//! Sponsored execution on EVM chains (EIP-7702), opt-in per chain by a vote (`SetEvmExecutor`).
//!
//! The company wallet delegates its code to `EuthynaExecutor`. For an operation on that chain the
//! vault no longer has NEAR MPC sign a transaction from the wallet (which would pay its own gas):
//! it has it sign the EIP-712 `Execute(to, value, data, opId, deadline)` of the very same call,
//! with the very same role checks. Anyone (Euthyna's relayer) submits `execute(...)` to the
//! wallet and pays the gas; the wallet's code runs the call only with that signature, once per
//! operation id, before the deadline. The vault settles on the wallet's `Executed(opId)` log,
//! attested by NEAR MPC like the plain path's transaction (`settle_sponsored`).
//!
//! `prepare_with_approval` turns one call that spends a token (a swap) into a batch the wallet runs
//! under a single signature: `approve(spender, amount)`, the call, `approve(spender, 0)`. The
//! spender is always the call's target and the amount is checked against the role like any
//! approve; the revoke is added by the vault, so no approval outlives the call.
//!
//! Nothing here touches the plain path: no executor voted, nothing changes. Kept in raw storage
//! keys so the vault's state layout stays as it was.
use crate::types::{EvmAddress, MpcSignature, OperationRequest};
use crate::*;
use near_sdk::json_types::{U64, U128};

const KEY_EXECUTOR: &[u8] = b"spx:";
const KEY_OPERATION: &[u8] = b"spo:";
const KEY_DELEGATION: &[u8] = b"spd:";
/// Room between a sponsored operation's deadline and the release of its budget without a proof.
const RELEASE_MARGIN_NS: u64 = 10 * 60 * 1_000_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub struct SponsoredOperation {
    /// Unix seconds; `execute` refuses after it.
    pub deadline: u64,
    /// Set: the wallet runs approve + call + revoke (`executeBatch`) instead of the call alone.
    pub approval: Option<SponsoredApproval>,
}

/// The token the call's target may take from the wallet, and how much, for this call only.
#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub struct SponsoredApproval {
    pub token: EvmAddress,
    pub amount: U128,
}

/// One call of a batch: (to, value, data).
pub(crate) type BatchCall = (EvmAddress, u128, Vec<u8>);

/// The wallet's EIP-7702 authorization to the voted executor, signed by NEAR MPC.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct WalletDelegation {
    pub chain_id: u64,
    pub executor: EvmAddress,
    /// The wallet's nonce the authorization consumes.
    pub nonce: u64,
    pub digest: [u8; 32],
    pub signature: Option<MpcSignature>,
}

fn chain_key(prefix: &[u8], chain_id: u64) -> Vec<u8> {
    [prefix, &chain_id.to_le_bytes()].concat()
}
fn op_key(op_id: &OperationId) -> Vec<u8> {
    [KEY_OPERATION, op_id.as_slice()].concat()
}
fn read<T: borsh::BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|bytes| {
        borsh::from_slice(&bytes).unwrap_or_else(|_| env::panic_str("ERR_SPONSORED_STATE"))
    })
}
fn write<T: borsh::BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(
        key,
        &borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("ERR_SPONSORED_STATE")),
    );
}

pub(crate) fn executor_of(chain_id: u64) -> Option<EvmAddress> {
    read(&chain_key(KEY_EXECUTOR, chain_id))
}
pub(crate) fn operation(op_id: &OperationId) -> Option<SponsoredOperation> {
    read(&op_key(op_id))
}
pub(crate) fn is_sponsored(op_id: &OperationId) -> bool {
    env::storage_has_key(&op_key(op_id))
}
pub(crate) fn delegation_of(chain_id: u64) -> Option<WalletDelegation> {
    read(&chain_key(KEY_DELEGATION, chain_id))
}

pub(crate) fn set_executor(chain_id: u64, executor: Option<EvmAddress>) {
    match executor {
        Some(executor) => write(&chain_key(KEY_EXECUTOR, chain_id), &executor),
        None => {
            env::storage_remove(&chain_key(KEY_EXECUTOR, chain_id));
        }
    }
    // A delegation to another executor (or to none) is no longer the one to submit.
    if delegation_of(chain_id).is_some_and(|delegation| Some(delegation.executor) != executor) {
        env::storage_remove(&chain_key(KEY_DELEGATION, chain_id));
    }
    env::log_str(&format!(
        "OMNIROLES_EVM_EXECUTOR:{chain_id}:{}",
        executor.map_or_else(
            || "none".to_string(),
            |address| format!("0x{}", hex::encode(address))
        )
    ));
}

/// When the chain runs sponsored, the digest MPC signs for this operation (and the operation is
/// recorded as sponsored); `None` keeps the plain transaction digest.
pub(crate) fn digest_for(
    request: &OperationRequest,
    wallet: EvmAddress,
    op_id: &OperationId,
    expires_at_ns: u64,
    unconfirmed_after_ns: u64,
) -> Option<[u8; 32]> {
    executor_of(request.chain_id)?;
    // The relayer has at least half the unconfirmed window after the last moment it can be signed.
    let deadline = expires_at_ns.saturating_add(unconfirmed_after_ns / 2) / 1_000_000_000;
    write(
        &op_key(op_id),
        &SponsoredOperation {
            deadline,
            approval: None,
        },
    );
    Some(execute_digest(
        request.chain_id,
        wallet,
        request.target,
        request.value.0,
        &request.calldata,
        op_id,
        deadline,
    ))
}

/// The budget of a sponsored operation comes back without a proof only once `execute` refuses it.
pub(crate) fn assert_releasable(op_id: &OperationId) {
    if let Some(op) = operation(op_id) {
        require!(
            env::block_timestamp()
                >= op
                    .deadline
                    .saturating_mul(1_000_000_000)
                    .saturating_add(RELEASE_MARGIN_NS),
            "ERR_SPONSORED_DEADLINE_OPEN"
        );
    }
}

fn word_u(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}
fn word_u64(value: u64) -> [u8; 32] {
    word_u(u128::from(value))
}
fn word_address(address: &EvmAddress) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}
fn keccak(bytes: &[u8]) -> [u8; 32] {
    env::keccak256_array(bytes)
}

pub(crate) fn domain_separator(chain_id: u64, wallet: EvmAddress) -> [u8; 32] {
    let typehash = keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    keccak(
        &[
            typehash,
            keccak(b"EuthynaExecutor"),
            keccak(b"1"),
            word_u64(chain_id),
            word_address(&wallet),
        ]
        .concat(),
    )
}

pub(crate) fn execute_digest(
    chain_id: u64,
    wallet: EvmAddress,
    to: EvmAddress,
    value: u128,
    data: &[u8],
    op_id: &OperationId,
    deadline: u64,
) -> [u8; 32] {
    let typehash =
        keccak(b"Execute(address to,uint256 value,bytes data,bytes32 opId,uint256 deadline)");
    let struct_hash = keccak(
        &[
            typehash,
            word_address(&to),
            word_u(value),
            keccak(data),
            *op_id,
            word_u64(deadline),
        ]
        .concat(),
    );
    keccak(
        &[
            &[0x19u8, 0x01][..],
            &domain_separator(chain_id, wallet),
            &struct_hash,
        ]
        .concat(),
    )
}

/// `approve(spender, amount)` of an ERC-20.
pub(crate) fn approve_calldata(spender: &EvmAddress, amount: u128) -> Vec<u8> {
    [
        &[0x09u8, 0x5e, 0xa7, 0xb3][..],
        &word_address(spender),
        &word_u(amount),
    ]
    .concat()
}

/// approve + the call + revoke: what a sponsored operation with an approval runs.
pub(crate) fn batch_calls(
    request: &OperationRequest,
    approval: &SponsoredApproval,
) -> Vec<BatchCall> {
    vec![
        (
            approval.token,
            0,
            approve_calldata(&request.target, approval.amount.0),
        ),
        (request.target, request.value.0, request.calldata.clone()),
        (approval.token, 0, approve_calldata(&request.target, 0)),
    ]
}

/// EIP-712 `Batch(Call[] calls,bytes32 opId,uint256 deadline)` with `Call(address to,uint256 value,bytes data)`.
pub(crate) fn batch_digest(
    chain_id: u64,
    wallet: EvmAddress,
    calls: &[BatchCall],
    op_id: &OperationId,
    deadline: u64,
) -> [u8; 32] {
    let call_typehash = keccak(b"Call(address to,uint256 value,bytes data)");
    let batch_typehash = keccak(b"Batch(Call[] calls,bytes32 opId,uint256 deadline)Call(address to,uint256 value,bytes data)");
    let hashes: Vec<u8> = calls
        .iter()
        .flat_map(|(to, value, data)| {
            keccak(
                &[
                    call_typehash,
                    word_address(to),
                    word_u(*value),
                    keccak(data),
                ]
                .concat(),
            )
        })
        .collect();
    let struct_hash =
        keccak(&[batch_typehash, keccak(&hashes), *op_id, word_u64(deadline)].concat());
    keccak(
        &[
            &[0x19u8, 0x01][..],
            &domain_separator(chain_id, wallet),
            &struct_hash,
        ]
        .concat(),
    )
}

fn padded(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    out.resize(data.len() + (32 - data.len() % 32) % 32, 0);
    out
}

/// `executeBatch((address,uint256,bytes)[],bytes32,uint256,uint8,bytes32,bytes32)` with the MPC signature.
pub(crate) fn execute_batch_calldata(
    calls: &[BatchCall],
    op_id: &OperationId,
    deadline: u64,
    signature: &MpcSignature,
) -> Vec<u8> {
    let selector =
        &keccak(b"executeBatch((address,uint256,bytes)[],bytes32,uint256,uint8,bytes32,bytes32)")
            [..4];
    let mut r = [0u8; 32];
    r.copy_from_slice(&signature.big_r[1..33]);
    let mut out = selector.to_vec();
    for word in [
        word_u64(6 * 32),
        *op_id,
        word_u64(deadline),
        word_u64(27 + u64::from(signature.recovery_id)),
        r,
        signature.s,
    ] {
        out.extend_from_slice(&word);
    }
    // The array: length, one offset per tuple (from the start of the offsets), then the tuples.
    let tuples: Vec<Vec<u8>> = calls
        .iter()
        .map(|(to, value, data)| {
            [
                word_address(to),
                word_u(*value),
                word_u64(3 * 32),
                word_u64(data.len() as u64),
            ]
            .concat()
            .into_iter()
            .chain(padded(data))
            .collect()
        })
        .collect();
    out.extend_from_slice(&word_u64(calls.len() as u64));
    let mut offset = 32 * calls.len() as u64;
    for tuple in &tuples {
        out.extend_from_slice(&word_u64(offset));
        offset += tuple.len() as u64;
    }
    for tuple in tuples {
        out.extend(tuple);
    }
    out
}

/// What the relayer sends for a sponsored operation: `execute`, or `executeBatch` with an approval.
pub(crate) fn sponsored_calldata(
    request: &OperationRequest,
    op_id: &OperationId,
    sponsored: &SponsoredOperation,
    signature: &MpcSignature,
) -> Vec<u8> {
    match &sponsored.approval {
        Some(approval) => execute_batch_calldata(
            &batch_calls(request, approval),
            op_id,
            sponsored.deadline,
            signature,
        ),
        None => execute_calldata(request, op_id, sponsored.deadline, signature),
    }
}

/// `execute(address,uint256,bytes,bytes32,uint256,uint8,bytes32,bytes32)` with the MPC signature:
/// what the relayer sends to the wallet.
pub(crate) fn execute_calldata(
    request: &OperationRequest,
    op_id: &OperationId,
    deadline: u64,
    signature: &MpcSignature,
) -> Vec<u8> {
    let selector =
        &keccak(b"execute(address,uint256,bytes,bytes32,uint256,uint8,bytes32,bytes32)")[..4];
    let mut r = [0u8; 32];
    r.copy_from_slice(&signature.big_r[1..33]);
    let data = &request.calldata;
    let mut out = Vec::with_capacity(4 + 32 * 10 + data.len());
    out.extend_from_slice(selector);
    for word in [
        word_address(&request.target),
        word_u(request.value.0),
        word_u64(8 * 32), // offset of `data`: after the eight head words
        *op_id,
        word_u64(deadline),
        word_u64(27 + u64::from(signature.recovery_id)),
        r,
        signature.s,
        word_u64(data.len() as u64),
    ] {
        out.extend_from_slice(&word);
    }
    out.extend_from_slice(data);
    out.resize(out.len() + (32 - data.len() % 32) % 32, 0);
    out
}

fn rlp_uint(value: u64) -> Vec<u8> {
    if value == 0 {
        return vec![0x80];
    }
    let bytes = value.to_be_bytes();
    let trimmed: Vec<u8> = bytes.iter().copied().skip_while(|b| *b == 0).collect();
    if trimmed.len() == 1 && trimmed[0] < 0x80 {
        trimmed
    } else {
        [vec![0x80 + trimmed.len() as u8], trimmed].concat()
    }
}

/// EIP-7702: keccak256(0x05 || rlp([chain_id, address, nonce])).
pub(crate) fn authorization_digest(chain_id: u64, executor: EvmAddress, nonce: u64) -> [u8; 32] {
    let payload = [
        rlp_uint(chain_id),
        [vec![0x94], executor.to_vec()].concat(),
        rlp_uint(nonce),
    ]
    .concat();
    require!(payload.len() < 56, "ERR_RLP_LENGTH");
    keccak(&[vec![0x05, 0xc0 + payload.len() as u8], payload].concat())
}

/// Topic of `Executed(bytes32 indexed opId)`.
pub(crate) fn executed_topic() -> [u8; 32] {
    keccak(b"Executed(bytes32)")
}

/// The MPC ForeignTx V1 payload for "transaction `tx` is final in `block`, and its log `log_index`
/// is the wallet's `Executed(opId)`": what the vault expects NEAR MPC to sign.
#[allow(clippy::too_many_arguments)]
pub(crate) fn log_payload_hash(
    tag: u8,
    tx: [u8; 32],
    block: [u8; 32],
    block_number: u64,
    tx_index: u64,
    log_index: u64,
    wallet: EvmAddress,
    op_id: &OperationId,
) -> [u8; 32] {
    // `Executed(bytes32 indexed opId)` has no data: the node reports "0x".
    any_log_payload_hash(
        tag,
        tx,
        block,
        block_number,
        tx_index,
        log_index,
        wallet,
        "0x",
        &[executed_topic(), *op_id],
    )
}

#[allow(clippy::too_many_arguments)]
fn any_log_payload_hash(
    tag: u8,
    tx: [u8; 32],
    block: [u8; 32],
    block_number: u64,
    tx_index: u64,
    log_index: u64,
    address: EvmAddress,
    data: &str,
    topics: &[[u8; 32]],
) -> [u8; 32] {
    let mut p = vec![0, tag]; // V1; chain
    p.extend(tx);
    p.extend(2u32.to_le_bytes()); // extractors: [BlockHash, Log { log_index }]
    p.push(0);
    p.push(1);
    p.extend(log_index.to_le_bytes());
    p.push(2); // Finalized
    p.extend(2u32.to_le_bytes()); // values
    p.extend([1, 0]); // Evm::BlockHash
    p.extend(block);
    p.extend([1, 1, 0]); // Evm::Log, removed = false
    p.extend(log_index.to_le_bytes());
    p.extend(tx_index.to_le_bytes());
    p.extend(tx);
    p.extend(block);
    p.extend(block_number.to_le_bytes());
    p.extend(address);
    p.extend((data.len() as u32).to_le_bytes());
    p.extend(data.as_bytes());
    p.extend((topics.len() as u32).to_le_bytes());
    for topic in topics {
        p.extend(topic);
    }
    env::sha256_array(&p)
}

#[near]
impl Vault {
    /// The executor the wallet runs sponsored calls through on this chain (`SetEvmExecutor`).
    pub fn get_evm_executor(&self, chain_id: u64) -> Option<String> {
        executor_of(chain_id).map(|address| format!("0x{}", hex::encode(address)))
    }

    pub fn get_sponsored_operation(&self, op_id: OperationId) -> Option<SponsoredOperation> {
        operation(&op_id)
    }

    pub fn get_wallet_delegation(&self, chain_id: u64) -> Option<WalletDelegation> {
        delegation_of(chain_id)
    }

    /// `prepare` for a call that spends a token (a swap): the wallet approves the call's target for
    /// `approval.amount` of `approval.token`, runs the call, and revokes the approval, all under one
    /// signature and one transaction the relayer pays. The approve must be allowed by the same role
    /// (the budget of an approve permission is checked, not charged: the call is charged). Only on a
    /// chain with sponsored execution.
    pub fn prepare_with_approval(
        &mut self,
        role: String,
        request: OperationRequest,
        approval: SponsoredApproval,
    ) -> Operation {
        require!(
            executor_of(request.chain_id).is_some(),
            "ERR_APPROVAL_NEEDS_SPONSORED"
        );
        require!(approval.amount.0 > 0, "ERR_ZERO_APPROVAL");
        require!(
            approval.token != request.target,
            "ERR_APPROVAL_TOKEN_IS_TARGET"
        );
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let wallet = self
            .wallets
            .get(&request.chain_id)
            .and_then(|wallet| wallet.address)
            .expect("ERR_WALLET_NOT_DERIVED");
        let approve = OperationRequest {
            target: approval.token,
            value: U128(0),
            calldata: approve_calldata(&request.target, approval.amount.0),
            allowance_amount: approval.amount,
            ..request.clone()
        };
        let permissions = self
            .roles
            .get(&role)
            .map(|state| state.config.permissions.clone())
            .unwrap_or_default();
        let mut refusal = String::from("NoPermission");
        let allowed = permissions.iter().any(|permission| {
            match self.check_permission(permission, &approve, &member, &role, wallet, now) {
                Ok(_) => true,
                Err(reason) => {
                    refusal = Self::closer_refusal(std::mem::take(&mut refusal), reason);
                    false
                }
            }
        });
        require!(allowed, format!("ERR_APPROVAL_DENIED:{refusal}"));
        let mut prepared = self.prepare(role, request);
        let mut sponsored = operation(&prepared.op_id).expect("ERR_SPONSORED_STATE");
        let calls = batch_calls(&prepared.request, &approval);
        sponsored.approval = Some(approval);
        write(&op_key(&prepared.op_id), &sponsored);
        prepared.tx_digest = batch_digest(
            prepared.request.chain_id,
            wallet,
            &calls,
            &prepared.op_id,
            sponsored.deadline,
        );
        self.operations.insert(prepared.op_id, prepared.clone());
        prepared
    }

    /// Permissionless: has NEAR MPC sign the wallet's EIP-7702 authorization to the voted
    /// executor. It takes the wallet's next nonce, so no transaction of the wallet may be waiting.
    pub fn delegate_wallet(&mut self, chain_id: u64) -> Promise {
        self.assert_not_paused();
        let executor = executor_of(chain_id).expect("ERR_NO_EVM_EXECUTOR");
        let wallet = self
            .wallets
            .get_mut(&chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        require!(wallet.address.is_some(), "ERR_WALLET_NOT_DERIVED");
        let delegation = match delegation_of(chain_id) {
            Some(existing) if existing.executor == executor => {
                require!(existing.signature.is_none(), "ERR_ALREADY_DELEGATED");
                existing
            }
            _ => {
                require!(
                    wallet.active_operation.is_none() && wallet.in_flight.is_empty(),
                    "ERR_WALLET_QUEUE_BUSY"
                );
                let nonce = wallet.next_nonce;
                wallet.next_nonce = wallet.next_nonce.saturating_add(1);
                let delegation = WalletDelegation {
                    chain_id,
                    executor,
                    nonce,
                    digest: authorization_digest(chain_id, executor, nonce),
                    signature: None,
                };
                write(&chain_key(KEY_DELEGATION, chain_id), &delegation);
                delegation
            }
        };
        let path = wallet.mpc_path.clone();
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path,
                payload_v2: MpcPayload::Ecdsa(hex::encode(delegation.digest)),
                domain_id: MPC_DOMAIN_ID,
            })
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_CALLBACK_GAS)
                    .on_delegation_signature(chain_id, delegation.digest),
            )
    }

    #[private]
    pub fn on_delegation_signature(
        &mut self,
        chain_id: u64,
        digest: [u8; 32],
        #[callback_result] result: Result<MpcSignatureResponse, PromiseError>,
    ) {
        let Some(mut delegation) = delegation_of(chain_id) else {
            return;
        };
        if delegation.digest != digest || delegation.signature.is_some() {
            return;
        }
        let Ok(response) = result else { return };
        let Some(signature) = Self::parse_mpc_signature(response) else {
            return;
        };
        delegation.signature = Some(signature);
        write(&chain_key(KEY_DELEGATION, chain_id), &delegation);
        env::log_str(&format!(
            "OMNIROLES_WALLET_DELEGATED:{chain_id}:{}",
            delegation.nonce
        ));
    }

    /// Settles a sponsored operation from its `Executed(opId)` log. The hints (block, indexes) are
    /// untrusted: they are bound into the request NEAR MPC verifies against the chain.
    pub fn settle_sponsored(
        &mut self,
        op_id: OperationId,
        tx_hash: [u8; 32],
        block_hash: [u8; 32],
        block_number: U64,
        tx_index: U64,
        log_index: U64,
    ) -> Promise {
        let op = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            op.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        require!(is_sponsored(&op_id), "ERR_NOT_SPONSORED");
        let wallet = self
            .wallets
            .get(&op.request.chain_id)
            .and_then(|wallet| wallet.address)
            .expect("ERR_WALLET_NOT_DERIVED");
        let (name, tag) = foreign::chain(op.request.chain_id, self.settlement_config.mainnet);
        let expected = log_payload_hash(
            tag,
            tx_hash,
            block_hash,
            block_number.0,
            tx_index.0,
            log_index.0,
            wallet,
            &op_id,
        );
        let request = foreign::VerifyArgs::new(
            near_sdk::serde_json::json!({name: {
                "tx_id": hex::encode(tx_hash),
                "extractors": ["BlockHash", {"Log": {"log_index": log_index.0}}],
                "finality": "Finalized",
            }}),
            self.settlement_config.foreign_tx_domain_id,
            hex::encode(expected),
        );
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .verify_foreign_transaction(request)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_settle_sponsored_verified(op_id, expected),
            )
    }

    #[private]
    pub fn on_settle_sponsored_verified(
        &mut self,
        op_id: OperationId,
        expected_payload_hash: [u8; 32],
        #[callback_result] result: Result<foreign::VerifyResponse, PromiseError>,
    ) {
        let Some(op) = self.operations.get(&op_id) else {
            return;
        };
        if op.state != OperationState::PossiblySigned {
            return;
        }
        if result.is_ok_and(|response| response.payload_hash == hex::encode(expected_payload_hash))
        {
            self.release_operation(op_id, OperationState::Confirmed, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h32(text: &str) -> [u8; 32] {
        hex::decode(text.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap()
    }
    fn h20(text: &str) -> [u8; 20] {
        hex::decode(text.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap()
    }

    // Vectors from viem 2.x (hashTypedData, hashAuthorization, encodeFunctionData).
    // Vectors from viem 2.x: hashTypedData(Batch) and encodeFunctionData(executeBatch).
    #[test]
    fn batch_digest_and_calldata_match_viem() {
        let wallet = h20("0x1db9bad1d7f4effed814dfc7a0dc5d5aef0f2303");
        let usdc = h20("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        let router = h20("0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4");
        let mut swap = vec![0x04, 0xe4, 0x5a, 0xaf];
        swap.extend([0x11u8; 37]);
        let request = OperationRequest {
            chain_id: 84532,
            target: router,
            value: U128(5),
            calldata: swap,
            allowance_amount: U128(0),
            reference: "r".into(),
            gas_limit: U128(0),
            max_fee_per_gas: U128(0),
            max_priority_fee_per_gas: U128(0),
        };
        let approval = SponsoredApproval {
            token: usdc,
            amount: U128(4_000_000),
        };
        let calls = batch_calls(&request, &approval);
        assert_eq!(
            hex::encode(&calls[0].2),
            "095ea7b300000000000000000000000094cc0aac535ccdb3c01d6787d6413c739ae12bc400000000000000000000000000000000000000000000000000000000003d0900"
        );
        let op_id = [0xab; 32];
        assert_eq!(
            hex::encode(batch_digest(84532, wallet, &calls, &op_id, 1794242060)),
            "4558b98c1c2ca713c373d288b1605d1c28bff539a2c5f6c54f213a482437df16"
        );
        let signature = MpcSignature {
            big_r: [vec![2], vec![1; 32]].concat(),
            s: [2; 32],
            recovery_id: 1,
        };
        let sponsored = SponsoredOperation {
            deadline: 1794242060,
            approval: Some(approval),
        };
        assert_eq!(
            hex::encode(sponsored_calldata(&request, &op_id, &sponsored, &signature)),
            "3b1e551800000000000000000000000000000000000000000000000000000000000000c0abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000006af1f60c000000000000000000000000000000000000000000000000000000000000001c010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000200000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000094cc0aac535ccdb3c01d6787d6413c739ae12bc400000000000000000000000000000000000000000000000000000000003d09000000000000000000000000000000000000000000000000000000000000000000000000000000000094cc0aac535ccdb3c01d6787d6413c739ae12bc400000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000002904e45aaf111111111111111111111111111111111111111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b300000000000000000000000094cc0aac535ccdb3c01d6787d6413c739ae12bc4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn execute_digest_matches_eip712() {
        let data = hex::decode("a9059cbb000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000004c4b40").unwrap();
        let digest = execute_digest(
            84532,
            h20("1be62b8a7425b076898000b02c12a401c5068e1d"),
            h20("036CbD53842c5426634e7929541eC2318f3dCF7e"),
            7,
            &data,
            &[0xab; 32],
            1_794_200_000,
        );
        assert_eq!(
            hex::encode(digest),
            "ff55052e7a6b0847eb65ff7ed598a29d08287341df23e95a0e37319f771996ac"
        );
    }

    #[test]
    fn authorization_digest_matches_eip7702() {
        let executor = h20("2Bf22f0C5aDDDE4f0ec41C6790EC47eB46508982");
        assert_eq!(
            hex::encode(authorization_digest(84532, executor, 0)),
            "fb9cf7e4549b367d8262244967a8ffc33975e7c4b81145a07271588c2a2393b5"
        );
        assert_eq!(
            hex::encode(authorization_digest(84532, executor, 300)),
            "c2b831deb4e5a3c5a6ad398e097a97909778b348489a521d87f0d9b44ba96c2f"
        );
    }

    #[test]
    fn calldata_matches_the_abi() {
        let request = OperationRequest {
            chain_id: 84532,
            target: h20("036CbD53842c5426634e7929541eC2318f3dCF7e"),
            value: U128(7),
            calldata: hex::decode("a9059cbb000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000004c4b40").unwrap(),
            allowance_amount: U128(0),
            reference: "r".into(),
            gas_limit: U128(0),
            max_fee_per_gas: U128(0),
            max_priority_fee_per_gas: U128(0),
        };
        let mut big_r = vec![2u8];
        big_r.extend([0x11; 32]);
        let signature = MpcSignature {
            big_r,
            s: [0x22; 32],
            recovery_id: 1,
        };
        let calldata = execute_calldata(&request, &[0xab; 32], 1_794_200_000, &signature);
        assert_eq!(
            hex::encode(calldata),
            "862ca979000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000100abababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000006af151c0000000000000000000000000000000000000000000000000000000000000001c111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000004c4b4000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn executed_topic_is_the_event_signature() {
        assert_eq!(
            hex::encode(executed_topic()),
            "a74c8847d513feba22a0f0cb38d53081abf97562cdb293926ba243689e7c41ca"
        );
    }

    /// The payload NEAR MPC (v1.signer-prod.testnet) signed on 9 Nov 2026 for a log of Base Sepolia
    /// transaction 0x0eef2dd1…: NEAR transaction GMm1Bbb3rURyjZzM8zDZiZjtPyd2wVzxafbqxpC4MFW.
    #[test]
    fn log_payload_hash_is_what_mpc_signed_on_testnet() {
        let hash = any_log_payload_hash(
            6,
            h32("0eef2dd1f229f0f0d7731a383df2176426d6b8b7113a591046a186817010c8e6"),
            h32("644e12ba198923de592b7e069d47fd57b8c650ea8579b1b9b169a1e070f38427"),
            55_802_747,
            2,
            0,
            h20("623ef90571256f905b2fde947dc33098bdd8f4d8"),
            "0x00000000000000000000000000000000000000000000000000000000004c4b40",
            &[
                h32("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"),
                h32("0000000000000000000000008b22b9fa3a6c541d80bf0c7e1e02a267c8c29de6"),
                h32("00000000000000000000000053b3fd8a86f23f3d503bbc994f26e50ecfc903e3"),
            ],
        );
        assert_eq!(
            hex::encode(hash),
            "8bbcab92798aeebc45412452ebd2261051fab42a83120a86fd513f16a48b9dd7"
        );
    }
}
