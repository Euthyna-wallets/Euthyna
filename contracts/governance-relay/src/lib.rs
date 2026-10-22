mod evm;
mod types;

use near_sdk::borsh::to_vec;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, ext_contract, near,
    require,
};

pub use types::{
    CancellationAttempt, Eip1559Transaction, GovernanceOperation, MpcSignature, OperationState,
    SignedStatusReport, StatusKind, StatusReport,
};
use types::{EvmAddress, MpcPayload, MpcSignRequest, MpcSignatureResponse, OperationId};

const STATUS_DOMAIN: &[u8] = b"mandateos:relay-status:v1";
const MPC_DOMAIN_ID: u64 = 0;
const MPC_SIGN_GAS: Gas = Gas::from_tgas(15);
const MPC_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const MPC_DERIVE_GAS: Gas = Gas::from_tgas(10);
const MPC_DERIVE_CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[allow(dead_code)]
#[ext_contract(ext_mpc)]
trait ExtMpc {
    fn sign(&mut self, request: MpcSignRequest) -> MpcSignatureResponse;
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_mpc_signature(&mut self, op_id: OperationId);
    fn on_cancel_signature(&mut self, op_id: OperationId, tx_digest: [u8; 32]);
    fn on_derived_public_key(&mut self);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct GovernanceRelay {
    client_id: String,
    owner_id: AccountId,
    mpc_contract_id: AccountId,
    mpc_path: String,
    evm_chain_id: u64,
    delay_address: EvmAddress,
    multisend_address: EvmAddress,
    guard_public_key: [u8; 32],
    max_gas_limit: U128,
    max_fee_per_gas: U128,
    max_priority_fee_per_gas: U128,
    max_total_fee: U128,
    derived_public_key: Option<String>,
    evm_address: Option<EvmAddress>,
    operation_sequence: u64,
    next_evm_nonce: u64,
    active_operation: Option<OperationId>,
    operations: LookupMap<OperationId, GovernanceOperation>,
    used_report_nonces: LookupSet<u64>,
}

#[near]
impl GovernanceRelay {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client_id: String,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
        mpc_path: String,
        evm_chain_id: u64,
        delay_address: Base64VecU8,
        multisend_address: Base64VecU8,
        guard_public_key: Base64VecU8,
        max_gas_limit: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        max_total_fee: U128,
    ) -> Self {
        require!(!client_id.is_empty(), "ERR_EMPTY_CLIENT_ID");
        require!(!mpc_path.is_empty(), "ERR_EMPTY_MPC_PATH");
        require!(evm_chain_id > 0, "ERR_ZERO_CHAIN_ID");
        let delay_address = bytes20(delay_address, "ERR_DELAY_ADDRESS");
        let multisend_address = bytes20(multisend_address, "ERR_MULTISEND_ADDRESS");
        let guard_public_key = bytes32(guard_public_key, "ERR_GUARD_KEY");
        Self {
            client_id,
            owner_id,
            mpc_contract_id,
            mpc_path,
            evm_chain_id,
            delay_address,
            multisend_address,
            guard_public_key,
            max_gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            max_total_fee,
            derived_public_key: None,
            evm_address: None,
            operation_sequence: 0,
            next_evm_nonce: 0,
            active_operation: None,
            operations: LookupMap::new(b"o".to_vec()),
            used_report_nonces: LookupSet::new(b"r".to_vec()),
        }
    }

    pub fn client_id(&self) -> String {
        self.client_id.clone()
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn evm_chain_id(&self) -> u64 {
        self.evm_chain_id
    }

    pub fn mpc_contract_id(&self) -> AccountId {
        self.mpc_contract_id.clone()
    }

    pub fn mpc_path(&self) -> String {
        self.mpc_path.clone()
    }

    pub fn delay_address(&self) -> Base64VecU8 {
        Base64VecU8(self.delay_address.to_vec())
    }
    pub fn multisend_address(&self) -> Base64VecU8 {
        Base64VecU8(self.multisend_address.to_vec())
    }

    pub fn guard_public_key(&self) -> Base64VecU8 {
        Base64VecU8(self.guard_public_key.to_vec())
    }

    pub fn evm_address(&self) -> Option<Base64VecU8> {
        self.evm_address
            .map(|address| Base64VecU8(address.to_vec()))
    }

    pub fn derived_public_key(&self) -> Option<String> {
        self.derived_public_key.clone()
    }

    pub fn next_evm_nonce(&self) -> u64 {
        self.next_evm_nonce
    }

    pub fn active_operation(&self) -> Option<OperationId> {
        self.active_operation
    }

    pub fn get_operation(&self, op_id: OperationId) -> Option<GovernanceOperation> {
        self.operations.get(&op_id).cloned()
    }

    pub fn request_derived_public_key(&self) -> Promise {
        self.assert_owner();
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(MPC_DERIVE_GAS)
            .derived_public_key(
                self.mpc_path.clone(),
                Some(env::current_account_id()),
                Some(MPC_DOMAIN_ID),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_DERIVE_CALLBACK_GAS)
                    .on_derived_public_key(),
            )
    }

    #[private]
    pub fn on_derived_public_key(
        &mut self,
        #[callback_result] result: Result<String, PromiseError>,
    ) {
        let public_key = result.unwrap_or_else(|_| env::panic_str("ERR_DERIVE_KEY_FAILED"));
        self.evm_address = Some(derive_evm_address(&public_key));
        self.derived_public_key = Some(public_key);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn propose(
        &mut self,
        target: Base64VecU8,
        value: U128,
        data: Base64VecU8,
        operation: u8,
        gas_limit: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        self.assert_owner();
        require!(self.active_operation.is_none(), "ERR_ACTIVE_OPERATION");
        require!(self.evm_address.is_some(), "ERR_KEY_NOT_DERIVED");
        let target = bytes20(target, "ERR_TARGET_ADDRESS");
        require!(operation <= 1, "ERR_OPERATION");
        require!(
            operation == 0 || target == self.multisend_address,
            "ERR_DELEGATECALL_TARGET"
        );
        let nonce = self.next_evm_nonce;
        let (transaction, tx_digest) = evm::build_delay_transaction(
            self.evm_chain_id,
            self.delay_address,
            nonce,
            target,
            value,
            &data.0,
            operation,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            self.max_gas_limit,
            self.max_fee_per_gas,
            self.max_priority_fee_per_gas,
            self.max_total_fee,
        );
        let op_id = self.next_operation_id();
        let operation = GovernanceOperation {
            op_id,
            proposer: env::predecessor_account_id(),
            target,
            value,
            data: data.0,
            operation,
            evm_nonce: nonce,
            transaction,
            tx_digest,
            possibly_signed_at_block: env::block_height(),
            state: OperationState::PossiblySigned,
            signature: None,
            signed_transaction: None,
            cancellation: None,
        };
        self.next_evm_nonce = nonce.saturating_add(1);
        self.active_operation = Some(op_id);
        self.operations.insert(op_id, operation.clone());
        self.sign_digest(op_id, operation.tx_digest, false)
    }

    #[private]
    pub fn on_mpc_signature(
        &mut self,
        op_id: OperationId,
        #[callback_result] result: Result<MpcSignatureResponse, PromiseError>,
    ) {
        let operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        if operation.state != OperationState::PossiblySigned {
            return;
        }
        let Ok(response) = result else {
            return;
        };
        let Some(signature) = parse_mpc_signature(response) else {
            return;
        };
        let signed_transaction = evm::signed_transaction(&operation.transaction, &signature);
        let operation = self
            .operations
            .get_mut(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        operation.signature = Some(signature);
        operation.signed_transaction = Some(signed_transaction);
    }

    pub fn cancel_nonce(
        &mut self,
        op_id: OperationId,
        gas_limit: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        self.assert_owner();
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let sender = self.evm_address.expect("ERR_KEY_NOT_DERIVED");
        let previous_fee = operation
            .cancellation
            .as_ref()
            .map_or(operation.transaction.max_fee_per_gas.0, |attempt| {
                attempt.transaction.max_fee_per_gas.0
            });
        let (transaction, tx_digest) = evm::build_cancellation_transaction(
            self.evm_chain_id,
            operation.evm_nonce,
            sender,
            previous_fee,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
            self.max_gas_limit,
            self.max_fee_per_gas,
            self.max_priority_fee_per_gas,
            self.max_total_fee,
        );
        let request_count = operation
            .cancellation
            .as_ref()
            .map_or(1, |attempt| attempt.request_count.saturating_add(1));
        operation.cancellation = Some(CancellationAttempt {
            transaction,
            tx_digest,
            signature: None,
            signed_transaction: None,
            requested_at_block: env::block_height(),
            request_count,
        });
        self.operations.insert(op_id, operation);
        self.sign_digest(op_id, tx_digest, true)
    }

    #[private]
    pub fn on_cancel_signature(
        &mut self,
        op_id: OperationId,
        tx_digest: [u8; 32],
        #[callback_result] result: Result<MpcSignatureResponse, PromiseError>,
    ) {
        let operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        if operation.state != OperationState::PossiblySigned {
            return;
        }
        let Some(attempt) = operation.cancellation.as_ref() else {
            return;
        };
        if attempt.tx_digest != tx_digest {
            return;
        }
        let Ok(response) = result else {
            return;
        };
        let Some(signature) = parse_mpc_signature(response) else {
            return;
        };
        let signed_transaction = evm::signed_transaction(&attempt.transaction, &signature);
        let operation = self
            .operations
            .get_mut(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        let attempt = operation
            .cancellation
            .as_mut()
            .expect("ERR_CANCELLATION_NOT_FOUND");
        if attempt.tx_digest != tx_digest {
            return;
        }
        attempt.signature = Some(signature);
        attempt.signed_transaction = Some(signed_transaction);
    }

    /// Permissionless recovery path for MPC signatures published on-chain after a
    /// failed, timed-out or late callback. Verified against the relay's derived
    /// `0xGOV` address and the exact original or cancellation digest.
    pub fn submit_signature(&mut self, op_id: OperationId, signature: MpcSignature) {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let expected_address = self.evm_address.expect("ERR_KEY_NOT_DERIVED");

        if signature_matches(operation.tx_digest, &signature, expected_address) {
            require!(
                operation.signature.is_none(),
                "ERR_SIGNATURE_ALREADY_SUBMITTED"
            );
            operation.signed_transaction =
                Some(evm::signed_transaction(&operation.transaction, &signature));
            operation.signature = Some(signature);
            self.operations.insert(op_id, operation);
            return;
        }

        if let Some(attempt) = operation.cancellation.as_mut() {
            if signature_matches(attempt.tx_digest, &signature, expected_address) {
                require!(
                    attempt.signature.is_none(),
                    "ERR_SIGNATURE_ALREADY_SUBMITTED"
                );
                attempt.signed_transaction =
                    Some(evm::signed_transaction(&attempt.transaction, &signature));
                attempt.signature = Some(signature);
                self.operations.insert(op_id, operation);
                return;
            }
        }

        env::panic_str("ERR_SIGNATURE_MISMATCH");
    }

    pub fn report_status(
        &mut self,
        signed_report: SignedStatusReport,
        mpc_signature: Option<MpcSignature>,
    ) {
        let report = &signed_report.report;
        require!(report.client_id == self.client_id, "ERR_REPORT_CLIENT");
        require!(
            !self.used_report_nonces.contains(&report.report_nonce),
            "ERR_REPORT_NONCE_USED"
        );
        let operation = self
            .operations
            .get(&report.op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let serialized =
            to_vec(report).unwrap_or_else(|_| env::panic_str("ERR_REPORT_SERIALIZATION"));
        let mut message = Vec::with_capacity(STATUS_DOMAIN.len() + serialized.len());
        message.extend_from_slice(STATUS_DOMAIN);
        message.extend_from_slice(&serialized);
        let signature: [u8; 64] = signed_report
            .signature
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_REPORT_SIGNATURE_LENGTH"));
        require!(
            env::ed25519_verify(&signature, &message, &self.guard_public_key),
            "ERR_REPORT_SIGNATURE"
        );
        require!(report.kind == StatusKind::Confirmed, "ERR_REPORT_KIND");
        if let Some(signature) = mpc_signature {
            if operation.signed_transaction.is_none() {
                self.submit_signature(report.op_id, signature);
            }
        }
        let signed_transaction = self
            .operations
            .get(&report.op_id)
            .and_then(|operation| operation.signed_transaction.clone())
            .expect("ERR_ORIGINAL_SIGNATURE_UNAVAILABLE");
        require!(
            report.tx_hash == env::keccak256_array(&signed_transaction),
            "ERR_REPORT_TX_HASH"
        );
        self.used_report_nonces.insert(report.report_nonce);
        self.operations
            .get_mut(&report.op_id)
            .expect("ERR_OPERATION_NOT_FOUND")
            .state = OperationState::Confirmed;
        self.active_operation = None;
    }

    pub fn confirm_original(
        &mut self,
        op_id: OperationId,
        tx_hash: [u8; 32],
        mpc_signature: Option<MpcSignature>,
    ) {
        self.assert_owner();
        let operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        if let Some(signature) = mpc_signature {
            if operation.signed_transaction.is_none() {
                self.submit_signature(op_id, signature);
            }
        }
        let signed_transaction = self
            .operations
            .get(&op_id)
            .and_then(|operation| operation.signed_transaction.clone())
            .expect("ERR_ORIGINAL_SIGNATURE_UNAVAILABLE");
        require!(
            tx_hash == env::keccak256_array(&signed_transaction),
            "ERR_ORIGINAL_TX_HASH"
        );
        self.operations
            .get_mut(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND")
            .state = OperationState::Confirmed;
        self.active_operation = None;
    }

    pub fn confirm_cancellation(&mut self, op_id: OperationId, tx_hash: [u8; 32]) {
        self.assert_owner();
        let operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let signed_transaction = operation
            .cancellation
            .as_ref()
            .and_then(|attempt| attempt.signed_transaction.as_ref())
            .expect("ERR_CANCELLATION_SIGNATURE_UNAVAILABLE");
        require!(
            tx_hash == env::keccak256_array(signed_transaction),
            "ERR_CANCELLATION_TX_HASH"
        );
        self.operations
            .get_mut(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND")
            .state = OperationState::Cancelled;
        self.active_operation = None;
    }

    fn sign_digest(&self, op_id: OperationId, digest: [u8; 32], cancellation: bool) -> Promise {
        let callback = if cancellation {
            ext_self::ext(env::current_account_id())
                .with_static_gas(MPC_CALLBACK_GAS)
                .on_cancel_signature(op_id, digest)
        } else {
            ext_self::ext(env::current_account_id())
                .with_static_gas(MPC_CALLBACK_GAS)
                .on_mpc_signature(op_id)
        };
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path: self.mpc_path.clone(),
                payload_v2: MpcPayload::Ecdsa(hex::encode(digest)),
                domain_id: MPC_DOMAIN_ID,
            })
            .then(callback)
    }

    fn next_operation_id(&mut self) -> OperationId {
        self.operation_sequence = self.operation_sequence.saturating_add(1);
        let mut bytes = Vec::with_capacity(env::current_account_id().as_str().len() + 8);
        bytes.extend_from_slice(env::current_account_id().as_bytes());
        bytes.extend_from_slice(&self.operation_sequence.to_le_bytes());
        env::sha256_array(bytes)
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
    }
}

fn parse_mpc_signature(response: MpcSignatureResponse) -> Option<MpcSignature> {
    let MpcSignatureResponse::Secp256k1 {
        big_r,
        s,
        recovery_id,
    } = response
    else {
        return None;
    };
    let big_r = hex::decode(big_r.affine_point).unwrap_or_else(|_| env::panic_str("ERR_BAD_BIG_R"));
    require!(big_r.len() == 33, "ERR_BAD_BIG_R_LENGTH");
    let s: [u8; 32] = hex::decode(s.scalar)
        .unwrap_or_else(|_| env::panic_str("ERR_BAD_S"))
        .try_into()
        .unwrap_or_else(|_| env::panic_str("ERR_BAD_S_LENGTH"));
    Some(MpcSignature {
        big_r,
        s,
        recovery_id,
    })
}

fn derive_evm_address(public_key: &str) -> EvmAddress {
    let encoded = public_key
        .strip_prefix("secp256k1:")
        .unwrap_or_else(|| env::panic_str("ERR_NOT_SECP256K1"));
    let decoded = bs58::decode(encoded)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("ERR_BAD_PUBLIC_KEY"));
    require!(decoded.len() == 64, "ERR_PUBLIC_KEY_LENGTH");
    let hash = env::keccak256_array(decoded);
    hash[12..]
        .try_into()
        .unwrap_or_else(|_| env::panic_str("ERR_ADDRESS_LENGTH"))
}

fn bytes20(value: Base64VecU8, error: &str) -> EvmAddress {
    value.0.try_into().unwrap_or_else(|_| env::panic_str(error))
}

fn bytes32(value: Base64VecU8, error: &str) -> [u8; 32] {
    value.0.try_into().unwrap_or_else(|_| env::panic_str(error))
}

fn signature_matches(
    digest: [u8; 32],
    signature: &MpcSignature,
    expected_address: EvmAddress,
) -> bool {
    if signature.big_r.len() != 33 || signature.recovery_id > 1 {
        return false;
    }
    let mut compact = [0u8; 64];
    compact[..32].copy_from_slice(&signature.big_r[1..]);
    compact[32..].copy_from_slice(&signature.s);
    env::ecrecover(&digest, &compact, signature.recovery_id, true)
        .is_some_and(|public_key| env::keccak256_array(public_key)[12..] == expected_address[..])
}
