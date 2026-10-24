mod conditions;
mod evm;
mod types;

use borsh::to_vec;
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract, near, require,
};

use conditions::EvaluationContext;
pub use types::{
    Allowance, ChainWallet, Eip1559Transaction, GuardApproval, GuardVisa, Membership, MpcSignature,
    Operation, OperationRequest, OperationState, Permission, QueuedRuleChange, RoleConfig,
    RoleView, RuleChange, RuleChangeState, SignedStatusReport, StatusKind, StatusReport,
    VelocityConfig, VelocityState,
};
use types::{
    AllowanceKey, MembershipKey, MpcPayload, MpcSignRequest, MpcSignatureResponse, OperationId,
    QueueId, ReferenceKey, RoleState, VelocityKey,
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
    fn on_wallet_public_key(&mut self, chain_id: u64);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    client_id: String,
    owner_id: AccountId,
    mpc_contract_id: AccountId,
    guard_public_key: [u8; 32],
    policy_version: u64,
    registry_version: u64,
    operation_ttl_ns: u64,
    rule_delay_ns: u64,
    rule_expiration_ns: u64,
    paused: bool,
    operation_sequence: u64,
    rule_sequence: u64,
    council: Vec<AccountId>,
    wallets: LookupMap<u64, ChainWallet>,
    role_reservations: LookupMap<String, u64>,
    roles: LookupMap<String, RoleState>,
    memberships: LookupMap<MembershipKey, Membership>,
    allowances: LookupMap<AllowanceKey, Allowance>,
    velocities: LookupMap<VelocityKey, VelocityState>,
    operations: LookupMap<OperationId, Operation>,
    references: LookupMap<ReferenceKey, OperationId>,
    rule_changes: LookupMap<QueueId, QueuedRuleChange>,
    used_visa_nonces: LookupSet<u64>,
    used_report_nonces: LookupSet<u64>,
}

#[near]
impl Vault {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client_id: String,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
        guard_public_key: Base64VecU8,
        policy_version: u64,
        registry_version: u64,
        operation_ttl_ns: u64,
        rule_delay_ns: u64,
        rule_expiration_ns: u64,
        council: Vec<AccountId>,
    ) -> Self {
        require!(!client_id.is_empty(), "ERR_EMPTY_CLIENT_ID");
        require!(operation_ttl_ns > 0, "ERR_ZERO_OPERATION_TTL");
        require!(rule_delay_ns > 0, "ERR_ZERO_RULE_DELAY");
        require!(rule_expiration_ns > rule_delay_ns, "ERR_RULE_EXPIRATION");
        Self::validate_council(&council);
        let guard_public_key: [u8; 32] = guard_public_key
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_GUARD_KEY_LENGTH"));
        Self {
            client_id,
            owner_id,
            mpc_contract_id,
            guard_public_key,
            policy_version,
            registry_version,
            operation_ttl_ns,
            rule_delay_ns,
            rule_expiration_ns,
            paused: false,
            operation_sequence: 0,
            rule_sequence: 0,
            council,
            wallets: LookupMap::new(b"w".to_vec()),
            roles: LookupMap::new(b"r".to_vec()),
            memberships: LookupMap::new(b"m".to_vec()),
            allowances: LookupMap::new(b"a".to_vec()),
            velocities: LookupMap::new(b"y".to_vec()),
            operations: LookupMap::new(b"o".to_vec()),
            references: LookupMap::new(b"f".to_vec()),
            role_reservations: LookupMap::new(b"z".to_vec()),
            rule_changes: LookupMap::new(b"c".to_vec()),
            used_visa_nonces: LookupSet::new(b"v".to_vec()),
            used_report_nonces: LookupSet::new(b"q".to_vec()),
        }
    }

    pub fn client_id(&self) -> String {
        self.client_id.clone()
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn mpc_contract_id(&self) -> AccountId {
        self.mpc_contract_id.clone()
    }

    pub fn guard_public_key(&self) -> Base64VecU8 {
        Base64VecU8(self.guard_public_key.to_vec())
    }

    pub fn policy_version(&self) -> u64 {
        self.policy_version
    }

    pub fn registry_version(&self) -> u64 {
        self.registry_version
    }

    pub fn council(&self) -> Vec<AccountId> {
        self.council.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_wallet(&self, chain_id: u64) -> Option<ChainWallet> {
        self.wallets.get(&chain_id).cloned()
    }

    pub fn get_role(&self, role: String) -> Option<RoleView> {
        self.roles.get(&role).map(RoleView::from)
    }

    pub fn get_membership(&self, role: String, member: AccountId) -> Option<Membership> {
        self.memberships
            .get(&MembershipKey { role, member })
            .cloned()
    }

    pub fn get_allowance(&self, key: AllowanceKey) -> Option<Allowance> {
        let mut allowance = self.allowances.get(&key).cloned()?;
        Self::refill_allowance(&mut allowance, env::block_timestamp());
        Some(allowance)
    }

    pub fn get_operation(&self, op_id: OperationId) -> Option<Operation> {
        self.operations.get(&op_id).cloned()
    }

    pub fn get_rule_change(&self, queue_id: QueueId) -> Option<QueuedRuleChange> {
        self.rule_changes.get(&queue_id).cloned()
    }

    pub fn next_evm_nonce(&self, chain_id: u64) -> u64 {
        self.wallets
            .get(&chain_id)
            .map_or(0, |wallet| wallet.next_nonce)
    }

    /// Derives the single ACME wallet for an EVM chain. The path belongs to the
    /// vault, not to a member, so every role shares one nonce stream and queue.
    pub fn request_wallet(&mut self, chain_id: u64) -> Promise {
        self.assert_owner();
        require!(chain_id > 0, "ERR_ZERO_CHAIN_ID");
        let path = Self::wallet_path(chain_id);
        if let Some(wallet) = self.wallets.get(&chain_id) {
            require!(wallet.address.is_none(), "ERR_WALLET_ALREADY_DERIVED");
        } else {
            self.wallets.insert(
                chain_id,
                ChainWallet {
                    chain_id,
                    mpc_path: path.clone(),
                    derived_public_key: None,
                    address: None,
                    next_nonce: 0,
                    active_operation: None,
                },
            );
        }
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(MPC_DERIVE_GAS)
            .derived_public_key(path, Some(env::current_account_id()), Some(MPC_DOMAIN_ID))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_DERIVE_CALLBACK_GAS)
                    .on_wallet_public_key(chain_id),
            )
    }

    #[private]
    pub fn on_wallet_public_key(
        &mut self,
        chain_id: u64,
        #[callback_result] result: Result<String, PromiseError>,
    ) {
        let public_key = result.unwrap_or_else(|_| env::panic_str("ERR_DERIVE_KEY_FAILED"));
        let address = derive_evm_address(&public_key);
        let wallet = self
            .wallets
            .get_mut(&chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        wallet.derived_public_key = Some(public_key);
        wallet.address = Some(address);
        env::log_str(&format!(
            "OMNIROLES_WALLET_DERIVED:{chain_id}:{}",
            hex::encode(address)
        ));
    }

    pub fn evm_address_from_public_key(&self, public_key: String) -> Base64VecU8 {
        Base64VecU8(derive_evm_address(&public_key).to_vec())
    }

    pub fn preview_rule_queue_id(&self, change: RuleChange) -> QueueId {
        Self::validate_rule_change(&change);
        self.queue_id(self.rule_sequence.saturating_add(1), &change)
    }

    pub fn queue_rule_change(&mut self, change: RuleChange) -> QueuedRuleChange {
        self.assert_owner();
        Self::validate_rule_change(&change);
        self.rule_sequence = self.rule_sequence.saturating_add(1);
        let now = env::block_timestamp();
        let queue_id = self.queue_id(self.rule_sequence, &change);
        let entry = QueuedRuleChange {
            queue_id,
            change,
            proposed_by: env::predecessor_account_id(),
            queued_at_ns: U64(now),
            execute_after_ns: U64(now.saturating_add(self.rule_delay_ns)),
            expires_at_ns: U64(now.saturating_add(self.rule_expiration_ns)),
            state: RuleChangeState::Queued,
            vetoed_by: None,
        };
        self.rule_changes.insert(queue_id, entry.clone());
        env::log_str(&format!("OMNIROLES_RULE_QUEUED:{}", hex::encode(queue_id)));
        entry
    }

    pub fn execute_rule_change(&mut self, queue_id: QueueId) {
        let mut entry = self
            .rule_changes
            .get(&queue_id)
            .cloned()
            .expect("ERR_RULE_CHANGE_NOT_FOUND");
        require!(
            entry.state == RuleChangeState::Queued,
            "ERR_RULE_NOT_QUEUED"
        );
        let now = env::block_timestamp();
        require!(now >= entry.execute_after_ns.0, "ERR_RULE_DELAY");
        require!(now <= entry.expires_at_ns.0, "ERR_RULE_EXPIRED");
        self.apply_rule_change(entry.change.clone(), now);
        entry.state = RuleChangeState::Executed;
        self.rule_changes.insert(queue_id, entry);
        env::log_str(&format!(
            "OMNIROLES_RULE_EXECUTED:{}",
            hex::encode(queue_id)
        ));
    }

    pub fn veto_rule_change(&mut self, queue_id: QueueId) {
        self.assert_council();
        let mut entry = self
            .rule_changes
            .get(&queue_id)
            .cloned()
            .expect("ERR_RULE_CHANGE_NOT_FOUND");
        require!(
            entry.state == RuleChangeState::Queued,
            "ERR_RULE_NOT_QUEUED"
        );
        entry.state = RuleChangeState::Vetoed;
        entry.vetoed_by = Some(env::predecessor_account_id());
        self.rule_changes.insert(queue_id, entry);
        env::log_str(&format!("OMNIROLES_RULE_VETOED:{}", hex::encode(queue_id)));
    }

    pub fn expire_rule_change(&mut self, queue_id: QueueId) {
        let mut entry = self
            .rule_changes
            .get(&queue_id)
            .cloned()
            .expect("ERR_RULE_CHANGE_NOT_FOUND");
        require!(
            entry.state == RuleChangeState::Queued,
            "ERR_RULE_NOT_QUEUED"
        );
        require!(
            env::block_timestamp() > entry.expires_at_ns.0,
            "ERR_RULE_NOT_EXPIRED"
        );
        entry.state = RuleChangeState::Expired;
        self.rule_changes.insert(queue_id, entry);
    }

    pub fn renounce_role(&mut self, role: String) {
        let member = env::predecessor_account_id();
        let key = MembershipKey {
            role: role.clone(),
            member: member.clone(),
        };
        let membership = self
            .memberships
            .get_mut(&key)
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        membership.active = false;
        env::log_str(&format!("OMNIROLES_ROLE_RENOUNCED:{role}:{member}"));
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn prepare(&mut self, role: String, request: OperationRequest) -> Operation {
        self.assert_not_paused();
        require!(!request.reference.is_empty(), "ERR_EMPTY_REFERENCE");
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let role_state = self.roles.get(&role).cloned().expect("ERR_ROLE_NOT_FOUND");
        require!(role_state.config.enabled, "ERR_ROLE_DISABLED");
        let wallet = self
            .wallets
            .get(&request.chain_id)
            .cloned()
            .expect("ERR_WALLET_NOT_FOUND");
        let wallet_address = wallet.address.expect("ERR_WALLET_NOT_DERIVED");
        require!(wallet.active_operation.is_none(), "ERR_WALLET_QUEUE_BUSY");

        let membership_key = MembershipKey {
            role: role.clone(),
            member: member.clone(),
        };
        let membership = self
            .memberships
            .get(&membership_key)
            .cloned()
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        Self::assert_membership_available(&membership, now);

        let (permission_index, permission) = role_state
            .config
            .permissions
            .iter()
            .enumerate()
            .find(|(_, permission)| {
                self.permission_matches(permission, &request, &member, &role, wallet_address, now)
            })
            .unwrap_or_else(|| env::panic_str("ERR_PERMISSION_DENIED"));

        let allowance_key = permission.allowance_key;
        self.reserve_allowance(allowance_key, &request, now);
        self.reserve_velocity(&role, &role_state.config, &request, now);
        self.reserve_membership_use(&membership_key);

        let reference_key = ReferenceKey {
            role: role.clone(),
            reference: request.reference.clone(),
        };
        require!(
            !self.references.contains_key(&reference_key),
            "ERR_REFERENCE_ALREADY_USED"
        );

        let nonce = wallet.next_nonce;
        let (transaction, tx_digest) = evm::build_transaction(&role_state.config, nonce, &request);
        let op_id = self.next_operation_id(&member, request.chain_id);
        let risk_value = Self::risk_value(&request);
        let execute_after_ns = role_state
            .config
            .operation_delay_threshold
            .filter(|threshold| risk_value > threshold.0)
            .map(|_| now.saturating_add(role_state.config.operation_delay_ns));
        if execute_after_ns.is_some() {
            require!(
                role_state.config.operation_delay_ns > 0,
                "ERR_ZERO_OPERATION_DELAY"
            );
        }
        let role_reservations = self.role_reservations.entry(role.clone()).or_insert(0);
        *role_reservations = role_reservations
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("ERR_ROLE_RESERVATION_OVERFLOW"));
        let operation = Operation {
            op_id,
            client_id: self.client_id.clone(),
            member: member.clone(),
            role: role.clone(),
            request,
            permission_index: permission_index
                .try_into()
                .unwrap_or_else(|_| env::panic_str("ERR_PERMISSION_INDEX")),
            allowance_key,
            policy_version: self.policy_version,
            registry_version: self.registry_version,
            evm_nonce: nonce,
            transaction,
            tx_digest,
            created_at_ns: U64(now),
            expires_at_ns: U64(now.saturating_add(self.operation_ttl_ns)),
            execute_after_ns: execute_after_ns.map(U64),
            visa_authorized: false,
            cosigned_by: None,
            possibly_signed_at_ns: None,
            state: OperationState::Prepared,
            signature: None,
            signed_transaction: None,
            cancellation: None,
        };
        self.references.insert(reference_key, op_id);
        self.wallets
            .get_mut(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND")
            .active_operation = Some(op_id);
        self.operations.insert(op_id, operation.clone());
        env::log_str(&format!(
            "OMNIROLES_OPERATION_PREPARED:{}",
            hex::encode(op_id)
        ));
        operation
    }

    pub fn co_sign(&mut self, op_id: OperationId) {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            matches!(
                operation.state,
                OperationState::Prepared | OperationState::Queued
            ),
            "ERR_OPERATION_NOT_COSIGNABLE"
        );
        require!(
            env::block_timestamp() <= operation.expires_at_ns.0,
            "ERR_OPERATION_EXPIRED"
        );
        require!(operation.cosigned_by.is_none(), "ERR_ALREADY_COSIGNED");
        let cosigner = env::predecessor_account_id();
        require!(cosigner != operation.member, "ERR_SELF_COSIGN");
        let membership = self
            .memberships
            .get(&MembershipKey {
                role: operation.role.clone(),
                member: cosigner.clone(),
            })
            .expect("ERR_COSIGNER_MEMBERSHIP");
        Self::assert_membership_available(membership, env::block_timestamp());
        operation.cosigned_by = Some(cosigner.clone());
        self.operations.insert(op_id, operation);
        env::log_str(&format!(
            "OMNIROLES_OPERATION_COSIGNED:{}:{cosigner}",
            hex::encode(op_id)
        ));
    }

    pub fn authorize(&mut self, op_id: OperationId, approval: GuardApproval) -> PromiseOrValue<()> {
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
        require!(operation.member == caller, "ERR_MEMBER_MISMATCH");
        require!(
            env::block_timestamp() <= operation.expires_at_ns.0,
            "ERR_OPERATION_EXPIRED"
        );
        let role = self.roles.get(&operation.role).expect("ERR_ROLE_NOT_FOUND");
        if role
            .config
            .co_sign_threshold
            .is_some_and(|threshold| Self::risk_value(&operation.request) > threshold.0)
        {
            require!(operation.cosigned_by.is_some(), "ERR_COSIGN_REQUIRED");
        }
        self.verify_visa(&operation, &approval);
        require!(
            !self.used_visa_nonces.contains(&approval.visa.visa_nonce),
            "ERR_VISA_USED"
        );
        self.used_visa_nonces.insert(approval.visa.visa_nonce);
        operation.visa_authorized = true;
        if operation
            .execute_after_ns
            .is_some_and(|execute_after| env::block_timestamp() < execute_after.0)
        {
            operation.state = OperationState::Queued;
            self.operations.insert(op_id, operation);
            env::log_str(&format!(
                "OMNIROLES_OPERATION_QUEUED:{}",
                hex::encode(op_id)
            ));
            PromiseOrValue::Value(())
        } else {
            self.operations.insert(op_id, operation);
            PromiseOrValue::Promise(self.request_operation_signature(op_id))
        }
    }

    pub fn execute_queued_operation(&mut self, op_id: OperationId) -> Promise {
        self.assert_not_paused();
        let operation = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(operation.state == OperationState::Queued, "ERR_NOT_QUEUED");
        require!(operation.visa_authorized, "ERR_VISA_REQUIRED");
        require!(
            env::block_timestamp()
                >= operation
                    .execute_after_ns
                    .expect("ERR_DELAY_NOT_CONFIGURED")
                    .0,
            "ERR_OPERATION_DELAY"
        );
        require!(
            env::block_timestamp() <= operation.expires_at_ns.0,
            "ERR_OPERATION_EXPIRED"
        );
        self.request_operation_signature(op_id)
    }

    pub fn veto_operation(&mut self, op_id: OperationId) {
        self.assert_council();
        let operation = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            matches!(
                operation.state,
                OperationState::Prepared | OperationState::Queued
            ),
            "ERR_OPERATION_NOT_VETOABLE"
        );
        self.release_operation(op_id, OperationState::Vetoed, true);
        env::log_str(&format!(
            "OMNIROLES_OPERATION_VETOED:{}:{}",
            hex::encode(op_id),
            env::predecessor_account_id()
        ));
    }

    pub fn cancel_prepared(&mut self, op_id: OperationId) {
        let operation = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        let caller = env::predecessor_account_id();
        require!(
            caller == operation.member || caller == self.owner_id || self.council.contains(&caller),
            "ERR_CANCEL_CALLER"
        );
        require!(
            matches!(
                operation.state,
                OperationState::Prepared | OperationState::Queued
            ),
            "ERR_NOT_CANCELLABLE"
        );
        self.release_operation(op_id, OperationState::Cancelled, true);
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
        require!(
            caller == operation.member
                || caller == self.owner_id
                || self.paused
                || self.council.contains(&caller),
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
        let wallet = self
            .wallets
            .get(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        let sender = wallet.address.expect("ERR_WALLET_NOT_DERIVED");
        let (transaction, tx_digest) = evm::build_cancellation_transaction(
            &role.config,
            operation.request.chain_id,
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
        operation.cancellation = Some(types::CancellationAttempt {
            transaction,
            tx_digest,
            signature: None,
            signed_transaction: None,
            requested_at_ns: env::block_timestamp(),
            request_count,
        });
        self.operations.insert(op_id, operation.clone());
        let path = wallet.mpc_path.clone();
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

    /// Permissionless recovery for an MPC callback that failed after the
    /// signature was published on NEAR. Only signatures recovering the derived
    /// ACME wallet for the exact digest are accepted.
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
        let expected_address = self
            .wallets
            .get(&operation.request.chain_id)
            .and_then(|wallet| wallet.address)
            .expect("ERR_WALLET_NOT_DERIVED");
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

    pub fn expire_operation(&mut self, op_id: OperationId) {
        let operation = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            matches!(
                operation.state,
                OperationState::Prepared | OperationState::Queued
            ),
            "ERR_NOT_EXPIRABLE"
        );
        require!(
            env::block_timestamp() > operation.expires_at_ns.0,
            "ERR_NOT_EXPIRED"
        );
        self.release_operation(op_id, OperationState::Expired, true);
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
            .clone()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_REPORT_SIGNATURE_LENGTH"));
        require!(
            env::ed25519_verify(&signature, &message, &self.guard_public_key),
            "ERR_REPORT_SIGNATURE"
        );
        if let Some(signature) = mpc_signature {
            if operation.signed_transaction.is_none() {
                self.submit_signature(report.op_id, signature);
            }
        }
        let signed_transaction = self
            .operations
            .get(&report.op_id)
            .and_then(|stored| stored.signed_transaction.clone())
            .expect("ERR_ORIGINAL_SIGNATURE_UNAVAILABLE");
        require!(
            report.tx_hash == env::keccak256_array(&signed_transaction),
            "ERR_REPORT_TX_HASH"
        );
        self.used_report_nonces.insert(report.report_nonce);
        match report.kind {
            StatusKind::Confirmed => {
                self.release_operation(report.op_id, OperationState::Confirmed, false)
            }
            StatusKind::Failed => {
                self.release_operation(report.op_id, OperationState::Failed, true)
            }
        }
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
        self.release_operation(op_id, OperationState::Cancelled, true);
    }

    fn request_operation_signature(&mut self, op_id: OperationId) -> Promise {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            matches!(
                operation.state,
                OperationState::Prepared | OperationState::Queued
            ),
            "ERR_OPERATION_NOT_READY"
        );
        require!(operation.visa_authorized, "ERR_VISA_REQUIRED");
        let wallet = self
            .wallets
            .get_mut(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        require!(
            wallet.next_nonce == operation.evm_nonce,
            "ERR_NONCE_ALREADY_CONSUMED"
        );
        wallet.next_nonce = wallet.next_nonce.saturating_add(1);
        let path = wallet.mpc_path.clone();
        operation.state = OperationState::PossiblySigned;
        operation.possibly_signed_at_ns = Some(U64(env::block_timestamp()));
        self.operations.insert(op_id, operation.clone());
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path,
                payload_v2: MpcPayload::Ecdsa(hex::encode(operation.tx_digest)),
                domain_id: MPC_DOMAIN_ID,
            })
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(MPC_CALLBACK_GAS)
                    .on_mpc_signature(op_id),
            )
    }

    fn permission_matches(
        &self,
        permission: &Permission,
        request: &OperationRequest,
        member: &AccountId,
        role: &str,
        wallet: [u8; 20],
        now: u64,
    ) -> bool {
        if permission.chain_id != request.chain_id || permission.target != request.target {
            return false;
        }
        if let Some(selector) = permission.selector {
            if request.calldata.get(..4) != Some(selector.as_slice()) {
                return false;
            }
        }
        let context = EvaluationContext {
            member,
            role,
            chain_id: request.chain_id,
            wallet,
            target: request.target,
            value: request.value.0,
            block_timestamp_ns: now,
        };
        match conditions::evaluate(&permission.conditions, &request.calldata, &context) {
            Ok(result) => result,
            Err(conditions::EvaluationError::EngineUnavailable) => {
                env::panic_str("ERR_CONDITION_ENGINE_UNAVAILABLE")
            }
        }
    }

    fn reserve_allowance(
        &mut self,
        allowance_key: Option<AllowanceKey>,
        request: &OperationRequest,
        now: u64,
    ) {
        let Some(key) = allowance_key else {
            require!(
                request.allowance_amount.0 == 0,
                "ERR_UNEXPECTED_ALLOWANCE_AMOUNT"
            );
            return;
        };
        if request.calldata.is_empty() {
            require!(
                request.allowance_amount.0 == request.value.0,
                "ERR_ETHER_ALLOWANCE_AMOUNT"
            );
        } else if let Some((_recipient, amount)) = evm::decode_erc20_transfer(&request.calldata) {
            require!(
                request.allowance_amount.0 == amount,
                "ERR_TOKEN_ALLOWANCE_AMOUNT"
            );
        } else {
            require!(false, "ERR_ALLOWANCE_REQUIRES_CONDITION_ENGINE");
        }
        let allowance = self
            .allowances
            .get_mut(&key)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        Self::refill_allowance(allowance, now);
        let available = allowance.balance.0.saturating_sub(allowance.reserved.0);
        require!(
            request.allowance_amount.0 <= available,
            "ERR_ALLOWANCE_EXCEEDED"
        );
        allowance.reserved = U128(
            allowance
                .reserved
                .0
                .checked_add(request.allowance_amount.0)
                .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_OVERFLOW")),
        );
    }

    fn reserve_velocity(
        &mut self,
        role: &str,
        config: &RoleConfig,
        request: &OperationRequest,
        now: u64,
    ) {
        let Some(limit) = &config.velocity else {
            return;
        };
        require!(limit.window_ns > 0, "ERR_ZERO_VELOCITY_WINDOW");
        let key = VelocityKey {
            role: role.to_owned(),
            chain_id: request.chain_id,
        };
        let state = self.velocities.entry(key).or_insert(VelocityState {
            window_started_at_ns: U64(now),
            spent: U128(0),
            reserved: U128(0),
        });
        if now >= state.window_started_at_ns.0.saturating_add(limit.window_ns) {
            require!(
                state.reserved.0 == 0,
                "ERR_VELOCITY_WINDOW_HAS_RESERVATIONS"
            );
            state.window_started_at_ns = U64(now);
            state.spent = U128(0);
            state.reserved = U128(0);
        }
        let risk = Self::risk_value(request);
        let used = state
            .spent
            .0
            .checked_add(state.reserved.0)
            .and_then(|value| value.checked_add(risk))
            .unwrap_or_else(|| env::panic_str("ERR_VELOCITY_OVERFLOW"));
        require!(used <= limit.limit.0, "ERR_VELOCITY_EXCEEDED");
        state.reserved = U128(state.reserved.0 + risk);
    }

    fn reserve_membership_use(&mut self, key: &MembershipKey) {
        let membership = self
            .memberships
            .get_mut(key)
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        if let Some(max_uses) = membership.max_uses {
            require!(
                membership
                    .used_uses
                    .saturating_add(membership.reserved_uses)
                    < max_uses,
                "ERR_MEMBERSHIP_USES_EXHAUSTED"
            );
        }
        membership.reserved_uses = membership.reserved_uses.saturating_add(1);
    }

    fn release_operation(&mut self, op_id: OperationId, terminal: OperationState, rollback: bool) {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            !matches!(
                operation.state,
                OperationState::Confirmed
                    | OperationState::Failed
                    | OperationState::Cancelled
                    | OperationState::Vetoed
                    | OperationState::Expired
            ),
            "ERR_OPERATION_TERMINAL"
        );
        let role_reservations = self
            .role_reservations
            .get_mut(&operation.role)
            .expect("ERR_ROLE_RESERVATION_MISSING");
        *role_reservations = role_reservations
            .checked_sub(1)
            .unwrap_or_else(|| env::panic_str("ERR_ROLE_RESERVATION_UNDERFLOW"));
        let membership_key = MembershipKey {
            role: operation.role.clone(),
            member: operation.member.clone(),
        };
        let membership = self
            .memberships
            .get_mut(&membership_key)
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        membership.reserved_uses = membership
            .reserved_uses
            .checked_sub(1)
            .unwrap_or_else(|| env::panic_str("ERR_MEMBERSHIP_RESERVATION"));
        if !rollback {
            membership.used_uses = membership.used_uses.saturating_add(1);
        }
        if let Some(key) = operation.allowance_key {
            let allowance = self
                .allowances
                .get_mut(&key)
                .expect("ERR_ALLOWANCE_NOT_FOUND");
            allowance.reserved = U128(
                allowance
                    .reserved
                    .0
                    .checked_sub(operation.request.allowance_amount.0)
                    .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_RESERVATION")),
            );
            if !rollback {
                allowance.balance = U128(
                    allowance
                        .balance
                        .0
                        .checked_sub(operation.request.allowance_amount.0)
                        .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_BALANCE")),
                );
            }
        }
        let velocity_key = VelocityKey {
            role: operation.role.clone(),
            chain_id: operation.request.chain_id,
        };
        if let Some(velocity) = self.velocities.get_mut(&velocity_key) {
            let risk = Self::risk_value(&operation.request);
            velocity.reserved = U128(
                velocity
                    .reserved
                    .0
                    .checked_sub(risk)
                    .unwrap_or_else(|| env::panic_str("ERR_VELOCITY_RESERVATION")),
            );
            if !rollback {
                velocity.spent = U128(
                    velocity
                        .spent
                        .0
                        .checked_add(risk)
                        .unwrap_or_else(|| env::panic_str("ERR_VELOCITY_OVERFLOW")),
                );
            }
        }
        if rollback {
            self.references.remove(&ReferenceKey {
                role: operation.role.clone(),
                reference: operation.request.reference.clone(),
            });
        }
        self.wallets
            .get_mut(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND")
            .active_operation = None;
        operation.state = terminal;
        self.operations.insert(op_id, operation);
    }

    fn apply_rule_change(&mut self, change: RuleChange, now: u64) {
        match change {
            RuleChange::SetRole { role, config } => {
                require!(
                    self.role_reservations.get(&role).copied().unwrap_or(0) == 0,
                    "ERR_ROLE_IN_USE"
                );
                self.roles.insert(role, RoleState { config });
            }
            RuleChange::RemoveRole { role } => {
                require!(
                    self.role_reservations.get(&role).copied().unwrap_or(0) == 0,
                    "ERR_ROLE_IN_USE"
                );
                self.roles.remove(&role);
            }
            RuleChange::GrantMembership {
                role,
                member,
                starts_at_ns,
                ends_at_ns,
                max_uses,
            } => {
                require!(self.roles.contains_key(&role), "ERR_ROLE_NOT_FOUND");
                require!(
                    ends_at_ns.is_none_or(|end| end.0 > starts_at_ns.0),
                    "ERR_MEMBERSHIP_TIME_RANGE"
                );
                require!(
                    max_uses.is_none_or(|uses| uses > 0),
                    "ERR_ZERO_MEMBERSHIP_USES"
                );
                let key = MembershipKey {
                    role: role.clone(),
                    member: member.clone(),
                };
                self.memberships.insert(
                    key,
                    Membership {
                        role,
                        member,
                        starts_at_ns,
                        ends_at_ns,
                        max_uses,
                        used_uses: 0,
                        reserved_uses: 0,
                        active: true,
                    },
                );
            }
            RuleChange::RevokeMembership { role, member } => {
                let membership = self
                    .memberships
                    .get_mut(&MembershipKey { role, member })
                    .expect("ERR_MEMBERSHIP_NOT_FOUND");
                require!(membership.reserved_uses == 0, "ERR_MEMBERSHIP_IN_USE");
                membership.active = false;
            }
            RuleChange::SetAllowance {
                key,
                balance,
                refill,
                max_refill,
                period_ns,
            } => {
                require!(
                    self.allowances
                        .get(&key)
                        .is_none_or(|allowance| allowance.reserved.0 == 0),
                    "ERR_ALLOWANCE_IN_USE"
                );
                require!(refill.0 == 0 || period_ns > 0, "ERR_ZERO_ALLOWANCE_PERIOD");
                self.allowances.insert(
                    key,
                    Allowance {
                        balance,
                        refill,
                        max_refill,
                        period_ns,
                        timestamp_ns: U64(now),
                        reserved: U128(0),
                    },
                );
            }
            RuleChange::SetCouncil { members } => {
                Self::validate_council(&members);
                self.council = members;
            }
            RuleChange::SetGuardPublicKey { guard_public_key } => {
                self.guard_public_key = guard_public_key
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str("ERR_GUARD_KEY_LENGTH"));
            }
            RuleChange::SetVersions {
                policy_version,
                registry_version,
            } => {
                self.policy_version = policy_version;
                self.registry_version = registry_version;
            }
        }
    }

    fn validate_rule_change(change: &RuleChange) {
        match change {
            RuleChange::SetRole { role, config } => {
                require!(!role.is_empty(), "ERR_EMPTY_ROLE");
                require!(!config.permissions.is_empty(), "ERR_EMPTY_PERMISSIONS");
                require!(
                    config.max_priority_fee_per_gas.0 <= config.max_fee_per_gas.0,
                    "ERR_PRIORITY_ABOVE_MAX_FEE"
                );
                if config.operation_delay_threshold.is_some() {
                    require!(config.operation_delay_ns > 0, "ERR_ZERO_OPERATION_DELAY");
                }
                if let Some(velocity) = &config.velocity {
                    require!(velocity.limit.0 > 0, "ERR_ZERO_VELOCITY_LIMIT");
                    require!(velocity.window_ns > 0, "ERR_ZERO_VELOCITY_WINDOW");
                }
            }
            RuleChange::GrantMembership {
                starts_at_ns,
                ends_at_ns,
                max_uses,
                ..
            } => {
                require!(
                    ends_at_ns.is_none_or(|end| end.0 > starts_at_ns.0),
                    "ERR_MEMBERSHIP_TIME_RANGE"
                );
                require!(
                    max_uses.is_none_or(|uses| uses > 0),
                    "ERR_ZERO_MEMBERSHIP_USES"
                );
            }
            RuleChange::SetAllowance {
                refill, period_ns, ..
            } => require!(refill.0 == 0 || *period_ns > 0, "ERR_ZERO_ALLOWANCE_PERIOD"),
            RuleChange::SetCouncil { members } => Self::validate_council(members),
            RuleChange::SetGuardPublicKey { guard_public_key } => {
                require!(guard_public_key.len() == 32, "ERR_GUARD_KEY_LENGTH")
            }
            RuleChange::RemoveRole { .. }
            | RuleChange::RevokeMembership { .. }
            | RuleChange::SetVersions { .. } => {}
        }
    }

    fn assert_membership_available(membership: &Membership, now: u64) {
        require!(membership.active, "ERR_MEMBERSHIP_REVOKED");
        require!(
            now >= membership.starts_at_ns.0,
            "ERR_MEMBERSHIP_NOT_STARTED"
        );
        require!(
            membership.ends_at_ns.is_none_or(|end| now <= end.0),
            "ERR_MEMBERSHIP_EXPIRED"
        );
        if let Some(max_uses) = membership.max_uses {
            require!(
                membership
                    .used_uses
                    .saturating_add(membership.reserved_uses)
                    < max_uses,
                "ERR_MEMBERSHIP_USES_EXHAUSTED"
            );
        }
    }

    fn refill_allowance(allowance: &mut Allowance, now: u64) {
        if allowance.refill.0 == 0 || allowance.period_ns == 0 || now <= allowance.timestamp_ns.0 {
            return;
        }
        let periods = (now - allowance.timestamp_ns.0) / allowance.period_ns;
        if periods == 0 {
            return;
        }
        let added = allowance.refill.0.saturating_mul(u128::from(periods));
        allowance.balance = U128(
            allowance
                .balance
                .0
                .saturating_add(added)
                .min(allowance.max_refill.0),
        );
        allowance.timestamp_ns = U64(allowance
            .timestamp_ns
            .0
            .saturating_add(periods.saturating_mul(allowance.period_ns)));
    }

    fn risk_value(request: &OperationRequest) -> u128 {
        request.allowance_amount.0.max(request.value.0)
    }

    fn verify_visa(&self, operation: &Operation, approval: &GuardApproval) {
        let visa = &approval.visa;
        require!(visa.client_id == self.client_id, "ERR_VISA_CLIENT");
        require!(visa.op_id == operation.op_id, "ERR_VISA_OP_ID");
        require!(visa.tx_digest == operation.tx_digest, "ERR_VISA_DIGEST");
        require!(visa.agent == operation.member.as_str(), "ERR_VISA_MEMBER");
        require!(visa.role == operation.role, "ERR_VISA_ROLE");
        require!(
            visa.reference == operation.request.reference,
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
            env::block_timestamp() <= visa.expires_at_ns.0,
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

    fn next_operation_id(&mut self, member: &AccountId, chain_id: u64) -> OperationId {
        self.operation_sequence = self.operation_sequence.saturating_add(1);
        let mut bytes = Vec::with_capacity(self.client_id.len() + member.as_str().len() + 16);
        bytes.extend_from_slice(self.client_id.as_bytes());
        bytes.extend_from_slice(member.as_bytes());
        bytes.extend_from_slice(&chain_id.to_le_bytes());
        bytes.extend_from_slice(&self.operation_sequence.to_le_bytes());
        env::sha256_array(bytes)
    }

    fn queue_id(&self, sequence: u64, change: &RuleChange) -> QueueId {
        let mut bytes = Vec::with_capacity(self.client_id.len() + 64);
        bytes.extend_from_slice(self.client_id.as_bytes());
        bytes.extend_from_slice(&sequence.to_le_bytes());
        bytes.extend_from_slice(&to_vec(change).expect("ERR_RULE_SERIALIZATION"));
        env::sha256_array(bytes)
    }

    fn wallet_path(chain_id: u64) -> String {
        format!("omniroles/evm/{chain_id}")
    }

    fn validate_council(council: &[AccountId]) {
        require!(!council.is_empty(), "ERR_EMPTY_COUNCIL");
        for (index, member) in council.iter().enumerate() {
            require!(
                !council[..index].contains(member),
                "ERR_DUPLICATE_COUNCIL_MEMBER"
            );
        }
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
    }

    fn assert_council(&self) {
        require!(
            self.council.contains(&env::predecessor_account_id()),
            "ERR_COUNCIL_ONLY"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "ERR_PAUSED");
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

fn signature_matches(
    digest: [u8; 32],
    signature: &MpcSignature,
    expected_address: [u8; 20],
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
