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
//! Stored under raw keys (not new struct fields), so the vault's state layout is unchanged and
//! existing vaults move to this version by a DAO upgrade.
use crate::types::EvmAddress;
use crate::*;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

const KEY_CONFIG: &[u8] = b"bank:c";
const KEY_BENEFICIARIES: &[u8] = b"bank:b";
const KEY_PERMISSION: &[u8] = b"bank:p:";
const KEY_PAYOUT: &[u8] = b"bank:o:";
const KEY_PENDING: &[u8] = b"bank:pending";
const KEY_INDEX: &[u8] = b"bank:i";
const KEY_TRANSFER: &[u8] = b"bank:t:";
const MAX_BENEFICIARIES: usize = 64;
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

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct BankBeneficiary {
    pub iban: String,
    pub name: String,
    /// "Business" or "Individual".
    pub holder_type: String,
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
    pub beneficiary: BankBeneficiary,
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
pub(crate) fn beneficiaries() -> Vec<BankBeneficiary> {
    read(KEY_BENEFICIARIES).unwrap_or_default()
}
fn set_beneficiaries(entries: &[BankBeneficiary]) {
    if entries.is_empty() {
        env::storage_remove(KEY_BENEFICIARIES);
    } else {
        write(KEY_BENEFICIARIES, &entries.to_vec());
    }
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
    read(&key(KEY_TRANSFER, transfer_id)).or_else(|| {
        // Payouts queued by the first version, before the link was stored.
        index()
            .iter()
            .rev()
            .map(payout)
            .find(|payout| payout.transfer_op_id.as_ref() == Some(transfer_id))
            .map(|payout| payout.op_id)
    })
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

/// ISO 7064 mod 97-10, as banks check it.
pub(crate) fn valid_iban(iban: &str) -> bool {
    let compact = canonical_iban(iban);
    if compact.len() < 15
        || compact.len() > 34
        || !compact.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return false;
    }
    let rotated = format!("{}{}", &compact[4..], &compact[..4]);
    let mut remainder: u32 = 0;
    for c in rotated.chars() {
        let value = if c.is_ascii_digit() {
            c as u32 - '0' as u32
        } else {
            c as u32 - 'A' as u32 + 10
        };
        let digits = if value >= 10 { 2 } else { 1 };
        for position in (0..digits).rev() {
            let digit = (value / 10u32.pow(position)) % 10;
            remainder = (remainder * 10 + digit) % 97;
        }
    }
    remainder == 1
}

pub(crate) fn validate_beneficiary(entry: &BankBeneficiary) {
    require!(valid_iban(&entry.iban), "ERR_BANK_IBAN");
    let name_chars = entry.name.chars().count();
    require!(
        name_chars > 0 && name_chars <= 255 && entry.name.chars().all(|c| (' '..='~').contains(&c)),
        "ERR_BANK_HOLDER_NAME"
    );
    require!(
        entry.holder_type == "Business" || entry.holder_type == "Individual",
        "ERR_BANK_HOLDER_TYPE"
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

    pub fn list_bank_beneficiaries(&self) -> Vec<BankBeneficiary> {
        beneficiaries()
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
        iban: String,
        amount: U128,
        reference: String,
    ) -> BankCheck {
        match self.bank_permission(
            &role,
            &member,
            &iban,
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
        iban: String,
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
        let (config, beneficiary, allowance) = self
            .bank_permission(&role, &member, &iban, amount.0, &reference, now)
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
            beneficiary: beneficiary.clone(),
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

        // What the signer gets: the payout the vault just authorised, nothing it could widen.
        // The partner's nonce is at most 36 characters: the first 128 bits of the payout id.
        let input = format!(
            "{{\"op\":\"payout\",\"vault\":{},\"customer_id\":{},\"iban\":{},\"holder_name\":{},\"holder_type\":{},\"reference\":{},\"crypto_amount\":{},\"source_address\":{},\"network\":{},\"crypto\":{},\"nonce\":{},\"expiry\":{}}}",
            json_string(env::current_account_id().as_str()),
            json_string(&config.customer_id),
            json_string(&canonical_iban(&beneficiary.iban)),
            json_string(&beneficiary.name),
            json_string(&beneficiary.holder_type),
            json_string(&reference),
            json_string(&decimal_string(amount.0, config.decimals)),
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
        Promise::new(config.outlayer_id)
            .function_call(
                "request_execution".to_owned(),
                args.into_bytes(),
                OUTLAYER_DEPOSIT,
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGNER_CALLBACK_GAS)
                    .on_bank_signer(op_id),
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
                consumptions: vec![payout.consumption.clone()],
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
        iban: &str,
        amount: u128,
        reference: &str,
        now: u64,
    ) -> Result<(BankConfig, BankBeneficiary, AllowanceKey), &'static str> {
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
        let wanted = canonical_iban(iban);
        let beneficiary = beneficiaries()
            .into_iter()
            .find(|entry| canonical_iban(&entry.iban) == wanted)
            .ok_or("BeneficiaryNotAllowed")?;
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
        let wanted = canonical_iban(&payout.beneficiary.iban);
        require!(
            beneficiaries()
                .iter()
                .any(|entry| canonical_iban(&entry.iban) == wanted),
            "ERR_CONDITIONS_CHANGED"
        );
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
            RuleChange::AddBankBeneficiary { beneficiary } => {
                let mut entries = beneficiaries();
                let wanted = canonical_iban(&beneficiary.iban);
                match entries
                    .iter_mut()
                    .find(|entry| canonical_iban(&entry.iban) == wanted)
                {
                    Some(entry) => *entry = beneficiary.clone(),
                    None => {
                        require!(
                            entries.len() < MAX_BENEFICIARIES,
                            "ERR_BANK_BENEFICIARIES_FULL"
                        );
                        entries.push(beneficiary.clone());
                    }
                }
                set_beneficiaries(&entries);
            }
            RuleChange::RemoveBankBeneficiary { iban } => {
                let wanted = canonical_iban(iban);
                let entries: Vec<BankBeneficiary> = beneficiaries()
                    .into_iter()
                    .filter(|entry| canonical_iban(&entry.iban) != wanted)
                    .collect();
                set_beneficiaries(&entries);
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
            RuleChange::AddBankBeneficiary { beneficiary } => validate_beneficiary(beneficiary),
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
    fn iban_checksum() {
        assert!(valid_iban("FR76 3000 6000 0112 3456 7890 189"));
        assert!(valid_iban("DE89370400440532013000"));
        assert!(valid_iban("MT22CFTE19870000000090010358449"));
        assert!(!valid_iban("FR7630006000011234567890180"));
        assert!(!valid_iban("nope"));
    }

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
