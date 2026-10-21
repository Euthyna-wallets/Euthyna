use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker, network::Testnet};
use serde::Serialize;
use serde_json::{Value, json};

const FACTORY: &str = "sputnikv2.testnet";
const MPC: &str = "v1.signer-prod.testnet";
const BOND: u128 = 100_000_000_000_000_000_000_000;
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const FT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_ft.wasm"));

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

#[tokio::main]
async fn main() -> Result<()> {
    let worker = near_workspaces::testnet()
        .rpc_addr("https://test.rpc.fastnear.com")
        .await?;
    let guard = SigningKey::from_bytes(&[9u8; 32]);
    let (council, agent, dao_id, vault, ft) =
        if let Ok(resume_dao_id) = std::env::var("NEAR_RESUME_DAO_ID") {
            let key = SecretKey::from_seed(KeyType::ED25519, "subaccount.seed");
            let account = |id: &str| -> Result<Account> {
                Ok(Account::from_secret_key(id.parse()?, key.clone(), &worker))
            };
            let council = vec![
                account("council-1-v4.mandateos-root-20261021.testnet")?,
                account("council-2-v4.mandateos-root-20261021.testnet")?,
                account("council-3-v4.mandateos-root-20261021.testnet")?,
            ];
            let agent = account("agent-v4.mandateos-root-20261021.testnet")?;
            let vault = Contract::from_secret_key(
                "vault-v4.mandateos-root-20261021.testnet".parse()?,
                key.clone(),
                &worker,
            );
            let ft = Contract::from_secret_key(
                "test-ft-v4.mandateos-root-20261021.testnet".parse()?,
                key,
                &worker,
            );
            (council, agent, resume_dao_id.parse()?, vault, ft)
        } else {
            let root = match (
                std::env::var("NEAR_TESTNET_ROOT_ACCOUNT"),
                std::env::var("NEAR_TESTNET_ROOT_PRIVATE_KEY"),
            ) {
                (Ok(account_id), Ok(private_key)) => Account::from_secret_key(
                    account_id.parse()?,
                    private_key.parse::<SecretKey>()?,
                    &worker,
                ),
                _ => worker.dev_create_account().await?,
            };
            let council = vec![
                root.create_subaccount("council-1-v5")
                    .initial_balance(NearToken::from_near(8))
                    .transact()
                    .await?
                    .into_result()?,
                root.create_subaccount("council-2-v5")
                    .initial_balance(NearToken::from_near(1))
                    .transact()
                    .await?
                    .into_result()?,
                root.create_subaccount("council-3-v5")
                    .initial_balance(NearToken::from_near(1))
                    .transact()
                    .await?
                    .into_result()?,
            ];
            let agent = root
                .create_subaccount("agent-v5")
                .initial_balance(NearToken::from_near(1))
                .transact()
                .await?
                .into_result()?;
            let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() % 100_000_000;
            let dao_name = format!("mandateos-uat-{suffix}");
            let factory: AccountId = FACTORY.parse()?;
            let dao_id: AccountId = format!("{dao_name}.{FACTORY}").parse()?;
            let dao_init = json!({
                "config": {
                    "name": "MandateOS UAT DAO",
                    "purpose": "Govern the MandateOS UAT Vault",
                    "metadata": ""
                },
                "policy": council_policy(&council)
            });
            council[0]
                .call(&factory, "create")
                .args_json(json!({
                    "name": dao_name,
                    "args": STANDARD.encode(serde_json::to_vec(&dao_init)?)
                }))
                .deposit(NearToken::from_near(7))
                .gas(Gas::from_tgas(150))
                .transact()
                .await?
                .into_result()?;
            worker.view_account(&dao_id).await?;
            let vault_account = root
                .create_subaccount("vault-v5")
                .initial_balance(NearToken::from_near(5))
                .transact()
                .await?
                .into_result()?;
            let vault = vault_account.deploy(VAULT_WASM).await?.into_result()?;
            let ft_account = root
                .create_subaccount("test-ft-v5")
                .initial_balance(NearToken::from_near(2))
                .transact()
                .await?
                .into_result()?;
            let ft = ft_account.deploy(FT_WASM).await?.into_result()?;
            ft.call("new").transact().await?.into_result()?;
            vault
                .call("new")
                .args_json(json!({
                    "client_id": "acme",
                    "owner_id": dao_id,
                    "token_id": ft.id(),
                    "mpc_contract_id": MPC,
                    "evm_chain_id": 84532,
                    "guard_public_key": STANDARD.encode(guard.verifying_key().to_bytes()),
                    "policy_version": 7,
                    "registry_version": 11,
                    "reservation_ttl_blocks": 50
                }))
                .gas(Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()?;
            let vault_key = vault.as_account().secret_key().public_key();
            vault
                .as_account()
                .batch(vault.id())
                .delete_key(vault_key)
                .transact()
                .await?
                .into_result()?;
            (council, agent, dao_id, vault, ft)
        };

    let set_role = function_call_kind(
        &vault,
        "set_role",
        json!({"role": "researcher", "config": role_config()}),
    )?;
    execute_proposal(&worker, &council, &dao_id, set_role).await?;
    let register_agent = function_call_kind(
        &vault,
        "register_agent",
        json!({
            "agent": agent.id(),
            "role": "researcher",
            "mpc_path": "agents/researcher/base"
        }),
    )?;
    execute_proposal(&worker, &council, &dao_id, register_agent).await?;
    let factory_update = json!({
        "FactoryInfoUpdate": {
            "factory_info": {"factory_id": FACTORY, "auto_update": false}
        }
    });
    execute_proposal(&worker, &council, &dao_id, factory_update).await?;

    agent
        .call(vault.id(), "request_derived_public_key")
        .args_json(json!({"agent": agent.id()}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;

    if std::env::var("NEAR_RESUME_DAO_ID").is_err() {
        ft.call("mint")
            .args_json(json!({"account_id": dao_id, "amount": "5000000"}))
            .transact()
            .await?
            .into_result()?;
    }
    let vault_storage: Option<Value> = ft
        .view("storage_balance_of")
        .args_json(json!({"account_id": vault.id()}))
        .await?
        .json()?;
    if vault_storage.is_none() {
        ft.call("storage_deposit")
            .args_json(json!({"account_id": vault.id(), "registration_only": true}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
    }
    let fund_role = json!({
        "Transfer": {
            "token_id": ft.id(),
            "receiver_id": vault.id(),
            "amount": "5000000",
            "msg": json!({"role": "researcher"}).to_string()
        }
    });
    execute_proposal(&worker, &council, &dao_id, fund_role).await?;

    let operation: Value = agent
        .call(vault.id(), "prepare")
        .args_json(json!({"intent": intent("UAT-MPC-001")}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let approval = approval(&guard, &agent, &operation)?;
    let sign_outcome = agent
        .call(vault.id(), "authorize")
        .args_json(json!({"op_id": operation["op_id"], "approval": approval}))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    let sign_gas = sign_outcome.total_gas_burnt.as_gas();
    sign_outcome.into_result()?;
    let signed: Option<Value> = vault
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json()?;
    let signed = signed.context("signed operation missing")?;
    let agent_state: Option<Value> = vault
        .view("get_agent")
        .args_json(json!({"agent": agent.id()}))
        .await?
        .json()?;

    println!(
        "MANDATEOS_TESTNET_DEPLOYMENT={}",
        serde_json::to_string(&json!({
            "dao": dao_id,
            "vault": vault.id(),
            "test_ft": ft.id(),
            "agent": agent.id(),
            "mpc": MPC,
            "vault_access_keys": vault.view_access_keys().await?.len(),
            "factory_info": worker.view(&dao_id, "get_factory_info").await?.json::<Value>()?,
            "agent_state": agent_state,
            "operation_state": signed["state"],
            "mpc_sign_total_gas": sign_gas,
            "mpc_sign_total_tgas": sign_gas as f64 / 1_000_000_000_000_f64
        }))?
    );
    Ok(())
}

fn council_policy(council: &[Account]) -> Value {
    json!({
        "roles": [{
            "name": "council",
            "kind": {"Group": council.iter().map(|m| m.id().to_string()).collect::<Vec<_>>()},
            "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
            "vote_policy": {}
        }],
        "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "2"},
        "proposal_bond": BOND.to_string(),
        "proposal_period": "86400000000000",
        "bounty_bond": BOND.to_string(),
        "bounty_forgiveness_period": "86400000000000"
    })
}

fn role_config() -> Value {
    json!({
        "enabled": true,
        "token": evm_address("418A2b47911dE05e21688F7490195F5324B49474"),
        "roles_modifier": evm_address("7178555779097cAE1BA20C5D7ED7205708a5ed40"),
        "role_key": role_key(),
        "allowed_recipients": [evm_address("a7BE833AD5422421204198E47C04516B0026F9B6")],
        "max_per_tx": "5000000",
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

fn intent(reference: &str) -> Value {
    json!({
        "token": evm_address("418A2b47911dE05e21688F7490195F5324B49474"),
        "recipient": evm_address("a7BE833AD5422421204198E47C04516B0026F9B6"),
        "amount": "1000000",
        "reference": reference,
        "gas_limit": "200000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    })
}

fn evm_address(value: &str) -> Vec<u8> {
    hex::decode(value).expect("valid EVM address")
}

fn role_key() -> Vec<u8> {
    let mut key = vec![0u8; 32];
    key[..10].copy_from_slice(b"researcher");
    key
}

fn function_call_kind(vault: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(json!({
        "FunctionCall": {
            "receiver_id": vault.id(),
            "actions": [{
                "method_name": method,
                "args": STANDARD.encode(serde_json::to_vec(&args)?),
                "deposit": "0",
                "gas": "50000000000000"
            }]
        }
    }))
}

async fn execute_proposal(
    worker: &Worker<Testnet>,
    council: &[Account],
    dao_id: &AccountId,
    kind: Value,
) -> Result<()> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({"proposal": {"description": "MandateOS UAT", "kind": kind}}))
        .deposit(NearToken::from_yoctonear(BOND))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    for member in &council[..2] {
        member
            .call(dao_id, "act_proposal")
            .args_json(json!({
                "id": proposal_id,
                "action": "VoteApprove",
                "proposal": kind,
                "memo": null
            }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?
            .into_result()?;
    }
    worker
        .view(dao_id, "get_proposal")
        .args_json(json!({"id": proposal_id}))
        .await?;
    Ok(())
}

fn approval(guard: &SigningKey, agent: &Account, operation: &Value) -> Result<Value> {
    let visa = VisaForSigning {
        client_id: "acme".to_string(),
        op_id: array32(&operation["op_id"]),
        tx_digest: array32(&operation["tx_digest"]),
        agent: agent.id().to_string(),
        role: "researcher".to_string(),
        reference: operation["intent"]["reference"]
            .as_str()
            .context("reference")?
            .to_string(),
        policy_version: 7,
        registry_version: 11,
        visa_nonce: 1,
        expires_at_block: operation["expires_at_block"].as_u64().context("expiry")?,
    };
    let mut message = b"mandateos:visa:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&visa)?);
    let signature = guard.sign(&message).to_bytes();
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
    Ok(json!({"visa": json_visa, "signature": STANDARD.encode(signature)}))
}

fn array32(value: &Value) -> [u8; 32] {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>()
        .try_into()
        .expect("32 bytes")
}
