use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{AccountId, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const MPC: &str = "v1.signer-prod.testnet";
const DAO: &str = "mandateos-uat-92543787.sputnikv2.testnet";
const BOND: u128 = 100_000_000_000_000_000_000_000;
const RELAY_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/governance_relay.wasm"
));

#[tokio::main]
async fn main() -> Result<()> {
    let worker = near_workspaces::testnet()
        .rpc_addr("https://test.rpc.fastnear.com")
        .await?;
    let root = Account::from_secret_key(
        std::env::var("NEAR_TESTNET_ROOT_ACCOUNT")?.parse()?,
        std::env::var("NEAR_TESTNET_ROOT_PRIVATE_KEY")?.parse::<SecretKey>()?,
        &worker,
    );
    let relay_account = root
        .create_subaccount("gov-relay-v1")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let relay = relay_account.deploy(RELAY_WASM).await?.into_result()?;
    let dao_id: AccountId = DAO.parse()?;
    relay
        .call("new")
        .args_json(json!({
            "owner_id": dao_id,
            "mpc_contract_id": MPC,
            "mpc_path": "governance/base-sepolia",
            "evm_chain_id": 84532,
            "delay_address": STANDARD.encode(evm_address("Dd860F2a45b62b84A94ABF61F7f6c2f262549533")),
            "max_gas_limit": "300000",
            "max_fee_per_gas": "100000000000",
            "max_priority_fee_per_gas": "10000000000",
            "max_total_fee": "30000000000000000"
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let relay_key = relay.as_account().secret_key().public_key();
    relay
        .as_account()
        .batch(relay.id())
        .delete_key(relay_key)
        .transact()
        .await?
        .into_result()?;

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
    let request_key = function_call_kind(&relay, "request_derived_public_key", json!({}))?;
    let proposal_id = execute_proposal(&council, &dao_id, request_key).await?;
    let public_key: Option<String> = relay.view("derived_public_key").await?.json()?;
    let address: Option<String> = relay.view("evm_address").await?.json()?;
    println!(
        "MANDATEOS_GOV_RELAY_DEPLOYMENT={}",
        serde_json::to_string(&json!({
            "dao": DAO,
            "relay": relay.id(),
            "mpc": MPC,
            "mpc_path": "governance/base-sepolia",
            "proposal_id": proposal_id,
            "derived_public_key": public_key.context("derived key missing")?,
            "evm_address_base64": address.context("derived address missing")?,
            "relay_access_keys": relay.view_access_keys().await?.len()
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
                "gas": Gas::from_tgas(80).as_gas().to_string()
            }]
        }
    }))
}

async fn execute_proposal(council: &[Account], dao_id: &AccountId, kind: Value) -> Result<u64> {
    let proposal_id: u64 = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": "MandateOS derive governance relay 0xGOV",
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

fn evm_address(value: &str) -> Vec<u8> {
    hex::decode(value).expect("valid EVM address")
}
