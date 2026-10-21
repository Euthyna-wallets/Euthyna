use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::network::Sandbox;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};
use serial_test::serial;
use sha3::{Digest as _, Keccak256};

const RELAY_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/governance_relay.wasm"
));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const MPC_PUBLIC_KEY: &str = "secp256k1:4No43FuGUrLugkr3DYjSa7ieGvmBvLC674qyaPtpEhW96kxmr2DRgHKJbUZv7dstGJEeHAvc5sTcsiQbuFs7APHN";
const DELAY: [u8; 20] = [0x44; 20];
const TARGET: [u8; 20] = [0x66; 20];

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
            "owner_id": owner.id(),
            "mpc_contract_id": mpc.id(),
            "mpc_path": "governance/base-sepolia",
            "evm_chain_id": 84532,
            "delay_address": STANDARD.encode(DELAY),
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
