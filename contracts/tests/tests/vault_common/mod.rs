use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde::Serialize;
use serde_json::{Value, json};
use sha3::{Digest as _, Keccak256};

pub const CLIENT_ID: &str = "acme";
pub const ROLE: &str = "researcher";
pub const FUNDED_BUDGET: u128 = 1_000;
pub const MAX_PER_TX: u128 = 500;
pub const POLICY_VERSION: u64 = 7;
pub const REGISTRY_VERSION: u64 = 11;
pub const TTL_BLOCKS: u64 = 50;
pub const TOKEN: [u8; 20] = [0x83; 20];
pub const ROLES_MODIFIER: [u8; 20] = [0x44; 20];
pub const RECIPIENT: [u8; 20] = [0x66; 20];
pub const ROLE_KEY: [u8; 32] = [0x55; 32];
pub const MPC_SECRET: [u8; 32] = [0x42; 32];
pub const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";

const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const TEST_FT_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_ft.wasm"));

pub struct Fixture {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub agent: Account,
    pub outsider: Account,
    pub vault: Contract,
    pub mpc: Contract,
    pub guard: SigningKey,
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
    expires_at_block: u64,
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
    expires_at_block: u64,
}

#[derive(BorshSerialize)]
enum StatusKindForSigning {
    Confirmed,
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
    let outsider = worker.dev_create_account().await?;
    let vault = worker.dev_deploy(VAULT_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;
    let ft = worker.dev_deploy(TEST_FT_WASM).await?;
    let guard = SigningKey::from_bytes(&[7u8; 32]);

    mpc.call("new")
        .args_json(json!({"public_key": MPC_PUBLIC_KEY}))
        .transact()
        .await?
        .into_result()?;
    ft.call("new").transact().await?.into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": CLIENT_ID,
            "owner_id": owner.id(),
            "token_id": ft.id(),
            "mpc_contract_id": mpc.id(),
            "evm_chain_id": 84532,
            "guard_public_key": STANDARD.encode(guard.verifying_key().to_bytes()),
            "policy_version": POLICY_VERSION,
            "registry_version": REGISTRY_VERSION,
            "reservation_ttl_blocks": TTL_BLOCKS
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(vault.id(), "set_role")
        .args_json(json!({"role": ROLE, "config": role_config()}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(vault.id(), "register_agent")
        .args_json(json!({
            "agent": agent.id(),
            "role": ROLE,
            "mpc_path": "agents/researcher/base"
        }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(vault.id(), "request_derived_public_key")
        .args_json(json!({"agent": agent.id()}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    ft.call("mint")
        .args_json(json!({"account_id": owner.id(), "amount": FUNDED_BUDGET.to_string()}))
        .transact()
        .await?
        .into_result()?;
    ft.call("storage_deposit")
        .args_json(json!({"account_id": vault.id(), "registration_only": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(ft.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": vault.id(),
            "amount": FUNDED_BUDGET.to_string(),
            "memo": null,
            "msg": json!({"role": ROLE}).to_string()
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

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
        outsider,
        vault,
        mpc,
        guard,
    })
}

pub fn role_config() -> Value {
    json!({
        "enabled": true,
        "token": TOKEN,
        "roles_modifier": ROLES_MODIFIER,
        "role_key": ROLE_KEY,
        "allowed_recipients": [RECIPIENT],
        "max_per_tx": MAX_PER_TX.to_string(),
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

pub fn intent(reference: &str, amount: u128) -> Value {
    json!({
        "token": TOKEN,
        "recipient": RECIPIENT,
        "amount": amount.to_string(),
        "reference": reference,
        "gas_limit": "200000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    })
}

pub async fn prepare(fixture: &Fixture, reference: &str, amount: u128) -> Result<Value> {
    Ok(fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": intent(reference, amount)}))
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
    expires_at_block: u64,
    digest_override: Option<[u8; 32]>,
) -> Value {
    let op_id = array32(&operation["op_id"]);
    let tx_digest = digest_override.unwrap_or_else(|| array32(&operation["tx_digest"]));
    let visa = VisaForSigning {
        client_id: CLIENT_ID.to_string(),
        op_id,
        tx_digest,
        agent: fixture.agent.id().to_string(),
        role: ROLE.to_string(),
        reference: operation["intent"]["reference"]
            .as_str()
            .expect("operation reference")
            .to_string(),
        policy_version: POLICY_VERSION,
        registry_version: REGISTRY_VERSION,
        visa_nonce,
        expires_at_block,
    };
    let mut message = b"mandateos:visa:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&visa).expect("visa serializes"));
    let signature = fixture.guard.sign(&message).to_bytes();
    let json_visa = VisaJson {
        client_id: visa.client_id,
        op_id: visa.op_id,
        tx_digest: visa.tx_digest,
        agent: visa.agent,
        role: visa.role,
        reference: visa.reference,
        policy_version: visa.policy_version,
        registry_version: visa.registry_version,
        visa_nonce: visa.visa_nonce,
        expires_at_block: visa.expires_at_block,
    };
    json!({
        "visa": json_visa,
        "signature": STANDARD.encode(signature)
    })
}

pub fn signed_transaction_hash(operation: &Value, cancellation: bool) -> [u8; 32] {
    let signed_transaction = if cancellation {
        &operation["cancellation"]["signed_transaction"]
    } else {
        &operation["signed_transaction"]
    };
    let raw = signed_transaction
        .as_array()
        .expect("signed transaction")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>();
    Keccak256::digest(raw).into()
}

pub fn status_report(fixture: &Fixture, operation: &Value, report_nonce: u64) -> Value {
    status_report_with_hash(
        fixture,
        operation,
        signed_transaction_hash(operation, false),
        report_nonce,
    )
}

pub fn status_report_with_hash(
    fixture: &Fixture,
    operation: &Value,
    tx_hash: [u8; 32],
    report_nonce: u64,
) -> Value {
    let report = StatusReportForSigning {
        client_id: CLIENT_ID.to_string(),
        op_id: op_id(operation),
        kind: StatusKindForSigning::Confirmed,
        tx_hash,
        report_nonce,
        block_number: 1,
    };
    let mut message = b"mandateos:status:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&report).expect("status report serializes"));
    let signature = fixture.guard.sign(&message).to_bytes();
    json!({
        "report": {
            "client_id": CLIENT_ID,
            "op_id": report.op_id,
            "kind": "Confirmed",
            "tx_hash": report.tx_hash,
            "report_nonce": report.report_nonce,
            "block_number": report.block_number
        },
        "signature": STANDARD.encode(signature)
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

pub async fn set_mpc_mode(fixture: &Fixture, mode: &str) -> Result<()> {
    fixture
        .mpc
        .call("set_mode")
        .args_json(json!({"mode": mode}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub fn op_id(operation: &Value) -> [u8; 32] {
    array32(&operation["op_id"])
}

pub fn operation_digest(operation: &Value) -> [u8; 32] {
    array32(&operation["tx_digest"])
}

pub fn cancellation_digest(operation: &Value) -> [u8; 32] {
    array32(&operation["cancellation"]["tx_digest"])
}

pub fn expected_evm_address(public_key: &str) -> [u8; 20] {
    let decoded = bs58::decode(public_key.strip_prefix("secp256k1:").expect("secp key"))
        .into_vec()
        .expect("base58 key");
    assert_eq!(decoded.len(), 64);
    let hash = Keccak256::digest(decoded);
    hash[12..].try_into().expect("20 byte address")
}

/// Signs `digest` with the fixture MPC secret and returns the Chain Signatures
/// JSON shape: compressed R, scalar s and recovery id.
pub fn mpc_signature(digest: [u8; 32]) -> Value {
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

pub fn assert_failure_contains(outcome: &ExecutionFinalResult, expected: &str) {
    assert!(outcome.is_failure(), "transaction unexpectedly succeeded");
    let failures = format!("{:#?}", outcome.failures());
    assert!(
        failures.contains(expected),
        "expected failure containing {expected:?}, got {failures}"
    );
}

fn array32(value: &Value) -> [u8; 32] {
    value
        .as_array()
        .expect("byte array")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes")
}
