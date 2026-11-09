use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, near};
use omniroles_conditions::ConditionFlat;
use serde::{Deserialize, Serialize};

pub type OperationId = [u8; 32];
pub type QueueId = [u8; 32];
pub type EvmAddress = [u8; 20];
pub type Digest = [u8; 32];
pub type AllowanceKey = [u8; 32];

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Permission {
    pub chain_id: u64,
    pub target: EvmAddress,
    /// `None` allows any function on the target. A selector requires at least
    /// four calldata bytes and an exact match.
    pub selector: Option<[u8; 4]>,
    /// OmniRoles condition tree, flattened (`{parent, paramType,
    /// operator, compValue}`), evaluated by `omniroles-conditions` on the exact
    /// calldata and value. Empty means unconditional. Allowances are charged
    /// by `WithinAllowance` / `CallWithinAllowance` nodes, so the amount always
    /// comes from the transaction itself, never from the caller.
    pub conditions: Vec<ConditionFlat>,
    /// Native value (ETH) may be sent with the call. Default: no.
    #[serde(default)]
    pub allow_value: bool,
}

/// Result of `check_operation` (dry run of `prepare`).
#[derive(Clone, Debug)]
#[near(serializers = [json])]
pub struct OperationCheck {
    pub allowed: bool,
    /// Refusal code, e.g. `ERR_PERMISSION_DENIED:{"status":"parameterNotAllowed","node":1}`.
    pub reason: Option<String>,
    pub permission_index: Option<u32>,
    pub consumptions: Vec<AllowanceConsumption>,
    pub measured_value: Option<U128>,
    pub requires_delay: bool,
    pub requires_cosign: bool,
    /// Another operation is in flight on this wallet: `prepare` would wait.
    pub wallet_busy: bool,
}

impl OperationCheck {
    pub(crate) fn refused(reason: &str) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.to_owned()),
            permission_index: None,
            consumptions: Vec::new(),
            measured_value: None,
            requires_delay: false,
            requires_cosign: false,
            wallet_busy: false,
        }
    }
}

/// Amount charged to one allowance by an operation.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct AllowanceConsumption {
    pub key: AllowanceKey,
    pub amount: U128,
    /// `true` when the allowance counts calls (`CallWithinAllowance`).
    pub calls_only: bool,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct VelocityConfig {
    pub limit: U128,
    pub window_ns: u64,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct RoleConfig {
    #[serde(default)]
    pub guard_required: bool,
    pub enabled: bool,
    pub permissions: Vec<Permission>,
    pub operation_delay_threshold: Option<U128>,
    pub operation_delay_ns: u64,
    pub co_sign_threshold: Option<U128>,
    pub co_signer_role: Option<String>,
    pub velocity: Option<VelocityConfig>,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub max_total_fee: U128,
}

#[derive(Clone)]
#[near(serializers = [borsh])]
pub(crate) struct RoleState {
    pub config: RoleConfig,
}

#[derive(Clone, Debug)]
#[near(serializers = [json])]
pub struct RoleView {
    pub config: RoleConfig,
}

impl From<&RoleState> for RoleView {
    fn from(state: &RoleState) -> Self {
        Self {
            config: state.config.clone(),
        }
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
#[near(serializers = [borsh])]
pub(crate) struct MembershipKey {
    pub role: String,
    pub member: AccountId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum MembershipKind {
    Human,
    Agent,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Membership {
    pub role: String,
    pub member: AccountId,
    pub kind: MembershipKind,
    pub starts_at_ns: U64,
    pub ends_at_ns: Option<U64>,
    pub max_uses: Option<u64>,
    pub used_uses: u64,
    pub reserved_uses: u64,
    pub active: bool,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Allowance {
    pub balance: U128,
    pub refill: U128,
    pub max_refill: U128,
    pub period_ns: u64,
    pub timestamp_ns: U64,
    pub reserved: U128,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
#[near(serializers = [borsh])]
pub(crate) struct VelocityKey {
    pub role: String,
    pub chain_id: u64,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct VelocityState {
    pub window_started_at_ns: U64,
    pub spent: U128,
    pub reserved: U128,
}

/// Signed but unsettled operations a wallet may carry. Bounds how many
/// transactions can wait behind a nonce that never lands.
pub const MAX_IN_FLIGHT: usize = 8;

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct ChainWallet {
    pub chain_id: u64,
    pub mpc_path: String,
    pub derived_public_key: Option<String>,
    pub address: Option<EvmAddress>,
    pub next_nonce: u64,
    /// The operation holding `next_nonce` before it is signed. One at a time,
    /// so nonces are handed out in order and an unsigned one is never skipped.
    pub active_operation: Option<OperationId>,
    /// Signed operations not settled yet, in nonce order. The budget is already
    /// spent when an operation is prepared, so settlement only finishes the
    /// accounting and does not block the next operation.
    pub in_flight: Vec<OperationId>,
}

impl ChainWallet {
    /// A new operation may take the next nonce: none is waiting to be signed
    /// and the in-flight queue has room.
    pub fn accepts_operation(&self) -> bool {
        self.active_operation.is_none() && self.in_flight.len() < MAX_IN_FLIGHT
    }

    pub(crate) fn release(&mut self, op_id: OperationId) {
        if self.active_operation == Some(op_id) {
            self.active_operation = None;
        }
        self.in_flight.retain(|id| *id != op_id);
    }
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct OperationRequest {
    pub chain_id: u64,
    pub target: EvmAddress,
    pub value: U128,
    pub calldata: Vec<u8>,
    pub allowance_amount: U128,
    pub reference: String,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Eip1559Transaction {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: EvmAddress,
    pub value: U128,
    pub input: Vec<u8>,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum OperationState {
    Prepared,
    Queued,
    PossiblySigned,
    Confirmed,
    Failed,
    Cancelled,
    Vetoed,
    Expired,
    /// A transaction the DAO voted: waiting for its veto window, then for the
    /// wallet to be free (it has no nonce yet).
    Scheduled,
    Unconfirmed,
}

/// One EVM transaction the DAO approved, outside any role (a multisig
/// transaction). The vault signs it after the veto window, in submission order.
#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct DaoTransaction {
    pub chain_id: u64,
    pub target: EvmAddress,
    pub value: U128,
    pub calldata: Vec<u8>,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct MpcSignature {
    pub big_r: Vec<u8>,
    pub s: [u8; 32],
    pub recovery_id: u8,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct CancellationAttempt {
    pub transaction: Eip1559Transaction,
    pub tx_digest: Digest,
    pub signature: Option<MpcSignature>,
    pub signed_transaction: Option<Vec<u8>>,
    pub requested_at_ns: u64,
    pub request_count: u32,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Operation {
    pub op_id: OperationId,
    pub client_id: String,
    pub member: AccountId,
    pub role: String,
    pub request: OperationRequest,
    pub permission_index: u32,
    /// Allowances charged by the matched permission's conditions.
    pub consumptions: Vec<AllowanceConsumption>,
    /// Largest value the operation moves, as measured by the vault: native
    /// value or an amount charged to an allowance. `None` when nothing in the
    /// permission measures it; delay and co-signature thresholds then apply.
    pub measured_value: Option<U128>,
    pub policy_version: u64,
    pub registry_version: u64,
    pub evm_nonce: u64,
    pub transaction: Eip1559Transaction,
    pub tx_digest: Digest,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub execute_after_ns: Option<U64>,
    pub visa_authorized: bool,
    pub cosigned_by: Option<AccountId>,
    pub possibly_signed_at_ns: Option<U64>,
    pub state: OperationState,
    pub signature: Option<MpcSignature>,
    pub signed_transaction: Option<Vec<u8>>,
    pub cancellation: Option<CancellationAttempt>,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub enum RuleChange {
    SetRole {
        role: String,
        config: RoleConfig,
    },
    RemoveRole {
        role: String,
    },
    GrantMembership {
        role: String,
        member: AccountId,
        kind: MembershipKind,
        starts_at_ns: U64,
        ends_at_ns: Option<U64>,
        max_uses: Option<u64>,
    },
    RevokeMembership {
        role: String,
        member: AccountId,
    },
    SetAllowance {
        key: AllowanceKey,
        balance: U128,
        refill: U128,
        max_refill: U128,
        period_ns: u64,
    },
    SetCouncil {
        members: Vec<AccountId>,
    },
    SetVisaPublicKey {
        visa_public_key: Vec<u8>,
    },
    SetStatusPublicKey {
        status_public_key: Vec<u8>,
    },
    SetVersions {
        policy_version: u64,
        registry_version: u64,
    },
    AddListAddress {
        list: String,
        address: EvmAddress,
        label: String,
    },
    RemoveListAddress {
        list: String,
        address: EvmAddress,
    },
    SetSettlementConfig {
        config: SettlementConfig,
    },
    AddListAddresses {
        list: String,
        entries: Vec<ListAddress>,
    },
    /// Move the vault to another version published by the account that
    /// created it. The vault checks the code against this hash itself.
    Upgrade {
        code_hash: near_sdk::json_types::Base58CryptoHash,
    },
    /// What the role may send on Solana (replaces the role's Solana list).
    SetSolanaPermissions {
        role: String,
        permissions: Vec<crate::solana::SolanaPermission>,
    },
    /// What the role may send in NEAR tokens (replaces the role's NEAR list).
    SetNearPermissions {
        role: String,
        permissions: Vec<crate::near_tokens::NearPermission>,
    },
    /// Register the vault on a NEP-141 token so it can receive it.
    NearStorageDeposit {
        token: AccountId,
    },
    /// Fetch future versions from another account. Safe to move: an upgrade
    /// still deploys only code with the hash the DAO voted for.
    SetCodeSource {
        account_id: AccountId,
    },
    /// Bank payouts (euros to voted IBANs through the bank signer): where they run and settle.
    SetBankConfig {
        config: Option<crate::bank::BankConfig>,
    },
    /// Refused since sealed beneficiaries: an IBAN in clear would stay public on chain. Kept so
    /// that rules queued before still decode.
    AddBankBeneficiary {
        beneficiary: crate::bank::BankBeneficiary,
    },
    RemoveBankBeneficiary {
        iban: String,
    },
    /// What the role may pay to the voted IBANs (replaces the role's bank permission).
    SetBankPermission {
        role: String,
        permission: Option<crate::bank::BankPermission>,
    },
    /// The bank signer enclave's X25519 key, which beneficiaries are sealed to (hex, 32 bytes).
    /// Voted with the signer's code hash: read from the enclave's own output.
    SetBankBoxKey {
        key: Option<String>,
    },
    /// An IBAN the company may pay, without the IBAN: a salted commitment, an envelope only the
    /// enclave opens (it checks the commitment before paying) and one for the members' reading
    /// keys. `label` is public: never a name.
    AddSealedBankBeneficiary {
        label: String,
        commitment: String,
        sealed_for_signer: String,
        sealed_for_members: String,
    },
    RemoveSealedBankBeneficiary {
        id: u32,
    },
    /// Pay a voted beneficiary this amount every period, from `first_at_ns` (payroll, rent). Run by
    /// anyone once due; the vote is the authorisation. `count`: how many times, or until removed.
    AddStandingOrder {
        beneficiary_id: u32,
        amount: U128,
        first_at_ns: U64,
        period_ns: U64,
        count: Option<u32>,
        label: String,
    },
    RemoveStandingOrder {
        id: u32,
    },
    /// Where the enclave's code comes from: an OutLayer project ("owner/name") whose secrets
    /// follow its versions, the vault running exactly its voted `signer_hash` of it. `follow`:
    /// the project's active version is queued as a `SetBankConfig` rule by anyone
    /// (`follow_bank_signer`), so it applies after the vault's rule delay unless the council
    /// vetoes it. `project: None` returns to the code URL of `SetBankConfig`.
    SetBankSignerSource {
        project: Option<String>,
        follow: bool,
    },
    /// Sponsored execution on an EVM chain (EIP-7702): the wallet delegates to this executor and
    /// the vault signs `Execute` of each call instead of a transaction, so a relayer pays the gas.
    /// `None` returns to plain transactions. Same role checks either way.
    SetEvmExecutor {
        chain_id: u64,
        executor: Option<EvmAddress>,
    },
    /// The veto window of later rule changes and voted transactions: at least 1 minute on testnet,
    /// 1 day on mainnet, and shorter than a queued change's expiration. Applies after the current window.
    SetRuleDelay {
        seconds: U64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum RuleChangeState {
    Queued,
    Executed,
    Vetoed,
    Expired,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct QueuedRuleChange {
    pub queue_id: QueueId,
    pub change: RuleChange,
    pub proposed_by: AccountId,
    pub queued_at_ns: U64,
    pub execute_after_ns: U64,
    pub expires_at_ns: U64,
    pub state: RuleChangeState,
    pub vetoed_by: Option<AccountId>,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct GuardVisa {
    pub client_id: String,
    pub op_id: OperationId,
    pub tx_digest: Digest,
    pub agent: String,
    pub role: String,
    pub reference: String,
    pub policy_version: u64,
    pub registry_version: u64,
    pub visa_nonce: u64,
    pub expires_at_ns: U64,
}

#[derive(Clone, Debug)]
#[near(serializers = [json])]
pub struct GuardApproval {
    pub visa: GuardVisa,
    pub signature: Base64VecU8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum StatusKind {
    Confirmed,
    Failed,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct StatusReport {
    pub client_id: String,
    pub op_id: OperationId,
    pub kind: StatusKind,
    pub tx_hash: Digest,
    pub report_nonce: u64,
    pub block_number: u64,
}

#[derive(Clone, Debug)]
#[near(serializers = [json])]
pub struct SignedStatusReport {
    pub report: StatusReport,
    pub signature: Base64VecU8,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
#[near(serializers = [borsh])]
pub(crate) struct ReferenceKey {
    pub role: String,
    pub reference: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct MpcSignRequest {
    pub path: String,
    pub payload_v2: MpcPayload,
    pub domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) enum MpcPayload {
    Ecdsa(String),
    Eddsa(String),
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum MpcSignatureResponse {
    Secp256k1 {
        big_r: MpcBigR,
        s: MpcScalar,
        recovery_id: u8,
    },
    Ed25519 {
        signature: Vec<u8>,
    },
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct MpcBigR {
    pub affine_point: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct MpcScalar {
    pub scalar: String,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct ListAddress {
    pub address: EvmAddress,
    pub label: String,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SettlementConfig {
    pub cancel_after_ns: U64,
    pub unconfirmed_after_ns: U64,
    pub foreign_tx_domain_id: u64,
    /// Explicit network mapping: false is testnet, true is mainnet.
    pub mainnet: bool,
}
impl Default for SettlementConfig {
    fn default() -> Self {
        Self {
            cancel_after_ns: U64(3_600_000_000_000),
            unconfirmed_after_ns: U64(21_600_000_000_000),
            foreign_tx_domain_id: 3,
            mainnet: false,
        }
    }
}
