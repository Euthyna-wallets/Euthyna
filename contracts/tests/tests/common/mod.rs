use std::borrow::Cow;

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};

pub const PROPOSAL_BOND_YOCTO: u128 = 100_000_000_000_000_000_000_000;
pub const PROPOSAL_PERIOD_NS: u64 = 30_000_000_000;
pub const ROLE_BUDGET: u128 = 50_000_000;
pub const ROLE_MAX_PER_TX: u128 = 10_000_000;

const PINNED_DAO_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/sputnikdao2-2.3.1-5434a59.wasm"
));
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const TEST_FT_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_ft.wasm"));

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
    pub ft: Contract,
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

    let dao_wasm = dao_wasm()?;
    let dao = worker.dev_deploy(&dao_wasm).await?;
    let vault = worker.dev_deploy(VAULT_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;
    let ft = worker.dev_deploy(TEST_FT_WASM).await?;

    dao.call("new")
        .args_json(json!({
            "config": {
                "name": "ACME MandateOS DAO",
                "purpose": "Govern MandateOS contracts",
                "metadata": ""
            },
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
    ft.call("new").transact().await?.into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": "acme",
            "owner_id": dao.id(),
            "token_id": ft.id(),
            "mpc_contract_id": mpc.id(),
            "evm_chain_id": 84532,
            "guard_public_key": STANDARD.encode([0u8; 32]),
            "policy_version": 1,
            "registry_version": 1,
            "reservation_ttl_blocks": 50
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    ft.call("mint")
        .args_json(json!({
            "account_id": dao.id(),
            "amount": "1000000000"
        }))
        .transact()
        .await?
        .into_result()?;

    ft.call("storage_deposit")
        .args_json(json!({
            "account_id": vault.id(),
            "registration_only": true
        }))
        .deposit(NearToken::from_near(1))
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

    let remaining_keys = vault.view_access_keys().await?;
    if !remaining_keys.is_empty() {
        bail!("vault still has access keys after setup");
    }

    Ok(Fixture {
        worker,
        dao,
        vault,
        ft,
        council,
        outsider,
    })
}

fn council_policy(council: &[Account], threshold: Value) -> Value {
    json!({
        "roles": [{
            "name": "council",
            "kind": {
                "Group": council.iter().map(|member| member.id().to_string()).collect::<Vec<_>>()
            },
            "permissions": [
                "*:AddProposal",
                "*:VoteApprove",
                "*:VoteReject",
                "*:VoteRemove",
                "*:Finalize"
            ],
            "vote_policy": {}
        }],
        "default_vote_policy": {
            "weight_kind": "RoleWeight",
            "quorum": "0",
            "threshold": threshold
        },
        "proposal_bond": PROPOSAL_BOND_YOCTO.to_string(),
        "proposal_period": PROPOSAL_PERIOD_NS.to_string(),
        "bounty_bond": PROPOSAL_BOND_YOCTO.to_string(),
        "bounty_forgiveness_period": PROPOSAL_PERIOD_NS.to_string()
    })
}

pub fn role_config() -> Value {
    let token = vec![0x83u8; 20];
    let roles_modifier = vec![0x44u8; 20];
    let role_key = vec![0x55u8; 32];
    let recipient = vec![0x66u8; 20];
    json!({
        "enabled": true,
        "token": token,
        "roles_modifier": roles_modifier,
        "role_key": role_key,
        "allowed_recipients": [recipient],
        "max_per_tx": ROLE_MAX_PER_TX.to_string(),
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

pub fn set_role_kind(vault: &Contract, role: &str) -> Value {
    let args = serde_json::to_vec(&json!({
        "role": role,
        "config": role_config()
    }))
    .expect("set_role arguments serialize");

    json!({
        "FunctionCall": {
            "receiver_id": vault.id(),
            "actions": [{
                "method_name": "set_role",
                "args": STANDARD.encode(args),
                "deposit": "0",
                "gas": Gas::from_tgas(30).as_gas().to_string()
            }]
        }
    })
}

pub fn transfer_kind(ft: &Contract, vault: &Contract, role: &str, create: bool) -> Value {
    let msg = if create {
        json!({"role": role, "config": role_config()}).to_string()
    } else {
        json!({"role": role}).to_string()
    };

    json!({
        "Transfer": {
            "token_id": ft.id().to_string(),
            "receiver_id": vault.id(),
            "amount": ROLE_BUDGET.to_string(),
            "msg": msg
        }
    })
}

pub async fn add_proposal(fixture: &Fixture, proposer: &Account, kind: Value) -> Result<u64> {
    Ok(proposer
        .call(fixture.dao.id(), "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": "MandateOS DAO spike",
                "kind": kind
            }
        }))
        .deposit(NearToken::from_yoctonear(PROPOSAL_BOND_YOCTO))
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
        .args_json(json!({
            "id": proposal_id,
            "action": "VoteApprove",
            "proposal": kind,
            "memo": null
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

pub async fn approve_with_two(
    fixture: &Fixture,
    proposal_id: u64,
    kind: Value,
) -> Result<ExecutionFinalResult> {
    vote(fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;
    let second = vote(fixture, &fixture.council[1], proposal_id, kind).await?;
    second.clone().into_result()?;
    Ok(second)
}

pub async fn get_role(fixture: &Fixture, role: &str) -> Result<Option<Value>> {
    Ok(fixture
        .vault
        .view("get_role")
        .args_json(json!({"role": role}))
        .await?
        .json()?)
}

pub async fn proposal_status(fixture: &Fixture, id: u64) -> Result<String> {
    let proposal: Value = fixture
        .dao
        .view("get_proposal")
        .args_json(json!({"id": id}))
        .await?
        .json()?;
    Ok(proposal["status"]
        .as_str()
        .with_context(|| format!("proposal status missing in {proposal}"))?
        .to_string())
}

pub fn assert_failure_contains(outcome: &ExecutionFinalResult, expected: &str) {
    assert!(outcome.is_failure(), "transaction unexpectedly succeeded");
    let failures = format!("{:#?}", outcome.failures());
    assert!(
        failures.contains(expected),
        "expected failure containing {expected:?}, got {failures}"
    );
}
