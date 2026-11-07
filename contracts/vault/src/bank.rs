//! Bank payouts: an agent pays a voted IBAN in euros, under its role's budget.
//!
//! The IBAN is paid by a regulated partner (Noah) that converts EURC it receives from the company
//! wallet. The partner acts only on requests signed by a key that lives in an OutLayer enclave
//! (`bank-signer/`), and that enclave signs only for a call made by this vault. So the policy is
//! this contract's: beneficiary in the voted list, amount within the role's budget, reference
//! never used, membership active. Then:
//!
//! 1. `request_bank_payout` checks and reserves, and asks OutLayer to run the bank signer, which
//!    creates at the partner a single-use rule "exactly this amount, from this wallet, before this
//!    expiry, to this IBAN" and answers with the partner's deposit address;
//! 2. `on_bank_signer` turns that into an EURC transfer the vault itself signs through NEAR MPC,
//!    queued like a voted transaction (the same worker broadcasts and settles it);
//! 3. the partner sees the deposit, matches the rule, and pays the IBAN.
//!
//! The IBAN is never on chain. The members vote a sealed beneficiary: a salted commitment to the
//! IBAN and its holder, an envelope only the enclave can open (it recomputes the commitment and
//! refuses any other IBAN) and an envelope for the members' reading keys. The agent names the
//! beneficiary by its number; the vault forwards the enclave's envelope. Proposals, transactions,
//! the OutLayer input and output, and the payout records carry the number and the commitment only.
//!
//! Stored under raw keys (not new struct fields), so the vault's state layout is unchanged and
//! existing vaults move to this version by a DAO upgrade.
use crate::types::EvmAddress;
use crate::*;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

const KEY_CONFIG: &[u8] = b"bank:c";
const KEY_PERMISSION: &[u8] = b"bank:p:";
const KEY_PENDING: &[u8] = b"bank:pending";
const KEY_SEALED: &[u8] = b"bank:s";
const KEY_SEALED_SEQUENCE: &[u8] = b"bank:sn";
const KEY_BOX: &[u8] = b"bank:k";
const KEY_PAYOUT: &[u8] = b"bank:q:";
const KEY_INDEX: &[u8] = b"bank:qi";
const KEY_TRANSFER: &[u8] = b"bank:qt:";
/// The first version kept IBANs in clear; erased from state when a sealed beneficiary or the box
/// key is voted (the chain's history still has them: archival nodes keep every past state).
const LEGACY_BENEFICIARIES: &[u8] = b"bank:b";
const LEGACY_PAYOUT: &[u8] = b"bank:o:";
const LEGACY_INDEX: &[u8] = b"bank:i";
const KEY_ORDERS: &[u8] = b"bank:so";
const KEY_ORDER_SEQUENCE: &[u8] = b"bank:son";
const KEY_ORDER_RUN: &[u8] = b"bank:sor:";
const MAX_STANDING_ORDERS: usize = 64;
/// A standing order runs at most this often.
const MIN_ORDER_PERIOD_NS: u64 = 60_000_000_000;
const MAX_BENEFICIARIES: usize = 64;
const MAX_LABEL_CHARS: usize = 32;
const MAX_SEALED_FOR_SIGNER: usize = 2_048;
const MAX_SEALED_FOR_MEMBERS: usize = 8_192;
const MAX_REFERENCE_CHARS: usize = 140;
/// Attached to OutLayer for the run; what it does not use comes back to the vault.
const OUTLAYER_DEPOSIT: NearToken = NearToken::from_millinear(20);
const OUTLAYER_GAS: Gas = Gas::from_tgas(120);
const SIGNER_CALLBACK_GAS: Gas = Gas::from_tgas(40);
const REQUEST_OVERHEAD_GAS: Gas = Gas::from_tgas(20);
/// The partner's rule and the transfer both expire after this.
const PAYOUT_TTL_NS: u64 = 24 * 3_600_000_000_000;
/// ERC-20 `transfer(address,uint256)`.
const TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

/// Where payouts run and settle. Voted by the DAO (`SetBankConfig`).
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct BankConfig {
    /// OutLayer's contract (`outlayer.testnet`).
    pub outlayer_id: AccountId,
    /// The bank signer's WASM, by URL and sha256; OutLayer refuses other bytes.
    pub signer_url: String,
    pub signer_hash: String,
    /// The secret row the signer reads (its partner credentials), owned by `secrets_owner`.
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
    /// This company at the partner, and how the partner names the chain and the euro token.
    pub customer_id: String,
    pub network: String,
    pub crypto: String,
    /// The euro token the vault pays with, on this chain.
    pub chain_id: u64,
    pub token: EvmAddress,
    pub decimals: u8,
    /// Fees of the EURC transfer on that chain, within the DAO's gas policy.
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

/// The first version's beneficiary, in clear: still decoded for rules queued before, never stored.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct BankBeneficiary {
    pub iban: String,
    pub name: String,
    /// "Business" or "Individual".
    pub holder_type: String,
}

/// A beneficiary the members voted, without its IBAN.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SealedBeneficiary {
    pub id: u32,
    /// Public, chosen by the members (never a name): what agents and the activity show.
    pub label: String,
    /// sha256("euthyna-bank-beneficiary-v1" 0 vault 0 IBAN 0 holder 0 type 0 salt), hex.
    pub commitment: String,
    /// Base64; opened only by the bank signer enclave, and only for this vault.
    pub sealed_for_signer: String,
    /// Base64; opened by the members' reading keys.
    pub sealed_for_members: String,
}

/// What a role may pay to the voted IBANs.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct BankPermission {
    /// Budget charged with the amount, in the euro token's base units.
    pub allowance: AllowanceKey,
    pub max_per_payout: U128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum BankPayoutState {
    /// The bank signer is being asked for the partner's single-use rule.
    Requested,
    /// The rule exists; the EURC transfer is queued (`transfer_op_id`), signed by the vault.
    Transferring,
    /// The signer refused or failed: nothing was reserved any more.
    Failed,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct BankPayout {
    pub op_id: OperationId,
    pub member: AccountId,
    pub role: String,
    pub beneficiary_id: u32,
    pub beneficiary_label: String,
    pub commitment: String,
    pub amount: U128,
    pub reference: String,
    pub consumption: AllowanceConsumption,
    pub state: BankPayoutState,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub rule_id: Option<String>,
    pub deposit_address: Option<EvmAddress>,
    pub fiat_amount: Option<String>,
    /// The EURC transfer, an operation like a voted transaction.
    pub transfer_op_id: Option<OperationId>,
    pub error: Option<String>,
}

/// A payout the members voted once and the vault makes on schedule: payroll, rent, a retainer.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct StandingOrder {
    pub id: u32,
    pub beneficiary_id: u32,
    /// In the euro token's base units, every time.
    pub amount: U128,
    pub next_at_ns: U64,
    pub period_ns: U64,
    /// Runs left; none: until the members remove it.
    pub remaining: Option<u32>,
    pub runs: u32,
    /// Public, like the beneficiary's label: never a name.
    pub label: String,
}

impl StandingOrder {
    fn reference_prefix(&self) -> String {
        format!("SO{}", self.id)
    }
}

#[near(serializers = [json])]
pub struct BankCheck {
    pub allowed: bool,
    pub reason: Option<String>,
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key)
        .map(|bytes| T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("ERR_BANK_STATE")))
}
fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(
        key,
        &borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("ERR_BANK_STATE")),
    );
}
fn key(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    [prefix, suffix].concat()
}
pub(crate) fn config() -> Option<BankConfig> {
    read(KEY_CONFIG)
}
pub(crate) fn set_config(config: Option<BankConfig>) {
    match config {
        Some(config) => write(KEY_CONFIG, &config),
        None => {
            env::storage_remove(KEY_CONFIG);
        }
    }
}
pub(crate) fn beneficiaries() -> Vec<SealedBeneficiary> {
    read(KEY_SEALED).unwrap_or_default()
}
fn set_beneficiaries(entries: &[SealedBeneficiary]) {
    if entries.is_empty() {
        env::storage_remove(KEY_SEALED);
    } else {
        write(KEY_SEALED, &entries.to_vec());
    }
}
fn beneficiary(id: u32) -> Option<SealedBeneficiary> {
    beneficiaries().into_iter().find(|entry| entry.id == id)
}
pub(crate) fn box_key() -> Option<String> {
    read(KEY_BOX)
}
fn legacy_beneficiaries() -> Vec<BankBeneficiary> {
    read(LEGACY_BENEFICIARIES).unwrap_or_default()
}
/// Erases the first version's clear IBANs and payout records from state.
fn erase_cleartext() {
    env::storage_remove(LEGACY_BENEFICIARIES);
    if let Some(ids) = env::storage_read(LEGACY_INDEX) {
        let ids: Vec<OperationId> = BorshDeserialize::try_from_slice(&ids).unwrap_or_default();
        for id in ids.iter().take(500) {
            env::storage_remove(&key(LEGACY_PAYOUT, id));
        }
        env::storage_remove(LEGACY_INDEX);
    }
}
fn hex64(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit())
}
pub(crate) fn permission_of(role: &str) -> Option<BankPermission> {
    read(&key(KEY_PERMISSION, role.as_bytes()))
}
pub(crate) fn set_permission(role: &str, permission: Option<BankPermission>) {
    let storage_key = key(KEY_PERMISSION, role.as_bytes());
    match permission {
        Some(permission) => write(&storage_key, &permission),
        None => {
            env::storage_remove(&storage_key);
        }
    }
}
fn payout(op_id: &OperationId) -> BankPayout {
    read(&key(KEY_PAYOUT, op_id)).unwrap_or_else(|| env::panic_str("ERR_OPERATION_NOT_FOUND"))
}
fn store(payout: &BankPayout) {
    write(&key(KEY_PAYOUT, &payout.op_id), payout);
}
fn index() -> Vec<OperationId> {
    read(KEY_INDEX).unwrap_or_default()
}
/// The payout behind a queued EURC transfer, if the operation is one.
pub(crate) fn payout_of_transfer(transfer_id: &OperationId) -> Option<OperationId> {
    read(&key(KEY_TRANSFER, transfer_id))
}
fn standing_orders() -> Vec<StandingOrder> {
    read(KEY_ORDERS).unwrap_or_default()
}
fn set_standing_orders(orders: &[StandingOrder]) {
    if orders.is_empty() {
        env::storage_remove(KEY_ORDERS);
    } else {
        write(KEY_ORDERS, &orders.to_vec());
    }
}

/// Asks OutLayer to run the bank signer for this payout; the callback queues the transfer.
fn call_signer(
    config: &BankConfig,
    entry: &SealedBeneficiary,
    op_id: OperationId,
    amount: u128,
    reference: &str,
    expires_at_ns: u64,
    source: EvmAddress,
) -> Promise {
    // What the signer gets: the payout the vault just authorised, nothing it could widen.
    // The partner's nonce is at most 36 characters: the first 128 bits of the payout id.
    let input = format!(
        "{{\"op\":\"payout\",\"vault\":{},\"customer_id\":{},\"commitment\":{},\"sealed\":{},\"reference\":{},\"crypto_amount\":{},\"source_address\":{},\"network\":{},\"crypto\":{},\"nonce\":{},\"expiry\":{}}}",
        json_string(env::current_account_id().as_str()),
        json_string(&config.customer_id),
        json_string(&entry.commitment),
        json_string(&entry.sealed_for_signer),
        json_string(reference),
        json_string(&decimal_string(amount, config.decimals)),
        json_string(&format!("0x{}", hex::encode(source))),
        json_string(&config.network),
        json_string(&config.crypto),
        json_string(&hex::encode(&op_id[..16])),
        json_string(&rfc3339(expires_at_ns)),
    );
    let args = format!(
        "{{\"source\":{{\"WasmUrl\":{{\"url\":{},\"hash\":{},\"build_target\":\"wasm32-wasip2\"}}}},\"resource_limits\":{{\"max_instructions\":2000000000,\"max_memory_mb\":128,\"max_execution_seconds\":60}},\"input_data\":{},\"secrets_ref\":{{\"profile\":{},\"account_id\":{}}},\"response_format\":\"Json\",\"payer_account_id\":{}}}",
        json_string(&config.signer_url),
        json_string(&config.signer_hash),
        json_string(&input),
        json_string(&config.secrets_profile),
        json_string(config.secrets_owner.as_str()),
        json_string(env::current_account_id().as_str()),
    );
    Promise::new(config.outlayer_id.clone())
        .function_call(
            "request_execution".to_owned(),
            args.into_bytes(),
            OUTLAYER_DEPOSIT,
            OUTLAYER_GAS,
        )
        .then(
            Vault::ext(env::current_account_id())
                .with_static_gas(SIGNER_CALLBACK_GAS)
                .on_bank_signer(op_id),
        )
}

fn pending() -> Option<OperationId> {
    read(KEY_PENDING)
}
fn set_pending(op_id: Option<OperationId>) {
    match op_id {
        Some(op_id) => write(KEY_PENDING, &op_id),
        None => {
            env::storage_remove(KEY_PENDING);
        }
    }
}

/// IBANs compare without spaces, in upper case.
pub(crate) fn canonical_iban(iban: &str) -> String {
    iban.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub(crate) fn validate_sealed(
    label: &str,
    commitment: &str,
    sealed_for_signer: &str,
    sealed_for_members: &str,
) {
    require!(
        label.chars().count() <= MAX_LABEL_CHARS && label.chars().all(|c| (' '..='~').contains(&c)),
        "ERR_BANK_LABEL"
    );
    require!(hex64(commitment), "ERR_BANK_COMMITMENT");
    let base64 = |text: &str| {
        !text.is_empty()
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
    };
    require!(
        base64(sealed_for_signer) && sealed_for_signer.len() <= MAX_SEALED_FOR_SIGNER,
        "ERR_BANK_SEALED"
    );
    require!(
        base64(sealed_for_members) && sealed_for_members.len() <= MAX_SEALED_FOR_MEMBERS,
        "ERR_BANK_SEALED"
    );
}

pub(crate) fn validate_config(config: &BankConfig) {
    require!(
        config.signer_hash.len() == 64 && config.signer_hash.chars().all(|c| c.is_ascii_hexdigit()),
        "ERR_BANK_SIGNER_HASH"
    );
    require!(
        config.signer_url.starts_with("https://") && config.signer_url.len() <= 512,
        "ERR_BANK_SIGNER_URL"
    );
    require!(
        !config.customer_id.is_empty() && config.customer_id.len() <= 64,
        "ERR_BANK_CUSTOMER"
    );
    require!(
        !config.network.is_empty()
            && !config.crypto.is_empty()
            && !config.secrets_profile.is_empty(),
        "ERR_BANK_CONFIG"
    );
    require!(config.decimals <= 18, "ERR_BANK_DECIMALS");
    evm::validate_gas(
        &Vault::dao_gas_config(),
        config.gas_limit,
        config.max_fee_per_gas,
        config.max_priority_fee_per_gas,
    );
}

/// "5000000" with 6 decimals -> "5", "5123456" -> "5.123456": what the partner's rule matches.
fn decimal_string(amount: u128, decimals: u8) -> String {
    let scale = 10u128.pow(decimals as u32);
    let whole = amount / scale;
    let fraction = amount % scale;
    if fraction == 0 || decimals == 0 {
        return whole.to_string();
    }
    let digits = format!("{fraction:0width$}", width = decimals as usize);
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

/// RFC 3339 at second precision, from nanoseconds since the epoch (Howard Hinnant's civil-from-days).
fn rfc3339(ns: u64) -> String {
    let seconds = ns / 1_000_000_000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

fn json_string(value: &str) -> String {
    near_sdk::serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[near]
impl Vault {
    pub fn get_bank_config(&self) -> Option<BankConfig> {
        config()
    }

    pub fn list_bank_beneficiaries(&self) -> Vec<SealedBeneficiary> {
        beneficiaries()
    }

    /// The enclave's X25519 key beneficiaries are sealed to (hex), as the members voted it.
    pub fn get_bank_box_key(&self) -> Option<String> {
        box_key()
    }

    pub fn get_bank_permission(&self, role: String) -> Option<BankPermission> {
        permission_of(&role)
    }

    pub fn get_bank_payout(&self, op_id: OperationId) -> Option<BankPayout> {
        read(&key(KEY_PAYOUT, &op_id))
    }

    /// Payouts, oldest first.
    pub fn list_bank_payouts(
        &self,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<BankPayout> {
        let ids = index();
        let from = from_index.unwrap_or(0) as usize;
        ids.iter()
            .skip(from)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(payout)
            .collect()
    }

    pub fn count_bank_payouts(&self) -> u64 {
        index().len() as u64
    }

    /// The payout an agent started with this reference, if any.
    pub fn get_bank_payout_by_reference(
        &self,
        role: String,
        reference: String,
    ) -> Option<BankPayout> {
        // Once the transfer is queued, the reference names the transfer; the payout record keeps the link.
        let id = *self.references.get(&ReferenceKey { role, reference })?;
        read(&key(KEY_PAYOUT, &id)).or_else(|| {
            index()
                .iter()
                .rev()
                .map(payout)
                .find(|payout| payout.transfer_op_id == Some(id))
        })
    }

    /// Dry run: would `request_bank_payout` accept this from `member`?
    pub fn check_bank_payout(
        &self,
        role: String,
        member: AccountId,
        beneficiary: u32,
        amount: U128,
        reference: String,
    ) -> BankCheck {
        match self.bank_permission(
            &role,
            &member,
            beneficiary,
            amount.0,
            &reference,
            env::block_timestamp(),
        ) {
            Ok(_) => BankCheck {
                allowed: true,
                reason: None,
            },
            Err(reason) => BankCheck {
                allowed: false,
                reason: Some(reason.to_owned()),
            },
        }
    }

    /// Agent: checked and charged to the budget, then the bank signer is asked for the
    /// partner's rule. Returns the payout id; the transfer follows in the callback.
    #[payable]
    pub fn request_bank_payout(
        &mut self,
        role: String,
        beneficiary: u32,
        amount: U128,
        reference: String,
    ) -> Promise {
        self.assert_not_paused();
        require!(
            env::prepaid_gas()
                >= OUTLAYER_GAS
                    .saturating_add(SIGNER_CALLBACK_GAS)
                    .saturating_add(REQUEST_OVERHEAD_GAS),
            "ERR_BANK_GAS"
        );
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let (config, entry, allowance) = self
            .bank_permission(&role, &member, beneficiary, amount.0, &reference, now)
            .unwrap_or_else(|reason| env::panic_str(&format!("ERR_PERMISSION_DENIED:{reason}")));
        let wallet = self
            .wallets
            .get(&config.chain_id)
            .expect("ERR_WALLET_NOT_FOUND");
        let source = wallet.address.expect("ERR_WALLET_NOT_DERIVED");

        // Same accounting as the other agent operations: budget, membership use, role in use, reference.
        let budget = self
            .allowances
            .get_mut(&allowance)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        Self::refill_allowance(budget, now);
        require!(
            amount.0 <= budget.balance.0.saturating_sub(budget.reserved.0),
            "ERR_ALLOWANCE_EXCEEDED"
        );
        budget.reserved = U128(budget.reserved.0.saturating_add(amount.0));
        self.reserve_membership_use(&MembershipKey {
            role: role.clone(),
            member: member.clone(),
        });
        let reservations = self.role_reservations.entry(role.clone()).or_insert(0);
        *reservations = reservations.saturating_add(1);
        let reference_key = ReferenceKey {
            role: role.clone(),
            reference: reference.clone(),
        };
        require!(
            !self.references.contains_key(&reference_key),
            "ERR_REFERENCE_ALREADY_USED"
        );

        let op_id = self.next_operation_id(&member, config.chain_id);
        self.references.insert(reference_key, op_id);
        let expires_at_ns = now.saturating_add(PAYOUT_TTL_NS);
        store(&BankPayout {
            op_id,
            member,
            role,
            beneficiary_id: entry.id,
            beneficiary_label: entry.label.clone(),
            commitment: entry.commitment.clone(),
            amount,
            reference: reference.clone(),
            consumption: AllowanceConsumption {
                key: allowance,
                amount,
                calls_only: false,
            },
            state: BankPayoutState::Requested,
            created_at_ns: U64(now),
            expires_at_ns: U64(expires_at_ns),
            rule_id: None,
            deposit_address: None,
            fiat_amount: None,
            transfer_op_id: None,
            error: None,
        });
        set_pending(Some(op_id));
        let mut ids = index();
        ids.push(op_id);
        write(KEY_INDEX, &ids);
        env::log_str(&format!(
            "OMNIROLES_BANK_PAYOUT_REQUESTED:{}",
            hex::encode(op_id)
        ));

        call_signer(
            &config,
            &entry,
            op_id,
            amount.0,
            &reference,
            expires_at_ns,
            source,
        )
    }

    pub fn list_standing_orders(&self) -> Vec<StandingOrder> {
        standing_orders()
    }

    /// Standing orders whose date has come (the keeper runs them).
    pub fn due_standing_orders(&self) -> Vec<u32> {
        let now = env::block_timestamp();
        standing_orders()
            .into_iter()
            .filter(|order| order.next_at_ns.0 <= now)
            .map(|order| order.id)
            .collect()
    }

    /// Anyone, once its date has come: pays a standing order the members voted (payroll, rent,
    /// a monthly supplier). No agent and no budget: the vote is the authorisation, so the vault
    /// pays exactly the voted beneficiary and amount, and moves the order to its next date.
    pub fn run_standing_order(&mut self, id: u32) -> Promise {
        self.assert_not_paused();
        require!(
            env::prepaid_gas()
                >= OUTLAYER_GAS
                    .saturating_add(SIGNER_CALLBACK_GAS)
                    .saturating_add(REQUEST_OVERHEAD_GAS),
            "ERR_BANK_GAS"
        );
        let now = env::block_timestamp();
        let mut orders = standing_orders();
        let position = orders
            .iter()
            .position(|order| order.id == id)
            .unwrap_or_else(|| env::panic_str("ERR_STANDING_ORDER_NOT_FOUND"));
        let order = orders[position].clone();
        require!(order.next_at_ns.0 <= now, "ERR_STANDING_ORDER_NOT_DUE");
        require!(pending().is_none(), "ERR_BANK_PAYOUT_PENDING");
        let config = config().unwrap_or_else(|| env::panic_str("ERR_BANK_NOT_CONFIGURED"));
        let entry = beneficiary(order.beneficiary_id)
            .unwrap_or_else(|| env::panic_str("BeneficiaryNotAllowed"));
        let source = self
            .wallets
            .get(&config.chain_id)
            .and_then(|wallet| wallet.address)
            .unwrap_or_else(|| env::panic_str("ERR_WALLET_NOT_DERIVED"));
        let reference = format!(
            "{}-{}",
            order.reference_prefix(),
            order.runs.saturating_add(1)
        );
        let reference_key = ReferenceKey {
            role: DAO_ROLE.to_owned(),
            reference: reference.clone(),
        };
        require!(
            !self.references.contains_key(&reference_key),
            "ERR_REFERENCE_ALREADY_USED"
        );
        let vault = env::current_account_id();
        let op_id = self.next_operation_id(&vault, config.chain_id);
        self.references.insert(reference_key, op_id);
        let expires_at_ns = now.saturating_add(PAYOUT_TTL_NS);
        store(&BankPayout {
            op_id,
            member: vault,
            role: DAO_ROLE.to_owned(),
            beneficiary_id: entry.id,
            beneficiary_label: entry.label.clone(),
            commitment: entry.commitment.clone(),
            amount: order.amount,
            reference: reference.clone(),
            consumption: AllowanceConsumption {
                key: [0; 32],
                amount: U128(0),
                calls_only: false,
            },
            state: BankPayoutState::Requested,
            created_at_ns: U64(now),
            expires_at_ns: U64(expires_at_ns),
            rule_id: None,
            deposit_address: None,
            fiat_amount: None,
            transfer_op_id: None,
            error: None,
        });
        set_pending(Some(op_id));
        let mut ids = index();
        ids.push(op_id);
        write(KEY_INDEX, &ids);
        // The next date now; put back if this payout fails, so the keeper tries again.
        write(&key(KEY_ORDER_RUN, &op_id), &order);
        let mut next = order.clone();
        next.runs = next.runs.saturating_add(1);
        next.next_at_ns = U64(order.next_at_ns.0.saturating_add(order.period_ns.0));
        match next.remaining {
            Some(1) => {
                orders.remove(position);
            }
            remaining => {
                next.remaining = remaining.map(|count| count.saturating_sub(1));
                orders[position] = next;
            }
        }
        set_standing_orders(&orders);
        env::log_str(&format!(
            "OMNIROLES_BANK_PAYOUT_REQUESTED:{}",
            hex::encode(op_id)
        ));
        env::log_str(&format!("OMNIROLES_STANDING_ORDER_RUN:{id}"));
        call_signer(
            &config,
            &entry,
            op_id,
            order.amount.0,
            &reference,
            expires_at_ns,
            source,
        )
    }

    /// The signer answered: queue the EURC transfer to the partner's deposit address, or release.
    #[private]
    pub fn on_bank_signer(
        &mut self,
        op_id: OperationId,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) -> BankPayoutState {
        let mut payout = payout(&op_id);
        require!(
            payout.state == BankPayoutState::Requested,
            "ERR_NOT_PENDING"
        );
        set_pending(None);
        let answer = match result {
            Ok(value) => value,
            Err(_) => return self.fail_bank_payout(payout, "signer unreachable"),
        };
        if answer["ok"].as_bool() != Some(true) {
            let error = answer["error"]
                .as_str()
                .unwrap_or("signer refused")
                .to_string();
            return self.fail_bank_payout(payout, &error);
        }
        let config = match config() {
            Some(config) => config,
            None => return self.fail_bank_payout(payout, "bank not configured"),
        };
        let deposit = match answer["deposit_address"]
            .as_str()
            .and_then(|text| hex::decode(text.trim_start_matches("0x")).ok())
        {
            Some(bytes) if bytes.len() == 20 => {
                let mut address = [0u8; 20];
                address.copy_from_slice(&bytes);
                address
            }
            _ => return self.fail_bank_payout(payout, "signer answered without a deposit address"),
        };
        if answer["crypto_amount"].as_str()
            != Some(decimal_string(payout.amount.0, config.decimals).as_str())
        {
            return self.fail_bank_payout(payout, "signer answered for another amount");
        }
        // The transfer: exactly the rule's amount, from the company wallet, to the partner's address.
        let mut calldata = Vec::with_capacity(68);
        calldata.extend_from_slice(&TRANSFER_SELECTOR);
        calldata.extend_from_slice(&[0u8; 12]);
        calldata.extend_from_slice(&deposit);
        calldata.extend_from_slice(&[0u8; 16]);
        calldata.extend_from_slice(&payout.amount.0.to_be_bytes());
        let now = env::block_timestamp();
        let gas_config = Self::dao_gas_config();
        let request = OperationRequest {
            chain_id: config.chain_id,
            target: config.token,
            value: U128(0),
            calldata,
            allowance_amount: payout.amount,
            reference: payout.reference.clone(),
            gas_limit: config.gas_limit,
            max_fee_per_gas: config.max_fee_per_gas,
            max_priority_fee_per_gas: config.max_priority_fee_per_gas,
        };
        let (placeholder, _) = evm::build_transaction(&gas_config, 0, &request);
        let transfer_id = self.next_operation_id(&payout.member, config.chain_id);
        // The role's delay applies above its threshold, as for its other operations; the council can veto meanwhile.
        let delay = self
            .roles
            .get(&payout.role)
            .map(|state| &state.config)
            .filter(|role| {
                role.operation_delay_threshold
                    .is_some_and(|threshold| payout.amount.0 >= threshold.0)
            })
            .map_or(0, |role| role.operation_delay_ns);
        let execute_after = now.saturating_add(delay);
        self.operations.insert(
            transfer_id,
            Operation {
                op_id: transfer_id,
                client_id: self.client_id.clone(),
                member: payout.member.clone(),
                role: payout.role.clone(),
                request,
                permission_index: 0,
                consumptions: if payout.role == DAO_ROLE {
                    Vec::new()
                } else {
                    vec![payout.consumption.clone()]
                },
                measured_value: None,
                policy_version: self.policy_version,
                registry_version: self.registry_version,
                evm_nonce: 0,
                transaction: placeholder,
                tx_digest: [0; 32],
                created_at_ns: U64(now),
                expires_at_ns: payout.expires_at_ns,
                execute_after_ns: Some(U64(execute_after)),
                visa_authorized: true,
                cosigned_by: None,
                possibly_signed_at_ns: None,
                state: OperationState::Scheduled,
                signature: None,
                signed_transaction: None,
                cancellation: None,
            },
        );
        // The reference now names the transfer: the agent's reference stays used either way.
        self.references.insert(
            ReferenceKey {
                role: payout.role.clone(),
                reference: payout.reference.clone(),
            },
            transfer_id,
        );
        self.dao_queue.push(transfer_id);
        // Listed with the voted transactions: the same keeper starts, broadcasts and settles it.
        self.dao_sequence = self.dao_sequence.saturating_add(1);
        self.dao_transactions.insert(self.dao_sequence, transfer_id);
        write(&key(KEY_TRANSFER, &transfer_id), &op_id);
        payout.rule_id = answer["rule_id"].as_str().map(str::to_owned);
        payout.deposit_address = Some(deposit);
        payout.fiat_amount = answer["fiat_amount"].as_str().map(str::to_owned);
        payout.transfer_op_id = Some(transfer_id);
        payout.state = BankPayoutState::Transferring;
        store(&payout);
        env::log_str(&format!(
            "OMNIROLES_BANK_PAYOUT_TRANSFERRING:{}:{}",
            hex::encode(op_id),
            hex::encode(transfer_id)
        ));
        env::log_str(&format!(
            "OMNIROLES_DAO_TRANSACTION_SCHEDULED:{}",
            hex::encode(transfer_id)
        ));
        BankPayoutState::Transferring
    }
}

impl Vault {
    #[allow(clippy::type_complexity)]
    fn bank_permission(
        &self,
        role: &str,
        member: &AccountId,
        beneficiary_id: u32,
        amount: u128,
        reference: &str,
        now: u64,
    ) -> Result<(BankConfig, SealedBeneficiary, AllowanceKey), &'static str> {
        if self.paused {
            return Err("ERR_PAUSED");
        }
        let config = config().ok_or("ERR_BANK_NOT_CONFIGURED")?;
        if reference.is_empty() || reference.chars().count() > MAX_REFERENCE_CHARS {
            return Err("ERR_BANK_REFERENCE");
        }
        if pending().is_some() {
            return Err("ERR_BANK_PAYOUT_PENDING");
        }
        let state = self.roles.get(role).ok_or("ERR_ROLE_NOT_FOUND")?;
        if !state.config.enabled {
            return Err("ERR_ROLE_DISABLED");
        }
        if state.config.guard_required {
            return Err("ERR_VISA_REQUIRED");
        }
        let membership = self
            .memberships
            .get(&MembershipKey {
                role: role.to_owned(),
                member: member.clone(),
            })
            .ok_or("ERR_MEMBERSHIP_NOT_FOUND")?;
        if !membership.active
            || now < membership.starts_at_ns.0
            || membership.ends_at_ns.is_some_and(|end| now > end.0)
            || membership.max_uses.is_some_and(|max| {
                membership
                    .used_uses
                    .saturating_add(membership.reserved_uses)
                    >= max
            })
        {
            return Err("ERR_MEMBERSHIP_UNAVAILABLE");
        }
        if amount == 0 {
            return Err("ERR_ZERO_AMOUNT");
        }
        let beneficiary = beneficiary(beneficiary_id).ok_or("BeneficiaryNotAllowed")?;
        let permission = permission_of(role).ok_or("FunctionNotAllowed")?;
        if amount > permission.max_per_payout.0 {
            return Err("ERR_MAX_PER_PAYOUT");
        }
        let mut budget = self
            .allowances
            .get(&permission.allowance)
            .ok_or("ERR_ALLOWANCE_NOT_FOUND")?
            .clone();
        Self::refill_allowance(&mut budget, now);
        if amount > budget.balance.0.saturating_sub(budget.reserved.0) {
            return Err("ERR_ALLOWANCE_EXCEEDED");
        }
        Ok((config, beneficiary, permission.allowance))
    }

    /// Before the transfer is signed: the payout still stands under the rules of the moment.
    pub(crate) fn recheck_bank_transfer(&self, payout_id: &OperationId, operation: &Operation) {
        let payout = payout(payout_id);
        require!(
            payout.state == BankPayoutState::Transferring,
            "ERR_CONDITIONS_CHANGED"
        );
        let config = config().unwrap_or_else(|| env::panic_str("ERR_CONDITIONS_CHANGED"));
        require!(
            config.chain_id == operation.request.chain_id
                && config.token == operation.request.target,
            "ERR_CONDITIONS_CHANGED"
        );
        require!(
            beneficiary(payout.beneficiary_id)
                .is_some_and(|entry| entry.commitment == payout.commitment),
            "ERR_CONDITIONS_CHANGED"
        );
        if payout.role == DAO_ROLE {
            // A standing order: voted as such; the beneficiary and the config were checked above.
            return;
        }
        let permission =
            permission_of(&payout.role).unwrap_or_else(|| env::panic_str("ERR_CONDITIONS_CHANGED"));
        require!(
            permission.allowance == payout.consumption.key
                && payout.amount.0 <= permission.max_per_payout.0,
            "ERR_CONDITIONS_CHANGED"
        );
        require!(
            self.roles
                .get(&payout.role)
                .is_some_and(|state| state.config.enabled),
            "ERR_ROLE_DISABLED"
        );
    }

    /// Nothing left the company: give back the budget, the membership use and the reference.
    fn fail_bank_payout(&mut self, mut payout: BankPayout, error: &str) -> BankPayoutState {
        if payout.role == DAO_ROLE {
            // A standing order: nothing was reserved; it goes back to the date it was due.
            if let Some(order) = read::<StandingOrder>(&key(KEY_ORDER_RUN, &payout.op_id)) {
                let mut orders: Vec<StandingOrder> = standing_orders()
                    .into_iter()
                    .filter(|existing| existing.id != order.id)
                    .collect();
                orders.push(order);
                orders.sort_by_key(|order| order.id);
                set_standing_orders(&orders);
                env::storage_remove(&key(KEY_ORDER_RUN, &payout.op_id));
            }
            self.references.remove(&ReferenceKey {
                role: payout.role.clone(),
                reference: payout.reference.clone(),
            });
            payout.state = BankPayoutState::Failed;
            payout.error = Some(error.chars().take(200).collect());
            store(&payout);
            env::log_str(&format!(
                "OMNIROLES_BANK_PAYOUT_FAILED:{}",
                hex::encode(payout.op_id)
            ));
            return BankPayoutState::Failed;
        }
        let reservations = self
            .role_reservations
            .get_mut(&payout.role)
            .expect("ERR_ROLE_RESERVATION_MISSING");
        *reservations = reservations.saturating_sub(1);
        let membership = self
            .memberships
            .get_mut(&MembershipKey {
                role: payout.role.clone(),
                member: payout.member.clone(),
            })
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        membership.reserved_uses = membership.reserved_uses.saturating_sub(1);
        let budget = self
            .allowances
            .get_mut(&payout.consumption.key)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        budget.reserved = U128(
            budget
                .reserved
                .0
                .saturating_sub(payout.consumption.amount.0),
        );
        self.references.remove(&ReferenceKey {
            role: payout.role.clone(),
            reference: payout.reference.clone(),
        });
        payout.state = BankPayoutState::Failed;
        payout.error = Some(error.chars().take(200).collect());
        store(&payout);
        env::log_str(&format!(
            "OMNIROLES_BANK_PAYOUT_FAILED:{}",
            hex::encode(payout.op_id)
        ));
        BankPayoutState::Failed
    }

    pub(crate) fn apply_bank_rule(&mut self, change: &RuleChange) -> bool {
        match change {
            RuleChange::SetBankConfig { config } => set_config(config.clone()),
            // Queued before sealed beneficiaries: an IBAN in clear is not stored any more.
            RuleChange::AddBankBeneficiary { .. } => {
                env::log_str("OMNIROLES_BANK_CLEARTEXT_IBAN_IGNORED");
            }
            RuleChange::RemoveBankBeneficiary { iban } => {
                let wanted = canonical_iban(iban);
                let entries: Vec<BankBeneficiary> = legacy_beneficiaries()
                    .into_iter()
                    .filter(|entry| canonical_iban(&entry.iban) != wanted)
                    .collect();
                if entries.is_empty() {
                    env::storage_remove(LEGACY_BENEFICIARIES);
                } else {
                    write(LEGACY_BENEFICIARIES, &entries);
                }
            }
            RuleChange::SetBankBoxKey { key } => {
                erase_cleartext();
                match key {
                    Some(key) => write(KEY_BOX, &key.to_ascii_lowercase()),
                    None => {
                        env::storage_remove(KEY_BOX);
                    }
                }
            }
            RuleChange::AddSealedBankBeneficiary {
                label,
                commitment,
                sealed_for_signer,
                sealed_for_members,
            } => {
                erase_cleartext();
                let mut entries = beneficiaries();
                require!(
                    entries.len() < MAX_BENEFICIARIES,
                    "ERR_BANK_BENEFICIARIES_FULL"
                );
                let commitment = commitment.to_ascii_lowercase();
                require!(
                    !entries.iter().any(|entry| entry.commitment == commitment),
                    "ERR_BANK_BENEFICIARY_EXISTS"
                );
                let id = read::<u32>(KEY_SEALED_SEQUENCE)
                    .unwrap_or(0)
                    .saturating_add(1);
                write(KEY_SEALED_SEQUENCE, &id);
                entries.push(SealedBeneficiary {
                    id,
                    label: label.clone(),
                    commitment,
                    sealed_for_signer: sealed_for_signer.clone(),
                    sealed_for_members: sealed_for_members.clone(),
                });
                set_beneficiaries(&entries);
                env::log_str(&format!("OMNIROLES_BANK_BENEFICIARY_ADDED:{id}"));
            }
            RuleChange::RemoveSealedBankBeneficiary { id } => {
                let entries: Vec<SealedBeneficiary> = beneficiaries()
                    .into_iter()
                    .filter(|entry| entry.id != *id)
                    .collect();
                set_beneficiaries(&entries);
                // Its standing orders go with it.
                let orders: Vec<StandingOrder> = standing_orders()
                    .into_iter()
                    .filter(|order| order.beneficiary_id != *id)
                    .collect();
                set_standing_orders(&orders);
            }
            RuleChange::AddStandingOrder {
                beneficiary_id,
                amount,
                first_at_ns,
                period_ns,
                count,
                label,
            } => {
                require!(
                    beneficiary(*beneficiary_id).is_some(),
                    "BeneficiaryNotAllowed"
                );
                let mut orders = standing_orders();
                require!(
                    orders.len() < MAX_STANDING_ORDERS,
                    "ERR_STANDING_ORDERS_FULL"
                );
                let id = read::<u32>(KEY_ORDER_SEQUENCE)
                    .unwrap_or(0)
                    .saturating_add(1);
                write(KEY_ORDER_SEQUENCE, &id);
                orders.push(StandingOrder {
                    id,
                    beneficiary_id: *beneficiary_id,
                    amount: *amount,
                    next_at_ns: *first_at_ns,
                    period_ns: *period_ns,
                    remaining: *count,
                    runs: 0,
                    label: label.clone(),
                });
                set_standing_orders(&orders);
                env::log_str(&format!("OMNIROLES_STANDING_ORDER_ADDED:{id}"));
            }
            RuleChange::RemoveStandingOrder { id } => {
                let orders: Vec<StandingOrder> = standing_orders()
                    .into_iter()
                    .filter(|order| order.id != *id)
                    .collect();
                set_standing_orders(&orders);
            }
            RuleChange::SetBankPermission { role, permission } => {
                set_permission(role, permission.clone())
            }
            _ => return false,
        }
        true
    }

    pub(crate) fn validate_bank_rule(change: &RuleChange) -> bool {
        match change {
            RuleChange::SetBankConfig { config } => {
                if let Some(config) = config {
                    validate_config(config);
                }
            }
            RuleChange::AddBankBeneficiary { .. } => env::panic_str("ERR_BANK_CLEARTEXT_IBAN"),
            RuleChange::SetBankBoxKey { key } => {
                if let Some(key) = key {
                    require!(hex64(key), "ERR_BANK_BOX_KEY");
                }
            }
            RuleChange::AddSealedBankBeneficiary {
                label,
                commitment,
                sealed_for_signer,
                sealed_for_members,
            } => validate_sealed(label, commitment, sealed_for_signer, sealed_for_members),
            RuleChange::RemoveSealedBankBeneficiary { .. }
            | RuleChange::RemoveStandingOrder { .. } => {}
            RuleChange::AddStandingOrder {
                amount,
                period_ns,
                count,
                label,
                ..
            } => {
                require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
                require!(
                    period_ns.0 >= MIN_ORDER_PERIOD_NS,
                    "ERR_STANDING_ORDER_PERIOD"
                );
                require!(
                    count.is_none_or(|count| count > 0),
                    "ERR_STANDING_ORDER_COUNT"
                );
                require!(
                    label.chars().count() <= MAX_LABEL_CHARS
                        && label.chars().all(|c| (' '..='~').contains(&c)),
                    "ERR_BANK_LABEL"
                );
            }
            RuleChange::RemoveBankBeneficiary { iban } => {
                require!(!iban.is_empty(), "ERR_BANK_IBAN")
            }
            RuleChange::SetBankPermission { role, permission } => {
                require!(role != DAO_ROLE && !role.is_empty(), "ERR_RESERVED_ROLE");
                if let Some(permission) = permission {
                    require!(permission.max_per_payout.0 > 0, "ERR_MAX_PER_PAYOUT");
                }
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_and_dates_as_the_partner_reads_them() {
        assert_eq!(decimal_string(5_000_000, 6), "5");
        assert_eq!(decimal_string(5_123_400, 6), "5.1234");
        assert_eq!(decimal_string(7, 6), "0.000007");
        assert_eq!(decimal_string(42, 0), "42");
        assert_eq!(rfc3339(1_794_074_419_551_900_647), "2026-11-07T18:00:19Z");
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400_000_000_000), "2000-02-29T00:00:00Z");
    }
}
