//! Nomos factory: keyless vaults from published versions, upgrades only by the
//! company DAO, after the vault's rule delay, to code matching the voted hash.
use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};
use serial_test::serial;
use sha2::{Digest, Sha256};

const NOMOS_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/nomos.wasm"));
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";
const RULE_DELAY_NS: u64 = 1_000_000_000;

#[tokio::test]
#[serial]
async fn nomos_creates_keyless_vaults_and_only_the_dao_upgrades_them() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let euthyna = worker.dev_create_account().await?;
    let dao = worker.dev_create_account().await?;
    let council = worker.dev_create_account().await?;
    let founder = worker.dev_create_account().await?;
    let nomos = worker.dev_deploy(NOMOS_WASM).await?;
    let mpc = worker.dev_deploy(MOCK_MPC_WASM).await?;
    mpc.call("new")
        .args_json(json!({"public_key": MPC_PUBLIC_KEY}))
        .transact()
        .await?
        .into_result()?;
    nomos
        .call("new")
        .args_json(json!({"owner_id": euthyna.id()}))
        .transact()
        .await?
        .into_result()?;

    // Only the owner publishes; the WASM is the raw input.
    let refused = founder
        .call(nomos.id(), "publish_version")
        .args(VAULT_WASM.to_vec())
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().unwrap_err()).contains("ERR_OWNER_ONLY"));
    euthyna
        .call(nomos.id(), "publish_version")
        .args(VAULT_WASM.to_vec())
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let version: Value = nomos.view("latest_version").await?.json()?;
    let hash = bs58::encode(Sha256::digest(VAULT_WASM)).into_string();
    assert_eq!(version["code_hash"], hash);

    let deposit: String = nomos
        .view("vault_deposit")
        .args_json(json!({"code_hash": null}))
        .await?
        .json()?;
    let init = json!({
        "client_id": "acme",
        "owner_id": dao.id(),
        "mpc_contract_id": mpc.id(),
        "visa_public_key": STANDARD.encode([7u8; 32]),
        "status_public_key": STANDARD.encode([8u8; 32]),
        "policy_version": 1,
        "registry_version": 1,
        "operation_ttl_ns": 120_000_000_000u64,
        "rule_delay_ns": RULE_DELAY_NS,
        "rule_expiration_ns": 60_000_000_000u64,
        "council": [council.id()],
        "settlement_config": null
    });
    founder
        .call(nomos.id(), "create_vault")
        .args_json(json!({
            "name": "acme",
            "args": STANDARD.encode(serde_json::to_vec(&init)?),
            "code_hash": null
        }))
        .deposit(NearToken::from_yoctonear(deposit.parse()?))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;

    let vault_id: near_workspaces::AccountId = format!("acme.{}", nomos.id()).parse()?;
    let details = worker.view_account(&vault_id).await?;
    let near_workspaces::ContractState::LocalHash(code_hash) = details.contract_state else {
        anyhow::bail!("vault has no local code");
    };
    assert_eq!(code_hash.to_string(), hash, "vault runs the published code");
    assert!(
        worker.view_access_keys(&vault_id).await?.is_empty(),
        "no key on the vault"
    );
    let owner: String = worker.view(&vault_id, "owner_id").await?.json()?;
    assert_eq!(owner, dao.id().to_string());
    let source: String = worker.view(&vault_id, "code_source").await?.json()?;
    assert_eq!(source, nomos.id().to_string());

    // Same name twice: refused, the founder gets the deposit back.
    let before = founder.view_account().await?.balance;
    let duplicate = founder
        .call(nomos.id(), "create_vault")
        .args_json(json!({
            "name": "acme",
            "args": STANDARD.encode(serde_json::to_vec(&init)?),
            "code_hash": null
        }))
        .deposit(NearToken::from_yoctonear(deposit.parse()?))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(
        duplicate
            .logs()
            .iter()
            .any(|log| log.contains("NOMOS_VAULT_CREATE_FAILED")),
        "duplicate refused"
    );
    let after = founder.view_account().await?.balance;
    assert!(before.as_near() - after.as_near() < 1, "deposit refunded");

    // Neither the factory owner nor anyone but the DAO can queue an upgrade.
    let change = json!({"Upgrade": {"code_hash": hash}});
    for outsider in [&euthyna, &founder] {
        let queued = outsider
            .call(&vault_id, "queue_rule_change")
            .args_json(json!({"change": change}))
            .transact()
            .await?;
        assert!(format!("{:?}", queued.into_result().unwrap_err()).contains("ERR_OWNER_ONLY"));
    }

    // The DAO sets a role, then upgrades: state survives the redeploy.
    let role = json!({"SetVersions": {"policy_version": 2, "registry_version": 3}});
    for change in [role, change] {
        let queue_id: Value = worker
            .view(&vault_id, "preview_rule_queue_id")
            .args_json(json!({"change": change}))
            .await?
            .json()?;
        dao.call(&vault_id, "queue_rule_change")
            .args_json(json!({"change": change}))
            .transact()
            .await?
            .into_result()?;
        let now = worker.view_block().await?.timestamp();
        tests::wait_until_timestamp(&worker, now + RULE_DELAY_NS + 1).await?;
        let executed = founder
            .call(&vault_id, "execute_rule_change")
            .args_json(json!({"queue_id": queue_id}))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        let logs = executed.logs().join("\n");
        executed.into_result()?;
        if change.get("Upgrade").is_some() {
            assert!(logs.contains("OMNIROLES_UPGRADED"), "{logs}");
        }
    }
    let policy: u64 = worker.view(&vault_id, "policy_version").await?.json()?;
    assert_eq!(policy, 2, "state kept across the upgrade");
    assert!(worker.view_access_keys(&vault_id).await?.is_empty());
    Ok(())
}
