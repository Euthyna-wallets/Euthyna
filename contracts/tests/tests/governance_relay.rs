use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract, Worker};
use serde::Serialize;
use serde_json::{Value, json};
use serial_test::serial;
use sha3::{Digest as _, Keccak256};

const RELAY_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/governance_relay.wasm"
));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const MPC_SECRET: [u8; 32] = [0x42; 32];
const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";
const DELAY: [u8; 20] = [0x44; 20];
const TARGET: [u8; 20] = [0x66; 20];
const MULTISEND: [u8; 20] = [0x77; 20];
const GUARD_SECRET: [u8; 32] = [9u8; 32];

#[derive(BorshSerialize, Serialize)]
enum ReportKind {
    Confirmed,
}

#[derive(BorshSerialize, Serialize)]
struct StatusReportForSigning {
    client_id: String,
    op_id: [u8; 32],
    kind: ReportKind,
    tx_hash: [u8; 32],
    report_nonce: u64,
    block_number: u64,
}

struct Fixture {
    worker: Worker<Sandbox>,
    owner: Account,
    outsider: Account,
    relay: Contract,
    mpc: Contract,
}

async fn setup() -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let relay = worker.dev_deploy(RELAY_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;
    mpc.call("new")
        .args_json(json!({"public_key": MPC_PUBLIC_KEY}))
        .transact()
        .await?
        .into_result()?;
    relay
        .call("new")
        .args_json(json!({
            "client_id": "acme",
            "owner_id": owner.id(),
            "mpc_contract_id": mpc.id(),
            "mpc_path": "governance/base-sepolia",
            "evm_chain_id": 84532,
            "delay_address": STANDARD.encode(DELAY),
            "multisend_address": STANDARD.encode(MULTISEND),
            "guard_public_key": STANDARD.encode(SigningKey::from_bytes(&GUARD_SECRET).verifying_key().to_bytes()),
            "max_gas_limit": "300000",
            "max_fee_per_gas": "100000000000",
            "max_priority_fee_per_gas": "10000000000",
            "max_total_fee": "30000000000000000"
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(relay.id(), "request_derived_public_key")
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let relay_key = relay.as_account().secret_key().public_key();
    relay
        .as_account()
        .batch(relay.id())
        .delete_key(relay_key)
        .transact()
        .await?
        .into_result()?;
    Ok(Fixture {
        worker,
        owner,
        outsider,
        relay,
        mpc,
    })
}

fn proposal_args() -> Value {
    json!({
        "target": STANDARD.encode(TARGET),
        "value": "0",
        "data": STANDARD.encode([0x12, 0x34, 0x56, 0x78]),
        "operation": 0,
        "gas_limit": "200000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    })
}

async fn propose(fixture: &Fixture) -> Result<Value> {
    fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .gas(Gas::from_tgas(120))
        .transact()
        .await?
        .into_result()?;
    get_active_operation(fixture).await
}

async fn get_active_operation(fixture: &Fixture) -> Result<Value> {
    let op_id: Option<Value> = fixture.relay.view("active_operation").await?.json()?;
    let op_id = op_id.context("active operation missing")?;
    let operation: Option<Value> = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": op_id}))
        .await?
        .json()?;
    operation.context("governance operation missing")
}

fn signed_transaction_hash(operation: &Value, cancellation: bool) -> [u8; 32] {
    let raw = if cancellation {
        &operation["cancellation"]["signed_transaction"]
    } else {
        &operation["signed_transaction"]
    }
    .as_array()
    .expect("signed transaction")
    .iter()
    .map(|byte| byte.as_u64().expect("byte") as u8)
    .collect::<Vec<_>>();
    Keccak256::digest(raw).into()
}

fn expected_evm_address() -> [u8; 20] {
    let decoded = bs58::decode(MPC_PUBLIC_KEY.strip_prefix("secp256k1:").expect("secp key"))
        .into_vec()
        .expect("base58 key");
    let hash = Keccak256::digest(decoded);
    hash[12..].try_into().expect("20 byte address")
}

fn mpc_signature(digest: [u8; 32]) -> Value {
    use k256::ecdsa::SigningKey;

    let signing_key = SigningKey::from_bytes((&MPC_SECRET).into()).expect("fixture MPC key");
    let (signature, recovery_id) = signing_key
        .sign_prehash_recoverable(&digest)
        .expect("fixture MPC signature");
    let mut big_r = vec![0x02 + recovery_id.to_byte()];
    big_r.extend_from_slice(&signature.r().to_bytes());
    json!({
        "big_r": big_r,
        "s": signature.s().to_bytes().to_vec(),
        "recovery_id": recovery_id.to_byte()
    })
}

fn digest(value: &Value) -> [u8; 32] {
    value
        .as_array()
        .expect("byte array")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes")
}

fn assert_failure_contains(
    outcome: &near_workspaces::result::ExecutionFinalResult,
    expected: &str,
) {
    assert!(outcome.is_failure(), "transaction unexpectedly succeeded");
    assert!(
        format!("{:#?}", outcome.failures()).contains(expected),
        "expected failure containing {expected}"
    );
}

fn signed_status_report(operation: &Value, report_nonce: u64) -> Value {
    signed_status_report_for_hash(
        operation,
        report_nonce,
        signed_transaction_hash(operation, false),
    )
}

fn signed_status_report_for_hash(operation: &Value, report_nonce: u64, tx_hash: [u8; 32]) -> Value {
    let report = StatusReportForSigning {
        client_id: "acme".to_string(),
        op_id: digest(&operation["op_id"]),
        kind: ReportKind::Confirmed,
        tx_hash,
        report_nonce,
        block_number: 42,
    };
    let mut message = b"mandateos:relay-status:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&report).expect("report serialization"));
    let signature = SigningKey::from_bytes(&GUARD_SECRET)
        .sign(&message)
        .to_bytes();
    json!({
        "report": report,
        "signature": STANDARD.encode(signature),
    })
}

#[tokio::test]
#[serial]
async fn only_dao_owner_can_propose_governance_calls() -> Result<()> {
    let fixture = setup().await?;
    let outcome = fixture
        .outsider
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    assert_failure_contains(&outcome, "ERR_OWNER_ONLY");
    Ok(())
}

#[tokio::test]
#[serial]
async fn propose_mpc_gas_is_measured() -> Result<()> {
    let fixture = setup().await?;
    let outcome = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    let gas_burnt = outcome.total_gas_burnt.as_gas();
    outcome.into_result()?;
    println!("MANDATEOS_RELAY_PROPOSE_GAS={gas_burnt}");
    assert!(gas_burnt > 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn delegatecall_is_limited_to_canonical_multisend() -> Result<()> {
    let fixture = setup().await?;
    let arbitrary = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(json!({
            "target": STANDARD.encode(TARGET),
            "value": "0",
            "data": STANDARD.encode([0x12, 0x34]),
            "operation": 1,
            "gas_limit": "200000",
            "max_fee_per_gas": "20000000000",
            "max_priority_fee_per_gas": "1000000000"
        }))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    assert_failure_contains(&arbitrary, "ERR_DELEGATECALL_TARGET");

    let invalid_operation = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(json!({
            "target": STANDARD.encode(MULTISEND),
            "value": "0",
            "data": STANDARD.encode([0x12, 0x34]),
            "operation": 2,
            "gas_limit": "200000",
            "max_fee_per_gas": "20000000000",
            "max_priority_fee_per_gas": "1000000000"
        }))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    assert_failure_contains(&invalid_operation, "ERR_OPERATION");

    fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(json!({
            "target": STANDARD.encode(MULTISEND),
            "value": "0",
            "data": STANDARD.encode([0x12, 0x34]),
            "operation": 1,
            "gas_limit": "200000",
            "max_fee_per_gas": "20000000000",
            "max_priority_fee_per_gas": "1000000000"
        }))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?
        .into_result()?;
    let operation = get_active_operation(&fixture).await?;
    assert_eq!(operation["operation"], 1);
    assert_eq!(operation["target"], json!(MULTISEND));
    let input = operation["transaction"]["input"]
        .as_array()
        .expect("delay calldata");
    assert!(input[100..131].iter().all(|byte| byte == 0));
    assert_eq!(input[131], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn proposal_builds_delay_call_and_confirms_sequential_nonce() -> Result<()> {
    let fixture = setup().await?;
    let operation = propose(&fixture).await?;
    assert_eq!(operation["state"], "PossiblySigned");
    assert_eq!(operation["evm_nonce"], 0);
    assert_eq!(operation["transaction"]["chain_id"], 84532);
    assert_eq!(operation["transaction"]["to"], json!(DELAY));
    assert_eq!(
        &operation["transaction"]["input"].as_array().expect("input")[..4],
        &[json!(0x46), json!(0x87), json!(0x21), json!(0xa7)]
    );
    assert!(!operation["signed_transaction"].is_null());

    let blocked = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .transact()
        .await?;
    assert_failure_contains(&blocked, "ERR_ACTIVE_OPERATION");

    fixture
        .owner
        .call(fixture.relay.id(), "confirm_original")
        .args_json(json!({
            "op_id": operation["op_id"],
            "tx_hash": signed_transaction_hash(&operation, false)
        }))
        .transact()
        .await?
        .into_result()?;
    let confirmed: Value = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("confirmed operation")?;
    assert_eq!(confirmed["state"], "Confirmed");
    assert_eq!(
        fixture.relay.view("next_evm_nonce").await?.json::<u64>()?,
        1
    );
    let second = propose(&fixture).await?;
    assert_eq!(second["evm_nonce"], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn guard_report_confirms_exact_signed_transaction_and_blocks_replay() -> Result<()> {
    let fixture = setup().await?;
    let operation = propose(&fixture).await?;
    let signed_report = signed_status_report(&operation, 7);
    fixture
        .outsider
        .call(fixture.relay.id(), "report_status")
        .args_json(json!({"signed_report": signed_report, "mpc_signature": null}))
        .transact()
        .await?
        .into_result()?;
    let confirmed: Value = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("confirmed operation")?;
    assert_eq!(confirmed["state"], "Confirmed");

    let second = propose(&fixture).await?;
    let replay = fixture
        .outsider
        .call(fixture.relay.id(), "report_status")
        .args_json(json!({
            "signed_report": signed_status_report(&second, 7),
            "mpc_signature": null
        }))
        .transact()
        .await?;
    assert_failure_contains(&replay, "ERR_REPORT_NONCE_USED");

    let wrong_hash = fixture
        .outsider
        .call(fixture.relay.id(), "report_status")
        .args_json(json!({
            "signed_report": signed_status_report_for_hash(&second, 8, [0u8; 32]),
            "mpc_signature": null
        }))
        .transact()
        .await?;
    assert_failure_contains(&wrong_hash, "ERR_REPORT_TX_HASH");
    Ok(())
}

#[tokio::test]
#[serial]
async fn cancel_nonce_signs_same_nonce_and_finishes_cancelled() -> Result<()> {
    let fixture = setup().await?;
    let operation = propose(&fixture).await?;
    fixture
        .owner
        .call(fixture.relay.id(), "cancel_nonce")
        .args_json(json!({
            "op_id": operation["op_id"],
            "gas_limit": "21000",
            "max_fee_per_gas": "30000000000",
            "max_priority_fee_per_gas": "2000000000"
        }))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?
        .into_result()?;
    let cancelling = get_active_operation(&fixture).await?;
    assert_eq!(cancelling["state"], "PossiblySigned");
    assert_eq!(
        cancelling["cancellation"]["transaction"]["nonce"],
        operation["evm_nonce"]
    );
    assert_eq!(
        cancelling["cancellation"]["transaction"]["to"],
        json!(expected_evm_address())
    );
    assert_eq!(
        cancelling["cancellation"]["transaction"]["input"],
        json!([])
    );
    fixture
        .owner
        .call(fixture.relay.id(), "confirm_cancellation")
        .args_json(json!({
            "op_id": operation["op_id"],
            "tx_hash": signed_transaction_hash(&cancelling, true)
        }))
        .transact()
        .await?
        .into_result()?;
    let cancelled: Value = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("cancelled operation")?;
    assert_eq!(cancelled["state"], "Cancelled");
    assert!(
        fixture
            .relay
            .view("active_operation")
            .await?
            .json::<Option<Value>>()?
            .is_none()
    );
    assert_eq!(
        fixture.relay.view("next_evm_nonce").await?.json::<u64>()?,
        1
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn late_mpc_response_never_reopens_or_reuses_nonce() -> Result<()> {
    let fixture = setup().await?;
    fixture
        .mpc
        .call("set_mode")
        .args_json(json!({"mode": "Timeout"}))
        .transact()
        .await?
        .into_result()?;
    let pending = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .gas(Gas::from_tgas(120))
        .transact_async()
        .await?;
    let _ = pending;
    fixture.worker.fast_forward(3).await?;
    let operation = get_active_operation(&fixture).await?;
    assert_eq!(operation["state"], "PossiblySigned");
    assert_eq!(
        fixture.relay.view("next_evm_nonce").await?.json::<u64>()?,
        1
    );
    let blocked = fixture
        .owner
        .call(fixture.relay.id(), "propose")
        .args_json(proposal_args())
        .transact()
        .await?;
    assert_failure_contains(&blocked, "ERR_ACTIVE_OPERATION");
    fixture
        .outsider
        .call(fixture.mpc.id(), "resume_sign")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    fixture.worker.fast_forward(3).await?;
    let resumed = get_active_operation(&fixture).await?;
    assert_eq!(resumed["state"], "PossiblySigned");
    assert!(!resumed["signed_transaction"].is_null());
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_mpc_callback_can_be_recovered_through_submit_signature() -> Result<()> {
    let fixture = setup().await?;
    fixture
        .mpc
        .call("set_mode")
        .args_json(json!({"mode": "Fail"}))
        .transact()
        .await?
        .into_result()?;
    let operation = propose(&fixture).await?;
    assert_eq!(operation["state"], "PossiblySigned");
    assert!(operation["signed_transaction"].is_null());

    let wrong = fixture
        .outsider
        .call(fixture.relay.id(), "submit_signature")
        .args_json(json!({
            "op_id": operation["op_id"],
            "signature": mpc_signature([0x99; 32])
        }))
        .transact()
        .await?;
    assert_failure_contains(&wrong, "ERR_SIGNATURE_MISMATCH");

    let direct = fixture
        .owner
        .call(fixture.relay.id(), "confirm_original")
        .args_json(json!({
            "op_id": operation["op_id"],
            "tx_hash": vec![0u8; 32],
            "mpc_signature": mpc_signature([0x98; 32])
        }))
        .transact()
        .await?;
    assert_failure_contains(&direct, "ERR_SIGNATURE_MISMATCH");

    fixture
        .outsider
        .call(fixture.relay.id(), "submit_signature")
        .args_json(json!({
            "op_id": operation["op_id"],
            "signature": mpc_signature(digest(&operation["tx_digest"]))
        }))
        .transact()
        .await?
        .into_result()?;

    let recovered = get_active_operation(&fixture).await?;
    assert!(!recovered["signed_transaction"].is_null());
    fixture
        .owner
        .call(fixture.relay.id(), "confirm_original")
        .args_json(json!({
            "op_id": recovered["op_id"],
            "tx_hash": signed_transaction_hash(&recovered, false)
        }))
        .transact()
        .await?
        .into_result()?;
    let confirmed: Value = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("confirmed operation")?;
    assert_eq!(confirmed["state"], "Confirmed");

    let second = propose(&fixture).await?;
    assert_eq!(second["evm_nonce"], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_cancellation_callback_can_be_recovered_through_submit_signature() -> Result<()> {
    let fixture = setup().await?;
    fixture
        .mpc
        .call("set_mode")
        .args_json(json!({"mode": "Fail"}))
        .transact()
        .await?
        .into_result()?;
    let operation = propose(&fixture).await?;
    fixture
        .owner
        .call(fixture.relay.id(), "cancel_nonce")
        .args_json(json!({
            "op_id": operation["op_id"],
            "gas_limit": "21000",
            "max_fee_per_gas": "30000000000",
            "max_priority_fee_per_gas": "2000000000"
        }))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?
        .into_result()?;
    let cancelling = get_active_operation(&fixture).await?;
    assert!(cancelling["cancellation"]["signed_transaction"].is_null());

    fixture
        .outsider
        .call(fixture.relay.id(), "submit_signature")
        .args_json(json!({
            "op_id": cancelling["op_id"],
            "signature": mpc_signature(digest(&cancelling["cancellation"]["tx_digest"]))
        }))
        .transact()
        .await?
        .into_result()?;

    let recovered = get_active_operation(&fixture).await?;
    assert!(!recovered["cancellation"]["signed_transaction"].is_null());
    fixture
        .owner
        .call(fixture.relay.id(), "confirm_cancellation")
        .args_json(json!({
            "op_id": recovered["op_id"],
            "tx_hash": signed_transaction_hash(&recovered, true)
        }))
        .transact()
        .await?
        .into_result()?;
    let cancelled: Value = fixture
        .relay
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("cancelled operation")?;
    assert_eq!(cancelled["state"], "Cancelled");
    assert_eq!(
        fixture.relay.view("next_evm_nonce").await?.json::<u64>()?,
        1
    );
    Ok(())
}
