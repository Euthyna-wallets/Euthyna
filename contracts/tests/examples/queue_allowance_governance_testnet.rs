use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const DAO: &str = "mandateos-uat-92543787.sputnikv2.testnet";
const RELAY: &str = "gov-relay-v1.mandateos-root-20261021.testnet";
const BOND: u128 = 100_000_000_000_000_000_000_000;
const ROLES: &str = "7178555779097cAE1BA20C5D7ED7205708a5ed40";
const SET_ALLOWANCE_10: &str = "a8ec43ee726573656172636865722d75736463000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009896800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

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
    let dao_id: AccountId = DAO.parse()?;
    let args = json!({
        "target": STANDARD.encode(hex::decode(ROLES)?),
        "value": "0",
        "data": STANDARD.encode(hex::decode(SET_ALLOWANCE_10)?),
        "gas_limit": "200000",
        "max_fee_per_gas": "20000000000",
        "max_priority_fee_per_gas": "1000000000"
    });
    let kind = function_call_kind(&relay, "propose", args)?;
    let proposal_id = execute_proposal(&council, &dao_id, kind).await?;
    let op_id: Option<Value> = relay.view("active_operation").await?.json()?;
    let op_id = op_id.context("active governance operation missing")?;
    let operation: Option<Value> = relay
        .view("get_operation")
        .args_json(json!({"op_id": op_id}))
        .await?
        .json()?;
    let operation = operation.context("governance operation missing")?;
    let raw = operation["signed_transaction"]
        .as_array()
        .context("signed transaction missing")?
        .iter()
        .map(|byte| {
            byte.as_u64()
                .context("signed byte")
                .map(|value| value as u8)
        })
        .collect::<Result<Vec<_>>>()?;
    println!(
        "MANDATEOS_ALLOWANCE_GOVERNANCE={}",
        serde_json::to_string(&json!({
            "proposal_id": proposal_id,
            "op_id": operation["op_id"],
            "evm_nonce": operation["evm_nonce"],
            "state": operation["state"],
            "signed_transaction": format!("0x{}", hex::encode(raw))
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
                "gas": Gas::from_tgas(120).as_gas().to_string()
            }]
        }
    }))
}

async fn execute_proposal(council: &[Account], dao_id: &AccountId, kind: Value) -> Result<u64> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": "Increase researcher allowance to 10 TestUSDC (test token)",
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
