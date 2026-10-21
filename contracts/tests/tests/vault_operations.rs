mod vault_common;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::Gas;
use serde_json::{Value, json};
use serial_test::serial;

use vault_common::{
    FUNDED_BUDGET, MPC_PUBLIC_KEY, ROLE, ROLES_MODIFIER, TTL_BLOCKS, approval,
    assert_failure_contains, authorize, expected_evm_address, get_operation, op_id, prepare,
    set_mpc_mode, setup, signed_transaction_hash, status_report,
};

fn expiry(operation: &Value) -> u64 {
    operation["expires_at_block"]
        .as_u64()
        .expect("expires_at_block")
}

#[tokio::test]
#[serial]
async fn rejects_missing_replayed_expired_and_modified_visas() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "INV-001", 100).await?;

    let mut missing = approval(&fixture, &operation, 42, expiry(&operation), None);
    missing["signature"] = json!(STANDARD.encode([]));
    let missing_outcome = authorize(&fixture, &operation, missing).await?;
    assert_failure_contains(&missing_outcome, "ERR_VISA_SIGNATURE_LENGTH");

    let mut modified_digest = [9u8; 32];
    if modified_digest == op_id(&operation) {
        modified_digest[0] ^= 1;
    }
    let modified = approval(
        &fixture,
        &operation,
        42,
        expiry(&operation),
        Some(modified_digest),
    );
    let modified_outcome = authorize(&fixture, &operation, modified).await?;
    assert_failure_contains(&modified_outcome, "ERR_VISA_DIGEST");

    let expired = approval(&fixture, &operation, 42, 0, None);
    let expired_outcome = authorize(&fixture, &operation, expired).await?;
    assert_failure_contains(&expired_outcome, "ERR_VISA_EXPIRED");

    let valid = approval(&fixture, &operation, 42, expiry(&operation), None);
    authorize(&fixture, &operation, valid)
        .await?
        .into_result()?;
    let signed = get_operation(&fixture, &operation).await?;
    assert_eq!(signed["state"], "PossiblySigned");
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(json!({"signed_report": status_report(&fixture, &signed, 1)}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        get_operation(&fixture, &operation).await?["state"],
        "Confirmed"
    );

    let second = prepare(&fixture, "INV-002", 100).await?;
    let replayed_nonce = approval(&fixture, &second, 42, expiry(&second), None);
    let replay_outcome = authorize(&fixture, &second, replayed_nonce).await?;
    assert_failure_contains(&replay_outcome, "ERR_VISA_USED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn enforces_budget_reference_and_single_active_operation() -> Result<()> {
    let fixture = setup().await?;

    let over_budget = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("TOO-LARGE", FUNDED_BUDGET + 1)}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&over_budget, "ERR_BUDGET_EXCEEDED");

    let operation = prepare(&fixture, "INV-DUP", 100).await?;
    assert_eq!(operation["transaction"]["chain_id"], 84532);
    assert_eq!(operation["transaction"]["input"][0], 198);
    assert_eq!(operation["transaction"]["input"][1], 254);
    assert_eq!(operation["transaction"]["input"][2], 135);
    assert_eq!(operation["transaction"]["input"][3], 71);
    assert_eq!(operation["transaction"]["to"], json!(ROLES_MODIFIER));
    let input = operation["transaction"]["input"]
        .as_array()
        .expect("transaction input");
    assert_eq!(
        input[228..232]
            .iter()
            .map(|byte| byte.as_u64().expect("byte") as u8)
            .collect::<Vec<_>>(),
        vec![0xa9, 0x05, 0x9c, 0xbb]
    );

    let concurrent = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("INV-OTHER", 100)}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&concurrent, "ERR_ACTIVE_OPERATION");

    let valid = approval(&fixture, &operation, 1, expiry(&operation), None);
    authorize(&fixture, &operation, valid)
        .await?
        .into_result()?;
    let signed = get_operation(&fixture, &operation).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(json!({"signed_report": status_report(&fixture, &signed, 1)}))
        .transact()
        .await?
        .into_result()?;

    let duplicate = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("INV-DUP", 100)}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&duplicate, "ERR_REFERENCE_ALREADY_USED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn pause_and_revoke_are_immediate_circuit_breakers() -> Result<()> {
    let fixture = setup().await?;
    fixture
        .owner
        .call(fixture.vault.id(), "pause")
        .transact()
        .await?
        .into_result()?;

    let paused = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("PAUSED", 100)}))
        .transact()
        .await?;
    assert_failure_contains(&paused, "ERR_PAUSED");

    fixture
        .owner
        .call(fixture.vault.id(), "unpause")
        .transact()
        .await?
        .into_result()?;
    let operation = prepare(&fixture, "REVOKE", 100).await?;
    let valid = approval(&fixture, &operation, 1, expiry(&operation), None);
    authorize(&fixture, &operation, valid)
        .await?
        .into_result()?;
    fixture
        .owner
        .call(fixture.vault.id(), "pause")
        .transact()
        .await?
        .into_result()?;
    fixture
        .owner
        .call(fixture.vault.id(), "revoke_agent")
        .args_json(json!({"agent": fixture.agent.id()}))
        .transact()
        .await?
        .into_result()?;
    fixture
        .outsider
        .call(fixture.vault.id(), "cancel_nonce")
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

    let cancelling = get_operation(&fixture, &operation).await?;
    assert_eq!(cancelling["state"], "PossiblySigned");
    assert!(!cancelling["cancellation"]["signed_transaction"].is_null());
    let role: Value = fixture
        .vault
        .view("get_role")
        .args_json(json!({"role": ROLE}))
        .await?
        .json::<Option<Value>>()?
        .expect("role");
    assert_eq!(role["reserved"], "100");
    Ok(())
}

#[tokio::test]
#[serial]
async fn prepare_rejects_recipient_outside_vault_allowlist() -> Result<()> {
    let fixture = setup().await?;
    let mut disallowed = vault_common::intent("OUTSIDE-ALLOWLIST", 100);
    disallowed["recipient"] = json!(vec![0x77u8; 20]);
    let outcome = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": disallowed}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&outcome, "ERR_RECIPIENT_NOT_ALLOWED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn expiration_releases_budget_reference_and_reuses_nonce() -> Result<()> {
    let fixture = setup().await?;
    let first = prepare(&fixture, "EXPIRE", 100).await?;
    assert_eq!(first["evm_nonce"], 0);

    fixture.worker.fast_forward(TTL_BLOCKS + 2).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "expire")
        .args_json(json!({"op_id": first["op_id"]}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(get_operation(&fixture, &first).await?["state"], "Expired");

    let second = prepare(&fixture, "EXPIRE", 100).await?;
    assert_eq!(second["evm_nonce"], 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn cancel_nonce_uses_same_nonce_and_consumes_it_after_confirmation() -> Result<()> {
    let fixture = setup().await?;
    let operation = prepare(&fixture, "CANCEL", 100).await?;
    let valid = approval(&fixture, &operation, 10, expiry(&operation), None);
    authorize(&fixture, &operation, valid)
        .await?
        .into_result()?;

    fixture
        .agent
        .call(fixture.vault.id(), "cancel_nonce")
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
    let cancelling = get_operation(&fixture, &operation).await?;
    assert_eq!(cancelling["state"], "PossiblySigned");
    assert_eq!(
        cancelling["cancellation"]["transaction"]["nonce"],
        operation["evm_nonce"]
    );
    assert_eq!(
        cancelling["cancellation"]["transaction"]["input"],
        json!([])
    );
    assert_eq!(cancelling["cancellation"]["transaction"]["value"], "0");
    let expected_sender: Vec<u8> = expected_evm_address(MPC_PUBLIC_KEY).into();
    assert_eq!(
        cancelling["cancellation"]["transaction"]["to"],
        json!(expected_sender)
    );

    fixture
        .owner
        .call(fixture.vault.id(), "confirm_cancellation")
        .args_json(json!({
            "op_id": operation["op_id"],
            "tx_hash": signed_transaction_hash(&cancelling, true)
        }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        get_operation(&fixture, &operation).await?["state"],
        "Cancelled"
    );
    let next = prepare(&fixture, "AFTER-CANCEL", 100).await?;
    assert_eq!(next["evm_nonce"], 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn derived_public_key_matches_host_and_contract_address() -> Result<()> {
    let fixture = setup().await?;
    let agent: Value = fixture
        .vault
        .view("get_agent")
        .args_json(json!({"agent": fixture.agent.id()}))
        .await?
        .json::<Option<Value>>()?
        .expect("agent");
    let public_key = agent["derived_public_key"].as_str().expect("public key");
    assert_eq!(public_key, MPC_PUBLIC_KEY);
    let expected = expected_evm_address(public_key);
    let stored: [u8; 20] = agent["evm_address"]
        .as_array()
        .expect("address")
        .iter()
        .map(|byte| byte.as_u64().expect("byte") as u8)
        .collect::<Vec<_>>()
        .try_into()
        .expect("20 bytes");
    assert_eq!(stored, expected);

    let contract_address: String = fixture
        .vault
        .view("evm_address_from_public_key")
        .args_json(json!({"public_key": public_key}))
        .await?
        .json()?;
    assert_eq!(STANDARD.decode(contract_address)?, expected);
    Ok(())
}

#[tokio::test]
#[serial]
async fn mpc_failure_and_late_response_never_release_or_reuse_nonce() -> Result<()> {
    let failed_fixture = setup().await?;
    set_mpc_mode(&failed_fixture, "Fail").await?;
    let failed = prepare(&failed_fixture, "MPC-FAIL", 100).await?;
    let failed_visa = approval(&failed_fixture, &failed, 20, expiry(&failed), None);
    authorize(&failed_fixture, &failed, failed_visa)
        .await?
        .into_result()?;
    assert_eq!(
        get_operation(&failed_fixture, &failed).await?["state"],
        "PossiblySigned"
    );
    let role: Value = failed_fixture
        .vault
        .view("get_role")
        .args_json(json!({"role": ROLE}))
        .await?
        .json::<Option<Value>>()?
        .expect("role");
    assert_eq!(role["reserved"], "100");

    let fixture = setup().await?;
    set_mpc_mode(&fixture, "Timeout").await?;
    let delayed = prepare(&fixture, "MPC-LATE", 100).await?;
    let delayed_visa = approval(&fixture, &delayed, 21, expiry(&delayed), None);
    let _pending = fixture
        .agent
        .call(fixture.vault.id(), "authorize")
        .args_json(json!({"op_id": delayed["op_id"], "approval": delayed_visa}))
        .gas(Gas::from_tgas(120))
        .transact_async()
        .await?;
    fixture.worker.fast_forward(3).await?;
    assert_eq!(
        get_operation(&fixture, &delayed).await?["state"],
        "PossiblySigned"
    );

    let reuse = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("MPC-REUSE", 100)}))
        .transact()
        .await?;
    assert_failure_contains(&reuse, "ERR_ACTIVE_OPERATION");

    fixture
        .outsider
        .call(fixture.mpc.id(), "resume_sign")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    fixture.worker.fast_forward(3).await?;
    let resumed = get_operation(&fixture, &delayed).await?;
    assert_eq!(resumed["state"], "PossiblySigned");
    assert!(!resumed["signed_transaction"].is_null());

    let reuse_after_response = fixture
        .agent
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"intent": vault_common::intent("MPC-REUSE-LATE", 100)}))
        .transact()
        .await?;
    assert_failure_contains(&reuse_after_response, "ERR_ACTIVE_OPERATION");
    Ok(())
}
