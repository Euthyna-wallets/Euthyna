//! Sealed orders end to end in the sandbox: a DAO seals a commitment, a fill proves the hidden terms
//! with a real UltraHonk proof (made at test time by circuits/sealed-order/prove.mjs, since a proof
//! states the time it was made), the contract verifies it on chain and the vault prepares and signs
//! the swap as for any member of the role. Needs `node` and apps/api's node_modules (pnpm install).

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};
use serial_test::serial;
use std::io::Write as _;
use std::process::{Command, Stdio};

const VAULT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/vault.wasm"));
const MOCK_MPC_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/mock_mpc.wasm"));
const SEALED_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/sealed_orders.wasm"
));
const MPC_PUBLIC_KEY: &str = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";

const CHAIN_ID: u64 = 84_532;
const ROLE: &str = "sealed-orders";
const USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const WETH: &str = "0x4200000000000000000000000000000000000006";
const ROUTER: &str = "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4";
const FEE: u32 = 3000;
const ALLOWANCE_KEY: [u8; 32] = [0x5e; 32];
/// The role's public budget: 5 USDC.
const BUDGET: u128 = 5_000_000;
/// The order's hidden terms: at least 3e8 wei per USDC unit (2 500 USDC/ETH is 4e8), 8 USDC in all.
const SCALE: u128 = 1_000_000_000_000_000_000;
const LIMIT_RATE: u128 = 300_000_000 * SCALE;
const CAP: u128 = 8_000_000;
const SALT: &str = "0x1234567890abcdef";
const SLIPPAGE_BPS: u16 = 50;

struct Setup {
    worker: Worker<Sandbox>,
    dao: Account,
    stranger: Account,
    vault: Contract,
    sealed: Contract,
}

fn word_hex(bytes: &[u8]) -> String {
    format!("0x{}{}", "00".repeat(32 - bytes.len()), hex::encode(bytes))
}

fn address(text: &str) -> Vec<u8> {
    hex::decode(text.trim_start_matches("0x")).unwrap()
}

/// exactInputSingle(tokenIn == USDC, tokenOut == WETH, fee any, recipient == wallet, amountIn within the
/// budget, amountOutMinimum > 0, sqrtPriceLimit any): the tree `uniswapV3Sheet` builds in the SDK.
fn role_config() -> Value {
    json!({
        "enabled": true,
        "permissions": [{
            "chain_id": CHAIN_ID,
            "target": address(ROUTER),
            "selector": [0x04, 0xe4, 0x5a, 0xaf],
            "conditions": [
                {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
                {"parent": 0, "paramType": 3, "operator": 5, "compValue": "0x"},
                {"parent": 1, "paramType": 1, "operator": 16, "compValue": word_hex(&address(USDC))},
                {"parent": 1, "paramType": 1, "operator": 16, "compValue": word_hex(&address(WETH))},
                {"parent": 1, "paramType": 1, "operator": 0, "compValue": "0x"},
                {"parent": 1, "paramType": 1, "operator": 15, "compValue": "0x"},
                {"parent": 1, "paramType": 1, "operator": 28, "compValue": format!("0x{}", hex::encode(ALLOWANCE_KEY))},
                {"parent": 1, "paramType": 1, "operator": 17, "compValue": word_hex(&[0])},
                {"parent": 1, "paramType": 1, "operator": 0, "compValue": "0x"}
            ],
            "allow_value": false
        }],
        "operation_delay_threshold": null,
        "operation_delay_ns": 0,
        "co_sign_threshold": null,
        "co_signer_role": null,
        "velocity": null,
        "gas_limit": "300000",
        "max_fee_per_gas": "100000000000",
        "max_priority_fee_per_gas": "10000000000",
        "max_total_fee": "30000000000000000"
    })
}

async fn apply(
    worker: &Worker<Sandbox>,
    dao: &Account,
    vault: &Contract,
    change: Value,
) -> Result<()> {
    let queued: Value = dao
        .call(vault.id(), "queue_rule_change")
        .args_json(json!({ "change": change }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    tests::wait_until_timestamp(
        worker,
        queued["execute_after_ns"].as_str().unwrap().parse()?,
    )
    .await?;
    dao.call(vault.id(), "execute_rule_change")
        .args_json(json!({ "queue_id": queued["queue_id"] }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn setup() -> Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let make = |name: &'static str| {
        let root = root.clone();
        async move {
            anyhow::Ok(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_near(30))
                    .transact()
                    .await?
                    .into_result()?,
            )
        }
    };
    let dao = make("acme-dao").await?;
    let council = make("council").await?;
    let stranger = make("stranger").await?;
    let vault = make("acme-vault")
        .await?
        .deploy(VAULT_WASM)
        .await?
        .into_result()?;
    let mpc = make("mpc")
        .await?
        .deploy(MOCK_MPC_WASM)
        .await?
        .into_result()?;
    let sealed = make("sealed")
        .await?
        .deploy(SEALED_WASM)
        .await?
        .into_result()?;
    mpc.call("new")
        .args_json(json!({ "public_key": MPC_PUBLIC_KEY }))
        .transact()
        .await?
        .into_result()?;
    sealed.call("new").transact().await?.into_result()?;
    let key = base64_key();
    vault
        .call("new")
        .args_json(json!({
            "client_id": "acme",
            "owner_id": dao.id(),
            "mpc_contract_id": mpc.id(),
            "visa_public_key": key,
            "status_public_key": key,
            "policy_version": 1,
            "registry_version": 1,
            "operation_ttl_ns": 120_000_000_000u64,
            "rule_delay_ns": 1_000_000_000u64,
            "rule_expiration_ns": 60_000_000_000u64,
            "council": [council.id()]
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    dao.call(vault.id(), "request_wallet")
        .args_json(json!({ "chain_id": CHAIN_ID }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    apply(
        &worker,
        &dao,
        &vault,
        json!({ "SetRole": { "role": ROLE, "config": role_config() } }),
    )
    .await?;
    apply(
        &worker,
        &dao,
        &vault,
        json!({ "SetAllowance": {
        "key": ALLOWANCE_KEY, "balance": BUDGET.to_string(), "refill": "0",
        "max_refill": BUDGET.to_string(), "period_ns": 86_400_000_000_000u64
    } }),
    )
    .await?;
    apply(
        &worker,
        &dao,
        &vault,
        json!({ "GrantMembership": {
        "role": ROLE, "member": sealed.id(), "kind": "Agent",
        "starts_at_ns": "0", "ends_at_ns": null, "max_uses": null
    } }),
    )
    .await?;
    Ok(Setup {
        worker,
        dao,
        stranger,
        vault,
        sealed,
    })
}

fn base64_key() -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode([9u8; 32])
}

/// Runs circuits/sealed-order/prove.mjs.
fn prover(input: Value) -> Result<Value> {
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../circuits/sealed-order/prove.mjs"
    );
    let mut child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("node is needed for the sealed-order prover")?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())?;
    let output = child.wait_with_output()?;
    anyhow::ensure!(
        output.status.success(),
        "prover failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout)?;
    Ok(serde_json::from_str(
        stdout.lines().last().context("no output")?,
    )?)
}

fn order(vault: &Contract, expiry: u64) -> Value {
    json!({
        "vaultId": vault.id().as_str(), "chainId": CHAIN_ID, "tokenIn": USDC, "tokenOut": WETH, "fee": FEE,
        "limitRate": LIMIT_RATE.to_string(), "cap": CAP.to_string(), "expiry": expiry, "salt": SALT
    })
}

async fn now_s(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

async fn configure(s: &Setup, caller: &Account) -> Result<ExecutionFinalResult> {
    Ok(caller
        .call(s.sealed.id(), "configure")
        .args_json(json!({
            "vault": s.vault.id(), "role": ROLE, "chain_id": CHAIN_ID,
            "router": ROUTER, "slippage_bps": SLIPPAGE_BPS
        }))
        .deposit(NearToken::from_millinear(10))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?)
}

async fn seal(s: &Setup, commitment: &str) -> Result<u64> {
    Ok(s.dao
        .call(s.sealed.id(), "seal")
        .args_json(json!({ "commitment": commitment }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn fill(
    s: &Setup,
    id: u64,
    proved: &Value,
    amount: u128,
    rate: u128,
    now: u64,
) -> Result<ExecutionFinalResult> {
    Ok(s.stranger
        .call(s.sealed.id(), "fill")
        .args_json(json!({
            "dao": s.dao.id(), "id": id, "token_in": USDC, "token_out": WETH, "fee": FEE,
            "amount_in": amount.to_string(), "rate": rate.to_string(), "now_s": now.to_string(),
            "proof": proved["proof"],
            "gas_limit": "250000", "max_fee_per_gas": "2000000000", "max_priority_fee_per_gas": "1000000"
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn get_order(s: &Setup, id: u64) -> Result<Value> {
    Ok(s.sealed
        .view("order")
        .args_json(json!({ "dao": s.dao.id(), "id": id }))
        .await?
        .json()?)
}

fn prove_input(
    vault: &Contract,
    expiry: u64,
    amount: u128,
    filled: u128,
    rate: u128,
    now: u64,
) -> Value {
    let mut input = order(vault, expiry);
    let extra = json!({ "mode": "prove", "amountIn": amount.to_string(), "filledBefore": filled.to_string(), "rate": rate.to_string(), "now": now });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    input
}

fn logs(outcome: &ExecutionFinalResult) -> String {
    outcome.logs().join("\n")
}

#[tokio::test]
#[serial]
async fn only_the_vault_owner_configures_and_a_proven_fill_becomes_a_signed_swap() -> Result<()> {
    let s = setup().await?;

    // A stranger cannot point the contract at someone else's vault.
    let refused: bool = configure(&s, &s.stranger).await?.into_result()?.json()?;
    assert!(!refused);
    let none: Option<Value> = s
        .sealed
        .view("config")
        .args_json(json!({ "dao": s.stranger.id() }))
        .await?
        .json()?;
    assert!(none.is_none());

    let accepted: bool = configure(&s, &s.dao).await?.into_result()?.json()?;
    assert!(accepted);
    let config: Value = s
        .sealed
        .view("config")
        .args_json(json!({ "dao": s.dao.id() }))
        .await?
        .json()?;
    let wallet = config["wallet"].as_str().unwrap().to_string();
    assert_eq!(wallet.len(), 42);

    let now = now_s(&s.worker).await?;
    let expiry = now + 86_400;
    let mut commit = order(&s.vault, expiry);
    commit["mode"] = json!("commit");
    let sealed = prover(commit)?;
    assert_eq!(
        config["vault_tag"], sealed["vaultTag"],
        "the contract and the prover tag the vault alike"
    );
    let id = seal(&s, sealed["commitment"].as_str().unwrap()).await?;
    let stored = get_order(&s, id).await?;
    // On chain: one hash. No pair, no rate, no cap, no date.
    assert_eq!(stored["commitment"], sealed["commitment"]);
    assert_eq!(stored["filled"], "0");

    // Fill 1 USDC at 4e8 wei per unit (the market), above the hidden 3e8.
    let rate = 400_000_000 * SCALE;
    let now = now_s(&s.worker).await?;
    let proved = prover(prove_input(&s.vault, expiry, 1_000_000, 0, rate, now))?;
    let outcome = fill(&s, id, &proved, 1_000_000, rate, now).await?;
    println!("fill: {} Tgas burnt", outcome.total_gas_burnt.as_tgas());
    let all_logs = logs(&outcome);
    assert!(
        outcome.is_success(),
        "{:?}",
        outcome.clone().into_result().err()
    );
    assert!(
        all_logs.contains("OMNIROLES_OPERATION_PREPARED"),
        "{all_logs}"
    );
    assert!(all_logs.contains("\"event\":\"filled\""), "{all_logs}");
    let stored = get_order(&s, id).await?;
    assert_eq!(stored["filled"], "1000000");
    assert_eq!(stored["fills"], 1);

    // The vault reserved the role's budget and signed the swap it built from the proof.
    let allowance: Value = s
        .vault
        .view("get_allowance")
        .args_json(json!({ "key": ALLOWANCE_KEY }))
        .await?
        .json()?;
    assert_eq!(allowance["reserved"], "1000000");
    let filled_event: Value = all_logs
        .lines()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|event| event["event"] == "filled")
        .context("filled event")?;
    let op_id = filled_event["data"][0]["op_id"].clone();
    let operation: Value = s
        .vault
        .view("get_operation")
        .args_json(json!({ "op_id": op_id }))
        .await?
        .json()?;
    assert!(
        !operation["signed_transaction"].is_null(),
        "the MPC signed the swap"
    );
    let calldata: Vec<u8> = operation["request"]["calldata"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    assert_eq!(&calldata[..4], &[0x04, 0xe4, 0x5a, 0xaf]);
    // recipient: the company wallet; amountOutMinimum: 1 USDC at 4e8 wei per unit, less 0.5%.
    assert_eq!(
        format!("0x{}", hex::encode(&calldata[4 + 3 * 32 + 12..4 + 4 * 32])),
        wallet
    );
    let min_out = u128::from_be_bytes(calldata[4 + 5 * 32 + 16..4 + 6 * 32].try_into().unwrap());
    assert_eq!(min_out, 398_000_000_000_000);

    // The same proof again: the filled amount moved, so its public inputs no longer match.
    let replay = fill(&s, id, &proved, 1_000_000, rate, now).await?;
    assert!(format!("{:?}", replay.into_result().err()).contains("ERR_PROOF_INVALID"));

    // A claimed rate other than the one proved fails too.
    let now = now_s(&s.worker).await?;
    let proved = prover(prove_input(
        &s.vault, expiry, 1_000_000, 1_000_000, rate, now,
    ))?;
    let forged = fill(&s, id, &proved, 1_000_000, rate + 1, now).await?;
    assert!(format!("{:?}", forged.into_result().err()).contains("ERR_PROOF_INVALID"));

    // A rate under the hidden limit cannot even be proved.
    let low = prover(prove_input(
        &s.vault,
        expiry,
        1_000_000,
        1_000_000,
        LIMIT_RATE - 1,
        now,
    ));
    assert!(format!("{:?}", low.err()).contains("rate below the limit"));
    // Nor more than the hidden cap: 1 filled + 7.5 > 8.
    let over = prover(prove_input(
        &s.vault, expiry, 7_500_000, 1_000_000, rate, now,
    ));
    assert!(format!("{:?}", over.err()).contains("over the cap"));
    Ok(())
}

#[tokio::test]
#[serial]
async fn the_role_still_decides_and_a_refused_fill_gives_the_amount_back() -> Result<()> {
    let s = setup().await?;
    assert!(configure(&s, &s.dao).await?.into_result()?.json::<bool>()?);
    let now = now_s(&s.worker).await?;
    let expiry = now + 86_400;
    let mut commit = order(&s.vault, expiry);
    commit["mode"] = json!("commit");
    let sealed = prover(commit)?;
    let id = seal(&s, sealed["commitment"].as_str().unwrap()).await?;

    // 6 USDC fits the hidden cap (8) but not the role's public budget (5): the vault refuses,
    // and the order gets the 6 back.
    let rate = 400_000_000 * SCALE;
    let proved = prover(prove_input(&s.vault, expiry, 6_000_000, 0, rate, now))?;
    let outcome = fill(&s, id, &proved, 6_000_000, rate, now).await?;
    let all_logs = logs(&outcome);
    assert!(all_logs.contains("fill_failed"), "{all_logs}");
    assert_eq!(get_order(&s, id).await?["filled"], "0");

    // A cancelled order cannot fill, even with a valid proof.
    let not_dao = s
        .stranger
        .call(s.sealed.id(), "cancel")
        .args_json(json!({ "id": id }))
        .transact()
        .await?;
    assert!(format!("{:?}", not_dao.into_result().err()).contains("ERR_ORDER_NOT_FOUND"));
    s.dao
        .call(s.sealed.id(), "cancel")
        .args_json(json!({ "id": id }))
        .transact()
        .await?
        .into_result()?;
    let now = now_s(&s.worker).await?;
    let proved = prover(prove_input(&s.vault, expiry, 1_000_000, 0, rate, now))?;
    let refused = fill(&s, id, &proved, 1_000_000, rate, now).await?;
    assert!(format!("{:?}", refused.into_result().err()).contains("ERR_ORDER_CANCELLED"));

    // A proof made long ago is refused: the deadline is checked against a recent time.
    let id = seal(&s, sealed["commitment"].as_str().unwrap()).await?;
    let old = now - 3_600;
    let proved = prover(prove_input(&s.vault, expiry, 1_000_000, 0, rate, old))?;
    let stale = fill(&s, id, &proved, 1_000_000, rate, old).await?;
    assert!(format!("{:?}", stale.into_result().err()).contains("ERR_PROOF_TIME"));
    Ok(())
}
