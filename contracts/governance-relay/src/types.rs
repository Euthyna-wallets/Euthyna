use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, near};
use serde::{Deserialize, Serialize};

pub type OperationId = [u8; 32];
pub type EvmAddress = [u8; 20];
pub type Digest = [u8; 32];

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
    PossiblySigned,
    Confirmed,
    Cancelled,
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
pub struct GovernanceOperation {
    pub op_id: OperationId,
    pub proposer: AccountId,
    pub target: EvmAddress,
    pub value: U128,
    pub data: Vec<u8>,
    pub operation: u8,
    pub evm_nonce: u64,
    pub transaction: Eip1559Transaction,
    pub tx_digest: Digest,
    pub possibly_signed_at_block: u64,
    pub state: OperationState,
    pub signature: Option<MpcSignature>,
    pub signed_transaction: Option<Vec<u8>>,
    pub cancellation: Option<CancellationAttempt>,
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
