mod vault_common;

use std::time::Duration;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::Gas;
use serde_json::{Value, json};
use serial_test::serial;
use vault_common::{
    ALLOWANCE_BALANCE, ALLOWANCE_KEY, CHAIN_ID, MAX_PER_OPERATION, RECIPIENT, ROLE, TOKEN,
    apply_rule_change, approval, assert_failure_contains, authorize, erc20_transfer, get_operation,
    op_id, prepare, request, role_config, setup, status_report,
};

async fn visa_expiry(fixture: &vault_common::Fixture) -> Result<u64> {
    Ok(fixture
        .worker
        .view_block()
        .await?
        .timestamp()
        .saturating_add(30_000_000_000))
}

async fn confirm(
    fixture: &vault_common::Fixture,
    operation: &Value,
    report_nonce: u64,
) -> Result<Value> {
    let signed = get_operation(fixture, operation).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(status_report(fixture, &signed, report_nonce, true))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    get_operation(fixture, operation).await
}

#[tokio::test]
#[serial]
async fn derives_one_wallet_per_chain_and_builds_direct_evm_calls() -> Result<()> {
    let fixture = setup().await?;
    let wallet: Value = fixture
        .vault
        .view("get_wallet")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .await?
        .json::<Option<Value>>()?
        .expect("wallet");
    assert_eq!(wallet["mpc_path"], "omniroles/evm");
    assert!(wallet["address"].is_array());
    assert_eq!(wallet["next_nonce"], 0);

    let operation = prepare(&fixture, "DIRECT-1", 100).await?;
    assert_eq!(operation["transaction"]["to"], json!(TOKEN));
    assert_eq!(
        operation["transaction"]["input"],
        request("DIRECT-1", 100)["calldata"]
    );
    assert_eq!(operation["evm_nonce"], 0);

    let duplicate = fixture
        .owner
        .call(fixture.vault.id(), "request_wallet")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .transact()
        .await?;
    assert_failure_contains(&duplicate, "ERR_WALLET_ALREADY_DERIVED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn executes_arbitrary_contract_calls_without_an_evm_module() -> Result<()> {
    let fixture = setup().await?;
    let target = [0x77u8; 20];
    let mut config = role_config();
    config["permissions"] = json!([{
        "chain_id": CHAIN_ID,
        "target": target,
        "selector": null,
        "conditions": [],
        "allow_value": true
    }]);
    config["co_sign_threshold"] = Value::Null;
    config["co_signer_role"] = Value::Null;
    config["operation_delay_threshold"] = Value::Null;
    config["velocity"] = Value::Null;
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetRole": {"role": ROLE, "config": config}}),
    )
    .await?;
    let arbitrary = json!({
        "chain_id": CHAIN_ID,
        "target": target,
        "value": "1",
        "calldata": [0xde, 0xad, 0xbe, 0xef, 1, 2, 3],
        "allowance_amount": "0",
        "reference": "ARBITRARY-1",
        "gas_limit": "120000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    });
    let operation: Value = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": arbitrary}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(operation["transaction"]["to"], json!(target));
    assert_eq!(operation["transaction"]["value"], "1");
    assert_eq!(
        operation["transaction"]["input"],
        json!([0xde, 0xad, 0xbe, 0xef, 1, 2, 3])
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn shares_allowance_across_chain_wallets_without_sharing_nonce_queues() -> Result<()> {
    let fixture = setup().await?;
    const SECOND_CHAIN: u64 = 8_453;
    fixture
        .owner
        .call(fixture.vault.id(), "request_wallet")
        .args_json(json!({"chain_id": SECOND_CHAIN}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let mut config = role_config();
    let mut second_permission = config["permissions"][0].clone();
    second_permission["chain_id"] = json!(SECOND_CHAIN);
    config["permissions"]
        .as_array_mut()
        .expect("permissions")
        .push(second_permission);
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetRole": {"role": ROLE, "config": config}}),
    )
    .await?;

    let first = prepare(&fixture, "CROSS-CHAIN-1", 100).await?;
    let mut second_request = request("CROSS-CHAIN-2", 100);
    second_request["chain_id"] = json!(SECOND_CHAIN);
    let second: Value = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": second_request}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(first["evm_nonce"], 0);
    assert_eq!(second["evm_nonce"], 0);
    let allowance: Value = fixture
        .vault
        .view("get_allowance")
        .args_json(json!({"key": ALLOWANCE_KEY}))
        .await?
        .json::<Option<Value>>()?
        .expect("allowance");
    assert_eq!(allowance["reserved"], "200");
    Ok(())
}

#[tokio::test]
#[serial]
async fn enforces_time_and_usage_bounded_memberships_and_self_renouncement() -> Result<()> {
    let fixture = setup().await?;
    let now = fixture.worker.view_block().await?.timestamp();
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"GrantMembership": {
            "role": ROLE,
            "member": fixture.outsider.id(),
            "kind": "Agent",
            "starts_at_ns": now.saturating_add(30_000_000_000).to_string(),
            "ends_at_ns": now.saturating_add(60_000_000_000).to_string(),
            "max_uses": 1
        }}),
    )
    .await?;
    let before_start = fixture
        .outsider
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": request("EARLY", 100)}))
        .transact()
        .await?;
    assert_failure_contains(&before_start, "ERR_MEMBERSHIP_NOT_STARTED");

    fixture
        .cosigner
        .call(fixture.vault.id(), "renounce_role")
        .args_json(json!({"role": "approver"}))
        .transact()
        .await?
        .into_result()?;
    let operation = prepare(&fixture, "COSIGN-RENOUNCED", 400).await?;
    let cosign = fixture
        .cosigner
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": operation["op_id"]}))
        .transact()
        .await?;
    assert_failure_contains(&cosign, "ERR_MEMBERSHIP_REVOKED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn tracks_allowance_reservation_spend_and_refill() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "ALLOWANCE-1", 100).await?;
    let reserved: Value = fixture
        .vault
        .view("get_allowance")
        .args_json(json!({"key": ALLOWANCE_KEY}))
        .await?
        .json::<Option<Value>>()?
        .expect("allowance");
    assert_eq!(reserved["balance"], ALLOWANCE_BALANCE.to_string());
    assert_eq!(reserved["reserved"], "100");

    let approval = approval(&fixture, &operation, 1, visa_expiry(&fixture).await?, None);
    authorize(&fixture, &operation, approval)
        .await?
        .into_result()?;
    let confirmed = confirm(&fixture, &operation, 1).await?;
    assert_eq!(confirmed["state"], "Confirmed");
    let spent: Value = fixture
        .vault
        .view("get_allowance")
        .args_json(json!({"key": ALLOWANCE_KEY}))
        .await?
        .json::<Option<Value>>()?
        .expect("allowance");
    assert_eq!(spent["balance"], "900");
    assert_eq!(spent["reserved"], "0");

    tokio::time::sleep(Duration::from_secs(11)).await;
    fixture.worker.fast_forward(1).await?;
    let refilled: Value = fixture
        .vault
        .view("get_allowance")
        .args_json(json!({"key": ALLOWANCE_KEY}))
        .await?
        .json::<Option<Value>>()?
        .expect("allowance");
    assert_eq!(refilled["balance"], ALLOWANCE_BALANCE.to_string());
    Ok(())
}

#[tokio::test]
#[serial]
async fn queues_rule_changes_and_vetoes_only_the_selected_entry() -> Result<()> {
    let fixture = setup().await?;
    let first: Value = fixture
        .owner
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(
            json!({"change": {"SetVersions": {"policy_version": 8, "registry_version": 12}}}),
        )
        .transact()
        .await?
        .into_result()?
        .json()?;
    let second: Value = fixture
        .owner
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(
            json!({"change": {"SetVersions": {"policy_version": 9, "registry_version": 13}}}),
        )
        .transact()
        .await?
        .into_result()?
        .json()?;
    fixture
        .council
        .call(fixture.vault.id(), "veto_rule_change")
        .args_json(json!({"queue_id": first["queue_id"]}))
        .transact()
        .await?
        .into_result()?;
    fixture.worker.fast_forward(2).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": second["queue_id"]}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        fixture.vault.view("policy_version").await?.json::<u64>()?,
        9
    );
    let first_state: Value = fixture
        .vault
        .view("get_rule_change")
        .args_json(json!({"queue_id": first["queue_id"]}))
        .await?
        .json::<Option<Value>>()?
        .expect("rule");
    assert_eq!(first_state["state"], "Vetoed");
    Ok(())
}

#[tokio::test]
#[serial]
async fn requires_cosignature_and_delays_high_value_operations_before_mpc() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "HIGH-1", MAX_PER_OPERATION + 100).await?;
    let approval = approval(&fixture, &operation, 1, visa_expiry(&fixture).await?, None);
    let without_cosign = authorize(&fixture, &operation, approval.clone()).await?;
    assert_failure_contains(&without_cosign, "ERR_COSIGN_REQUIRED");
    fixture
        .cosigner
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": operation["op_id"]}))
        .transact()
        .await?
        .into_result()?;
    authorize(&fixture, &operation, approval)
        .await?
        .into_result()?;
    let queued = get_operation(&fixture, &operation).await?;
    assert_eq!(queued["state"], "Queued");
    assert!(queued["signed_transaction"].is_null());
    let early = fixture
        .outsider
        .call(fixture.vault.id(), "execute_queued_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&early, "ERR_OPERATION_DELAY");
    fixture.worker.fast_forward(15).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "execute_queued_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let signed = get_operation(&fixture, &operation).await?;
    assert_eq!(signed["state"], "PossiblySigned");
    assert!(signed["signed_transaction"].is_array());
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_operation_role_agents_and_nonhuman_approver_members_as_cosigners() -> Result<()> {
    let fixture = setup().await?;
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"GrantMembership": {
            "role": ROLE,
            "member": fixture.outsider.id(),
            "kind": "Agent",
            "starts_at_ns": "0",
            "ends_at_ns": null,
            "max_uses": null
        }}),
    )
    .await?;
    let first = prepare(&fixture, "COSIGN-AGENT-ROLE", MAX_PER_OPERATION + 100).await?;
    let same_role = fixture
        .outsider
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": first["op_id"]}))
        .transact()
        .await?;
    assert_failure_contains(&same_role, "ERR_COSIGNER_IN_OPERATION_ROLE");
    fixture
        .agent
        .call(fixture.vault.id(), "cancel_prepared")
        .args_json(json!({"op_id": first["op_id"]}))
        .transact()
        .await?
        .into_result()?;
    let nonhuman_approver = fixture.worker.dev_create_account().await?;

    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"GrantMembership": {
            "role": "approver",
            "member": nonhuman_approver.id(),
            "kind": "Agent",
            "starts_at_ns": "0",
            "ends_at_ns": null,
            "max_uses": null
        }}),
    )
    .await?;
    let second = prepare(&fixture, "COSIGN-NONHUMAN", MAX_PER_OPERATION + 100).await?;
    let nonhuman = nonhuman_approver
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": second["op_id"]}))
        .transact()
        .await?;
    assert_failure_contains(&nonhuman, "ERR_COSIGNER_NOT_HUMAN");
    fixture
        .agent
        .call(fixture.vault.id(), "cancel_prepared")
        .args_json(json!({"op_id": second["op_id"]}))
        .transact()
        .await?
        .into_result()?;

    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"GrantMembership": {
            "role": ROLE,
            "member": fixture.cosigner.id(),
            "kind": "Human",
            "starts_at_ns": "0",
            "ends_at_ns": null,
            "max_uses": null
        }}),
    )
    .await?;
    let third = prepare(&fixture, "COSIGN-DUAL-ROLE", MAX_PER_OPERATION + 100).await?;
    let dual_role = fixture
        .cosigner
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": third["op_id"]}))
        .transact()
        .await?;
    assert_failure_contains(&dual_role, "ERR_COSIGNER_IN_OPERATION_ROLE");
    Ok(())
}

#[tokio::test]
#[serial]
async fn council_veto_releases_one_delayed_operation_and_wallet_queue() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "VETO-1", MAX_PER_OPERATION + 100).await?;
    fixture
        .cosigner
        .call(fixture.vault.id(), "co_sign")
        .args_json(json!({"op_id": operation["op_id"]}))
        .transact()
        .await?
        .into_result()?;
    let approval = approval(&fixture, &operation, 1, visa_expiry(&fixture).await?, None);
    authorize(&fixture, &operation, approval)
        .await?
        .into_result()?;
    fixture
        .council
        .call(fixture.vault.id(), "veto_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        get_operation(&fixture, &operation).await?["state"],
        "Vetoed"
    );
    let replacement = prepare(&fixture, "VETO-2", 100).await?;
    assert_eq!(replacement["evm_nonce"], 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn enforces_velocity_and_one_operation_queue_per_wallet() -> Result<()> {
    let fixture = setup().await?;
    let first = prepare(&fixture, "QUEUE-1", 200).await?;
    let blocked = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": request("QUEUE-2", 100)}))
        .transact()
        .await?;
    assert_failure_contains(&blocked, "ERR_WALLET_QUEUE_BUSY");
    let approval = approval(&fixture, &first, 1, visa_expiry(&fixture).await?, None);
    authorize(&fixture, &first, approval).await?.into_result()?;
    confirm(&fixture, &first, 1).await?;

    let velocity = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": request("VELOCITY", 700)}))
        .transact()
        .await?;
    assert_failure_contains(&velocity, "ERR_VELOCITY_EXCEEDED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn evaluates_roles_conditions_on_the_exact_calldata() -> Result<()> {
    let fixture = setup().await?;

    // Recipient outside the condition tree: refused with the engine's reason.
    let mut other = request("CONDITION-RECIPIENT", 100);
    other["calldata"] = json!(erc20_transfer([0x99; 20], 100));
    let refused = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": other}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&refused, "ERR_PERMISSION_DENIED");
    assert_failure_contains(&refused, "parameterNotAllowed");

    // The amount charged comes from the calldata, not from the caller.
    let mut understated = request("CONDITION-AMOUNT", 400);
    understated["allowance_amount"] = json!("1");
    let mismatch = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": understated}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&mismatch, "ERR_ALLOWANCE_AMOUNT_MISMATCH");

    // Above the remaining allowance: refused by the engine.
    let excessive = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(
            json!({"role": ROLE, "request": request("CONDITION-EXCESS", ALLOWANCE_BALANCE + 1)}),
        )
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&excessive, "allowanceExceeded");

    // Native value needs `allow_value`.
    let mut with_value = request("CONDITION-VALUE", 100);
    with_value["value"] = json!("1");
    let send = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": with_value}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&send, "SendNotAllowed");

    let accepted = prepare(&fixture, "CONDITION-OK", 100).await?;
    assert_eq!(accepted["consumptions"][0]["amount"], "100");
    assert_eq!(accepted["measured_value"], "100");
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_invalid_condition_trees_when_queued() -> Result<()> {
    let fixture = setup().await?;
    let mut config = role_config();
    // WithinRatio is not implemented: refused, never ignored.
    config["permissions"][0]["conditions"] = json!([
        {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
        {"parent": 0, "paramType": 1, "operator": 23, "compValue": format!("0x{}", "00".repeat(32))}
    ]);
    let queued = fixture
        .owner
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(json!({"change": {"SetRole": {"role": ROLE, "config": config}}}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&queued, "ERR_INVALID_CONDITIONS");
    Ok(())
}

#[tokio::test]
#[serial]
async fn unmeasured_operations_hit_delay_and_cosign_thresholds() -> Result<()> {
    let fixture = setup().await?;
    let target = [0x77u8; 20];
    let mut config = role_config();
    // No condition measures this call: the vault cannot know what it moves.
    config["permissions"] = json!([{
        "chain_id": CHAIN_ID,
        "target": target,
        "selector": null,
        "conditions": [],
        "allow_value": false
    }]);
    config["velocity"] = Value::Null;
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetRole": {"role": ROLE, "config": config}}),
    )
    .await?;
    let call = json!({
        "chain_id": CHAIN_ID,
        "target": target,
        "value": "0",
        "calldata": [0x09, 0x5e, 0xa7, 0xb3, 1, 2, 3],
        "allowance_amount": "0",
        "reference": "UNMEASURED-1",
        "gas_limit": "120000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    });
    let operation: Value = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": call}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(operation["measured_value"], Value::Null);
    assert!(!operation["execute_after_ns"].is_null(), "delay applies");
    let expiry = visa_expiry(&fixture).await?;
    let without_cosign = authorize(
        &fixture,
        &operation,
        approval(&fixture, &operation, 77, expiry, None),
    )
    .await?;
    assert_failure_contains(&without_cosign, "ERR_COSIGN_REQUIRED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn rejects_modified_replayed_visas_and_invalid_mpc_signatures() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "VISA-1", 100).await?;
    let expiry = visa_expiry(&fixture).await?;
    let modified = approval(&fixture, &operation, 1, expiry, Some([9u8; 32]));
    let rejected = authorize(&fixture, &operation, modified).await?;
    assert_failure_contains(&rejected, "ERR_VISA_DIGEST");
    let valid = approval(&fixture, &operation, 1, expiry, None);
    authorize(&fixture, &operation, valid.clone())
        .await?
        .into_result()?;
    let replay = fixture
        .agent
        .call(fixture.vault.id(), "authorize")
        .args_json(json!({"op_id": operation["op_id"], "approval": valid}))
        .transact()
        .await?;
    assert_failure_contains(&replay, "ERR_NOT_PREPARED");

    let stored = get_operation(&fixture, &operation).await?;
    assert!(stored["signed_transaction"].is_array());
    let signature = json!({"big_r": vec![0u8; 33], "s": vec![0u8; 32], "recovery_id": 0});
    let duplicate = fixture
        .outsider
        .call(fixture.vault.id(), "submit_signature")
        .args_json(json!({"op_id": op_id(&stored), "signature": signature}))
        .transact()
        .await?;
    assert_failure_contains(&duplicate, "ERR_SIGNATURE_MISMATCH");
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_execution_releases_policy_reservations_but_consumes_wallet_nonce() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "FAILED-1", 100).await?;
    let approval = approval(&fixture, &operation, 1, visa_expiry(&fixture).await?, None);
    authorize(&fixture, &operation, approval)
        .await?
        .into_result()?;
    let signed = get_operation(&fixture, &operation).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(status_report(&fixture, &signed, 1, false))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        get_operation(&fixture, &operation).await?["state"],
        "Failed"
    );
    let next = prepare(&fixture, "FAILED-2", 100).await?;
    assert_eq!(next["evm_nonce"], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn council_can_pause_but_only_owner_can_unpause() -> Result<()> {
    let fixture = setup().await?;
    let outsider = fixture
        .outsider
        .call(fixture.vault.id(), "pause")
        .transact()
        .await?;
    assert_failure_contains(&outsider, "ERR_OWNER_OR_COUNCIL");
    fixture
        .council
        .call(fixture.vault.id(), "pause")
        .transact()
        .await?
        .into_result()?;
    assert!(fixture.vault.view("is_paused").await?.json::<bool>()?);
    let council_unpause = fixture
        .council
        .call(fixture.vault.id(), "unpause")
        .transact()
        .await?;
    assert_failure_contains(&council_unpause, "ERR_OWNER_ONLY");
    fixture
        .owner
        .call(fixture.vault.id(), "unpause")
        .transact()
        .await?
        .into_result()?;
    assert!(!fixture.vault.view("is_paused").await?.json::<bool>()?);
    Ok(())
}

#[tokio::test]
#[serial]
async fn rotates_distinct_visa_and_status_keys_only_through_delayed_rules() -> Result<()> {
    let fixture = setup().await?;
    let initial_visa: String = fixture.vault.view("visa_public_key").await?.json()?;
    let initial_status: String = fixture.vault.view("status_public_key").await?.json()?;
    assert_ne!(initial_visa, initial_status);

    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetVisaPublicKey": {"visa_public_key": vec![9u8; 32]}}),
    )
    .await?;
    assert_eq!(
        fixture
            .vault
            .view("visa_public_key")
            .await?
            .json::<String>()?,
        STANDARD.encode([9u8; 32])
    );
    assert_eq!(
        fixture
            .vault
            .view("status_public_key")
            .await?
            .json::<String>()?,
        initial_status
    );

    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetStatusPublicKey": {"status_public_key": vec![10u8; 32]}}),
    )
    .await?;
    assert_eq!(
        fixture
            .vault
            .view("status_public_key")
            .await?
            .json::<String>()?,
        STANDARD.encode([10u8; 32])
    );
    Ok(())
}

#[test]
fn fixture_constants_bind_the_demo_payment() {
    assert_eq!(TOKEN, [0x83; 20]);
    assert_eq!(RECIPIENT, [0x66; 20]);
    assert_eq!(ALLOWANCE_BALANCE, 1_000);
}

#[tokio::test]
#[serial]
async fn check_operation_explains_refusals_without_state_change() -> Result<()> {
    let fixture = setup().await?;
    let check = |member: String, request: Value| {
        let vault = fixture.vault.clone();
        async move {
            vault
                .view("check_operation")
                .args_json(json!({"role": ROLE, "member": member, "request": request}))
                .await?
                .json::<Value>()
                .map_err(anyhow::Error::from)
        }
    };
    let agent = fixture.agent.id().to_string();

    let allowed = check(agent.clone(), request("CHECK-1", 100)).await?;
    assert_eq!(allowed["allowed"], true);
    assert_eq!(allowed["consumptions"][0]["amount"], "100");
    assert_eq!(allowed["requires_delay"], false);

    let mut other = request("CHECK-2", 100);
    other["calldata"] = json!(erc20_transfer([0x99; 20], 100));
    let refused = check(agent.clone(), other).await?;
    assert_eq!(refused["allowed"], false);
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("parameterNotAllowed")
    );

    let outsider = check(fixture.outsider.id().to_string(), request("CHECK-3", 100)).await?;
    assert_eq!(outsider["reason"], "ERR_MEMBERSHIP_NOT_FOUND");

    // A dry run reserves nothing: the real prepare still succeeds with the same reference.
    let operation = prepare(&fixture, "CHECK-1", 100).await?;
    assert_eq!(operation["consumptions"][0]["amount"], "100");
    Ok(())
}

#[tokio::test]
#[serial]
async fn lists_rule_changes_newest_first() -> Result<()> {
    let fixture = setup().await?;
    let sequence: u64 = fixture.vault.view("rule_sequence").await?.json()?;
    assert!(sequence >= 2, "setup queues several rule changes");
    let all: Vec<Value> = fixture
        .vault
        .view("list_rule_changes")
        .args_json(json!({"before": null, "limit": 50}))
        .await?
        .json()?;
    assert_eq!(all.len() as u64, sequence);
    assert!(all.iter().all(|entry| entry["state"] == "Executed"));
    let older: Vec<Value> = fixture
        .vault
        .view("list_rule_changes")
        .args_json(json!({"before": sequence, "limit": 1}))
        .await?
        .json()?;
    assert_eq!(older.len(), 1);
    assert_eq!(older[0]["queue_id"], all[1]["queue_id"]);
    Ok(())
}

#[tokio::test]
#[serial]
async fn refusal_comes_from_the_closest_permission() -> Result<()> {
    let fixture = setup().await?;
    let mut config = role_config();
    let unrelated_target = [0x77u8; 20];
    let unrelated = json!({
        "chain_id": CHAIN_ID,
        "target": unrelated_target,
        "selector": null,
        "conditions": [],
        "allow_value": false
    });
    config["permissions"]
        .as_array_mut()
        .expect("permissions")
        .push(unrelated);
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"SetRole": {"role": ROLE, "config": config}}),
    )
    .await?;
    let mut other = request("CLOSEST-1", 100);
    other["calldata"] = json!(erc20_transfer([0x99; 20], 100));
    let checked: Value = fixture
        .vault
        .view("check_operation")
        .args_json(json!({"role": ROLE, "member": fixture.agent.id(), "request": other.clone()}))
        .await?
        .json()?;
    assert!(
        checked["reason"]
            .as_str()
            .unwrap()
            .contains("parameterNotAllowed"),
        "{checked}"
    );
    let refused = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": other}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&refused, "parameterNotAllowed");
    Ok(())
}

fn dao_transaction(reference_amount: u128) -> Value {
    json!({
        "chain_id": CHAIN_ID,
        "target": TOKEN,
        "value": "0",
        "calldata": erc20_transfer(RECIPIENT, reference_amount),
        "gas_limit": "100000",
        "max_fee_per_gas": "1000000000",
        "max_priority_fee_per_gas": "1000000"
    })
}

async fn submit_dao(fixture: &vault_common::Fixture, transactions: Value) -> Result<Vec<Value>> {
    Ok(fixture
        .owner
        .call(fixture.vault.id(), "submit_transactions")
        .args_json(json!({"transactions": transactions}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json::<Vec<Value>>()?)
}

async fn start_dao(fixture: &vault_common::Fixture) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(fixture
        .outsider
        .call(fixture.vault.id(), "start_dao_transaction")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

async fn operation_by_id(fixture: &vault_common::Fixture, op_id: &Value) -> Result<Value> {
    Ok(fixture
        .vault
        .view("get_operation")
        .args_json(json!({"op_id": op_id}))
        .await?
        .json::<Option<Value>>()?
        .expect("operation"))
}

#[tokio::test]
#[serial]
async fn dao_transactions_wait_for_the_veto_window_then_run_in_order() -> Result<()> {
    let fixture = setup().await?;
    // Only the DAO (owner) can submit, and no role is involved.
    let outsider = fixture
        .outsider
        .call(fixture.vault.id(), "submit_transactions")
        .args_json(json!({"transactions": [dao_transaction(1)]}))
        .transact()
        .await?;
    assert_failure_contains(&outsider, "ERR_OWNER_ONLY");

    let ids = submit_dao(&fixture, json!([dao_transaction(10), dao_transaction(20)])).await?;
    assert_eq!(ids.len(), 2);
    let first = operation_by_id(&fixture, &ids[0]).await?;
    assert_eq!(first["state"], "Scheduled");
    assert_eq!(first["role"], "__dao__");

    // Veto window still open.
    assert_failure_contains(&start_dao(&fixture).await?, "ERR_VETO_WINDOW_OPEN");
    fixture.worker.fast_forward(2).await?;

    start_dao(&fixture).await?.into_result()?;
    let first = operation_by_id(&fixture, &ids[0]).await?;
    assert_eq!(first["state"], "PossiblySigned");
    assert_eq!(first["evm_nonce"], 0);
    assert_eq!(first["transaction"]["input"], json!(erc20_transfer(RECIPIENT, 10)));

    // One transaction at a time per wallet: the second waits for the first.
    assert_failure_contains(&start_dao(&fixture).await?, "ERR_WALLET_QUEUE_BUSY");
    let confirmed = confirm(&fixture, &first, 900).await?;
    assert_eq!(confirmed["state"], "Confirmed");

    start_dao(&fixture).await?.into_result()?;
    let second = operation_by_id(&fixture, &ids[1]).await?;
    assert_eq!(second["state"], "PossiblySigned");
    assert_eq!(second["evm_nonce"], 1);

    let listed: Vec<Value> = fixture
        .vault
        .view("list_dao_transactions")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0]["op_id"], ids[1]);
    Ok(())
}

#[tokio::test]
#[serial]
async fn council_vetoes_a_dao_transaction_and_agents_keep_working() -> Result<()> {
    let fixture = setup().await?;
    let ids = submit_dao(&fixture, json!([dao_transaction(10)])).await?;
    fixture
        .council
        .call(fixture.vault.id(), "veto_operation")
        .args_json(json!({"op_id": ids[0]}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(operation_by_id(&fixture, &ids[0]).await?["state"], "Vetoed");
    fixture.worker.fast_forward(2).await?;
    assert_failure_contains(&start_dao(&fixture).await?, "ERR_NO_DAO_TRANSACTION");
    // The wallet was never held: an agent can still prepare.
    let operation = prepare(&fixture, "AFTER-VETO", 100).await?;
    assert_eq!(operation["evm_nonce"], 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn dao_role_name_is_reserved_and_fees_are_bounded() -> Result<()> {
    let fixture = setup().await?;
    // Refused as soon as the DAO tries to queue it.
    let queued = fixture
        .owner
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(json!({"change": {"SetRole": {"role": "__dao__", "config": role_config()}}}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&queued, "ERR_RESERVED_ROLE");

    let mut expensive = dao_transaction(1);
    expensive["max_fee_per_gas"] = json!("600000000000");
    let refused = fixture
        .owner
        .call(fixture.vault.id(), "submit_transactions")
        .args_json(json!({"transactions": [expensive]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&refused, "ERR_MAX_FEE_PER_GAS");
    Ok(())
}

#[tokio::test]
#[serial]
async fn the_company_wallet_has_the_same_address_on_every_evm_chain() -> Result<()> {
    let fixture = setup().await?;
    fixture
        .owner
        .call(fixture.vault.id(), "request_wallet")
        .args_json(json!({"chain_id": 11155111}))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    let base: Value = fixture.vault.view("get_wallet").args_json(json!({"chain_id": CHAIN_ID})).await?.json()?;
    let sepolia: Value = fixture.vault.view("get_wallet").args_json(json!({"chain_id": 11155111})).await?.json()?;
    assert!(base["address"].is_array());
    assert_eq!(base["address"], sepolia["address"]);
    Ok(())
}
