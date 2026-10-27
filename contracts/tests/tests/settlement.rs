mod vault_common;
use anyhow::Result;
use near_workspaces::types::Gas;
use serde_json::{Value, json};
use serial_test::serial;
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use vault_common::*;

async fn prove(f: &Fixture, op: &Value, cancellation: bool) -> Result<()> {
    let raw: Vec<u8> = serde_json::from_value(if cancellation {
        op["cancellation"]["signed_transaction"].clone()
    } else {
        op["signed_transaction"].clone()
    })?;
    let tx: [u8; 32] = Keccak256::digest(raw).into();
    let block = [9u8; 32];
    let mut bytes = vec![0, 6];
    bytes.extend(tx);
    bytes.extend(1u32.to_le_bytes());
    bytes.extend([0, 2]);
    bytes.extend(1u32.to_le_bytes());
    bytes.extend([1, 0]);
    bytes.extend(block);
    let hash = hex::encode(Sha256::digest(bytes));
    let request = json!({"request":{"Base":{"tx_id":hex::encode(tx),"extractors":["BlockHash"],"finality":"Finalized"}},"domain_id":3,"payload_version":1,"expected_payload_hash":hash});
    f.mpc
        .call("set_foreign_fixture")
        .args_json(json!({"request":request,"payload_hash":hash}))
        .transact()
        .await?
        .into_result()?;
    f.outsider
        .call(
            f.vault.id(),
            if cancellation {
                "settle_cancellation"
            } else {
                "settle"
            },
        )
        .args_json(json!({"op_id":op["op_id"],"block_hash":block}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}
#[tokio::test]
#[serial]
async fn finalized_foreign_proof_consumes_budget() -> Result<()> {
    let f = setup().await?;
    let op = prepare(&f, "PROOF-1", 100).await?;
    f.agent
        .call(f.vault.id(), "authorize")
        .args_json(json!({"op_id":op["op_id"],"approval":null}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let signed = get_operation(&f, &op).await?;
    prove(&f, &signed, false).await?;
    assert_eq!(get_operation(&f, &op).await?["state"], "Confirmed");
    let allowance: Value = f
        .vault
        .view("get_allowance")
        .args_json(json!({"key":ALLOWANCE_KEY}))
        .await?
        .json()?;
    assert_eq!(allowance["reserved"], "0");
    Ok(())
}
#[tokio::test]
#[serial]
async fn latest_finality_is_rejected_by_mock_verifier() -> Result<()> {
    let f = setup().await?;
    let result=f.outsider.call(f.mpc.id(),"verify_foreign_transaction").args_json(json!({"request":{"request":{"Base":{"tx_id":"00".repeat(32),"extractors":["BlockHash"],"finality":"Latest"}},"domain_id":3,"payload_version":1,"expected_payload_hash":"00".repeat(32)}})).deposit(near_workspaces::types::NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await?;
    assert_failure_contains(&result, "ERR_FINALITY");
    Ok(())
}

async fn signed_operation(f: &Fixture, reference: &str) -> Result<Value> {
    let op = prepare(f, reference, 100).await?;
    f.agent
        .call(f.vault.id(), "authorize")
        .args_json(json!({"op_id": op["op_id"], "approval": null}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    get_operation(f, &op).await
}
async fn pending_bogus_proofs(f: &Fixture, op: &Value) -> Result<()> {
    f.mpc
        .call("set_mode")
        .args_json(json!({"mode":"Timeout"}))
        .transact()
        .await?
        .into_result()?;
    for i in 0..5 {
        let _pending = f
            .outsider
            .call(f.vault.id(), "settle")
            .args_json(json!({"op_id":op["op_id"],"block_hash":vec![i;32]}))
            .gas(Gas::from_tgas(100))
            .transact_async()
            .await?;
    }
    tests::wait_until_timestamp(
        &f.worker,
        f.worker.view_block().await?.timestamp() + 1_000_000_000,
    )
    .await?;
    assert!(
        f.mpc
            .view("has_pending_verification")
            .await?
            .json::<bool>()?
    );
    f.mpc
        .call("set_mode")
        .args_json(json!({"mode":"Success"}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}
#[tokio::test]
#[serial]
async fn unresolved_bogus_proofs_do_not_block_valid_settlement() -> Result<()> {
    let f = setup().await?;
    let op = signed_operation(&f, "CONCURRENT-PROOFS").await?;
    pending_bogus_proofs(&f, &op).await?;
    prove(&f, &op, false).await?;
    assert_eq!(get_operation(&f, &op).await?["state"], "Confirmed");
    Ok(())
}
#[tokio::test]
#[serial]
async fn zero_tip_input_cannot_poison_cancellation_or_refund() -> Result<()> {
    let f = setup().await?;
    apply_rule_change(&f.owner,&f.outsider,&f.worker,&f.vault,json!({"SetSettlementConfig":{"config":{"cancel_after_ns":"1","unconfirmed_after_ns":"3600000000001","foreign_tx_domain_id":3,"mainnet":false}}})).await?;
    let op = signed_operation(&f, "CANCEL-ZERO-TIP").await?;
    pending_bogus_proofs(&f, &op).await?;
    let attack=f.outsider.call(f.vault.id(),"cancel_nonce").args_json(json!({"op_id":op["op_id"],"gas_limit":"0","max_fee_per_gas":"0","max_priority_fee_per_gas":"0"})).gas(Gas::from_tgas(100)).transact().await?;
    if attack.is_failure() {
        assert!(get_operation(&f, &op).await?["cancellation"].is_null());
        f.outsider
            .call(f.vault.id(), "cancel_nonce")
            .args_json(json!({"op_id":op["op_id"]}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    let cancelled = get_operation(&f, &op).await?;
    let original_tip: u128 = cancelled["transaction"]["max_priority_fee_per_gas"]
        .as_str()
        .unwrap()
        .parse()?;
    let tip: u128 = cancelled["cancellation"]["transaction"]["max_priority_fee_per_gas"]
        .as_str()
        .unwrap()
        .parse()?;
    assert!(tip >= original_tip + original_tip.div_ceil(8).max(1));
    assert!(cancelled["cancellation"]["signed_transaction"].is_array());
    prove(&f, &cancelled, true).await?;
    assert_eq!(get_operation(&f, &op).await?["state"], "Cancelled");
    let allowance: Value = f
        .vault
        .view("get_allowance")
        .args_json(json!({"key":ALLOWANCE_KEY}))
        .await?
        .json()?;
    assert_eq!(allowance["reserved"], "0");
    assert_eq!(allowance["balance"], ALLOWANCE_BALANCE.to_string());
    Ok(())
}

#[tokio::test]
#[serial]
async fn failed_cancellation_signature_can_retry_and_refund() -> Result<()> {
    let f = setup().await?;
    apply_rule_change(&f.owner,&f.outsider,&f.worker,&f.vault,json!({"SetSettlementConfig":{"config":{"cancel_after_ns":"1","unconfirmed_after_ns":"3600000000001","foreign_tx_domain_id":3,"mainnet":false}}})).await?;
    let op = signed_operation(&f, "CANCEL-SIGN-RETRY").await?;
    f.mpc
        .call("set_mode")
        .args_json(json!({"mode":"Fail"}))
        .transact()
        .await?
        .into_result()?;
    let _ = f
        .outsider
        .call(f.vault.id(), "cancel_nonce")
        .args_json(json!({"op_id":op["op_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let failed = get_operation(&f, &op).await?;
    assert_eq!(failed["state"], "PossiblySigned");
    assert!(failed["cancellation"]["signed_transaction"].is_null());
    assert!(failed["cancellation"]["signature"].is_null());
    assert_eq!(failed["cancellation"]["request_count"], 1);
    f.mpc
        .call("set_mode")
        .args_json(json!({"mode":"Success"}))
        .transact()
        .await?
        .into_result()?;
    f.outsider
        .call(f.vault.id(), "cancel_nonce")
        .args_json(json!({"op_id":op["op_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let retried = get_operation(&f, &op).await?;
    assert_eq!(
        retried["cancellation"]["transaction"],
        failed["cancellation"]["transaction"]
    );
    assert_eq!(
        retried["cancellation"]["tx_digest"],
        failed["cancellation"]["tx_digest"]
    );
    assert_eq!(retried["cancellation"]["request_count"], 2);
    assert!(retried["cancellation"]["signed_transaction"].is_array());
    let duplicate = f
        .outsider
        .call(f.vault.id(), "cancel_nonce")
        .args_json(json!({"op_id":op["op_id"]}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_failure_contains(&duplicate, "ERR_CANCELLATION_ALREADY_SIGNED");
    assert_eq!(
        get_operation(&f, &op).await?["cancellation"],
        retried["cancellation"]
    );
    prove(&f, &retried, true).await?;
    assert_eq!(get_operation(&f, &op).await?["state"], "Cancelled");
    let allowance: Value = f
        .vault
        .view("get_allowance")
        .args_json(json!({"key":ALLOWANCE_KEY}))
        .await?
        .json()?;
    assert_eq!(allowance["reserved"], "0");
    assert_eq!(allowance["balance"], ALLOWANCE_BALANCE.to_string());
    Ok(())
}
