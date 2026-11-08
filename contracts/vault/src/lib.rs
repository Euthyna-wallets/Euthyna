#![allow(clippy::too_many_arguments)]
pub mod bank;
mod conditions;
mod evm;
mod foreign;
pub mod near_tokens;
pub mod solana;
mod types;

use borsh::to_vec;
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract, near, require,
};

use conditions::{EvaluationContext, ReservedAllowances};
use omniroles_conditions::Consumption;
pub use types::{
    Allowance, AllowanceConsumption, ChainWallet, DaoTransaction, Eip1559Transaction,
    GuardApproval, GuardVisa, ListAddress, Membership, MembershipKind, MpcSignature, Operation,
    OperationCheck, OperationRequest, OperationState, Permission, QueuedRuleChange, RoleConfig,
    RoleView, RuleChange, RuleChangeState, SettlementConfig, SignedStatusReport, StatusKind,
    StatusReport, VelocityConfig, VelocityState,
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
/// Role name of the transactions voted by the DAO; no role can be created with it.
pub const DAO_ROLE: &str = "__dao__";
const MAX_DAO_TRANSACTIONS_PER_PROPOSAL: usize = 10;
const CODE_FETCH_GAS: Gas = Gas::from_tgas(30);
const UPGRADE_CALLBACK_GAS: Gas = Gas::from_tgas(80);
const MIGRATE_GAS: Gas = Gas::from_tgas(30);
const UPGRADE_MIN_GAS: Gas = Gas::from_tgas(250);

#[allow(dead_code)]
#[ext_contract(ext_mpc)]
trait ExtMpc {
    fn verify_foreign_transaction(
        &mut self,
        request: foreign::VerifyArgs,
    ) -> foreign::VerifyResponse;
    fn sign(&mut self, request: MpcSignRequest) -> MpcSignatureResponse;
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
}

#[allow(dead_code)]
#[ext_contract(ext_code_source)]
trait ExtCodeSource {
    fn code_of(&self, code_hash: near_sdk::json_types::Base58CryptoHash);
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_mpc_signature(&mut self, op_id: OperationId);
    fn on_cancel_signature(&mut self, op_id: OperationId, tx_digest: [u8; 32]);
    fn on_wallet_public_key(&mut self, chain_id: u64);
    fn on_upgrade_code(&mut self, code_hash: near_sdk::json_types::Base58CryptoHash);
    fn on_settle_verified(
        &mut self,
        op_id: OperationId,
        cancellation: bool,
        tx_hash: [u8; 32],
        expected_payload_hash: [u8; 32],
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    address_lists: std::collections::BTreeMap<String, Vec<ListAddress>>,
    settlement_config: SettlementConfig,
    client_id: String,
    owner_id: AccountId,
    mpc_contract_id: AccountId,
    visa_public_key: [u8; 32],
    status_public_key: [u8; 32],
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
    /// Queue id of every rule change, by sequence number (1-based), for listings.
    rule_queue_ids: LookupMap<u64, QueueId>,
    used_visa_nonces: LookupSet<u64>,
    used_report_nonces: LookupSet<u64>,
    /// DAO transactions waiting for their veto window or for the wallet, in order.
    dao_queue: Vec<OperationId>,
    dao_sequence: u64,
    /// Operation id of every DAO transaction, by sequence number (1-based).
    dao_transactions: LookupMap<u64, OperationId>,
    /// Account that deployed this vault (the Nomos factory): where published
    /// versions are fetched from on an upgrade. Untrusted: code is checked by hash.
    code_source: AccountId,
}

#[near]
impl Vault {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client_id: String,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
        visa_public_key: Base64VecU8,
        status_public_key: Base64VecU8,
        policy_version: u64,
        registry_version: u64,
        operation_ttl_ns: u64,
        rule_delay_ns: u64,
        rule_expiration_ns: u64,
        council: Vec<AccountId>,
        settlement_config: Option<SettlementConfig>,
    ) -> Self {
        require!(!client_id.is_empty(), "ERR_EMPTY_CLIENT_ID");
        require!(operation_ttl_ns > 0, "ERR_ZERO_OPERATION_TTL");
        require!(rule_delay_ns > 0, "ERR_ZERO_RULE_DELAY");
        require!(rule_expiration_ns > rule_delay_ns, "ERR_RULE_EXPIRATION");
        Self::validate_council(&council);
        let visa_public_key: [u8; 32] = visa_public_key
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_VISA_KEY_LENGTH"));
        let status_public_key: [u8; 32] = status_public_key
            .0
            .try_into()
            .unwrap_or_else(|_| env::panic_str("ERR_STATUS_KEY_LENGTH"));
        let settlement_config = settlement_config.unwrap_or_default();
        Self::validate_settlement_config(&settlement_config);
        Self {
            address_lists: Default::default(),
            settlement_config,
            client_id,
            owner_id,
            mpc_contract_id,
            visa_public_key,
            status_public_key,
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
            rule_queue_ids: LookupMap::new(b"s".to_vec()),
            used_visa_nonces: LookupSet::new(b"v".to_vec()),
            used_report_nonces: LookupSet::new(b"q".to_vec()),
            dao_queue: Vec::new(),
            dao_sequence: 0,
            dao_transactions: LookupMap::new(b"d".to_vec()),
            code_source: env::predecessor_account_id(),
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

    pub fn visa_public_key(&self) -> Base64VecU8 {
        Base64VecU8(self.visa_public_key.to_vec())
    }

    pub fn status_public_key(&self) -> Base64VecU8 {
        Base64VecU8(self.status_public_key.to_vec())
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

    /// Number of rule changes ever queued.
    pub fn rule_sequence(&self) -> u64 {
        self.rule_sequence
    }

    /// Rule changes by sequence number, newest first, `limit` at most 50.
    pub fn list_rule_changes(
        &self,
        before: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<QueuedRuleChange> {
        let start = before
            .unwrap_or(self.rule_sequence.saturating_add(1))
            .min(self.rule_sequence.saturating_add(1));
        let limit = limit.unwrap_or(20).min(50);
        (1..start)
            .rev()
            .take(limit as usize)
            .filter_map(|sequence| self.rule_queue_ids.get(&sequence))
            .filter_map(|queue_id| self.rule_changes.get(queue_id).cloned())
            .collect()
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
    /// Dry run of `prepare` for `member`: same checks, no state change. Lets the
    /// console and agents explain a refusal before submitting anything.
    pub fn check_operation(
        &self,
        role: String,
        member: AccountId,
        request: OperationRequest,
    ) -> OperationCheck {
        let now = env::block_timestamp();
        let refuse = |reason: &str| OperationCheck::refused(reason);
        if self.paused {
            return refuse("ERR_PAUSED");
        }
        if request.reference.is_empty() {
            return refuse("ERR_EMPTY_REFERENCE");
        }
        let Some(role_state) = self.roles.get(&role) else {
            return refuse("ERR_ROLE_NOT_FOUND");
        };
        if !role_state.config.enabled {
            return refuse("ERR_ROLE_DISABLED");
        }
        let Some(wallet) = self.wallets.get(&request.chain_id) else {
            return refuse("ERR_WALLET_NOT_FOUND");
        };
        let Some(wallet_address) = wallet.address else {
            return refuse("ERR_WALLET_NOT_DERIVED");
        };
        let Some(membership) = self.memberships.get(&MembershipKey {
            role: role.clone(),
            member: member.clone(),
        }) else {
            return refuse("ERR_MEMBERSHIP_NOT_FOUND");
        };
        if let Some(reason) = Self::membership_unavailable(membership, now) {
            return refuse(reason);
        }
        if self.references.contains_key(&ReferenceKey {
            role: role.clone(),
            reference: request.reference.clone(),
        }) {
            return refuse("ERR_REFERENCE_ALREADY_USED");
        }
        let mut refusal = String::from("NoPermission");
        for (index, permission) in role_state.config.permissions.iter().enumerate() {
            match self.check_permission(permission, &request, &member, &role, wallet_address, now) {
                Ok(consumptions) => {
                    let consumptions: Vec<AllowanceConsumption> = consumptions
                        .iter()
                        .map(|consumption| AllowanceConsumption {
                            key: consumption.key.as_slice().try_into().unwrap_or([0; 32]),
                            amount: U128(consumption.consumed),
                            calls_only: consumption.calls_only,
                        })
                        .collect();
                    let declared: u128 = consumptions
                        .iter()
                        .filter(|consumption| !consumption.calls_only)
                        .map(|consumption| consumption.amount.0)
                        .sum();
                    if declared != request.allowance_amount.0 {
                        return refuse("ERR_ALLOWANCE_AMOUNT_MISMATCH");
                    }
                    let measured_value = Self::measured_value(&request, &consumptions);
                    let threshold_value = Self::threshold_value(measured_value);
                    let config = &role_state.config;
                    return OperationCheck {
                        allowed: true,
                        reason: None,
                        permission_index: Some(index as u32),
                        consumptions,
                        measured_value: measured_value.map(U128),
                        requires_delay: config
                            .operation_delay_threshold
                            .is_some_and(|threshold| threshold_value > threshold.0),
                        requires_cosign: config
                            .co_sign_threshold
                            .is_some_and(|threshold| threshold_value > threshold.0),
                        wallet_busy: !wallet.accepts_operation(),
                    };
                }
                Err(reason) => refusal = Self::closer_refusal(refusal, reason),
            }
        }
        refuse(&format!("ERR_PERMISSION_DENIED:{refusal}"))
    }

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
                    in_flight: Vec::new(),
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
        self.enqueue_rule_change(change, env::predecessor_account_id())
    }

    /// Queued like an owner's vote: the same rule delay, the same council veto.
    pub(crate) fn enqueue_rule_change(&mut self, change: RuleChange, proposed_by: AccountId) -> QueuedRuleChange {
        self.rule_sequence = self.rule_sequence.saturating_add(1);
        let now = env::block_timestamp();
        let queue_id = self.queue_id(self.rule_sequence, &change);
        let entry = QueuedRuleChange {
            queue_id,
            change,
            proposed_by,
            queued_at_ns: U64(now),
            execute_after_ns: U64(now.saturating_add(self.rule_delay_ns)),
            expires_at_ns: U64(now.saturating_add(self.rule_expiration_ns)),
            state: RuleChangeState::Queued,
            vetoed_by: None,
        };
        self.rule_changes.insert(queue_id, entry.clone());
        self.rule_queue_ids.insert(self.rule_sequence, queue_id);
        env::log_str(&format!("OMNIROLES_RULE_QUEUED:{}", hex::encode(queue_id)));
        entry
    }

    pub fn execute_rule_change(&mut self, queue_id: QueueId) -> PromiseOrValue<()> {
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
        let upgrade = match &entry.change {
            RuleChange::Upgrade { code_hash } => Some(*code_hash),
            _ => None,
        };
        let storage_token = match &entry.change {
            RuleChange::NearStorageDeposit { token } => Some(token.clone()),
            _ => None,
        };
        // Too little gas would mark the upgrade executed and then fail to
        // deploy: refuse, so nobody can burn a voted upgrade.
        if upgrade.is_some() {
            require!(
                env::prepaid_gas() >= UPGRADE_MIN_GAS,
                "ERR_UPGRADE_NEEDS_MORE_GAS"
            );
        }
        self.apply_rule_change(entry.change.clone(), now);
        entry.state = RuleChangeState::Executed;
        self.rule_changes.insert(queue_id, entry);
        env::log_str(&format!(
            "OMNIROLES_RULE_EXECUTED:{}",
            hex::encode(queue_id)
        ));
        if let Some(token) = storage_token {
            return PromiseOrValue::Promise(near_tokens::storage_deposit(token));
        }
        match upgrade {
            Some(code_hash) => PromiseOrValue::Promise(
                ext_code_source::ext(self.code_source.clone())
                    .with_static_gas(CODE_FETCH_GAS)
                    .code_of(code_hash)
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(UPGRADE_CALLBACK_GAS)
                            .on_upgrade_code(code_hash),
                    ),
            ),
            None => PromiseOrValue::Value(()),
        }
    }

    pub fn code_source(&self) -> AccountId {
        self.code_source.clone()
    }

    /// Deploys the fetched code only if it has the hash the DAO voted for.
    #[private]
    pub fn on_upgrade_code(
        &mut self,
        code_hash: near_sdk::json_types::Base58CryptoHash,
    ) -> Promise {
        let code = match env::promise_result_checked(0, 4 * 1024 * 1024) {
            Ok(code) => code,
            Err(_) => env::panic_str("ERR_UPGRADE_CODE_UNAVAILABLE"),
        };
        let expected: [u8; 32] = code_hash.into();
        require!(
            env::sha256_array(&code) == expected,
            "ERR_UPGRADE_CODE_HASH"
        );
        env::log_str(&format!("OMNIROLES_UPGRADED:{}", String::from(&code_hash)));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_owned(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                MIGRATE_GAS,
            )
    }

    /// Runs on the new code right after an upgrade. Same state layout: read as is.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("ERR_NO_STATE"))
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
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.council.contains(&caller),
            "ERR_OWNER_OR_COUNCIL"
        );
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
        require!(wallet.accepts_operation(), "ERR_WALLET_QUEUE_BUSY");

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

        // First permission whose target, selector, value option and conditions
        // all accept the call. The refusal of the last candidate is reported.
        let mut refusal = String::from("NoPermission");
        let mut matched = None;
        for (index, permission) in role_state.config.permissions.iter().enumerate() {
            match self.check_permission(permission, &request, &member, &role, wallet_address, now) {
                Ok(consumptions) => {
                    matched = Some((index, consumptions));
                    break;
                }
                Err(reason) => refusal = Self::closer_refusal(refusal, reason),
            }
        }
        let (permission_index, consumptions) =
            matched.unwrap_or_else(|| env::panic_str(&format!("ERR_PERMISSION_DENIED:{refusal}")));

        let consumptions = self.reserve_allowances(&consumptions, &request, now);
        let measured_value = Self::measured_value(&request, &consumptions);
        self.reserve_velocity(&role, &role_state.config, &request, measured_value, now);
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
        let risk_value = Self::threshold_value(measured_value);
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
            consumptions,
            measured_value: measured_value.map(U128),
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
        let now = env::block_timestamp();
        if let Some(operation_membership) = self.memberships.get(&MembershipKey {
            role: operation.role.clone(),
            member: cosigner.clone(),
        }) {
            let active_in_operation_role = operation_membership.active
                && now >= operation_membership.starts_at_ns.0
                && operation_membership
                    .ends_at_ns
                    .is_none_or(|end| now <= end.0);
            require!(!active_in_operation_role, "ERR_COSIGNER_IN_OPERATION_ROLE");
        }
        let co_signer_role = self
            .roles
            .get(&operation.role)
            .and_then(|role| role.config.co_signer_role.clone())
            .expect("ERR_COSIGNER_ROLE_NOT_CONFIGURED");
        require!(co_signer_role != operation.role, "ERR_COSIGNER_ROLE_SAME");
        let membership = self
            .memberships
            .get(&MembershipKey {
                role: co_signer_role,
                member: cosigner.clone(),
            })
            .expect("ERR_COSIGNER_MEMBERSHIP");
        require!(
            membership.kind == MembershipKind::Human,
            "ERR_COSIGNER_NOT_HUMAN"
        );
        Self::assert_membership_available(membership, now);
        operation.cosigned_by = Some(cosigner.clone());
        self.operations.insert(op_id, operation);
        env::log_str(&format!(
            "OMNIROLES_OPERATION_COSIGNED:{}:{cosigner}",
            hex::encode(op_id)
        ));
    }

    pub fn authorize(
        &mut self,
        op_id: OperationId,
        approval: Option<GuardApproval>,
    ) -> PromiseOrValue<()> {
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
        if role.config.co_sign_threshold.is_some_and(|threshold| {
            Self::threshold_value(operation.measured_value.map(|value| value.0)) > threshold.0
        }) {
            require!(operation.cosigned_by.is_some(), "ERR_COSIGN_REQUIRED");
        }
        if let Some(approval) = approval {
            self.verify_visa(&operation, &approval);
            require!(
                !self.used_visa_nonces.contains(&approval.visa.visa_nonce),
                "ERR_VISA_USED"
            );
            self.used_visa_nonces.insert(approval.visa.visa_nonce);
        } else {
            require!(!role.config.guard_required, "ERR_VISA_REQUIRED");
        }
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
                OperationState::Prepared | OperationState::Queued | OperationState::Scheduled
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

    /// Called by the DAO when members approve a transaction outside any role.
    /// Each one waits for the veto window, then is signed in submission order.
    pub fn submit_transactions(&mut self, transactions: Vec<DaoTransaction>) -> Vec<OperationId> {
        self.assert_owner();
        require!(
            !transactions.is_empty() && transactions.len() <= MAX_DAO_TRANSACTIONS_PER_PROPOSAL,
            "ERR_DAO_TRANSACTION_COUNT"
        );
        let now = env::block_timestamp();
        let execute_after = now.saturating_add(self.rule_delay_ns);
        let gas_config = Self::dao_gas_config();
        let owner = self.owner_id.clone();
        let mut ids = Vec::with_capacity(transactions.len());
        for transaction in transactions {
            let wallet = self
                .wallets
                .get(&transaction.chain_id)
                .expect("ERR_WALLET_NOT_FOUND");
            require!(wallet.address.is_some(), "ERR_WALLET_NOT_DERIVED");
            self.dao_sequence = self.dao_sequence.saturating_add(1);
            let request = OperationRequest {
                chain_id: transaction.chain_id,
                target: transaction.target,
                value: transaction.value,
                calldata: transaction.calldata,
                allowance_amount: U128(0),
                reference: format!("dao:{}", self.dao_sequence),
                gas_limit: transaction.gas_limit,
                max_fee_per_gas: transaction.max_fee_per_gas,
                max_priority_fee_per_gas: transaction.max_priority_fee_per_gas,
            };
            // Same caps as when it is built, so a bad fee fails the vote, not later.
            let (placeholder, _) = evm::build_transaction(&gas_config, 0, &request);
            let op_id = self.next_operation_id(&owner, request.chain_id);
            let operation = Operation {
                op_id,
                client_id: self.client_id.clone(),
                member: owner.clone(),
                role: DAO_ROLE.to_string(),
                request,
                permission_index: 0,
                consumptions: Vec::new(),
                measured_value: None,
                policy_version: self.policy_version,
                registry_version: self.registry_version,
                evm_nonce: 0,
                transaction: placeholder,
                tx_digest: [0; 32],
                created_at_ns: U64(now),
                expires_at_ns: U64(execute_after.saturating_add(self.rule_expiration_ns)),
                execute_after_ns: Some(U64(execute_after)),
                visa_authorized: true,
                cosigned_by: None,
                possibly_signed_at_ns: None,
                state: OperationState::Scheduled,
                signature: None,
                signed_transaction: None,
                cancellation: None,
            };
            self.operations.insert(op_id, operation);
            self.dao_queue.push(op_id);
            self.dao_transactions.insert(self.dao_sequence, op_id);
            env::log_str(&format!(
                "OMNIROLES_DAO_TRANSACTION_SCHEDULED:{}",
                hex::encode(op_id)
            ));
            ids.push(op_id);
        }
        ids
    }

    /// Permissionless: once its veto window has passed and the wallet is free,
    /// the oldest DAO transaction for this chain gets its nonce and is signed.
    pub fn start_dao_transaction(&mut self, chain_id: u64) -> Promise {
        self.assert_not_paused();
        let position = self
            .dao_queue
            .iter()
            .position(|op_id| {
                self.operations
                    .get(op_id)
                    .is_some_and(|operation| operation.request.chain_id == chain_id)
            })
            .unwrap_or_else(|| env::panic_str("ERR_NO_DAO_TRANSACTION"));
        let op_id = self.dao_queue[position];
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::Scheduled,
            "ERR_NOT_SCHEDULED"
        );
        let now = env::block_timestamp();
        require!(
            now >= operation
                .execute_after_ns
                .expect("ERR_DELAY_NOT_CONFIGURED")
                .0,
            "ERR_VETO_WINDOW_OPEN"
        );
        require!(now <= operation.expires_at_ns.0, "ERR_OPERATION_EXPIRED");
        let wallet = self
            .wallets
            .get_mut(&chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        require!(wallet.accepts_operation(), "ERR_WALLET_QUEUE_BUSY");
        let nonce = wallet.next_nonce;
        wallet.active_operation = Some(op_id);
        let (transaction, tx_digest) =
            evm::build_transaction(&Self::dao_gas_config(), nonce, &operation.request);
        operation.evm_nonce = nonce;
        operation.transaction = transaction;
        operation.tx_digest = tx_digest;
        operation.expires_at_ns = U64(now.saturating_add(self.operation_ttl_ns));
        operation.state = OperationState::Prepared;
        self.operations.insert(op_id, operation);
        self.dao_queue.remove(position);
        env::log_str(&format!(
            "OMNIROLES_DAO_TRANSACTION_STARTED:{}",
            hex::encode(op_id)
        ));
        self.request_operation_signature(op_id)
    }

    /// DAO transactions, newest first.
    pub fn list_dao_transactions(&self, before: Option<u64>, limit: Option<u64>) -> Vec<Operation> {
        let limit = limit.unwrap_or(20).min(50);
        let start = before.unwrap_or(self.dao_sequence.saturating_add(1));
        (1..start)
            .rev()
            .take(limit as usize)
            .filter_map(|sequence| self.dao_transactions.get(&sequence))
            .filter_map(|op_id| self.operations.get(op_id).cloned())
            .collect()
    }

    pub fn dao_queue(&self) -> Vec<Base64VecU8> {
        self.dao_queue
            .iter()
            .map(|op_id| Base64VecU8(op_id.to_vec()))
            .collect()
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
                OperationState::Prepared | OperationState::Queued | OperationState::Scheduled
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

    pub fn cancel_nonce(&mut self, op_id: OperationId) -> Promise {
        let mut operation = self
            .operations
            .get(&op_id)
            .cloned()
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            operation.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        require!(
            env::block_timestamp()
                >= operation
                    .possibly_signed_at_ns
                    .expect("ERR_NOT_POSSIBLY_SIGNED")
                    .0
                    .saturating_add(self.settlement_config.cancel_after_ns.0),
            "ERR_CANCEL_TOO_EARLY"
        );
        let wallet = self
            .wallets
            .get(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        let sender = wallet.address.expect("ERR_WALLET_NOT_DERIVED");
        let path = wallet.mpc_path.clone();
        let tx_digest = if let Some(attempt) = operation.cancellation.as_mut() {
            require!(
                attempt.signature.is_none() && attempt.signed_transaction.is_none(),
                "ERR_CANCELLATION_ALREADY_SIGNED"
            );
            // Retry the stored transaction even if the role's fee caps have changed.
            attempt.requested_at_ns = env::block_timestamp();
            attempt.request_count = attempt.request_count.saturating_add(1);
            attempt.tx_digest
        } else {
            let gas_config = self.gas_config(&operation.role);
            let (transaction, tx_digest) =
                evm::build_cancellation_transaction(&gas_config, &operation.transaction, sender);
            operation.cancellation = Some(types::CancellationAttempt {
                transaction,
                tx_digest,
                signature: None,
                signed_transaction: None,
                requested_at_ns: env::block_timestamp(),
                request_count: 1,
            });
            tx_digest
        };
        self.operations.insert(op_id, operation.clone());
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
        if attempt.tx_digest != tx_digest || attempt.signed_transaction.is_some() {
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
        if let Some(attempt) = operation.cancellation.as_mut()
            && signature_matches(attempt.tx_digest, &signature, expected_address)
        {
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
                OperationState::Prepared | OperationState::Queued | OperationState::Scheduled
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
        require!(
            report.kind == StatusKind::Confirmed,
            "ERR_FAILURE_REPORT_DISABLED"
        );
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
            env::ed25519_verify(&signature, &message, &self.status_public_key),
            "ERR_REPORT_SIGNATURE"
        );
        if let Some(signature) = mpc_signature
            && operation.signed_transaction.is_none()
        {
            self.submit_signature(report.op_id, signature);
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
            StatusKind::Failed => env::panic_str("ERR_FAILURE_REPORT_DISABLED"),
        }
    }

    pub fn confirm_cancellation(&mut self, op_id: OperationId, tx_hash: [u8; 32]) {
        let _ = (op_id, tx_hash);
        env::panic_str("ERR_CANCELLATION_PROOF_REQUIRED");
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
        if operation.role != DAO_ROLE {
            let membership = self
                .memberships
                .get(&MembershipKey {
                    role: operation.role.clone(),
                    member: operation.member.clone(),
                })
                .expect("ERR_MEMBERSHIP_NOT_FOUND");
            require!(membership.active, "ERR_MEMBERSHIP_REVOKED");
            require!(
                membership
                    .ends_at_ns
                    .is_none_or(|end| env::block_timestamp() <= end.0),
                "ERR_MEMBERSHIP_EXPIRED"
            );
        }
        if let Some(payout_id) = bank::payout_of_transfer(&op_id) {
            // A euro payout's transfer: the voted IBAN, the config and the role are rechecked, not
            // the role's EVM permissions (the partner's deposit address is not a supplier).
            self.recheck_bank_transfer(&payout_id, &operation);
        } else if operation.role != DAO_ROLE {
            let permission = &self
                .roles
                .get(&operation.role)
                .expect("ERR_ROLE_NOT_FOUND")
                .config
                .permissions[operation.permission_index as usize];
            let wallet = self
                .wallets
                .get(&operation.request.chain_id)
                .expect("ERR_WALLET_NOT_FOUND")
                .address
                .expect("ERR_WALLET_NOT_DERIVED");
            let now = env::block_timestamp();
            let context = EvaluationContext {
                member: &operation.member,
                role: &operation.role,
                chain_id: operation.request.chain_id,
                wallet,
                target: operation.request.target,
                value: operation.request.value.0,
                block_timestamp_ns: now,
                address_lists: self,
            };
            let allowances = ReservedAllowances {
                allowances: &self.allowances,
                now,
                own: &operation.consumptions,
            };
            let checked = conditions::evaluate(
                &permission.conditions,
                &operation.request.calldata,
                &context,
                &allowances,
            )
            .unwrap_or_else(|_| env::panic_str("ERR_CONDITIONS_CHANGED"));
            require!(
                checked.len() == operation.consumptions.len()
                    && checked
                        .iter()
                        .zip(&operation.consumptions)
                        .all(|(a, b)| a.key.as_slice() == b.key
                            && a.consumed == b.amount.0
                            && a.calls_only == b.calls_only),
                "ERR_RESERVATION_CHANGED"
            );
        }
        let wallet = self
            .wallets
            .get_mut(&operation.request.chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        require!(
            wallet.next_nonce == operation.evm_nonce,
            "ERR_NONCE_ALREADY_CONSUMED"
        );
        wallet.next_nonce = wallet.next_nonce.saturating_add(1);
        // Signed: the nonce is used, the next operation may take the following one.
        require!(
            wallet.in_flight.len() < types::MAX_IN_FLIGHT,
            "ERR_WALLET_QUEUE_BUSY"
        );
        wallet.in_flight.push(op_id);
        if wallet.active_operation == Some(op_id) {
            wallet.active_operation = None;
        }
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

    fn check_permission(
        &self,
        permission: &Permission,
        request: &OperationRequest,
        member: &AccountId,
        role: &str,
        wallet: [u8; 20],
        now: u64,
    ) -> Result<Vec<Consumption>, String> {
        if permission.chain_id != request.chain_id || permission.target != request.target {
            return Err("TargetNotAllowed".into());
        }
        if let Some(selector) = permission.selector
            && request.calldata.get(..4) != Some(selector.as_slice())
        {
            return Err("FunctionNotAllowed".into());
        }
        if request.value.0 > 0 && !permission.allow_value {
            return Err("SendNotAllowed".into());
        }
        let context = EvaluationContext {
            member,
            role,
            chain_id: request.chain_id,
            wallet,
            target: request.target,
            value: request.value.0,
            block_timestamp_ns: now,
            address_lists: self,
        };
        let allowances = ReservedAllowances {
            allowances: &self.allowances,
            now,
            own: &[],
        };
        conditions::evaluate(
            &permission.conditions,
            &request.calldata,
            &context,
            &allowances,
        )
        .map_err(|status| {
            near_sdk::serde_json::to_string(&status).unwrap_or_else(|_| format!("{status:?}"))
        })
    }

    /// Reserve what the conditions consumed. The caller-declared
    /// `allowance_amount` must equal the amount the engine measured.
    fn reserve_allowances(
        &mut self,
        consumptions: &[Consumption],
        request: &OperationRequest,
        now: u64,
    ) -> Vec<AllowanceConsumption> {
        let mut declared = 0u128;
        let mut reserved = Vec::with_capacity(consumptions.len());
        for consumption in consumptions {
            let key: AllowanceKey = consumption
                .key
                .as_slice()
                .try_into()
                .unwrap_or_else(|_| env::panic_str("ERR_ALLOWANCE_KEY"));
            let allowance = self
                .allowances
                .get_mut(&key)
                .expect("ERR_ALLOWANCE_NOT_FOUND");
            Self::refill_allowance(allowance, now);
            let available = allowance.balance.0.saturating_sub(allowance.reserved.0);
            require!(consumption.consumed <= available, "ERR_ALLOWANCE_EXCEEDED");
            allowance.reserved = U128(
                allowance
                    .reserved
                    .0
                    .checked_add(consumption.consumed)
                    .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_OVERFLOW")),
            );
            if !consumption.calls_only {
                declared = declared
                    .checked_add(consumption.consumed)
                    .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_OVERFLOW"));
            }
            reserved.push(AllowanceConsumption {
                key,
                amount: U128(consumption.consumed),
                calls_only: consumption.calls_only,
            });
        }
        require!(
            request.allowance_amount.0 == declared,
            "ERR_ALLOWANCE_AMOUNT_MISMATCH"
        );
        reserved
    }

    /// Largest value the vault can measure: native value or an amount charged
    /// to an allowance. `None` when the permission measures nothing.
    fn measured_value(
        request: &OperationRequest,
        consumptions: &[AllowanceConsumption],
    ) -> Option<u128> {
        let charged = consumptions
            .iter()
            .filter(|consumption| !consumption.calls_only)
            .map(|consumption| consumption.amount.0)
            .max();
        if request.value.0 == 0 && charged.is_none() {
            return None;
        }
        Some(charged.unwrap_or(0).max(request.value.0))
    }

    /// Value compared with delay and co-signature thresholds. An operation the
    /// vault cannot measure is treated as above every threshold (fail safe).
    fn threshold_value(measured_value: Option<u128>) -> u128 {
        measured_value.unwrap_or(u128::MAX)
    }

    fn reserve_velocity(
        &mut self,
        role: &str,
        config: &RoleConfig,
        request: &OperationRequest,
        measured_value: Option<u128>,
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
        let risk = measured_value.unwrap_or(0);
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
                    | OperationState::Unconfirmed
            ),
            "ERR_OPERATION_TERMINAL"
        );
        // A voted transaction, or a bank transfer queued like one, that ends before it started.
        self.dao_queue.retain(|queued| *queued != op_id);
        if operation.role == DAO_ROLE {
            // No role, budget or reference behind a DAO transaction.
            let wallet = self
                .wallets
                .get_mut(&operation.request.chain_id)
                .expect("ERR_WALLET_NOT_FOUND");
            wallet.release(op_id);
            operation.state = terminal;
            self.operations.insert(op_id, operation);
            return;
        }
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
        for consumption in &operation.consumptions {
            let allowance = self
                .allowances
                .get_mut(&consumption.key)
                .expect("ERR_ALLOWANCE_NOT_FOUND");
            allowance.reserved = U128(
                allowance
                    .reserved
                    .0
                    .checked_sub(consumption.amount.0)
                    .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_RESERVATION")),
            );
            if !rollback {
                allowance.balance = U128(
                    allowance
                        .balance
                        .0
                        .checked_sub(consumption.amount.0)
                        .unwrap_or_else(|| env::panic_str("ERR_ALLOWANCE_BALANCE")),
                );
            }
        }
        let velocity_key = VelocityKey {
            role: operation.role.clone(),
            chain_id: operation.request.chain_id,
        };
        if let Some(velocity) = self.velocities.get_mut(&velocity_key) {
            let risk = operation.measured_value.map_or(0, |value| value.0);
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
            .release(op_id);
        operation.state = terminal;
        self.operations.insert(op_id, operation);
    }

    fn apply_rule_change(&mut self, change: RuleChange, now: u64) {
        match change {
            RuleChange::AddListAddresses { list, entries } => {
                for entry in entries {
                    self.apply_rule_change(
                        RuleChange::AddListAddress {
                            list: list.clone(),
                            address: entry.address,
                            label: entry.label,
                        },
                        now,
                    );
                }
            }
            RuleChange::AddListAddress {
                list,
                address,
                label,
            } => {
                let entries = self.address_lists.entry(list).or_default();
                if let Some(entry) = entries.iter_mut().find(|entry| entry.address == address) {
                    entry.label = label;
                } else {
                    require!(entries.len() < 256, "ERR_ADDRESS_LIST_FULL");
                    entries.push(ListAddress { address, label });
                }
            }
            RuleChange::RemoveListAddress { list, address } => {
                if let Some(entries) = self.address_lists.get_mut(&list) {
                    entries.retain(|entry| entry.address != address);
                }
            }
            RuleChange::SetSettlementConfig { config } => {
                Self::validate_settlement_config(&config);
                self.settlement_config = config;
            }
            // Deployed by `execute_rule_change` once the code is fetched.
            RuleChange::Upgrade { .. } => {}
            RuleChange::SetCodeSource { account_id } => {
                env::log_str(&format!("OMNIROLES_CODE_SOURCE:{account_id}"));
                self.code_source = account_id;
            }
            change @ (RuleChange::SetBankConfig { .. }
            | RuleChange::AddBankBeneficiary { .. }
            | RuleChange::RemoveBankBeneficiary { .. }
            | RuleChange::SetBankPermission { .. }
            | RuleChange::SetBankBoxKey { .. }
            | RuleChange::AddSealedBankBeneficiary { .. }
            | RuleChange::RemoveSealedBankBeneficiary { .. }
            | RuleChange::AddStandingOrder { .. }
            | RuleChange::RemoveStandingOrder { .. }
            | RuleChange::SetBankSignerSource { .. }) => {
                self.apply_bank_rule(&change);
            }
            // Independent of SetRole's order in the same vote; RemoveRole clears it.
            RuleChange::SetSolanaPermissions { role, permissions } => {
                solana::set_permissions(&role, permissions);
            }
            RuleChange::SetNearPermissions { role, permissions } => {
                near_tokens::set_permissions(&role, permissions);
            }
            // The registration call is made by `execute_rule_change`.
            RuleChange::NearStorageDeposit { .. } => {}

            RuleChange::SetRole { role, config } => {
                require!(role != DAO_ROLE, "ERR_RESERVED_ROLE");
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
                solana::set_permissions(&role, Vec::new());
                near_tokens::set_permissions(&role, Vec::new());
            }
            RuleChange::GrantMembership {
                role,
                member,
                kind,
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
                require!(
                    self.memberships
                        .get(&key)
                        .is_none_or(|member| member.reserved_uses == 0),
                    "ERR_MEMBERSHIP_IN_USE"
                );
                self.memberships.insert(
                    key,
                    Membership {
                        role,
                        member,
                        kind,
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
                // Takes effect at once, even with operations in flight: nothing unsigned is
                // signed for a revoked member (request_operation_signature), and what is
                // already signed still settles or times out, releasing its reservation on
                // the entry kept here. Refusing instead let an agent block its own removal
                // by always keeping one operation open.
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
            RuleChange::SetVisaPublicKey { visa_public_key } => {
                self.visa_public_key = visa_public_key
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str("ERR_VISA_KEY_LENGTH"));
            }
            RuleChange::SetStatusPublicKey { status_public_key } => {
                self.status_public_key = status_public_key
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str("ERR_STATUS_KEY_LENGTH"));
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
            RuleChange::AddListAddresses { list, entries } => {
                Self::validate_list_name(list);
                require!(
                    !entries.is_empty() && entries.len() <= 256,
                    "ERR_ADDRESS_LIST_BATCH_SIZE"
                );
                let mut unique = std::collections::BTreeSet::new();
                for entry in entries {
                    require!(
                        entry.label.chars().count() <= 64,
                        "ERR_ADDRESS_LABEL_LENGTH"
                    );
                    require!(unique.insert(entry.address), "ERR_DUPLICATE_LIST_ADDRESS");
                }
            }
            RuleChange::AddListAddress { list, label, .. } => {
                Self::validate_list_name(list);
                require!(label.chars().count() <= 64, "ERR_ADDRESS_LABEL_LENGTH");
            }
            RuleChange::RemoveListAddress { list, .. } => Self::validate_list_name(list),
            RuleChange::SetSettlementConfig { config } => Self::validate_settlement_config(config),
            RuleChange::Upgrade { .. } => {}
            RuleChange::SetCodeSource { account_id } => require!(
                *account_id != env::current_account_id(),
                "ERR_CODE_SOURCE_SELF"
            ),
            change @ (RuleChange::SetBankConfig { .. }
            | RuleChange::AddBankBeneficiary { .. }
            | RuleChange::RemoveBankBeneficiary { .. }
            | RuleChange::SetBankPermission { .. }
            | RuleChange::SetBankBoxKey { .. }
            | RuleChange::AddSealedBankBeneficiary { .. }
            | RuleChange::RemoveSealedBankBeneficiary { .. }
            | RuleChange::AddStandingOrder { .. }
            | RuleChange::RemoveStandingOrder { .. }
            | RuleChange::SetBankSignerSource { .. }) => {
                Self::validate_bank_rule(change);
            }
            RuleChange::SetSolanaPermissions { role, permissions } => {
                require!(role != DAO_ROLE && !role.is_empty(), "ERR_RESERVED_ROLE");
                solana::validate_permissions(permissions);
            }
            RuleChange::SetNearPermissions { role, permissions } => {
                require!(role != DAO_ROLE && !role.is_empty(), "ERR_RESERVED_ROLE");
                near_tokens::validate_permissions(permissions);
            }
            RuleChange::NearStorageDeposit { token } => {
                require!(token != &env::current_account_id(), "ERR_NEAR_SELF");
            }

            RuleChange::SetRole { role, config } => {
                require!(role != DAO_ROLE, "ERR_RESERVED_ROLE");
                require!(!role.is_empty(), "ERR_EMPTY_ROLE");
                require!(
                    config.max_priority_fee_per_gas.0 <= config.max_fee_per_gas.0,
                    "ERR_PRIORITY_ABOVE_MAX_FEE"
                );
                if config.operation_delay_threshold.is_some() {
                    require!(config.operation_delay_ns > 0, "ERR_ZERO_OPERATION_DELAY");
                }
                require!(
                    config.co_sign_threshold.is_some() == config.co_signer_role.is_some(),
                    "ERR_COSIGNER_ROLE_THRESHOLD_PAIR"
                );
                if let Some(co_signer_role) = &config.co_signer_role {
                    require!(!co_signer_role.is_empty(), "ERR_EMPTY_COSIGNER_ROLE");
                    require!(co_signer_role != role, "ERR_COSIGNER_ROLE_SAME");
                }
                if let Some(velocity) = &config.velocity {
                    require!(velocity.limit.0 > 0, "ERR_ZERO_VELOCITY_LIMIT");
                    require!(velocity.window_ns > 0, "ERR_ZERO_VELOCITY_WINDOW");
                }
                // Condition trees are checked when the rule is queued, so the
                // DAO votes only on trees the engine can evaluate.
                for permission in &config.permissions {
                    if !permission.conditions.is_empty()
                        && let Err(error) = omniroles_conditions::validate(&permission.conditions)
                    {
                        env::panic_str(&format!("ERR_INVALID_CONDITIONS:{error:?}"));
                    }
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
            RuleChange::SetVisaPublicKey { visa_public_key } => {
                require!(visa_public_key.len() == 32, "ERR_VISA_KEY_LENGTH")
            }
            RuleChange::SetStatusPublicKey { status_public_key } => {
                require!(status_public_key.len() == 32, "ERR_STATUS_KEY_LENGTH")
            }
            RuleChange::RemoveRole { .. }
            | RuleChange::RevokeMembership { .. }
            | RuleChange::SetVersions { .. } => {}
        }
    }

    /// Keep the refusal of the permission that came closest to matching: a
    /// condition failure on the right contract and function explains more than
    /// "target not allowed" from an unrelated permission.
    fn closer_refusal(current: String, candidate: String) -> String {
        let rank = |reason: &str| match reason {
            "NoPermission" => 0,
            "TargetNotAllowed" => 1,
            "FunctionNotAllowed" => 2,
            "SendNotAllowed" => 3,
            _ => 4,
        };
        if rank(&candidate) >= rank(&current) {
            candidate
        } else {
            current
        }
    }

    fn membership_unavailable(membership: &Membership, now: u64) -> Option<&'static str> {
        if !membership.active {
            return Some("ERR_MEMBERSHIP_REVOKED");
        }
        if now < membership.starts_at_ns.0 {
            return Some("ERR_MEMBERSHIP_NOT_STARTED");
        }
        if membership.ends_at_ns.is_some_and(|end| now > end.0) {
            return Some("ERR_MEMBERSHIP_EXPIRED");
        }
        if membership.max_uses.is_some_and(|max_uses| {
            membership
                .used_uses
                .saturating_add(membership.reserved_uses)
                >= max_uses
        }) {
            return Some("ERR_MEMBERSHIP_USES_EXHAUSTED");
        }
        None
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
            env::ed25519_verify(&signature, &message, &self.visa_public_key),
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

    /// Gas caps of DAO transactions: wide (members vote on the fees), but bounded.
    fn dao_gas_config() -> RoleConfig {
        RoleConfig {
            guard_required: false,
            enabled: true,
            permissions: Vec::new(),
            operation_delay_threshold: None,
            operation_delay_ns: 0,
            co_sign_threshold: None,
            co_signer_role: None,
            velocity: None,
            gas_limit: U128(5_000_000),
            max_fee_per_gas: U128(500_000_000_000),
            max_priority_fee_per_gas: U128(100_000_000_000),
            max_total_fee: U128(500_000_000_000_000_000),
        }
    }

    fn gas_config(&self, role: &str) -> RoleConfig {
        if role == DAO_ROLE {
            return Self::dao_gas_config();
        }
        self.roles
            .get(role)
            .expect("ERR_ROLE_NOT_FOUND")
            .config
            .clone()
    }

    /// One key for every EVM chain: the company wallet has the same address
    /// everywhere, so funds sent to it on another chain are never stranded.
    fn wallet_path(_chain_id: u64) -> String {
        String::from("omniroles/evm")
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

#[cfg(test)]
mod bank_tests;
#[cfg(test)]
mod onchain_tests;
