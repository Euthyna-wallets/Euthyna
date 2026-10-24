use std::borrow::Cow;

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};

pub const PROPOSAL_BOND_YOCTO: u128 = 100_000_000_000_000_000_000_000;
pub const PROPOSAL_PERIOD_NS: u64 = 30_000_000_000;
pub const CHAIN_ID: u64 = 84_532;
pub const RULE_DELAY_NS: u64 = 1_000_000_000;
pub const TOKEN: [u8; 20] = [0x83; 20];
pub const ALLOWANCE_KEY: [u8; 32] = [0x55; 32];

const PINNED_DAO_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/sputnikdao2-2.3.1-5434a59.wasm"
));
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));

fn dao_wasm() -> Result<Cow<'static, [u8]>> {
    match std::env::var("SPUTNIK_DAO_WASM") {
        Ok(path) => Ok(Cow::Owned(
            std::fs::read(&path).with_context(|| format!("failed to read {path}"))?,
        )),
        Err(std::env::VarError::NotPresent) => Ok(Cow::Borrowed(PINNED_DAO_WASM)),
        Err(error) => Err(error.into()),
    }
}

pub struct Fixture {
    pub worker: Worker<Sandbox>,
    pub dao: Contract,
    pub vault: Contract,
    pub council: Vec<Account>,
    pub outsider: Account,
}

pub async fn setup() -> Result<Fixture> {
    setup_with_threshold(json!("2")).await
}
pub async fn setup_with_threshold(threshold: Value) -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let council = vec![
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
        worker.dev_create_account().await?,
    ];
    let outsider = worker.dev_create_account().await?;
    let dao = worker.dev_deploy(&dao_wasm()?).await?;
    let vault = worker.dev_deploy(VAULT_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;

    dao.call("new")
        .args_json(json!({
            "config": {"name": "ACME OmniRoles DAO", "purpose": "Govern OmniRoles", "metadata": ""},
            "policy": council_policy(&council, threshold)
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    mpc.call("new")
        .args_json(json!({
            "public_key": "secp256k1:4No43FuGUrLugkr3DYjSa7ieGvmBvLC674qyaPtpEhW96kxmr2DRgHKJbUZv7dstGJEeHAvc5sTcsiQbuFs7APHN"
        }))
        .transact()
        .await?
        .into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": "acme",
            "owner_id": dao.id(),
            "mpc_contract_id": mpc.id(),
            "visa_public_key": STANDARD.encode([0u8; 32]),
            "status_public_key": STANDARD.encode([1u8; 32]),
            "policy_version": 1,
            "registry_version": 1,
            "operation_ttl_ns": 120_000_000_000u64,
            "rule_delay_ns": RULE_DELAY_NS,
            "rule_expiration_ns": 60_000_000_000u64,
            "council": council.iter().map(Account::id).collect::<Vec<_>>()
        }))
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
        dao,
        vault,
        council,
        outsider,
    })
}

fn council_policy(council: &[Account], threshold: Value) -> Value {
    json!({
        "roles": [{
            "name": "council",
            "kind": {"Group": council.iter().map(|member| member.id().to_string()).collect::<Vec<_>>()},
            "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
            "vote_policy": {}
        }],
        "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": threshold},
        "proposal_bond": PROPOSAL_BOND_YOCTO.to_string(),
        "proposal_period": PROPOSAL_PERIOD_NS.to_string(),
        "bounty_bond": PROPOSAL_BOND_YOCTO.to_string(),
        "bounty_forgiveness_period": PROPOSAL_PERIOD_NS.to_string()
    })
}

pub fn role_config() -> Value {
    json!({
        "enabled": true,
        "permissions": [{
            "chain_id": CHAIN_ID,
            "target": TOKEN,
            "selector": [0xa9, 0x05, 0x9c, 0xbb],
            "conditions": [
                {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
                {"parent": 0, "paramType": 1, "operator": 0, "compValue": "0x"},
                {"parent": 0, "paramType": 1, "operator": 28, "compValue": format!("0x{}", hex::encode(ALLOWANCE_KEY))}
            ],
            "allow_value": false
        }],
        "operation_delay_threshold": "5000000",
        "operation_delay_ns": 300_000_000_000u64,
        "co_sign_threshold": "1000000",
        "co_signer_role": "approver",
        "velocity": {"limit": "50000000", "window_ns": 86_400_000_000_000u64},
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

pub fn set_role_change(role: &str) -> Value {
    json!({"SetRole": {"role": role, "config": role_config()}})
}

pub fn function_call_kind(receiver: &Contract, method: &str, args: Value, gas_tgas: u64) -> Value {
    json!({
        "FunctionCall": {
            "receiver_id": receiver.id(),
            "actions": [{
                "method_name": method,
                "args": STANDARD.encode(serde_json::to_vec(&args).expect("args serialize")),
                "deposit": "0",
                "gas": Gas::from_tgas(gas_tgas).as_gas().to_string()
            }]
        }
    })
}

pub async fn preview_queue_id(fixture: &Fixture, change: Value) -> Result<Value> {
    Ok(fixture
        .vault
        .view("preview_rule_queue_id")
        .args_json(json!({"change": change}))
        .await?
        .json()?)
}

pub async fn add_proposal(fixture: &Fixture, proposer: &Account, kind: Value) -> Result<u64> {
    Ok(proposer
        .call(fixture.dao.id(), "add_proposal")
        .args_json(json!({"proposal": {"description": "OmniRoles rule change", "kind": kind}}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(
            PROPOSAL_BOND_YOCTO,
        ))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

pub async fn vote(
    fixture: &Fixture,
    member: &Account,
    proposal_id: u64,
    kind: Value,
) -> Result<ExecutionFinalResult> {
    Ok(member
        .call(fixture.dao.id(), "act_proposal")
        .args_json(
            json!({"id": proposal_id, "action": "VoteApprove", "proposal": kind, "memo": null}),
        )
        .gas(Gas::from_tgas(200))
        .transact()
        .await?)
}

pub async fn proposal_status(fixture: &Fixture, proposal_id: u64) -> Result<String> {
    let proposal: Value = fixture
        .dao
        .view("get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?
        .json()?;
    Ok(proposal["status"]
        .as_str()
        .context("proposal status")?
        .to_owned())
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
