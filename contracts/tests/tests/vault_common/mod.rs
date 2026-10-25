use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer as _, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract, Worker};
use serde::Serialize;
use serde_json::{Value, json};
use sha3::{Digest as _, Keccak256};

pub const CLIENT_ID: &str = "acme";
pub const ROLE: &str = "researcher";
pub const CHAIN_ID: u64 = 84_532;
pub const ALLOWANCE_BALANCE: u128 = 1_000;
pub const MAX_PER_OPERATION: u128 = 500;
pub const POLICY_VERSION: u64 = 7;
pub const REGISTRY_VERSION: u64 = 11;
pub const TOKEN: [u8; 20] = [0x83; 20];
pub const RECIPIENT: [u8; 20] = [0x66; 20];
pub const ALLOWANCE_KEY: [u8; 32] = [0x55; 32];
pub const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";
pub const RULE_DELAY_NS: u64 = 1_000_000_000;
pub const RULE_EXPIRATION_NS: u64 = 60_000_000_000;
pub const OPERATION_TTL_NS: u64 = 120_000_000_000;

const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));

pub struct Fixture {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub agent: Account,
    pub cosigner: Account,
    pub council: Account,
    pub outsider: Account,
    pub vault: Contract,
    pub guard: SigningKey,
    pub status_guard: SigningKey,
}

#[derive(BorshSerialize)]
struct VisaForSigning {
    client_id: String,
    op_id: [u8; 32],
    tx_digest: [u8; 32],
    agent: String,
    role: String,
    reference: String,
    policy_version: u64,
    registry_version: u64,
    visa_nonce: u64,
    expires_at_ns: u64,
}

#[derive(Serialize)]
struct VisaJson {
    client_id: String,
    op_id: [u8; 32],
    tx_digest: [u8; 32],
    agent: String,
    role: String,
    reference: String,
    policy_version: u64,
    registry_version: u64,
    visa_nonce: u64,
    expires_at_ns: String,
}

#[derive(BorshSerialize)]
enum StatusKindForSigning {
    Confirmed,
    Failed,
}

#[derive(BorshSerialize)]
struct StatusReportForSigning {
    client_id: String,
    op_id: [u8; 32],
    kind: StatusKindForSigning,
    tx_hash: [u8; 32],
    report_nonce: u64,
    block_number: u64,
}

pub async fn setup() -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let cosigner = worker.dev_create_account().await?;
    let council = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let vault = worker.dev_deploy(VAULT_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;
    let guard = SigningKey::from_bytes(&[7u8; 32]);
    let status_guard = SigningKey::from_bytes(&[8u8; 32]);

    mpc.call("new")
        .args_json(json!({"public_key": MPC_PUBLIC_KEY}))
        .transact()
        .await?
        .into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": CLIENT_ID,
            "owner_id": owner.id(),
            "mpc_contract_id": mpc.id(),
            "visa_public_key": STANDARD.encode(guard.verifying_key().to_bytes()),
            "status_public_key": STANDARD.encode(status_guard.verifying_key().to_bytes()),
            "policy_version": POLICY_VERSION,
            "registry_version": REGISTRY_VERSION,
            "operation_ttl_ns": OPERATION_TTL_NS,
            "rule_delay_ns": RULE_DELAY_NS,
            "rule_expiration_ns": RULE_EXPIRATION_NS,
            "council": [council.id()]
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(vault.id(), "request_wallet")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    apply_rule_change(
        &owner,
        &outsider,
        &worker,
        &vault,
        json!({
            "SetRole": {"role": ROLE, "config": role_config()}
        }),
    )
    .await?;
    apply_rule_change(
        &owner,
        &outsider,
        &worker,
        &vault,
        json!({
            "SetRole": {"role": "approver", "config": approver_role_config()}
        }),
    )
    .await?;
    apply_rule_change(
        &owner,
        &outsider,
        &worker,
        &vault,
        json!({
            "GrantMembership": {
                "role": ROLE,
                "member": agent.id(),
                "kind": "Agent",
                "starts_at_ns": "0",
                "ends_at_ns": null,
                "max_uses": 10
            }
        }),
    )
    .await?;
    apply_rule_change(
        &owner,
        &outsider,
        &worker,
        &vault,
        json!({
            "GrantMembership": {
                "role": "approver",
                "member": cosigner.id(),
                "kind": "Human",
                "starts_at_ns": "0",
                "ends_at_ns": null,
                "max_uses": null
            }
        }),
    )
    .await?;
    apply_rule_change(
        &owner,
        &outsider,
        &worker,
        &vault,
        json!({
            "SetAllowance": {
                "key": ALLOWANCE_KEY,
                "balance": ALLOWANCE_BALANCE.to_string(),
                "refill": "100",
                "max_refill": ALLOWANCE_BALANCE.to_string(),
                "period_ns": 10_000_000_000u64
            }
        }),
    )
    .await?;

    let vault_public_key = vault.as_account().secret_key().public_key();
    vault
        .as_account()
        .batch(vault.id())
        .delete_key(vault_public_key)
        .transact()
        .await?
        .into_result()?;
    if !vault.view_access_keys().await?.is_empty() {
        bail!("vault still has access keys after setup");
    }

    Ok(Fixture {
        worker,
        owner,
        agent,
        cosigner,
        council,
        outsider,
        vault,
        guard,
        status_guard,
    })
}

/// Roles-format conditions for `transfer(to == recipient, amount within key)`.
pub fn transfer_conditions(recipient: [u8; 20], key: [u8; 32]) -> Value {
    json!([
        {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
        {"parent": 0, "paramType": 1, "operator": 16, "compValue": format!("0x{}{}", "00".repeat(12), hex::encode(recipient))},
        {"parent": 0, "paramType": 1, "operator": 28, "compValue": format!("0x{}", hex::encode(key))}
    ])
}

pub fn role_config() -> Value {
    json!({
        "enabled": true,
        "permissions": [{
            "chain_id": CHAIN_ID,
            "target": TOKEN,
            "selector": [0xa9, 0x05, 0x9c, 0xbb],
            "conditions": transfer_conditions(RECIPIENT, ALLOWANCE_KEY),
            "allow_value": false
        }],
        "operation_delay_threshold": MAX_PER_OPERATION.to_string(),
        "operation_delay_ns": 5_000_000_000u64,
        "co_sign_threshold": "300",
        "co_signer_role": "approver",
        "velocity": {"limit": "800", "window_ns": 60_000_000_000u64},
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

pub fn approver_role_config() -> Value {
    json!({
        "enabled": true,
        "permissions": [],
        "operation_delay_threshold": null,
        "operation_delay_ns": 0,
        "co_sign_threshold": null,
        "co_signer_role": null,
        "velocity": null,
        "gas_limit": "21000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "2100000000000000"
    })
}

pub fn request(reference: &str, amount: u128) -> Value {
    json!({
        "chain_id": CHAIN_ID,
        "target": TOKEN,
        "value": "0",
        "calldata": erc20_transfer(RECIPIENT, amount),
        "allowance_amount": amount.to_string(),
        "reference": reference,
        "gas_limit": "120000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    })
}

pub fn erc20_transfer(recipient: [u8; 20], amount: u128) -> Vec<u8> {
    let mut calldata = vec![0xa9, 0x05, 0x9c, 0xbb];
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(&recipient);
    calldata.extend_from_slice(&[0u8; 16]);
    calldata.extend_from_slice(&amount.to_be_bytes());
    calldata
}

pub async fn prepare(fixture: &Fixture, reference: &str, amount: u128) -> Result<Value> {
    Ok(fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": request(reference, amount)}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

pub fn approval(
    fixture: &Fixture,
    operation: &Value,
    visa_nonce: u64,
    expires_at_ns: u64,
    digest_override: Option<[u8; 32]>,
) -> Value {
    approval_signed_by(fixture, &fixture.guard, operation, visa_nonce, expires_at_ns, digest_override)
}

/// A visa signed by any key: the Guard's, or an attacker's.
pub fn approval_signed_by(
    fixture: &Fixture,
    signer: &SigningKey,
    operation: &Value,
    visa_nonce: u64,
    expires_at_ns: u64,
    digest_override: Option<[u8; 32]>,
) -> Value {
    let op_id = array32(&operation["op_id"]);
    let digest = digest_override.unwrap_or_else(|| array32(&operation["tx_digest"]));
    let reference = operation["request"]["reference"]
        .as_str()
        .expect("reference")
        .to_owned();
    let visa = VisaForSigning {
        client_id: CLIENT_ID.to_owned(),
        op_id,
        tx_digest: digest,
        agent: fixture.agent.id().to_string(),
        role: ROLE.to_owned(),
        reference: reference.clone(),
        policy_version: POLICY_VERSION,
        registry_version: REGISTRY_VERSION,
        visa_nonce,
        expires_at_ns,
    };
    let mut message = b"mandateos:visa:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&visa).expect("visa serializes"));
    let signature = signer.sign(&message);
    json!({
        "visa": VisaJson {
            client_id: CLIENT_ID.to_owned(),
            op_id,
            tx_digest: digest,
            agent: fixture.agent.id().to_string(),
            role: ROLE.to_owned(),
            reference,
            policy_version: POLICY_VERSION,
            registry_version: REGISTRY_VERSION,
            visa_nonce,
            expires_at_ns: expires_at_ns.to_string(),
        },
        "signature": STANDARD.encode(signature.to_bytes())
    })
}

pub fn status_report(
    fixture: &Fixture,
    operation: &Value,
    report_nonce: u64,
    confirmed: bool,
) -> Value {
    status_report_signed_by(&fixture.status_guard, operation, report_nonce, confirmed)
}

/// A status report signed by any key: the worker's, or an attacker's.
pub fn status_report_signed_by(
    signer: &SigningKey,
    operation: &Value,
    report_nonce: u64,
    confirmed: bool,
) -> Value {
    let op_id = array32(&operation["op_id"]);
    let signed_transaction = operation["signed_transaction"]
        .as_array()
        .expect("signed transaction")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>();
    let tx_hash: [u8; 32] = Keccak256::digest(&signed_transaction).into();
    let kind = if confirmed {
        StatusKindForSigning::Confirmed
    } else {
        StatusKindForSigning::Failed
    };
    let report = StatusReportForSigning {
        client_id: CLIENT_ID.to_owned(),
        op_id,
        kind,
        tx_hash,
        report_nonce,
        block_number: 1,
    };
    let mut message = b"mandateos:status:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&report).expect("report serializes"));
    let signature = signer.sign(&message);
    json!({
        "signed_report": {
            "report": {
                "client_id": CLIENT_ID,
                "op_id": op_id,
                "kind": if confirmed { "Confirmed" } else { "Failed" },
                "tx_hash": tx_hash,
                "report_nonce": report_nonce,
                "block_number": 1
            },
            "signature": STANDARD.encode(signature.to_bytes())
        },
        "mpc_signature": null
    })
}

pub async fn authorize(
    fixture: &Fixture,
    operation: &Value,
    approval: Value,
) -> Result<ExecutionFinalResult> {
    Ok(fixture
        .agent
        .call(fixture.vault.id(), "authorize")
        .args_json(json!({"op_id": operation["op_id"], "approval": approval}))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?)
}

pub async fn get_operation(fixture: &Fixture, operation: &Value) -> Result<Value> {
    Ok(fixture
        .vault
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("operation missing")?)
}

pub fn op_id(operation: &Value) -> [u8; 32] {
    array32(&operation["op_id"])
}

pub fn assert_failure_contains(outcome: &ExecutionFinalResult, expected: &str) {
    let failure = outcome
        .clone()
        .into_result()
        .expect_err("transaction should fail");
    assert!(
        format!("{failure:?}").contains(expected),
        "expected {expected}, got {failure:?}"
    );
}

pub async fn apply_rule_change(
    owner: &Account,
    executor: &Account,
    worker: &Worker<Sandbox>,
    vault: &Contract,
    change: Value,
) -> Result<()> {
    let queued: Value = owner
        .call(vault.id(), "queue_rule_change")
        .args_json(json!({"change": change}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    worker.fast_forward(2).await?;
    executor
        .call(vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": queued["queue_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

fn array32(value: &Value) -> [u8; 32] {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes")
}
