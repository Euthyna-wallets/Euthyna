//! Company registry: a company lists itself through its DAO, and the registry
//! checks on chain that the vault and the shares contract belong to that DAO.

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use serial_test::serial;

const REGISTRY_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/registry.wasm"));
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const SHARES_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/shares.wasm"));
const DEPOSIT: NearToken = NearToken::from_millinear(20);

async fn vault_of(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    owner: &Account,
) -> Result<Contract> {
    let vault = worker.dev_deploy(VAULT_WASM).await?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": "test", "owner_id": owner.id(), "mpc_contract_id": "mpc.test.near",
            "visa_public_key": STANDARD.encode([0u8; 32]), "status_public_key": STANDARD.encode([1u8; 32]),
            "policy_version": 1, "registry_version": 1, "operation_ttl_ns": 120_000_000_000u64,
            "rule_delay_ns": 1_000_000_000u64, "rule_expiration_ns": 60_000_000_000u64, "council": [owner.id()]
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(vault)
}

async fn shares_of(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    dao: &Account,
) -> Result<Contract> {
    let shares = worker.dev_deploy(SHARES_WASM).await?;
    shares
        .call("new")
        .args_json(json!({
            "dao_id": dao.id(), "name": "Shares", "symbol": "SHR", "total_supply": "1000",
            "price_per_share": "1000", "unlock_period_ns": "60000000000", "epoch_ns": "60000000000",
            "revenue_token": null, "allocations": []
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(shares)
}

async fn register(
    registry: &Contract,
    dao: &Account,
    vault: &Contract,
    shares: Option<&Contract>,
    name: &str,
    deposit: NearToken,
) -> Result<ExecutionFinalResult> {
    Ok(dao
        .call(registry.id(), "register")
        .args_json(json!({"vault_id": vault.id(), "shares_id": shares.map(|s| s.id()), "name": name, "description": "AI company"}))
        .deposit(deposit)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

fn callback_result(outcome: &ExecutionFinalResult) -> bool {
    outcome
        .clone()
        .into_result()
        .ok()
        .and_then(|r| r.json::<bool>().ok())
        .unwrap_or(false)
}

#[tokio::test]
#[serial]
async fn companies_list_themselves_and_only_themselves() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let factory = root
        .create_subaccount("factory")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let acme = factory
        .create_subaccount("acme")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let atlas = factory
        .create_subaccount("atlas")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let outsider = worker.dev_create_account().await?;
    let registry = worker.dev_deploy(REGISTRY_WASM).await?;
    registry
        .call("new")
        .args_json(json!({"factory_id": factory.id(), "vault_factory_id": null}))
        .transact()
        .await?
        .into_result()?;

    let acme_vault = vault_of(&worker, &acme).await?;
    let acme_shares = shares_of(&worker, &acme).await?;
    let atlas_vault = vault_of(&worker, &atlas).await?;
    let outsider_vault = vault_of(&worker, &outsider).await?;

    // A company lists itself with its vault and shares; the spare deposit comes back.
    let before = acme.view_account().await?.balance;
    let outcome = register(
        &registry,
        &acme,
        &acme_vault,
        Some(&acme_shares),
        "Acme AI",
        DEPOSIT,
    )
    .await?;
    assert!(callback_result(&outcome), "{outcome:?}");
    let spent = before.as_yoctonear() - acme.view_account().await?.balance.as_yoctonear();
    assert!(
        spent < DEPOSIT.as_yoctonear(),
        "the unused deposit is refunded"
    );
    let company: Value = registry
        .view("get_company")
        .args_json(json!({"dao_id": acme.id()}))
        .await?
        .json()?;
    assert_eq!(company["vault_id"], acme_vault.id().as_str());
    assert_eq!(company["shares_id"], acme_shares.id().as_str());
    assert_eq!(company["name"], "Acme AI");

    // An account not created by the factory cannot list anything.
    let outcome = register(&registry, &outsider, &outsider_vault, None, "Fake", DEPOSIT).await?;
    assert!(
        format!("{:?}", outcome.into_result().unwrap_err()).contains("ERR_NOT_A_MANDATEOS_DAO")
    );
    println!(
        "BLOCKED | account outside the factory lists a company | factory check | ERR_NOT_A_MANDATEOS_DAO"
    );

    // A real company cannot claim another company's vault or shares.
    let outcome = register(&registry, &atlas, &acme_vault, None, "Atlas", DEPOSIT).await?;
    assert!(!callback_result(&outcome));
    assert!(
        outcome
            .logs()
            .iter()
            .any(|log| log.contains("ERR_VAULT_NOT_OWNED_BY_DAO"))
    );
    let outcome = register(
        &registry,
        &atlas,
        &atlas_vault,
        Some(&acme_shares),
        "Atlas",
        DEPOSIT,
    )
    .await?;
    assert!(!callback_result(&outcome));
    assert!(
        outcome
            .logs()
            .iter()
            .any(|log| log.contains("ERR_SHARES_NOT_OF_DAO"))
    );
    let listed: Option<Value> = registry
        .view("get_company")
        .args_json(json!({"dao_id": atlas.id()}))
        .await?
        .json()?;
    assert!(listed.is_none());
    println!(
        "BLOCKED | company claims another company's vault or shares | vault owner check | ERR_VAULT_NOT_OWNED_BY_DAO"
    );

    // Too small a deposit: nothing listed, everything refunded.
    let outcome = register(
        &registry,
        &atlas,
        &atlas_vault,
        None,
        "Atlas Labs",
        NearToken::from_yoctonear(1),
    )
    .await?;
    assert!(!callback_result(&outcome));
    assert!(
        outcome
            .logs()
            .iter()
            .any(|log| log.contains("ERR_STORAGE_DEPOSIT"))
    );

    // Atlas lists itself properly, then updates its name.
    assert!(callback_result(
        &register(&registry, &atlas, &atlas_vault, None, "Atlas", DEPOSIT).await?
    ));
    assert!(callback_result(
        &register(&registry, &atlas, &atlas_vault, None, "Atlas Labs", DEPOSIT).await?
    ));
    let list: Vec<Value> = registry
        .view("list_companies")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|c| c["name"] == "Atlas Labs"));

    // A company leaves the directory.
    atlas
        .call(registry.id(), "unregister")
        .transact()
        .await?
        .into_result()?;
    let count: u32 = registry.view("company_count").await?.json()?;
    assert_eq!(count, 1);
    let outcome = outsider
        .call(registry.id(), "unregister")
        .transact()
        .await?;
    assert!(outcome.into_result().is_err());
    Ok(())
}

#[tokio::test]
#[serial]
async fn with_a_vault_factory_only_its_vaults_are_listed() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let factory = root
        .create_subaccount("sputnik")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let nomos = root
        .create_subaccount("nomos")
        .initial_balance(NearToken::from_near(30))
        .transact()
        .await?
        .into_result()?;
    let acme = factory
        .create_subaccount("acme")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let registry = worker.dev_deploy(REGISTRY_WASM).await?;
    registry
        .call("new")
        .args_json(json!({"factory_id": factory.id(), "vault_factory_id": nomos.id()}))
        .transact()
        .await?
        .into_result()?;
    let vault_factory: Option<String> = registry.view("vault_factory_id").await?.json()?;
    assert_eq!(vault_factory.as_deref(), Some(nomos.id().as_str()));

    // A vault the DAO owns but that the vault factory did not create: refused.
    let outside_vault = vault_of(&worker, &acme).await?;
    let outcome = register(&registry, &acme, &outside_vault, None, "Acme", DEPOSIT).await?;
    assert!(
        format!("{:?}", outcome.into_result().unwrap_err()).contains("ERR_NOT_A_FACTORY_VAULT")
    );
    println!(
        "BLOCKED | company lists a vault outside the vault factory | vault factory check | ERR_NOT_A_FACTORY_VAULT"
    );

    // Its vault from the vault factory: listed.
    let account = nomos
        .create_subaccount("acme")
        .initial_balance(NearToken::from_near(12))
        .transact()
        .await?
        .into_result()?;
    let vault = account.deploy(VAULT_WASM).await?.into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "client_id": "test", "owner_id": acme.id(), "mpc_contract_id": "mpc.test.near",
            "visa_public_key": STANDARD.encode([0u8; 32]), "status_public_key": STANDARD.encode([1u8; 32]),
            "policy_version": 1, "registry_version": 1, "operation_ttl_ns": 120_000_000_000u64,
            "rule_delay_ns": 1_000_000_000u64, "rule_expiration_ns": 60_000_000_000u64, "council": [acme.id()]
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(callback_result(
        &register(&registry, &acme, &vault, None, "Acme", DEPOSIT).await?
    ));
    let count: u32 = registry.view("company_count").await?.json()?;
    assert_eq!(count, 1);
    Ok(())
}
