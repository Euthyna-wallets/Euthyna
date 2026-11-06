use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use borsh::BorshSerialize;
use ed25519_dalek::{Signer as _, SigningKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccountId, Gas, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::time::sleep;

const MPC: &str = "v1.signer-prod.testnet";
const DAO_FACTORY: &str = "factory-v2.mandateos.testnet";
const PROPOSAL_BOND: u128 = 100_000_000_000_000_000_000_000;
const RULE_DELAY_NS: u64 = 300_000_000_000;
const CHAIN_ID: u64 = 84_532;
const ROLE: &str = "purchasing";
const ALLOWANCE_KEY: [u8; 32] = [0x55; 32];
const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));

#[derive(BorshSerialize)]
struct VisaForSigning {
    client_id: String,
    op_id: [u8; 32],
    tx_digest: [u8; 32],
    agent: String,
    role: String,
    reference: String,
    policy_version: u64,
    registry_version: u64,
    visa_nonce: u64,
    expires_at_ns: u64,
}

#[derive(Serialize)]
struct VisaJson {
    client_id: String,
    op_id: [u8; 32],
    tx_digest: [u8; 32],
    agent: String,
    role: String,
    reference: String,
    policy_version: u64,
    registry_version: u64,
    visa_nonce: u64,
    expires_at_ns: String,
}

#[derive(BorshSerialize)]
enum StatusKindForSigning {
    Confirmed,
}

#[derive(BorshSerialize)]
struct StatusForSigning {
    client_id: String,
    op_id: [u8; 32],
    kind: StatusKindForSigning,
    tx_hash: [u8; 32],
    report_nonce: u64,
    block_number: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let near_rpc = env("NEAR_RPC_URL")?;
    let base_rpc = env("BASE_SEPOLIA_RPC_URL")?;
    let token = address(&env("BASE_TEST_USDC_ADDRESS")?)?;
    let recipient = address(&env("OMNIROLES_PAYMENT_RECIPIENT")?)?;
    let amount = std::env::var("OMNIROLES_PAYMENT_AMOUNT")
        .unwrap_or_else(|_| "1000000".to_owned())
        .parse::<u128>()?;
    let minimum_gas_wei = std::env::var("OMNIROLES_MIN_GAS_WEI")
        .unwrap_or_else(|_| "50000000000000".to_owned())
        .parse::<u128>()?;
    let worker = near_workspaces::testnet().rpc_addr(&near_rpc).await?;
    let owner = if std::env::var("OMNIROLES_USE_DEV_ACCOUNT").as_deref() == Ok("1") {
        worker.dev_create_account().await?
    } else {
        account_from_env(
            &worker,
            "NEAR_TESTNET_ROOT_ACCOUNT",
            "NEAR_TESTNET_ROOT_PRIVATE_KEY",
        )?
    };
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() % 100_000_000;
    let council = vec![
        owner
            .create_subaccount(&format!("omni-c1-{suffix}"))
            .initial_balance(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?,
        owner
            .create_subaccount(&format!("omni-c2-{suffix}"))
            .initial_balance(NearToken::from_millinear(300))
            .transact()
            .await?
            .into_result()?,
        owner
            .create_subaccount(&format!("omni-c3-{suffix}"))
            .initial_balance(NearToken::from_millinear(300))
            .transact()
            .await?
            .into_result()?,
    ];
    let agent = owner
        .create_subaccount(&format!("omni-agent-{suffix}"))
        .initial_balance(NearToken::from_millinear(500))
        .transact()
        .await?
        .into_result()?;
    let vault_account = owner
        .create_subaccount(&format!("omni-vault-{suffix}"))
        .initial_balance(NearToken::from_near(6))
        .transact()
        .await?
        .into_result()?;
    let visa_secret = hex::decode(env("OMNIROLES_VISA_SECRET_HEX")?)?;
    let visa_guard = SigningKey::from_bytes(
        &visa_secret
            .try_into()
            .map_err(|_| anyhow::anyhow!("OMNIROLES_VISA_SECRET_HEX must contain 32 bytes"))?,
    );
    let status_secret = hex::decode(env("OMNIROLES_STATUS_SECRET_HEX")?)?;
    let status_guard = SigningKey::from_bytes(
        &status_secret
            .try_into()
            .map_err(|_| anyhow::anyhow!("OMNIROLES_STATUS_SECRET_HEX must contain 32 bytes"))?,
    );

    let dao_name = format!("omni-{suffix}");
    let dao_id: AccountId = format!("{dao_name}.{DAO_FACTORY}").parse()?;
    let dao_init = json!({
        "config": {
            "name": "ACME OmniRoles Jury DAO",
            "purpose": "Govern OmniRoles policy",
            "metadata": ""
        },
        "policy": council_policy(&council)
    });
    let dao_created = council[0]
        .call(&DAO_FACTORY.parse::<AccountId>()?, "create")
        .args_json(json!({
            "name": dao_name,
            "args": STANDARD.encode(serde_json::to_vec(&dao_init)?)
        }))
        .deposit(NearToken::from_millinear(250))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    let dao_create_hash = tx_hash(&dao_created);
    dao_created.into_result()?;

    let deployed = vault_account.deploy(VAULT_WASM).await?;
    let deploy_hash = deployed.details.outcome().transaction_hash.to_string();
    let vault = deployed.into_result()?;
    let initialized = vault
        .call("new")
        .args_json(json!({
            "client_id": "acme-omniroles",
            "owner_id": dao_id,
            "mpc_contract_id": MPC,
            "visa_public_key": STANDARD.encode(visa_guard.verifying_key().to_bytes()),
            "status_public_key": STANDARD.encode(status_guard.verifying_key().to_bytes()),
            "policy_version": 1,
            "registry_version": 1,
            "operation_ttl_ns": 300_000_000_000u64,
            "rule_delay_ns": RULE_DELAY_NS,
            "rule_expiration_ns": 900_000_000_000u64,
            "council": council.iter().map(Account::id).collect::<Vec<_>>()
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let init_hash = tx_hash(&initialized);
    initialized.into_result()?;

    let key_deleted = vault
        .as_account()
        .batch(vault.id())
        .delete_key(vault.as_account().secret_key().public_key())
        .transact()
        .await?;
    let key_delete_hash = tx_hash(&key_deleted);
    key_deleted.into_result()?;
    if !vault.view_access_keys().await?.is_empty() {
        bail!("Vault still has a full-access key after initialization");
    }

    let wallet_request_hashes = execute_dao_call(
        &council,
        &dao_id,
        &vault,
        "request_wallet",
        json!({"chain_id": CHAIN_ID}),
    )
    .await?;
    let wallet: Value = vault
        .view("get_wallet")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .await?
        .json::<Option<Value>>()?
        .context("derived Base wallet missing")?;
    let wallet_address = format!("0x{}", hex::encode(byte_array(&wallet["address"], 20)?));
    println!("OMNIROLES_WALLET_READY={wallet_address}");
    println!("Fund it with: pnpm --filter @euthyna/deployer fund:omniroles");
    wait_for_funds(&base_rpc, &token, &wallet_address, amount, minimum_gas_wei).await?;

    let role_change = json!({"SetRole": {"role": ROLE, "config": {
        "enabled": true,
        "permissions": [{
            "chain_id": CHAIN_ID,
            "target": token,
            "selector": [0xa9, 0x05, 0x9c, 0xbb],
            // transfer(to == recipient, amount within ALLOWANCE_KEY)
            "conditions": [
                {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
                {"parent": 0, "paramType": 1, "operator": 16, "compValue": format!("0x{}{}", "00".repeat(12), hex::encode(recipient))},
                {"parent": 0, "paramType": 1, "operator": 28, "compValue": format!("0x{}", hex::encode(ALLOWANCE_KEY))}
            ],
            "allow_value": false
        }],
        "operation_delay_threshold": null,
        "operation_delay_ns": 0,
        "co_sign_threshold": null,
        "co_signer_role": null,
        "velocity": {"limit": (amount * 10).to_string(), "window_ns": 60_000_000_000u64},
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    }}});
    let membership_change = json!({"GrantMembership": {
        "role": ROLE,
        "member": agent.id(),
        "kind": "Agent",
        "starts_at_ns": "0",
        "ends_at_ns": null,
        "max_uses": 10
    }});
    let allowance_change = json!({"SetAllowance": {
        "key": ALLOWANCE_KEY,
        "balance": (amount * 10).to_string(),
        "refill": (amount * 10).to_string(),
        "max_refill": (amount * 10).to_string(),
        "period_ns": 86_400_000_000_000u64
    }});
    let mut rule_hashes = Vec::new();
    let mut queue_ids = Vec::new();
    for change in [role_change, membership_change, allowance_change] {
        let queue_id: Value = vault
            .view("preview_rule_queue_id")
            .args_json(json!({"change": change.clone()}))
            .await?
            .json()?;
        rule_hashes.extend(
            execute_dao_call(
                &council,
                &dao_id,
                &vault,
                "queue_rule_change",
                json!({"change": change}),
            )
            .await?,
        );
        queue_ids.push(queue_id);
    }
    println!("OMNIROLES_RULE_DELAY_WAIT_SECONDS=305");
    sleep(Duration::from_secs(305)).await;
    for queue_id in queue_ids {
        let executed = owner
            .call(vault.id(), "execute_rule_change")
            .args_json(json!({"queue_id": queue_id}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        rule_hashes.push(tx_hash(&executed));
        executed.into_result()?;
    }

    let calldata = erc20_transfer(recipient, amount);
    let prepared = agent
        .call(vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": {
            "chain_id": CHAIN_ID,
            "target": token,
            "value": "0",
            "calldata": calldata,
            "allowance_amount": amount.to_string(),
            "reference": format!("OMNIROLES-UAT-{}", SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()),
            "gas_limit": "120000",
            "max_fee_per_gas": "100000000",
            "max_priority_fee_per_gas": "1000000"
        }}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let prepare_hash = tx_hash(&prepared);
    let operation: Value = prepared.into_result()?.json()?;
    let approval = approval(&visa_guard, &agent, &operation)?;
    let authorized = agent
        .call(vault.id(), "authorize")
        .args_json(json!({"op_id": operation["op_id"], "approval": approval}))
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    let authorize_hash = tx_hash(&authorized);
    authorized.into_result()?;
    let signed: Value = vault
        .view("get_operation")
        .args_json(json!({"op_id": operation["op_id"]}))
        .await?
        .json::<Option<Value>>()?
        .context("signed operation missing")?;
    let raw = format!(
        "0x{}",
        hex::encode(byte_array_any(&signed["signed_transaction"])?)
    );
    let publish_output = cast(&["publish", "--rpc-url", &base_rpc, &raw])?;
    let receipt: Value = if publish_output.trim_start().starts_with('{') {
        serde_json::from_str(&publish_output)?
    } else {
        serde_json::from_str(&cast(&[
            "receipt",
            "--rpc-url",
            &base_rpc,
            &publish_output,
            "--json",
        ])?)?
    };
    let base_hash = receipt["transactionHash"]
        .as_str()
        .unwrap_or(&publish_output)
        .to_owned();
    let status = receipt["status"].as_str().unwrap_or_default();
    if status != "0x1" && status != "1" {
        bail!("Base transaction reverted: {base_hash}");
    }
    let block_number = parse_quantity(&receipt["blockNumber"])?;
    let tx_hash_bytes: [u8; 32] = hex::decode(base_hash.trim_start_matches("0x"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Base hash must contain 32 bytes"))?;
    let report = status_report(&status_guard, &signed, tx_hash_bytes, block_number)?;
    let reported = owner
        .call(vault.id(), "report_status")
        .args_json(report)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let report_hash = tx_hash(&reported);
    reported.into_result()?;

    println!(
        "OMNIROLES_BASE_PAYMENT={}",
        serde_json::to_string(&json!({
            "dao": dao_id,
            "council": council.iter().map(Account::id).collect::<Vec<_>>(),
            "vault": vault.id(),
            "vault_access_keys": vault.view_access_keys().await?.len(),
            "wallet": wallet_address,
            "dao_create_near_tx": dao_create_hash,
            "deploy_near_tx": deploy_hash,
            "init_near_tx": init_hash,
            "wallet_derivation_near_txs": wallet_request_hashes,
            "rule_near_txs": rule_hashes,
            "key_delete_near_tx": key_delete_hash,
            "prepare_near_tx": prepare_hash,
            "authorize_near_tx": authorize_hash,
            "base_tx": base_hash,
            "report_near_tx": report_hash,
            "rule_delay_ns": RULE_DELAY_NS,
            "amount": amount.to_string(),
            "token": format!("0x{}", hex::encode(token)),
            "recipient": format!("0x{}", hex::encode(recipient))
        }))?
    );
    Ok(())
}

async fn execute_dao_call(
    council: &[Account],
    dao_id: &AccountId,
    receiver: &Contract,
    method_name: &str,
    args: Value,
) -> Result<Vec<String>> {
    let kind = json!({
        "FunctionCall": {
            "receiver_id": receiver.id(),
            "actions": [{
                "method_name": method_name,
                "args": STANDARD.encode(serde_json::to_vec(&args)?),
                "deposit": "0",
                "gas": Gas::from_tgas(100).as_gas().to_string()
            }]
        }
    });
    let proposed = council[0]
        .call(dao_id, "add_proposal")
        .args_json(json!({"proposal": {
            "description": format!("OmniRoles {method_name}"),
            "kind": kind.clone()
        }}))
        .deposit(NearToken::from_yoctonear(PROPOSAL_BOND))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let proposal_hash = tx_hash(&proposed);
    let proposal_id: u64 = proposed.into_result()?.json()?;
    let mut hashes = vec![proposal_hash];
    for member in council.iter().take(2) {
        let voted = member
            .call(dao_id, "act_proposal")
            .args_json(json!({
                "id": proposal_id,
                "action": "VoteApprove",
                "proposal": kind.clone(),
                "memo": null
            }))
            .gas(Gas::from_tgas(200))
            .transact()
            .await?;
        hashes.push(tx_hash(&voted));
        voted.into_result()?;
    }
    Ok(hashes)
}

async fn wait_for_funds(
    rpc: &str,
    token: &[u8; 20],
    wallet: &str,
    amount: u128,
    minimum_gas_wei: u128,
) -> Result<()> {
    let token_address = format!("0x{}", hex::encode(token));
    for _ in 0..120 {
        let eth = cast_number(&["balance", "--rpc-url", rpc, wallet])?;
        let tokens = cast_number(&[
            "call",
            "--rpc-url",
            rpc,
            &token_address,
            "balanceOf(address)(uint256)",
            wallet,
        ])?;
        if eth >= minimum_gas_wei && tokens >= amount {
            return Ok(());
        }
        sleep(Duration::from_secs(5)).await;
    }
    bail!("derived wallet was not funded within 10 minutes")
}

fn approval(guard: &SigningKey, agent: &Account, operation: &Value) -> Result<Value> {
    let op_id = array::<32>(&operation["op_id"])?;
    let tx_digest = array::<32>(&operation["tx_digest"])?;
    let reference = operation["request"]["reference"]
        .as_str()
        .context("reference")?
        .to_owned();
    let expires_at_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .saturating_add(120_000_000_000)
        .try_into()?;
    let visa = VisaForSigning {
        client_id: "acme-omniroles".to_owned(),
        op_id,
        tx_digest,
        agent: agent.id().to_string(),
        role: ROLE.to_owned(),
        reference: reference.clone(),
        policy_version: 1,
        registry_version: 1,
        visa_nonce: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        expires_at_ns,
    };
    let mut message = b"mandateos:visa:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&visa)?);
    Ok(json!({
        "visa": VisaJson {
            client_id: visa.client_id,
            op_id,
            tx_digest,
            agent: visa.agent,
            role: visa.role,
            reference,
            policy_version: 1,
            registry_version: 1,
            visa_nonce: visa.visa_nonce,
            expires_at_ns: expires_at_ns.to_string()
        },
        "signature": STANDARD.encode(guard.sign(&message).to_bytes())
    }))
}

fn status_report(
    guard: &SigningKey,
    operation: &Value,
    tx_hash: [u8; 32],
    block_number: u64,
) -> Result<Value> {
    let report_nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let report = StatusForSigning {
        client_id: "acme-omniroles".to_owned(),
        op_id: array::<32>(&operation["op_id"])?,
        kind: StatusKindForSigning::Confirmed,
        tx_hash,
        report_nonce,
        block_number,
    };
    let mut message = b"mandateos:status:v1".to_vec();
    message.extend_from_slice(&borsh::to_vec(&report)?);
    Ok(json!({"signed_report": {"report": {
        "client_id": report.client_id,
        "op_id": report.op_id,
        "kind": "Confirmed",
        "tx_hash": tx_hash,
        "report_nonce": report_nonce,
        "block_number": block_number
    }, "signature": STANDARD.encode(guard.sign(&message).to_bytes())}, "mpc_signature": null}))
}

fn erc20_transfer(recipient: [u8; 20], amount: u128) -> Vec<u8> {
    let mut calldata = vec![0xa9, 0x05, 0x9c, 0xbb];
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(&recipient);
    calldata.extend_from_slice(&[0u8; 16]);
    calldata.extend_from_slice(&amount.to_be_bytes());
    calldata
}

fn council_policy(council: &[Account]) -> Value {
    json!({
        "roles": [{
            "name": "council",
            "kind": {
                "Group": council.iter().map(|member| member.id().to_string()).collect::<Vec<_>>()
            },
            "permissions": [
                "*:AddProposal",
                "*:VoteApprove",
                "*:VoteReject",
                "*:VoteRemove",
                "*:Finalize"
            ],
            "vote_policy": {}
        }],
        "default_vote_policy": {
            "weight_kind": "RoleWeight",
            "quorum": "0",
            "threshold": "2"
        },
        "proposal_bond": PROPOSAL_BOND.to_string(),
        "proposal_period": "604800000000000",
        "bounty_bond": PROPOSAL_BOND.to_string(),
        "bounty_forgiveness_period": "604800000000000"
    })
}

fn account_from_env(
    worker: &near_workspaces::Worker<near_workspaces::network::Testnet>,
    id_name: &str,
    key_name: &str,
) -> Result<Account> {
    let account_id = env(id_name)?.parse()?;
    let secret_key = env(key_name)?.parse::<SecretKey>()?;
    Ok(Account::from_secret_key(account_id, secret_key, worker))
}

fn address(value: &str) -> Result<[u8; 20]> {
    hex::decode(value.trim_start_matches("0x"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("EVM address must contain 20 bytes"))
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is required"))
}

fn cast(args: &[&str]) -> Result<String> {
    let output = Command::new("cast").args(args).output()?;
    if !output.status.success() {
        bail!(
            "cast {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn cast_number(args: &[&str]) -> Result<u128> {
    let output = cast(args)?;
    output
        .split_whitespace()
        .next()
        .context("cast numeric output")?
        .parse()
        .map_err(Into::into)
}

fn parse_quantity(value: &Value) -> Result<u64> {
    let raw = value.as_str().context("quantity")?;
    Ok(if let Some(hex) = raw.strip_prefix("0x") {
        u64::from_str_radix(hex, 16)?
    } else {
        raw.parse()?
    })
}

fn byte_array_any(value: &Value) -> Result<Vec<u8>> {
    value
        .as_array()
        .context("byte array")?
        .iter()
        .map(|item| Ok(item.as_u64().context("byte")? as u8))
        .collect()
}

fn byte_array(value: &Value, len: usize) -> Result<Vec<u8>> {
    let bytes = byte_array_any(value)?;
    if bytes.len() != len {
        bail!("expected {len} bytes, got {}", bytes.len());
    }
    Ok(bytes)
}

fn array<const N: usize>(value: &Value) -> Result<[u8; N]> {
    byte_array(value, N)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected {N} bytes"))
}

fn tx_hash(outcome: &ExecutionFinalResult) -> String {
    outcome.outcome().transaction_hash.to_string()
}
