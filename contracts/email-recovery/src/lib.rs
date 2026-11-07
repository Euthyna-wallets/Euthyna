//! Founder seat recovery with ZK Email, verified on chain.
//!
//! A founder enrolls their mailbox: they prove, with the zero-knowledge circuit in
//! `circuits/email-recovery`, that their mail provider signed an email whose subject is
//! `Euthyna enroll near:<their account>`. This contract verifies the proof, checks that the
//! DKIM key is one it knows for that domain, and keeps a salted hash of the address.
//!
//! If the founder loses their account, a new account brings a proof of an email from the same
//! mailbox, with the subject `Euthyna recovery near:<new account>` and the enrollment's salt.
//! The contract verifies it and opens a recovery. For the waiting period the lost account can
//! cancel it; after that the other founders vote, as for any member change. Nothing here
//! changes a seat: the DAO's vote does.
//!
//! The account is deployed without access keys. The keeper (a DAO on mainnet) can only add and
//! remove DKIM keys; it cannot touch enrollments or recoveries.

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, env, near, require,
};
use num_bigint::BigUint;
use ultrahonk_no_std::{ProofType, verify};

mod hooks;

/// The verification key of `circuits/email-recovery` (zero-knowledge, Keccak transcript).
/// Written by `circuits/email-recovery/build.mjs`; a new circuit means a new contract.
const VK: &[u8] = include_bytes!("vk.bin");

const KEY_LIMBS: usize = 18;
const MAX_DOMAIN: usize = 64;
const MAX_SUBJECT: usize = 96;
/// modulus (18) + redc (18) + salt + address hash + domain (64 + len) + subject (96 + len).
const PUBLIC_INPUTS: usize = KEY_LIMBS * 2 + 1 + 1 + MAX_DOMAIN + 1 + MAX_SUBJECT + 1;
const MAX_PROOF_BYTES: usize = 16_384;
/// How many recoveries a DAO keeps in its history.
const MAX_HISTORY: usize = 20;
/// A recovery nobody cancelled nor voted on stays open this long after its waiting period.
const STALE_AFTER_NS: u64 = 30 * 24 * 3600 * 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Dkim,
    Enrollments,
    Recoveries,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Enrollment {
    pub account_id: AccountId,
    /// The salt in the address hash, public: the recovery proof must use the same one.
    pub salt: String,
    /// The circuit's salted hash of the sender address (hex).
    pub identity: String,
    pub domain: String,
    pub enrolled_at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
pub enum RecoveryState {
    Waiting,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Recovery {
    pub lost_account_id: AccountId,
    pub new_account_id: AccountId,
    pub domain: String,
    pub requested_at_ns: U64,
    /// The lost account can cancel until then; after it, the members can vote.
    pub not_before_ns: U64,
    pub state: RecoveryState,
    /// When the lost account cancelled it. No new request for that seat until a full waiting
    /// period has passed since.
    pub cancelled_at_ns: Option<U64>,
}

#[near(serializers = [json])]
pub struct RecoveryView {
    #[serde(flatten)]
    pub recovery: Recovery,
    /// Waiting and past its waiting period: the members can vote.
    pub ready: bool,
}

/// What a proof states, from its public inputs.
struct Stated {
    key_hash: [u8; 32],
    salt: [u8; 32],
    identity: [u8; 32],
    domain: String,
    subject: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EmailRecovery {
    keeper_id: AccountId,
    delay_ns: u64,
    /// Domain → sha256 of the DKIM key as the circuit takes it (modulus and redc limbs).
    dkim: IterableMap<String, Vec<[u8; 32]>>,
    /// DAO → its enrolled founders.
    enrollments: IterableMap<AccountId, Vec<Enrollment>>,
    /// DAO → its recoveries, newest last.
    recoveries: IterableMap<AccountId, Vec<Recovery>>,
}

#[near]
impl EmailRecovery {
    #[init]
    pub fn new(keeper_id: AccountId, delay_seconds: U64) -> Self {
        require!(delay_seconds.0 >= 60, "ERR_DELAY_TOO_SHORT");
        Self {
            keeper_id,
            delay_ns: delay_seconds.0 * 1_000_000_000,
            dkim: IterableMap::new(Key::Dkim),
            enrollments: IterableMap::new(Key::Enrollments),
            recoveries: IterableMap::new(Key::Recoveries),
        }
    }

    // ---- DKIM keys (keeper) -------------------------------------------------------------

    /// Adds a 2048-bit RSA DKIM key (hex modulus) for a domain. Keeper only.
    pub fn add_dkim_key(&mut self, domain: String, modulus_hex: String) -> String {
        self.only_keeper();
        let domain = domain.to_ascii_lowercase();
        require!(
            !domain.is_empty() && domain.len() <= MAX_DOMAIN,
            "ERR_DOMAIN"
        );
        let hash = key_hash_of_modulus(&modulus_hex);
        let keys = self.dkim.entry(domain.clone()).or_default();
        if !keys.contains(&hash) {
            keys.push(hash);
        }
        let hash = hex::encode(hash);
        event(
            "dkim_key_added",
            &serde_json::json!({ "domain": domain, "key_hash": hash }),
        );
        hash
    }

    /// Removes a DKIM key (for instance one the provider revoked). Keeper only.
    pub fn remove_dkim_key(&mut self, domain: String, key_hash: String) {
        self.only_keeper();
        let domain = domain.to_ascii_lowercase();
        if let Some(keys) = self.dkim.get_mut(&domain) {
            keys.retain(|key| hex::encode(key) != key_hash);
        }
        event(
            "dkim_key_removed",
            &serde_json::json!({ "domain": domain, "key_hash": key_hash }),
        );
    }

    pub fn dkim_keys(&self, domain: String) -> Vec<String> {
        self.dkim
            .get(&domain.to_ascii_lowercase())
            .map(|keys| keys.iter().map(hex::encode).collect())
            .unwrap_or_default()
    }

    // ---- Enrollment --------------------------------------------------------------------

    /// The caller enrolls their mailbox for their seat in `dao_id` (again to change it).
    /// The email's subject must be `Euthyna enroll near:<caller>`. Attach about 0.01 NEAR for
    /// storage; the rest is refunded.
    #[payable]
    pub fn enroll(
        &mut self,
        dao_id: AccountId,
        proof: Base64VecU8,
        public_inputs: Base64VecU8,
    ) -> Enrollment {
        let before = env::storage_usage();
        let account = env::predecessor_account_id();
        let stated = self.check(
            &proof.0,
            &public_inputs.0,
            &format!("euthyna enroll near:{account}"),
        );
        let enrollment = Enrollment {
            account_id: account.clone(),
            salt: hex::encode(stated.salt),
            identity: hex::encode(stated.identity),
            domain: stated.domain,
            enrolled_at_ns: U64(env::block_timestamp()),
        };
        let list = self.enrollments.entry(dao_id.clone()).or_default();
        list.retain(|item| item.account_id != account);
        list.push(enrollment.clone());
        event(
            "enrolled",
            &serde_json::json!({ "dao_id": dao_id, "account_id": account, "domain": enrollment.domain }),
        );
        charge_storage(before);
        enrollment
    }

    pub fn enrollment(&self, dao_id: AccountId, account_id: AccountId) -> Option<Enrollment> {
        self.enrollments.get(&dao_id).and_then(|list| {
            list.iter()
                .find(|item| item.account_id == account_id)
                .cloned()
        })
    }

    pub fn enrollments_of(&self, dao_id: AccountId) -> Vec<Enrollment> {
        self.enrollments.get(&dao_id).cloned().unwrap_or_default()
    }

    // ---- Recovery ----------------------------------------------------------------------

    /// The caller, a new account, asks for `lost_account_id`'s seat in `dao_id` with a proof
    /// from the enrolled mailbox, salted with the enrollment's salt. The email's subject must be
    /// `Euthyna recovery near:<caller>`.
    #[payable]
    pub fn request(
        &mut self,
        dao_id: AccountId,
        lost_account_id: AccountId,
        proof: Base64VecU8,
        public_inputs: Base64VecU8,
    ) -> RecoveryView {
        let before = env::storage_usage();
        let account = env::predecessor_account_id();
        require!(account != lost_account_id, "ERR_SAME_ACCOUNT");
        let enrollment = self
            .enrollment(dao_id.clone(), lost_account_id.clone())
            .unwrap_or_else(|| env::panic_str("ERR_NOT_ENROLLED"));
        let stated = self.check(
            &proof.0,
            &public_inputs.0,
            &format!("euthyna recovery near:{account}"),
        );
        require!(
            hex::encode(stated.salt) == enrollment.salt,
            "ERR_WRONG_SALT"
        );
        require!(
            hex::encode(stated.identity) == enrollment.identity,
            "ERR_DIFFERENT_MAILBOX"
        );
        let now = env::block_timestamp();
        let list = self.recoveries.entry(dao_id.clone()).or_default();
        let open = list.iter().any(|item| {
            item.lost_account_id == lost_account_id
                && item.state == RecoveryState::Waiting
                && now < item.not_before_ns.0 + STALE_AFTER_NS
        });
        require!(!open, "ERR_RECOVERY_OPEN");
        // Someone who holds the mailbox could otherwise ask again as soon as the founder
        // cancels, and again, until one request goes unnoticed: after a cancel, the seat
        // rests for a waiting period (time to enroll another mailbox).
        let resting = list.iter().any(|item| {
            item.lost_account_id == lost_account_id
                && item
                    .cancelled_at_ns
                    .is_some_and(|at| now < at.0.saturating_add(self.delay_ns))
        });
        require!(!resting, "ERR_RECOVERY_COOLDOWN");
        let recovery = Recovery {
            lost_account_id: lost_account_id.clone(),
            new_account_id: account.clone(),
            domain: stated.domain,
            requested_at_ns: U64(now),
            not_before_ns: U64(now + self.delay_ns),
            state: RecoveryState::Waiting,
            cancelled_at_ns: None,
        };
        list.push(recovery.clone());
        if list.len() > MAX_HISTORY {
            // Drop the oldest entry that neither waits nor rests a seat, so a full history
            // cannot erase a cooldown.
            let delay_ns = self.delay_ns;
            let old = list.iter().position(|item| {
                item.state != RecoveryState::Waiting
                    && item
                        .cancelled_at_ns
                        .is_none_or(|at| now >= at.0.saturating_add(delay_ns))
            });
            list.remove(old.unwrap_or(0));
        }
        event(
            "recovery_requested",
            &serde_json::json!({ "dao_id": dao_id, "lost_account_id": lost_account_id, "new_account_id": account, "not_before_ns": recovery.not_before_ns }),
        );
        charge_storage(before);
        RecoveryView {
            recovery,
            ready: false,
        }
    }

    /// The lost account still works: its holder stops a recovery of their seat.
    pub fn cancel(&mut self, dao_id: AccountId) {
        let account = env::predecessor_account_id();
        let now = env::block_timestamp();
        let list = self
            .recoveries
            .get_mut(&dao_id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_RECOVERY"));
        let mut cancelled = false;
        for item in list.iter_mut() {
            if item.lost_account_id == account && item.state == RecoveryState::Waiting {
                item.state = RecoveryState::Cancelled;
                item.cancelled_at_ns = Some(U64(now));
                cancelled = true;
            }
        }
        require!(cancelled, "ERR_NO_RECOVERY");
        event(
            "recovery_cancelled",
            &serde_json::json!({ "dao_id": dao_id, "lost_account_id": account }),
        );
    }

    /// The open recovery of a seat, if any.
    pub fn recovery(&self, dao_id: AccountId, lost_account_id: AccountId) -> Option<RecoveryView> {
        self.recoveries_of(dao_id).into_iter().rev().find(|item| {
            item.recovery.lost_account_id == lost_account_id
                && item.recovery.state == RecoveryState::Waiting
        })
    }

    pub fn recoveries_of(&self, dao_id: AccountId) -> Vec<RecoveryView> {
        let now = env::block_timestamp();
        self.recoveries
            .get(&dao_id)
            .map(|list| {
                list.iter()
                    .map(|item| RecoveryView {
                        ready: item.state == RecoveryState::Waiting
                            && now >= item.not_before_ns.0
                            && now < item.not_before_ns.0 + STALE_AFTER_NS,
                        recovery: item.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn keeper_id(&self) -> AccountId {
        self.keeper_id.clone()
    }

    pub fn delay_seconds(&self) -> U64 {
        U64(self.delay_ns / 1_000_000_000)
    }

    /// The verification key built into this contract (hex), to compare with the circuit's.
    pub fn verification_key(&self) -> String {
        hex::encode(VK)
    }

    /// Verifies a proof without recording anything (for clients that check before signing).
    pub fn verify_proof(&self, proof: Base64VecU8, public_inputs: Base64VecU8) -> bool {
        let pubs = split_inputs(&public_inputs.0);
        verify::<hooks::NearHooks>(VK, &ProofType::ZK(proof.0.into_boxed_slice()), &pubs).is_ok()
    }
}

impl EmailRecovery {
    fn only_keeper(&self) {
        require!(
            env::predecessor_account_id() == self.keeper_id,
            "ERR_KEEPER_ONLY"
        );
    }

    /// Cheap checks first (subject, key), then the proof.
    fn check(&self, proof: &[u8], public_inputs: &[u8], expected_subject: &str) -> Stated {
        require!(proof.len() <= MAX_PROOF_BYTES, "ERR_PROOF_SIZE");
        let pubs = split_inputs(public_inputs);
        let stated = read_inputs(&pubs);
        require!(
            stated.subject.trim().to_ascii_lowercase() == expected_subject,
            "ERR_WRONG_SUBJECT"
        );
        let known = self
            .dkim
            .get(&stated.domain)
            .is_some_and(|keys| keys.contains(&stated.key_hash));
        require!(known, "ERR_DKIM_KEY_UNKNOWN");
        if verify::<hooks::NearHooks>(VK, &ProofType::ZK(proof.to_vec().into_boxed_slice()), &pubs)
            .is_err()
        {
            env::panic_str("ERR_PROOF_INVALID");
        }
        stated
    }
}

fn split_inputs(bytes: &[u8]) -> Vec<[u8; 32]> {
    require!(bytes.len() == PUBLIC_INPUTS * 32, "ERR_PUBLIC_INPUTS");
    bytes.as_chunks::<32>().0.to_vec()
}

/// A field that holds one byte (domain and subject characters, lengths).
fn small(field: &[u8; 32], max: u64) -> u64 {
    require!(
        field[..24].iter().all(|byte| *byte == 0),
        "ERR_PUBLIC_INPUTS"
    );
    let value = u64::from_be_bytes(field[24..].try_into().unwrap());
    require!(value <= max, "ERR_PUBLIC_INPUTS");
    value
}

fn text(fields: &[[u8; 32]], length: &[u8; 32], max: usize) -> String {
    let length = small(length, max as u64) as usize;
    let bytes: Vec<u8> = fields[..length]
        .iter()
        .map(|field| small(field, 255) as u8)
        .collect();
    String::from_utf8(bytes).unwrap_or_else(|_| env::panic_str("ERR_PUBLIC_INPUTS"))
}

fn read_inputs(pubs: &[[u8; 32]]) -> Stated {
    let key: Vec<u8> = pubs[..KEY_LIMBS * 2].concat();
    let mut at = KEY_LIMBS * 2;
    let salt = pubs[at];
    at += 1;
    let identity = pubs[at];
    at += 1;
    let domain = text(
        &pubs[at..at + MAX_DOMAIN],
        &pubs[at + MAX_DOMAIN],
        MAX_DOMAIN,
    );
    at += MAX_DOMAIN + 1;
    let subject = text(
        &pubs[at..at + MAX_SUBJECT],
        &pubs[at + MAX_SUBJECT],
        MAX_SUBJECT,
    );
    Stated {
        key_hash: env::sha256_array(&key),
        salt,
        identity,
        domain,
        subject,
    }
}

/// The DKIM key as the circuit takes it: 18 limbs of 120 bits of the modulus, then of
/// redc = 2^(2·2048 + 6) / modulus, each as a 32-byte big-endian field; its sha256.
pub fn key_hash_of_modulus(modulus_hex: &str) -> [u8; 32] {
    let modulus = BigUint::parse_bytes(modulus_hex.trim_start_matches("0x").as_bytes(), 16)
        .unwrap_or_else(|| env::panic_str("ERR_DKIM_KEY"));
    require!(modulus.bits() == 2048, "ERR_DKIM_KEY_SIZE");
    let redc = (BigUint::from(1u8) << (2 * 2048 + 6)) / &modulus;
    let mut bytes = Vec::with_capacity(KEY_LIMBS * 2 * 32);
    for value in [&modulus, &redc] {
        let mask = (BigUint::from(1u8) << 120) - 1u8;
        for i in 0..KEY_LIMBS {
            let limb = (value >> (120 * i)) & &mask;
            let limb = limb.to_bytes_be();
            bytes.extend(core::iter::repeat_n(0u8, 32 - limb.len()));
            bytes.extend_from_slice(&limb);
        }
    }
    env::sha256_array(&bytes)
}

fn event(name: &str, data: &serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({ "standard": "euthyna-recovery", "version": "1.0.0", "event": name, "data": [data] })
    ));
}

/// The caller pays for the storage this call added and gets the rest of the deposit back.
fn charge_storage(before: u64) {
    let used = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    let deposit = env::attached_deposit();
    require!(
        deposit >= cost,
        format!(
            "ERR_STORAGE_DEPOSIT: attach at least {} yoctoNEAR",
            cost.as_yoctonear()
        )
    );
    let refund = deposit.saturating_sub(cost);
    if refund > NearToken::from_yoctonear(0) {
        Promise::new(env::predecessor_account_id())
            .transfer(refund)
            .detach();
    }
}
