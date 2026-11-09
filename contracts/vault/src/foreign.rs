//! MPC ForeignTx V1 wire encoding, pinned to near/mpc 6326b7d5062fd4eb99afce8dc63c5cc927c8db44.
use crate::*;
use near_sdk::serde::{Deserialize, Serialize};
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct VerifyArgs {
    request: near_sdk::serde_json::Value,
    domain_id: u64,
    payload_version: u8,
    expected_payload_hash: String,
}
impl VerifyArgs {
    pub(crate) fn new(
        request: near_sdk::serde_json::Value,
        domain_id: u64,
        expected_payload_hash: String,
    ) -> Self {
        Self {
            request,
            domain_id,
            payload_version: 1,
            expected_payload_hash,
        }
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyResponse {
    pub payload_hash: String,
    pub signature: MpcSignatureResponse,
}
pub(crate) fn chain(chain_id: u64, mainnet: bool) -> (&'static str, u8) {
    match (mainnet, chain_id) {
        (false, 84532) | (true, 8453) => ("Base", 6),
        (false, 421614) | (true, 42161) => ("Arbitrum", 7),
        (false, 97) | (true, 56) => ("Bnb", 5),
        (false, 80002) | (true, 137) => ("Polygon", 8),
        (false, 43113) | (true, 43114) => ("Avalanche", 13),
        _ => env::panic_str("ERR_FOREIGN_CHAIN_UNAVAILABLE"),
    }
}
/// An EVM chain NEAR MPC attests transactions of (testnet or mainnet id).
pub(crate) fn attestable(chain_id: u64) -> bool {
    matches!(
        chain_id,
        84532 | 8453 | 421614 | 42161 | 97 | 56 | 80002 | 137 | 43113 | 43114
    )
}
/// How final a foreign block must be before NEAR MPC attests it: `Finalized` on mainnet (the L1
/// block is final); `Safe` on testnet (the L2 block is posted on L1: minutes instead of the hour
/// or more Base Sepolia's finalized head can trail). Name for the request, byte for the payload.
pub(crate) fn evm_finality(mainnet: bool) -> (&'static str, u8) {
    if mainnet {
        ("Finalized", 2)
    } else {
        ("Safe", 1)
    }
}
pub(crate) fn payload_hash(tag: u8, tx: [u8; 32], block: [u8; 32], finality: u8) -> [u8; 32] {
    // V1=0; chain tag; EvmRpcRequest; [BlockHash=0]; finality (Latest=0, Safe=1, Finalized=2);
    // [ExtractedValue::EvmExtractedValue=1::BlockHash=0]. Vec lengths: u32 LE.
    let mut p = vec![0, tag];
    p.extend(tx);
    p.extend(1u32.to_le_bytes());
    p.extend([0, finality]);
    p.extend(1u32.to_le_bytes());
    p.extend([1, 0]);
    p.extend(block);
    env::sha256_array(&p)
}
#[near]
impl Vault {
    pub fn get_address_list(&self, list: String) -> Vec<ListAddress> {
        self.address_lists.get(&list).cloned().unwrap_or_default()
    }
    pub fn get_settlement_config(&self) -> SettlementConfig {
        self.settlement_config.clone()
    }
    /// Block hash is an untrusted hint bound into the request verified by MPC.
    pub fn settle(&mut self, op_id: OperationId, block_hash: [u8; 32]) -> Promise {
        self.start_settlement(op_id, block_hash, false)
    }
    pub fn settle_cancellation(&mut self, op_id: OperationId, block_hash: [u8; 32]) -> Promise {
        self.start_settlement(op_id, block_hash, true)
    }
    #[private]
    pub fn on_settle_verified(
        &mut self,
        op_id: OperationId,
        cancellation: bool,
        tx_hash: [u8; 32],
        expected_payload_hash: [u8; 32],
        #[callback_result] result: Result<VerifyResponse, PromiseError>,
    ) {
        let Some(op) = self.operations.get(&op_id) else {
            return;
        };
        if op.state != OperationState::PossiblySigned {
            return;
        }
        let raw = if cancellation {
            op.cancellation
                .as_ref()
                .and_then(|c| c.signed_transaction.as_ref())
        } else {
            op.signed_transaction.as_ref()
        };
        if !raw.is_some_and(|raw| env::keccak256_array(raw) == tx_hash) {
            return;
        }
        if result.is_ok_and(|response| response.payload_hash == hex::encode(expected_payload_hash))
        {
            self.release_operation(
                op_id,
                if cancellation {
                    OperationState::Cancelled
                } else {
                    OperationState::Confirmed
                },
                cancellation,
            );
        }
    }
    pub fn release_unconfirmed(&mut self, op_id: OperationId) {
        let op = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            op.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        require!(
            env::block_timestamp()
                >= op
                    .possibly_signed_at_ns
                    .expect("ERR_NOT_POSSIBLY_SIGNED")
                    .0
                    .saturating_add(self.settlement_config.unconfirmed_after_ns.0),
            "ERR_UNCONFIRMED_TOO_EARLY"
        );
        sponsored::assert_releasable(&op_id);
        self.release_operation(op_id, OperationState::Unconfirmed, false);
    }
}
impl Vault {
    fn start_settlement(
        &mut self,
        op_id: OperationId,
        block: [u8; 32],
        cancellation: bool,
    ) -> Promise {
        let op = self
            .operations
            .get(&op_id)
            .expect("ERR_OPERATION_NOT_FOUND");
        require!(
            op.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        require!(!sponsored::is_sponsored(&op_id), "ERR_USE_SETTLE_SPONSORED");
        let raw = if cancellation {
            op.cancellation
                .as_ref()
                .and_then(|c| c.signed_transaction.as_ref())
        } else {
            op.signed_transaction.as_ref()
        }
        .expect("ERR_SIGNED_TRANSACTION_REQUIRED");
        let tx_hash = env::keccak256_array(raw);
        let (name, tag) = chain(op.request.chain_id, self.settlement_config.mainnet);
        let (finality, finality_byte) = evm_finality(self.settlement_config.mainnet);
        let expected_payload_hash = payload_hash(tag, tx_hash, block, finality_byte);
        let request = VerifyArgs {
            request: near_sdk::serde_json::json!({name: {"tx_id": hex::encode(tx_hash), "extractors": ["BlockHash"], "finality": finality}}),
            domain_id: self.settlement_config.foreign_tx_domain_id,
            payload_version: 1,
            expected_payload_hash: hex::encode(expected_payload_hash),
        };
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .verify_foreign_transaction(request)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_settle_verified(op_id, cancellation, tx_hash, expected_payload_hash),
            )
    }
    pub(crate) fn validate_list_name(list: &str) {
        require!(
            !list.is_empty()
                && list.len() <= 32
                && list.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'_'
                    || b == b'-'),
            "ERR_ADDRESS_LIST_NAME"
        );
    }
    pub(crate) fn validate_settlement_config(c: &SettlementConfig) {
        require!(c.cancel_after_ns.0 > 0, "ERR_CANCEL_TIMEOUT");
        require!(
            c.unconfirmed_after_ns.0 >= c.cancel_after_ns.0.saturating_add(3_600_000_000_000),
            "ERR_UNCONFIRMED_TIMEOUT"
        );
    }
}
