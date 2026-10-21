use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::Account;
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use serde_json::{Value, json};

const DAO: &str = "mandateos-uat-92543787.sputnikv2.testnet";
const RELAY: &str = "gov-relay-v1.mandateos-root-20261021.testnet";

#[tokio::main]
async fn main() -> Result<()> {
    let worker = near_workspaces::testnet()
        .rpc_addr("https://test.rpc.fastnear.com")
        .await?;
    let key = SecretKey::from_seed(KeyType::ED25519, "subaccount.seed");
    let council = vec![
        Account::from_secret_key(
            "council-1-v4.mandateos-root-20261021.testnet".parse()?,
            key.clone(),
            &worker,
        ),
        Account::from_secret_key(
            "council-2-v4.mandateos-root-20261021.testnet".parse()?,
            key,
            &worker,
        ),
    ];
    let op_id: [u8; 32] = hex_array(&std::env::var("GOV_OP_ID_HEX")?)?;
    let tx_hash: [u8; 32] = hex_array(&std::env::var("GOV_TX_HASH")?)?;
    let args = serde_json::to_vec(&json!({"op_id": op_id, "tx_hash": tx_hash}))?;
    let kind = json!({
        "FunctionCall": {
            "receiver_id": RELAY,
            "actions": [{
                "method_name": "confirm_original",
                "args": STANDARD.encode(args),
                "deposit": "0",
                "gas": Gas::from_tgas(50).as_gas().to_string()
            }]
        }
    });
    let proposal_id = execute_proposal(&council, &DAO.parse()?, kind).await?;
    println!(
        "MANDATEOS_GOV_CONFIRMATION={}",
        serde_json::to_string(&json!({
            "proposal_id": proposal_id,
            "op_id": format!("0x{}", hex::encode(op_id)),
            "base_tx_hash": format!("0x{}", hex::encode(tx_hash))
        }))?
    );
    Ok(())
}

async fn execute_proposal(council: &[Account], dao_id: &AccountId, kind: Value) -> Result<u64> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(
            json!({"proposal": {"description": "Confirm 0xGOV Base transaction", "kind": kind}}),
        )
        .deposit(NearToken::from_millinear(100))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    for member in council {
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
    Ok(proposal_id)
}

fn hex_array<const N: usize>(value: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(value.trim_start_matches("0x"))?;
    anyhow::ensure!(bytes.len() == N, "invalid byte length");
    Ok(bytes.try_into().expect("checked byte length"))
}
