use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const DAO: &str = "mandateos-uat-92543787.sputnikv2.testnet";
const RELAY: &str = "gov-relay-v1.mandateos-root-20261021.testnet";
const ROLES: &str = "7178555779097cAE1BA20C5D7ED7205708a5ed40";
const ALLOWANCE_KEY: [u8; 32] = [
    0x72, 0x65, 0x73, 0x65, 0x61, 0x72, 0x63, 0x68, 0x65, 0x72, 0x2d, 0x75, 0x73, 0x64, 0x63, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

#[tokio::main]
async fn main() -> Result<()> {
    let allowance: u128 = std::env::var("ALLOWANCE_BALANCE")
        .unwrap_or_else(|_| "10000000".to_string())
        .parse()?;
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
    let relay_args = json!({
        "target": STANDARD.encode(evm_address(ROLES)),
        "value": "0",
        "data": STANDARD.encode(set_allowance_calldata(allowance)),
        "gas_limit": "200000",
        "max_fee_per_gas": "1000000000",
        "max_priority_fee_per_gas": "10000000"
    });
    let proposal_id = execute_proposal(
        &council,
        &dao_id,
        json!({
            "FunctionCall": {
                "receiver_id": RELAY,
                "actions": [{
                    "method_name": "propose",
                    "args": STANDARD.encode(serde_json::to_vec(&relay_args)?),
                    "deposit": "0",
                    "gas": Gas::from_tgas(120).as_gas().to_string()
                }]
            }
        }),
        allowance,
    )
    .await?;
    let op_id: Option<Value> = relay.view("active_operation").await?.json()?;
    let op_id = op_id.context("relay active operation missing")?;
    let operation: Option<Value> = relay
        .view("get_operation")
        .args_json(json!({"op_id": op_id}))
        .await?
        .json()?;
    let operation = operation.context("relay operation missing")?;
    println!(
        "MANDATEOS_GOV_ALLOWANCE_PREPARED={}",
        serde_json::to_string(&json!({
            "dao_proposal_id": proposal_id,
            "relay": RELAY,
            "operation": operation,
            "roles": format!("0x{ROLES}"),
            "allowance": allowance.to_string()
        }))?
    );
    Ok(())
}

async fn execute_proposal(
    council: &[Account],
    dao_id: &AccountId,
    kind: Value,
    allowance: u128,
) -> Result<u64> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({"proposal": {
            "description": format!("Set researcher TestUSDC (token de test) allowance to {allowance}"),
            "kind": kind
        }}))
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

fn set_allowance_calldata(balance: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 6 * 32);
    data.extend_from_slice(&[0xa8, 0xec, 0x43, 0xee]);
    data.extend_from_slice(&ALLOWANCE_KEY);
    data.extend_from_slice(&word_u128(balance));
    data.extend_from_slice(&word_u128(0));
    data.extend_from_slice(&word_u128(0));
    data.extend_from_slice(&word_u128(0));
    data.extend_from_slice(&word_u128(0));
    data
}

fn evm_address(value: &str) -> Vec<u8> {
    hex::decode(value).expect("valid EVM address")
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}
