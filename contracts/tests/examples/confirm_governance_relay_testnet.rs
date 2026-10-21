use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const DAO: &str = "mandateos-uat-92543787.sputnikv2.testnet";
const RELAY: &str = "gov-relay-v1.mandateos-root-20261021.testnet";
const BOND: u128 = 100_000_000_000_000_000_000_000;

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
            key.clone(),
            &worker,
        ),
    ];
    let relay = Contract::from_secret_key(RELAY.parse()?, key, &worker);
    let op_id: Option<Value> = relay.view("active_operation").await?.json()?;
    let op_id = op_id.context("active governance operation missing")?;
    let tx_hash = hex::decode(std::env::var("GOV_BASE_TX_HASH")?.trim_start_matches("0x"))?;
    let args = json!({"op_id": op_id, "tx_hash": tx_hash});
    let kind = function_call_kind(&relay, "confirm_original", args)?;
    let proposal_id = execute_proposal(&council, &DAO.parse()?, kind).await?;
    println!(
        "MANDATEOS_GOV_CONFIRMATION={}",
        serde_json::to_string(&json!({
            "proposal_id": proposal_id,
            "op_id": op_id,
            "base_tx_hash": std::env::var("GOV_BASE_TX_HASH")?
        }))?
    );
    Ok(())
}

fn function_call_kind(relay: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(json!({
        "FunctionCall": {
            "receiver_id": relay.id(),
            "actions": [{
                "method_name": method,
                "args": STANDARD.encode(serde_json::to_vec(&args)?),
                "deposit": "0",
                "gas": Gas::from_tgas(50).as_gas().to_string()
            }]
        }
    }))
}

async fn execute_proposal(council: &[Account], dao_id: &AccountId, kind: Value) -> Result<u64> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": "Confirm Base governance transaction in MandateOS relay",
                "kind": kind
            }
        }))
        .deposit(NearToken::from_yoctonear(BOND))
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
