mod evm;
mod types;

use borsh::to_vec;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract, near, require,
};

pub use types::{
    AgentState, CancellationAttempt, Eip1559Transaction, GuardApproval, GuardVisa, MpcSignature,
    Operation, OperationState, PaymentIntent, RoleConfig, RoleView, SignedStatusReport, StatusKind,
    StatusReport,
};
use types::{
    FundingMessage, MpcPayload, MpcSignRequest, MpcSignatureResponse, OperationId, ReferenceKey,
    RoleState,
};

const VISA_DOMAIN: &[u8] = b"mandateos:visa:v1";
const STATUS_DOMAIN: &[u8] = b"mandateos:status:v1";
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
    fn on_derived_public_key(&mut self, agent: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    client_id: String,
    owner_id: AccountId,
    token_id: AccountId,
    mpc_contract_id: AccountId,
    evm_chain_id: u64,
    guard_public_key: [u8; 32],
    policy_version: u64,
    registry_version: u64,
    reservation_ttl_blocks: u64,
    paused: bool,
    operation_sequence: u64,
    roles: LookupMap<String, RoleState>,
    agents: LookupMap<AccountId, AgentState>,
    operations: LookupMap<OperationId, Operation>,
    active_operations: LookupMap<AccountId, OperationId>,
    references: LookupMap<ReferenceKey, OperationId>,
    used_visa_nonces: LookupSet<u64>,
    used_report_nonces: LookupSet<u64>,
    next_evm_nonces: LookupMap<AccountId, u64>,
}

#[near]
impl Vault {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client_id: String,
        owner_id: AccountId,
        token_id: AccountId,
        mpc_contract_id: AccountId,
        evm_chain_id: u64,
        guard_public_key: Base64VecU8,
        policy_version: u64,
        registry_version: u64,
        reservation_ttl_blocks: u64,
    ) -> Self {
        require!(!client_id.is_empty(), "ERR_EMPTY_CLIENT_ID");
        require!(reservation_ttl_blocks > 0, "ERR_ZERO_TTL");
        require!(evm_chain_id > 0, "ERR_ZERO_CHAIN_ID");
        let guard_public_key: [u8; 32] = guard_public_key
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_GUARD_KEY_LENGTH"));
        Self {
            client_id,
            owner_id,
            token_id,
            mpc_contract_id,
            evm_chain_id,
            guard_public_key,
            policy_version,
            registry_version,
            reservation_ttl_blocks,
            paused: false,
            operation_sequence: 0,
            roles: LookupMap::new(b"r".to_vec()),
            agents: LookupMap::new(b"a".to_vec()),
            operations: LookupMap::new(b"o".to_vec()),
            active_operations: LookupMap::new(b"x".to_vec()),
            references: LookupMap::new(b"f".to_vec()),
            used_visa_nonces: LookupSet::new(b"v".to_vec()),
            used_report_nonces: LookupSet::new(b"q".to_vec()),
            next_evm_nonces: LookupMap::new(b"n".to_vec()),
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

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_role(&self, role: String) -> Option<RoleView> {
        self.roles.get(&role).map(RoleView::from)
    }

    pub fn get_agent(&self, agent: AccountId) -> Option<AgentState> {
        self.agents.get(&agent).cloned()
    }

    pub fn get_operation(&self, op_id: OperationId) -> Option<Operation> {
        self.operations.get(&op_id).cloned()
    }

    pub fn next_evm_nonce(&self, agent: AccountId) -> u64 {
        self.next_evm_nonces.get(&agent).copied().unwrap_or(0)
    }

    pub fn set_role(&mut self, role: String, config: RoleConfig) {
        self.assert_owner();
        let (funded, spent, reserved) = self.roles.get(&role).map_or((0, 0, 0), |state| {
            (state.funded, state.spent, state.reserved)
        });
        self.roles.insert(
            role,
            RoleState {
                config,
                funded,
                spent,
                reserved,
            },
        );
    }

    pub fn set_versions(&mut self, policy_version: u64, registry_version: u64) {
        self.assert_owner();
        self.policy_version = policy_version;
        self.registry_version = registry_version;
    }

    pub fn set_guard_public_key(&mut self, guard_public_key: Base64VecU8) {
        self.assert_owner();
        self.guard_public_key = guard_public_key
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_GUARD_KEY_LENGTH"));
    }

    pub fn register_agent(&mut self, agent: AccountId, role: String, mpc_path: String) {
        self.assert_owner();
        require!(self.roles.contains_key(&role), "ERR_ROLE_NOT_FOUND");
        require!(!mpc_path.is_empty(), "ERR_EMPTY_MPC_PATH");
        self.agents.insert(
            agent.clone(),
            AgentState {
                role,
                mpc_path,
                active: true,
                derived_public_key: None,
                evm_address: None,
            },
        );
        self.next_evm_nonces.entry(agent).or_insert(0);
    }

    pub fn request_derived_public_key(&self, agent: AccountId) -> Promise {
        self.assert_owner_or_agent(&agent);
        let state = self.agents.get(&agent).expect("ERR_AGENT_NOT_FOUND");
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(MPC_DERIVE_GAS)
            .derived_public_key(
                state.mpc_path.clone(),
                Some(env::current_account_id()),
                Some(MPC_DOMAIN_ID),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_DERIVE_CALLBACK_GAS)
                    .on_derived_public_key(agent),
            )
    }

    #[private]
    pub fn on_derived_public_key(
        &mut self,
        agent: AccountId,
        #[callback_result] result: Result<String, PromiseError>,
    ) {
        let public_key = result.unwrap_or_else(|_| env::panic_str("ERR_DERIVE_KEY_FAILED"));
        let address = derive_evm_address(&public_key);
        let state = self.agents.get_mut(&agent).expect("ERR_AGENT_NOT_FOUND");
        state.derived_public_key = Some(public_key);
        state.evm_address = Some(address);
    }

    pub fn evm_address_from_public_key(&self, public_key: String) -> Base64VecU8 {
        Base64VecU8(derive_evm_address(&public_key).to_vec())
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        env::log_str("MANDATEOS_CANCEL_ALL_POSSIBLY_SIGNED");
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn revoke_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        let state = self.agents.get_mut(&agent).expect("ERR_AGENT_NOT_FOUND");
        state.active = false;
        if let Some(op_id) = self.active_operations.get(&agent).copied() {
            let operation = self
                .operations
                .get(&op_id)
                .expect("ERR_OPERATION_NOT_FOUND");
            match operation.state {
                OperationState::Prepared => {
                    self.cancel_operation(op_id, OperationState::Cancelled);
                }
                OperationState::PossiblySigned => {
                    env::log_str(&format!(
                        "MANDATEOS_CANCEL_NONCE_REQUIRED:{}",
                        hex::encode(op_id)
                    ));
                }
                _ => {}
            }
        }
    }

    pub fn prepare(&mut self, intent: PaymentIntent) -> Operation {
        self.assert_not_paused();
        let agent = env::predecessor_account_id();
        let agent_state = self
            .agents
            .get(&agent)
            .cloned()
            .expect("ERR_AGENT_NOT_FOUND");
        require!(agent_state.active, "ERR_AGENT_REVOKED");
        require!(
            agent_state.evm_address.is_some(),
            "ERR_AGENT_KEY_NOT_DERIVED"
        );
        require!(
            !self.active_operations.contains_key(&agent),
            "ERR_ACTIVE_OPERATION"
        );
        let role = self
            .roles
            .get_mut(&agent_state.role)
            .expect("ERR_ROLE_NOT_FOUND");
        require!(role.config.enabled, "ERR_ROLE_DISABLED");
        let available = role
            .funded
            .checked_sub(role.spent)
            .and_then(|value| value.checked_sub(role.reserved))
            .unwrap_or_else(|| env::panic_str("ERR_BUDGET_INVARIANT"));
        require!(intent.amount.0 <= available, "ERR_BUDGET_EXCEEDED");
        let reference_key = ReferenceKey {
            role: agent_state.role.clone(),
            reference: intent.reference.clone(),
        };
        require!(
            !self.references.contains_key(&reference_key),
            "ERR_REFERENCE_ALREADY_USED"
        );
        let nonce = self.next_evm_nonces.get(&agent).copied().unwrap_or(0);
        let (transaction, tx_digest) =
            evm::build_transaction(self.evm_chain_id, &role.config, nonce, &intent);
        role.reserved = role
            .reserved
            .checked_add(intent.amount.0)
            .unwrap_or_else(|| env::panic_str("ERR_BUDGET_OVERFLOW"));

        let op_id = self.next_operation_id(&agent);
        let block = env::block_height();
        let operation = Operation {
            op_id,
            client_id: self.client_id.clone(),
            agent: agent.clone(),
            role: agent_state.role,
            intent,
            policy_version: self.policy_version,
            registry_version: self.registry_version,
            evm_nonce: nonce,
            transaction,
            tx_digest,
            created_at_block: block,
            expires_at_block: block.saturating_add(self.reservation_ttl_blocks),
            possibly_signed_at_block: None,
            state: OperationState::Prepared,
            signature: None,
            signed_transaction: None,
            cancellation: None,
        };
        self.references.insert(reference_key, op_id);
        self.active_operations.insert(agent, op_id);
        self.operations.insert(op_id, operation.clone());
        operation
    }

    pub fn authorize(&mut self, op_id: OperationId, approval: GuardApproval) -> Promise {
        self.assert_not_paused();
        let caller = env::predecessor_account_id();
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::Prepared,
            "ERR_NOT_PREPARED"
        );
        require!(operation.agent == caller, "ERR_AGENT_MISMATCH");
        require!(
            env::block_height() <= operation.expires_at_block,
            "ERR_OPERATION_EXPIRED"
        );
        self.verify_visa(&operation, &approval);
        require!(
            !self.used_visa_nonces.contains(&approval.visa.visa_nonce),
            "ERR_VISA_USED"
        );
        require!(
            self.next_evm_nonces.get(&caller).copied().unwrap_or(0) == operation.evm_nonce,
            "ERR_NONCE_ALREADY_CONSUMED"
        );

        self.used_visa_nonces.insert(approval.visa.visa_nonce);
        operation.state = OperationState::PossiblySigned;
        operation.possibly_signed_at_block = Some(env::block_height());
        self.next_evm_nonces
            .insert(caller.clone(), operation.evm_nonce.saturating_add(1));
        self.operations.insert(op_id, operation.clone());

        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path: self
                    .agents
                    .get(&caller)
                    .expect("ERR_AGENT_NOT_FOUND")
                    .mpc_path
                    .clone(),
                payload_v2: MpcPayload::Ecdsa(hex::encode(operation.tx_digest)),
                domain_id: MPC_DOMAIN_ID,
            })
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_CALLBACK_GAS)
                    .on_mpc_signature(op_id),
            )
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
        let Some(signature) = Self::parse_mpc_signature(response) else {
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
        let caller = env::predecessor_account_id();
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        let agent_active = self
            .agents
            .get(&operation.agent)
            .is_some_and(|agent| agent.active);
        require!(
            caller == self.owner_id || caller == operation.agent || self.paused || !agent_active,
            "ERR_CANCEL_CALLER"
        );
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let role = self.roles.get(&operation.role).expect("ERR_ROLE_NOT_FOUND");
        let previous_fee = operation
            .cancellation
            .as_ref()
            .map_or(operation.transaction.max_fee_per_gas.0, |attempt| {
                attempt.transaction.max_fee_per_gas.0
            });
        let sender = self
            .agents
            .get(&operation.agent)
            .and_then(|agent| agent.evm_address)
            .expect("ERR_EVM_ADDRESS_NOT_DERIVED");
        let (transaction, tx_digest) = evm::build_cancellation_transaction(
            self.evm_chain_id,
            &role.config,
            operation.evm_nonce,
            sender,
            previous_fee,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
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
        self.operations.insert(op_id, operation.clone());
        let path = self
            .agents
            .get(&operation.agent)
            .expect("ERR_AGENT_NOT_FOUND")
            .mpc_path
            .clone();

        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path,
                payload_v2: MpcPayload::Ecdsa(hex::encode(tx_digest)),
                domain_id: MPC_DOMAIN_ID,
            })
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_CALLBACK_GAS)
                    .on_cancel_signature(op_id, tx_digest),
            )
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
        let Some(signature) = Self::parse_mpc_signature(response) else {
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

    pub fn expire(&mut self, op_id: OperationId) {
        let operation = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::Prepared,
            "ERR_NOT_PREPARED"
        );
        require!(
            env::block_height() > operation.expires_at_block,
            "ERR_NOT_EXPIRED"
        );
        self.cancel_operation(op_id, OperationState::Expired);
    }

    pub fn report_status(&mut self, signed_report: SignedStatusReport) {
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
            .clone()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_REPORT_SIGNATURE_LENGTH"));
        require!(
            env::ed25519_verify(&signature, &message, &self.guard_public_key),
            "ERR_REPORT_SIGNATURE"
        );

        require!(report.kind == StatusKind::Confirmed, "ERR_REPORT_KIND");
        let signed_transaction = operation
            .signed_transaction
            .as_ref()
            .expect("ERR_ORIGINAL_SIGNATURE_UNAVAILABLE");
        let expected_hash = env::keccak256_array(signed_transaction);
        require!(report.tx_hash == expected_hash, "ERR_REPORT_TX_HASH");
        self.used_report_nonces.insert(report.report_nonce);

        let role = self
            .roles
            .get_mut(&operation.role)
            .expect("ERR_ROLE_NOT_FOUND");
        role.reserved = role
            .reserved
            .checked_sub(operation.intent.amount.0)
            .unwrap_or_else(|| env::panic_str("ERR_RESERVED_UNDERFLOW"));
        role.spent = role
            .spent
            .checked_add(operation.intent.amount.0)
            .unwrap_or_else(|| env::panic_str("ERR_SPENT_OVERFLOW"));
        self.operations
            .get_mut(&report.op_id)
            .expect("ERR_OPERATION_NOT_FOUND")
            .state = OperationState::Confirmed;
        self.active_operations.remove(&operation.agent);
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
        let role = self
            .roles
            .get_mut(&operation.role)
            .expect("ERR_ROLE_NOT_FOUND");
        role.reserved = role
            .reserved
            .checked_sub(operation.intent.amount.0)
            .unwrap_or_else(|| env::panic_str("ERR_RESERVED_UNDERFLOW"));
        self.references.remove(&ReferenceKey {
            role: operation.role.clone(),
            reference: operation.intent.reference.clone(),
        });
        self.active_operations.remove(&operation.agent);
        self.operations
            .get_mut(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND")
            .state = OperationState::Cancelled;
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
        let big_r =
            hex::decode(big_r.affine_point).unwrap_or_else(|_| env::panic_str("ERR_BAD_BIG_R"));
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

    fn verify_visa(&self, operation: &Operation, approval: &GuardApproval) {
        let visa = &approval.visa;
        require!(visa.client_id == self.client_id, "ERR_VISA_CLIENT");
        require!(visa.op_id == operation.op_id, "ERR_VISA_OP_ID");
        require!(visa.tx_digest == operation.tx_digest, "ERR_VISA_DIGEST");
        require!(visa.agent == operation.agent.as_str(), "ERR_VISA_AGENT");
        require!(visa.role == operation.role, "ERR_VISA_ROLE");
        require!(
            visa.reference == operation.intent.reference,
            "ERR_VISA_REFERENCE"
        );
        require!(
            visa.policy_version == self.policy_version,
            "ERR_VISA_POLICY_VERSION"
        );
        require!(
            visa.registry_version == self.registry_version,
            "ERR_VISA_REGISTRY_VERSION"
        );
        require!(
            env::block_height() <= visa.expires_at_block,
            "ERR_VISA_EXPIRED"
        );
        let signature: [u8; 64] = approval
            .signature
            .0
            .clone()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_VISA_SIGNATURE_LENGTH"));
        let mut message = Vec::with_capacity(VISA_DOMAIN.len() + 256);
        message.extend_from_slice(VISA_DOMAIN);
        message.extend_from_slice(&to_vec(visa).expect("ERR_VISA_SERIALIZATION"));
        require!(
            env::ed25519_verify(&signature, &message, &self.guard_public_key),
            "ERR_VISA_SIGNATURE"
        );
    }

    fn cancel_operation(&mut self, op_id: OperationId, terminal_state: OperationState) {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::Prepared,
            "ERR_NOT_CANCELLABLE"
        );
        let role = self
            .roles
            .get_mut(&operation.role)
            .expect("ERR_ROLE_NOT_FOUND");
        role.reserved = role
            .reserved
            .checked_sub(operation.intent.amount.0)
            .unwrap_or_else(|| env::panic_str("ERR_BUDGET_INVARIANT"));
        self.active_operations.remove(&operation.agent);
        self.references.remove(&ReferenceKey {
            role: operation.role.clone(),
            reference: operation.intent.reference.clone(),
        });
        operation.state = terminal_state;
        self.operations.insert(op_id, operation);
    }

    fn next_operation_id(&mut self, agent: &AccountId) -> OperationId {
        self.operation_sequence = self.operation_sequence.saturating_add(1);
        let mut bytes = Vec::with_capacity(self.client_id.len() + agent.as_str().len() + 8);
        bytes.extend_from_slice(self.client_id.as_bytes());
        bytes.extend_from_slice(agent.as_bytes());
        bytes.extend_from_slice(&self.operation_sequence.to_le_bytes());
        env::sha256_array(bytes)
    }

    fn assert_owner_or_agent(&self, agent: &AccountId) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || &caller == agent,
            "ERR_OWNER_OR_AGENT"
        );
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "ERR_PAUSED");
    }
}

#[near]
impl FungibleTokenReceiver for Vault {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token_id,
            "ERR_UNSUPPORTED_TOKEN"
        );
        require!(sender_id == self.owner_id, "ERR_OWNER_FUNDS_ONLY");
        let message: FundingMessage =
            near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("ERR_BAD_MSG"));
        if let Some(role) = self.roles.get_mut(&message.role) {
            role.funded = role
                .funded
                .checked_add(amount.0)
                .unwrap_or_else(|| env::panic_str("ERR_BUDGET_OVERFLOW"));
        } else {
            let config = message
                .config
                .unwrap_or_else(|| env::panic_str("ERR_ROLE_NOT_FOUND"));
            self.roles.insert(
                message.role,
                RoleState {
                    config,
                    funded: amount.0,
                    spent: 0,
                    reserved: 0,
                },
            );
        }
        PromiseOrValue::Value(U128(0))
    }
}

fn derive_evm_address(public_key: &str) -> [u8; 20] {
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
