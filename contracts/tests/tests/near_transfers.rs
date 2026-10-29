//! NEP-141 transfers from the vault: an agent refills a listed card account
//! within a voted budget; a failed `ft_transfer` gives the budget back; an
//! existing Nomos vault gains the feature by a DAO-voted upgrade.

mod vault_common;

use anyhow::{Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};
use serial_test::serial;
use sha2::{Digest, Sha256};
use vault_common::{
    NEAR_BUDGET, NEAR_VAULT_FUNDS, ROLE, allowance, deploy_test_ft, execute_near, ft_balance,
    near_operation_by_reference, near_request, near_setup, setup,
};

const NOMOS_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/nomos.wasm"));
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
/// The vault version Nomos serves today (Solana + upgrade gas guard).
const PUBLISHED_VAULT_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/vault_published_2bfxk3gC.wasm"
));
const PUBLISHED_VAULT_HASH: &str = "2bfxk3gC6ChH6ccRgaBtx7K8L2uDtWbezRYB59bGfQmH";
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";
const RULE_DELAY_NS: u64 = 1_000_000_000;
const FIVE_USDC: u128 = 5_000_000;

#[tokio::test]
#[serial]
async fn agent_refills_a_listed_card_within_the_budget() -> Result<()> {
    let fixture = setup().await?;
    let near = near_setup(&fixture).await?;

    let outcome = execute_near(
        &fixture,
        &fixture.agent,
        near_request(&near.token, &near.card, FIVE_USDC, "CARD-1"),
    )
    .await?;
    let logs = outcome.logs().join("\n");
    outcome.into_result()?;
    assert!(logs.contains("OMNIROLES_NEAR_OPERATION:"), "{logs}");

    assert_eq!(ft_balance(&near.token, near.card.id()).await?, FIVE_USDC);
    assert_eq!(
        ft_balance(&near.token, fixture.vault.id()).await?,
        NEAR_VAULT_FUNDS - FIVE_USDC
    );
    let operation = near_operation_by_reference(&fixture, "CARD-1").await?;
    assert_eq!(operation["state"], "Confirmed");
    assert_eq!(operation["member"], fixture.agent.id().to_string());

    let budget = allowance(&fixture, vault_common::NEAR_ALLOWANCE_KEY).await?;
    assert_eq!(budget["balance"], (NEAR_BUDGET - FIVE_USDC).to_string());
    assert_eq!(budget["reserved"], "0");
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_ft_transfer_releases_the_budget() -> Result<()> {
    let fixture = setup().await?;
    let near = near_setup(&fixture).await?;

    // Listed, but never registered on the token: ft_transfer panics.
    execute_near(
        &fixture,
        &fixture.agent,
        near_request(&near.token, &near.unregistered, FIVE_USDC, "UNREGISTERED-1"),
    )
    .await?
    .into_result()?;

    let operation = near_operation_by_reference(&fixture, "UNREGISTERED-1").await?;
    assert_eq!(operation["state"], "Failed");
    assert_eq!(
        ft_balance(&near.token, fixture.vault.id()).await?,
        NEAR_VAULT_FUNDS
    );
    let budget = allowance(&fixture, vault_common::NEAR_ALLOWANCE_KEY).await?;
    assert_eq!(budget["balance"], NEAR_BUDGET.to_string());
    assert_eq!(budget["reserved"], "0");

    // The whole budget is still usable, and the role is not stuck "in use".
    execute_near(
        &fixture,
        &fixture.agent,
        near_request(&near.token, &near.card, FIVE_USDC, "CARD-AFTER-FAILURE"),
    )
    .await?
    .into_result()?;
    assert_eq!(ft_balance(&near.token, near.card.id()).await?, FIVE_USDC);
    Ok(())
}

/// A vault created by Nomos on the published version upgrades by vote; its
/// state survives and NEAR transfers then work.
#[tokio::test]
#[serial]
async fn published_vault_upgrades_by_vote_then_transfers_near_tokens() -> Result<()> {
    assert_eq!(
        bs58::encode(Sha256::digest(PUBLISHED_VAULT_WASM)).into_string(),
        PUBLISHED_VAULT_HASH
    );
    let worker = near_workspaces::sandbox().await?;
    let euthyna = worker.dev_create_account().await?;
    let dao = worker.dev_create_account().await?;
    let council = worker.dev_create_account().await?;
    let founder = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let card = worker.dev_create_account().await?;
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
    for wasm in [PUBLISHED_VAULT_WASM, VAULT_WASM] {
        euthyna
            .call(nomos.id(), "publish_version")
            .args(wasm.to_vec())
            .gas(Gas::from_tgas(300))
            .transact()
            .await?
            .into_result()?;
    }
    let new_hash = bs58::encode(Sha256::digest(VAULT_WASM)).into_string();

    let deposit: String = nomos
        .view("vault_deposit")
        .args_json(json!({"code_hash": PUBLISHED_VAULT_HASH}))
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
            "code_hash": PUBLISHED_VAULT_HASH
        }))
        .deposit(NearToken::from_yoctonear(deposit.parse()?))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let vault_id: near_workspaces::AccountId = format!("acme.{}", nomos.id()).parse()?;
    let near_workspaces::ContractState::LocalHash(code_hash) =
        worker.view_account(&vault_id).await?.contract_state
    else {
        bail!("vault has no local code");
    };
    assert_eq!(code_hash.to_string(), PUBLISHED_VAULT_HASH);

    // State written by the old version: a role, a member and a budget.
    let token = deploy_test_ft(&worker).await?;
    let budget_key = [0x4e; 32];
    let role = json!({
        "enabled": true,
        "permissions": [],
        "operation_delay_threshold": null,
        "operation_delay_ns": 0,
        "co_sign_threshold": null,
        "co_signer_role": null,
        "velocity": null,
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    });
    let vote = |change: Value| {
        let worker = &worker;
        let dao = &dao;
        let founder = &founder;
        let vault_id = &vault_id;
        async move {
            let queue_id: Value = worker
                .view(vault_id, "preview_rule_queue_id")
                .args_json(json!({"change": change}))
                .await?
                .json()?;
            dao.call(vault_id, "queue_rule_change")
                .args_json(json!({"change": change}))
                .gas(Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()?;
            let now = worker.view_block().await?.timestamp();
            tests::wait_until_timestamp(worker, now + RULE_DELAY_NS + 1).await?;
            let executed = founder
                .call(vault_id, "execute_rule_change")
                .args_json(json!({"queue_id": queue_id}))
                .gas(Gas::from_tgas(300))
                .transact()
                .await?;
            let logs = executed.logs().join("\n");
            executed.into_result()?;
            anyhow::Ok(logs)
        }
    };
    vote(json!({"SetRole": {"role": ROLE, "config": role}})).await?;
    vote(json!({"GrantMembership": {
        "role": ROLE, "member": agent.id(), "kind": "Agent",
        "starts_at_ns": "0", "ends_at_ns": null, "max_uses": null
    }}))
    .await?;
    vote(json!({"SetAllowance": {
        "key": budget_key, "balance": NEAR_BUDGET.to_string(), "refill": "1",
        "max_refill": NEAR_BUDGET.to_string(), "period_ns": 86_400_000_000_000u64
    }}))
    .await?;

    // The old version does not know NEAR permissions.
    let near_permissions = json!({"SetNearPermissions": {
        "role": ROLE,
        "permissions": [{
            "token": token.id(), "receivers": [card.id()],
            "allowance": budget_key, "max_per_transfer": FIVE_USDC.to_string()
        }]
    }});
    let refused = dao
        .call(&vault_id, "queue_rule_change")
        .args_json(json!({"change": near_permissions}))
        .transact()
        .await?;
    assert!(
        refused.into_result().is_err(),
        "old version accepted a NEAR rule"
    );

    // The new code is ~60 KB larger (~0.6 NEAR of storage) and Nomos funds
    // vaults tightly: anyone tops the vault up before the upgrade vote.
    founder
        .transfer_near(&vault_id, NearToken::from_near(1))
        .await?
        .into_result()?;
    let logs = vote(json!({"Upgrade": {"code_hash": new_hash}})).await?;
    assert!(logs.contains("OMNIROLES_UPGRADED"), "{logs}");
    let near_workspaces::ContractState::LocalHash(code_hash) =
        worker.view_account(&vault_id).await?.contract_state
    else {
        bail!("vault has no local code");
    };
    assert_eq!(code_hash.to_string(), new_hash);

    // Old state intact after the redeploy.
    let membership: Option<Value> = worker
        .view(&vault_id, "get_membership")
        .args_json(json!({"role": ROLE, "member": agent.id()}))
        .await?
        .json()?;
    assert_eq!(membership.expect("membership kept")["active"], true);
    let kept: Option<Value> = worker
        .view(&vault_id, "get_allowance")
        .args_json(json!({"key": budget_key}))
        .await?
        .json()?;
    assert_eq!(
        kept.expect("budget kept")["balance"],
        NEAR_BUDGET.to_string()
    );
    assert!(worker.view_access_keys(&vault_id).await?.is_empty());

    // The upgraded vault registers on the token, then pays the card.
    vote(json!({"NearStorageDeposit": {"token": token.id()}})).await?;
    vote(near_permissions).await?;
    card.call(token.id(), "storage_deposit")
        .args_json(json!({"account_id": null, "registration_only": true}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    token
        .call("mint")
        .args_json(json!({"account_id": vault_id, "amount": NEAR_VAULT_FUNDS.to_string()}))
        .transact()
        .await?
        .into_result()?;
    agent
        .call(&vault_id, "execute_near")
        .args_json(json!({"role": ROLE, "request": {
            "token": token.id(), "receiver_id": card.id(),
            "amount": FIVE_USDC.to_string(), "memo": null, "reference": "UPGRADED-1"
        }}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ft_balance(&token, card.id()).await?, FIVE_USDC);
    Ok(())
}
