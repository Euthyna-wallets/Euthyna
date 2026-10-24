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
    /// Zodiac Roles v3 condition tree, flattened (`{parent, paramType,
    /// operator, compValue}`), evaluated by `omniroles-conditions` on the exact
    /// calldata and value. Empty means unconditional. Allowances are charged
    /// by `WithinAllowance` / `CallWithinAllowance` nodes, so the amount always
    /// comes from the transaction itself, never from the caller.
    pub conditions: Vec<ConditionFlat>,
    /// Native value (ETH) may be sent with the call. Default: no.
    #[serde(default)]
    pub allow_value: bool,
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

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct ChainWallet {
    pub chain_id: u64,
    pub mpc_path: String,
    pub derived_public_key: Option<String>,
    pub address: Option<EvmAddress>,
    pub next_nonce: u64,
    pub active_operation: Option<OperationId>,
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
        signature: String,
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
