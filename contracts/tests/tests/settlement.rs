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
