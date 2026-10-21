use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, near};
use serde::{Deserialize, Serialize};

pub type OperationId = [u8; 32];
pub type EvmAddress = [u8; 20];
pub type Digest = [u8; 32];

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct RoleConfig {
    pub enabled: bool,
    pub token: EvmAddress,
    pub roles_modifier: EvmAddress,
    pub role_key: [u8; 32],
    pub allowed_recipients: Vec<EvmAddress>,
    pub max_per_tx: U128,
    pub gas_limit: U128,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub max_total_fee: U128,
}

#[derive(Clone)]
#[near(serializers = [borsh])]
pub(crate) struct RoleState {
    pub config: RoleConfig,
    pub funded: u128,
    pub spent: u128,
    pub reserved: u128,
}

#[derive(Clone, Debug)]
#[near(serializers = [json])]
pub struct RoleView {
    pub config: RoleConfig,
    pub funded: U128,
    pub spent: U128,
    pub reserved: U128,
    pub available: U128,
}

impl From<&RoleState> for RoleView {
    fn from(state: &RoleState) -> Self {
        let available = state
            .funded
            .saturating_sub(state.spent)
            .saturating_sub(state.reserved);
        Self {
            config: state.config.clone(),
            funded: U128(state.funded),
            spent: U128(state.spent),
            reserved: U128(state.reserved),
            available: U128(available),
        }
    }
}

#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct AgentState {
    pub role: String,
    pub mpc_path: String,
    pub active: bool,
    pub derived_public_key: Option<String>,
    pub evm_address: Option<EvmAddress>,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct PaymentIntent {
    pub token: EvmAddress,
    pub recipient: EvmAddress,
    pub amount: U128,
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
    PossiblySigned,
    Confirmed,
    Cancelled,
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
    pub requested_at_block: u64,
    pub request_count: u32,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Operation {
    pub op_id: OperationId,
    pub client_id: String,
    pub agent: AccountId,
    pub role: String,
    pub intent: PaymentIntent,
    pub policy_version: u64,
    pub registry_version: u64,
    pub evm_nonce: u64,
    pub transaction: Eip1559Transaction,
    pub tx_digest: Digest,
    pub created_at_block: u64,
    pub expires_at_block: u64,
    pub possibly_signed_at_block: Option<u64>,
    pub state: OperationState,
    pub signature: Option<MpcSignature>,
    pub signed_transaction: Option<Vec<u8>>,
    pub cancellation: Option<CancellationAttempt>,
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
    pub expires_at_block: u64,
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

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct FundingMessage {
    pub role: String,
    pub config: Option<RoleConfig>,
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
