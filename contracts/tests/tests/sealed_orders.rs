//! Sealed orders end to end in the sandbox, with a real Sputnik DAO owning the vault: a role whose
//! members are an agent and the sealed-orders contract, orders sealed by the agent or by a DAO vote,
//! fills proved with real UltraHonk proofs (made at test time by circuits/sealed-order/prove.mjs,
//! since a proof states the time it was made) and verified on chain, the vault preparing and the
//! (mock) MPC signing the swap. Needs `node` and apps/api's node_modules (pnpm install).

#[allow(dead_code)]
mod common;

use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use common::{Fixture, add_proposal, preview_queue_id, proposal_status, setup, vote};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use serial_test::serial;
use std::io::Write as _;
use std::process::{Command, Stdio};

const SEALED_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/sealed_orders.wasm"
));

const CHAIN_ID: u64 = 84_532;
const ROLE: &str = "treasury-desk";
const USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const WETH: &str = "0x4200000000000000000000000000000000000006";
const ROUTER: &str = "0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4";
const FEE: u32 = 3000;
const ALLOWANCE_KEY: [u8; 32] = [0x5e; 32];
/// The role's public budget: 5 USDC a day; approvals up to 20.
const BUDGET: u128 = 5_000_000;
const MAX_APPROVAL: u128 = 20_000_000;
/// The order's hidden terms: at least 3e8 wei per USDC unit (2 500 USDC/ETH is 4e8), 8 USDC in all.
const SCALE: u128 = 1_000_000_000_000_000_000;
const LIMIT_RATE: u128 = 300_000_000 * SCALE;
const CAP: u128 = 8_000_000;
const SALT: &str = "0x1234567890abcdef";
const SLIPPAGE_BPS: u16 = 50;
const DEPOSIT: NearToken = NearToken::from_millinear(20);

struct Setup {
    f: Fixture,
    agent: Account,
    sealed: Contract,
}

fn word_hex(bytes: &[u8]) -> String {
    format!("0x{}{}", "00".repeat(32 - bytes.len()), hex::encode(bytes))
}
fn address(text: &str) -> Vec<u8> {
    hex::decode(text.trim_start_matches("0x")).unwrap()
}

/// The swap block's two permissions, as `swapSheets` builds them: exactInputSingle (USDC → WETH,
/// recipient the wallet, amount within the budget) and approve (router only, at most 20 USDC).
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
        }, {
            "chain_id": CHAIN_ID,
            "target": address(USDC),
            "selector": [0x09, 0x5e, 0xa7, 0xb3],
            "conditions": [
                {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
                {"parent": 0, "paramType": 1, "operator": 16, "compValue": word_hex(&address(ROUTER))},
                {"parent": 0, "paramType": 1, "operator": 18, "compValue": word_hex(&(MAX_APPROVAL + 1).to_be_bytes())}
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

fn kind(receiver: &str, method: &str, args: Value, deposit: NearToken, gas_tgas: u64) -> Value {
    json!({ "FunctionCall": { "receiver_id": receiver, "actions": [{
        "method_name": method,
        "args": STANDARD.encode(serde_json::to_vec(&args).unwrap()),
        "deposit": deposit.as_yoctonear().to_string(),
        "gas": Gas::from_tgas(gas_tgas).as_gas().to_string()
    }] } })
}

/// A DAO vote: proposed and approved by two of the three council members.
async fn dao_call(
    f: &Fixture,
    receiver: &str,
    method: &str,
    args: Value,
    deposit: NearToken,
    gas_tgas: u64,
) -> Result<()> {
    let kind = kind(receiver, method, args, deposit, gas_tgas);
    let id = add_proposal(f, &f.council[0], kind.clone()).await?;
    vote(f, &f.council[0], id, kind.clone())
        .await?
        .into_result()?;
    vote(f, &f.council[1], id, kind).await?.into_result()?;
    anyhow::ensure!(
        proposal_status(f, id).await? == "Approved",
        "proposal {id} not approved"
    );
    Ok(())
}

async fn rule(f: &Fixture, change: Value) -> Result<()> {
    let queue_id = preview_queue_id(f, change.clone()).await?;
    dao_call(
        f,
        f.vault.id().as_str(),
        "queue_rule_change",
        json!({ "change": change }),
        NearToken::from_yoctonear(0),
        80,
    )
    .await?;
    let now = f.worker.view_block().await?.timestamp();
    tests::wait_until_timestamp(&f.worker, now + 2_000_000_000).await?;
    f.outsider
        .call(f.vault.id(), "execute_rule_change")
        .args_json(json!({ "queue_id": queue_id }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

fn grant(member: &str) -> Value {
    json!({ "GrantMembership": { "role": ROLE, "member": member, "kind": "Agent", "starts_at_ns": "0", "ends_at_ns": null, "max_uses": null } })
}

/// The DAO's vault with the role and its budget; the agent a member; the contract a member only
/// when `contract_in_role`.
async fn setup_sealed(contract_in_role: bool) -> Result<Setup> {
    let f = setup().await?;
    let agent = f.worker.dev_create_account().await?;
    let sealed = f.worker.dev_deploy(SEALED_WASM).await?;
    sealed.call("new").transact().await?.into_result()?;
    dao_call(
        &f,
        f.vault.id().as_str(),
        "request_wallet",
        json!({ "chain_id": CHAIN_ID }),
        NearToken::from_yoctonear(0),
        80,
    )
    .await?;
    rule(
        &f,
        json!({ "SetRole": { "role": ROLE, "config": role_config() } }),
    )
    .await?;
    rule(
        &f,
        json!({ "SetAllowance": {
        "key": ALLOWANCE_KEY, "balance": BUDGET.to_string(), "refill": "0",
        "max_refill": BUDGET.to_string(), "period_ns": 86_400_000_000_000u64
    } }),
    )
    .await?;
    rule(&f, grant(agent.id().as_str())).await?;
    if contract_in_role {
        rule(&f, grant(sealed.id().as_str())).await?;
    }
    Ok(Setup { f, agent, sealed })
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

fn order_terms(vault: &Contract, expiry: u64) -> Value {
    json!({
        "vaultId": vault.id().as_str(), "chainId": CHAIN_ID, "tokenIn": USDC, "tokenOut": WETH, "fee": FEE,
        "limitRate": LIMIT_RATE.to_string(), "cap": CAP.to_string(), "expiry": expiry, "salt": SALT
    })
}

fn commitment(vault: &Contract, expiry: u64) -> Result<String> {
    let mut input = order_terms(vault, expiry);
    input["mode"] = json!("commit");
    Ok(prover(input)?["commitment"].as_str().unwrap().to_string())
}

fn prove(
    vault: &Contract,
    expiry: u64,
    amount: u128,
    filled: u128,
    rate: u128,
    now: u64,
) -> Result<Value> {
    let mut input = order_terms(vault, expiry);
    let extra = json!({ "mode": "prove", "amountIn": amount.to_string(), "filledBefore": filled.to_string(), "rate": rate.to_string(), "now": now });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    prover(input)
}

fn seal_args(s: &Setup, commitment: &str, terms: Option<&str>) -> Value {
    json!({ "vault": s.f.vault.id(), "role": ROLE, "chain_id": CHAIN_ID, "commitment": commitment, "slippage_bps": SLIPPAGE_BPS, "terms": terms })
}

async fn seal_as(
    s: &Setup,
    who: &Account,
    commitment: &str,
    terms: Option<&str>,
) -> Result<Option<Value>> {
    Ok(who
        .call(s.sealed.id(), "seal")
        .args_json(seal_args(s, commitment, terms))
        .deposit(DEPOSIT)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn now_s(s: &Setup) -> Result<u64> {
    Ok(s.f.worker.view_block().await?.timestamp() / 1_000_000_000)
}

async fn fill(
    s: &Setup,
    id: u64,
    proved: &Value,
    amount: u128,
    rate: u128,
    now: u64,
) -> Result<ExecutionFinalResult> {
    Ok(s.f.outsider
        .call(s.sealed.id(), "fill")
        .args_json(json!({
            "vault": s.f.vault.id(), "id": id, "router": ROUTER, "token_in": USDC, "token_out": WETH, "fee": FEE,
            "amount_in": amount.to_string(), "rate": rate.to_string(), "now_s": now.to_string(), "proof": proved["proof"],
            "gas_limit": "250000", "max_fee_per_gas": "2000000000", "max_priority_fee_per_gas": "1000000"
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn get_order(s: &Setup, id: u64) -> Result<Value> {
    Ok(s.sealed
        .view("order")
        .args_json(json!({ "vault": s.f.vault.id(), "id": id }))
        .await?
        .json()?)
}

fn events(outcome: &ExecutionFinalResult) -> Vec<Value> {
    outcome
        .logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn event<'a>(all: &'a [Value], name: &str) -> Option<&'a Value> {
    all.iter().find(|event| event["event"] == name)
}

async fn calldata_of(s: &Setup, op_id: &Value) -> Result<(Value, Vec<u8>)> {
    let operation: Value =
        s.f.vault
            .view("get_operation")
            .args_json(json!({ "op_id": op_id }))
            .await?
            .json()?;
    let calldata = operation["request"]["calldata"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    Ok((operation, calldata))
}

#[tokio::test]
#[serial]
async fn an_agent_or_the_dao_seals_and_a_proven_fill_becomes_a_signed_swap() -> Result<()> {
    let s = setup_sealed(true).await?;
    let now = now_s(&s).await?;
    let expiry = now + 86_400;
    let commitment = commitment(&s.f.vault, expiry)?;

    // A stranger (not the owner, not in the role) cannot seal; the deposit comes back.
    assert!(
        seal_as(&s, &s.f.outsider, &commitment, None)
            .await?
            .is_none()
    );

    // The agent, a member of the role, seals with the terms encrypted for the members.
    let order = seal_as(&s, &s.agent, &commitment, Some("eyJ2IjoxfQ=="))
        .await?
        .context("agent seal")?;
    assert_eq!(order["id"], 0);
    assert_eq!(order["sealer"], s.agent.id().as_str());
    assert_eq!(order["terms"], "eyJ2IjoxfQ==");
    let wallet = order["wallet"].as_str().unwrap().to_string();
    assert_eq!(wallet.len(), 42);
    // On chain: the hash, the role, the wallet, the ciphertext. No pair, no rate, no cap, no date.
    assert_eq!(order["commitment"], commitment.as_str());

    // The DAO seals one by a vote, with its deposit attached to the proposal.
    dao_call(
        &s.f,
        s.sealed.id().as_str(),
        "seal",
        seal_args(&s, &commitment, None),
        DEPOSIT,
        100,
    )
    .await?;
    assert_eq!(get_order(&s, 1).await?["sealer"], s.f.dao.id().as_str());

    // The agent approves the router through the vault, within the role's 20 USDC cap.
    let approve = |who: &Account, amount: u128| {
        who.call(s.sealed.id(), "approve")
            .args_json(json!({
                "vault": s.f.vault.id(), "role": ROLE, "chain_id": CHAIN_ID, "token": USDC, "router": ROUTER,
                "amount": amount.to_string(), "gas_limit": "80000", "max_fee_per_gas": "2000000000", "max_priority_fee_per_gas": "1000000"
            }))
            .gas(Gas::from_tgas(300))
            .transact()
    };
    let approved = approve(&s.agent, MAX_APPROVAL).await?;
    let approved_events = events(&approved);
    let op = event(&approved_events, "approved").context(format!(
        "approved: {:?} {:?}",
        approved.logs(),
        approved.receipt_failures()
    ))?["data"][0]["op_id"]
        .clone();
    let (operation, calldata) = calldata_of(&s, &op).await?;
    assert!(!operation["signed_transaction"].is_null());
    assert_eq!(&calldata[..4], &[0x09, 0x5e, 0xa7, 0xb3]);
    assert_eq!(
        format!("0x{}", hex::encode(&calldata[4 + 12..4 + 32])),
        ROUTER
    );
    // Over the role's cap the vault refuses; a stranger is refused before the vault.
    assert!(
        event(
            &events(&approve(&s.agent, MAX_APPROVAL + 1).await?),
            "failed"
        )
        .is_some()
    );
    assert!(!approve(&s.f.outsider, 1).await?.json::<bool>()?);

    // Anyone with the proof fills order 0: 1 USDC at 4e8 wei per unit, above the hidden 3e8.
    let rate = 400_000_000 * SCALE;
    let now = now_s(&s).await?;
    let proved = prove(&s.f.vault, expiry, 1_000_000, 0, rate, now)?;
    let outcome = fill(&s, 0, &proved, 1_000_000, rate, now).await?;
    println!("fill: {} Tgas burnt", outcome.total_gas_burnt.as_tgas());
    let fill_events = events(&outcome);
    let filled = event(&fill_events, "filled").context(format!("filled: {:?}", outcome.logs()))?;
    let (operation, calldata) = calldata_of(&s, &filled["data"][0]["op_id"]).await?;
    assert!(
        !operation["signed_transaction"].is_null(),
        "the MPC signed the swap"
    );
    assert_eq!(&calldata[..4], &[0x04, 0xe4, 0x5a, 0xaf]);
    assert_eq!(
        format!("0x{}", hex::encode(&calldata[4 + 3 * 32 + 12..4 + 4 * 32])),
        wallet
    );
    let min_out = u128::from_be_bytes(calldata[4 + 5 * 32 + 16..4 + 6 * 32].try_into().unwrap());
    assert_eq!(min_out, 398_000_000_000_000);
    assert_eq!(get_order(&s, 0).await?["filled"], "1000000");

    // The same proof again, or a claimed rate other than the one proved: refused.
    assert!(
        format!(
            "{:?}",
            fill(&s, 0, &proved, 1_000_000, rate, now)
                .await?
                .into_result()
                .err()
        )
        .contains("ERR_PROOF_INVALID")
    );
    let now = now_s(&s).await?;
    let proved = prove(&s.f.vault, expiry, 1_000_000, 1_000_000, rate, now)?;
    assert!(
        format!(
            "{:?}",
            fill(&s, 0, &proved, 1_000_000, rate + 1, now)
                .await?
                .into_result()
                .err()
        )
        .contains("ERR_PROOF_INVALID")
    );
    // Under the hidden limit or over the hidden cap, no proof exists.
    assert!(
        format!(
            "{:?}",
            prove(
                &s.f.vault,
                expiry,
                1_000_000,
                1_000_000,
                LIMIT_RATE - 1,
                now
            )
            .err()
        )
        .contains("rate below the limit")
    );
    assert!(
        format!(
            "{:?}",
            prove(&s.f.vault, expiry, 7_500_000, 1_000_000, rate, now).err()
        )
        .contains("over the cap")
    );

    // Cancelling: the agent cannot cancel the DAO's order; the DAO cancels the agent's by a vote.
    let refused: bool = s
        .agent
        .call(s.sealed.id(), "cancel")
        .args_json(json!({ "vault": s.f.vault.id(), "id": 1 }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .json()?;
    assert!(!refused);
    dao_call(
        &s.f,
        s.sealed.id().as_str(),
        "cancel",
        json!({ "vault": s.f.vault.id(), "id": 0 }),
        NearToken::from_yoctonear(0),
        50,
    )
    .await?;
    assert_eq!(get_order(&s, 0).await?["cancelled"], true);
    let proved = prove(&s.f.vault, expiry, 1_000_000, 1_000_000, rate, now)?;
    assert!(
        format!(
            "{:?}",
            fill(&s, 0, &proved, 1_000_000, rate, now)
                .await?
                .into_result()
                .err()
        )
        .contains("ERR_ORDER_CANCELLED")
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn the_role_still_decides_and_members_register_reading_keys() -> Result<()> {
    let s = setup_sealed(false).await?;
    let now = now_s(&s).await?;
    let expiry = now + 86_400;
    let commitment = commitment(&s.f.vault, expiry)?;

    // Without the contract in the role, no order: it could never fill.
    assert!(seal_as(&s, &s.agent, &commitment, None).await?.is_none());
    rule(&s.f, grant(s.sealed.id().as_str())).await?;
    let id = seal_as(&s, &s.agent, &commitment, None)
        .await?
        .context("seal")?["id"]
        .as_u64()
        .unwrap();

    // 6 USDC fits the hidden cap (8) but not the role's public budget (5): the vault refuses and the
    // order gets the 6 back.
    let rate = 400_000_000 * SCALE;
    let proved = prove(&s.f.vault, expiry, 6_000_000, 0, rate, now)?;
    let outcome = fill(&s, id, &proved, 6_000_000, rate, now).await?;
    assert!(
        event(&events(&outcome), "failed").is_some(),
        "{:?}",
        outcome.logs()
    );
    assert_eq!(get_order(&s, id).await?["filled"], "0");

    // A proof made long ago is refused: the deadline is checked against a recent time.
    let old = now - 3_600;
    let proved = prove(&s.f.vault, expiry, 1_000_000, 0, rate, old)?;
    assert!(
        format!(
            "{:?}",
            fill(&s, id, &proved, 1_000_000, rate, old)
                .await?
                .into_result()
                .err()
        )
        .contains("ERR_PROOF_TIME")
    );

    // A DAO member registers the key the terms are encrypted to; an outsider cannot.
    let key = STANDARD.encode([7u8; 32]);
    let register = |who: &Account| {
        who.call(s.sealed.id(), "register_reader")
            .args_json(json!({ "vault": s.f.vault.id(), "public_key": key }))
            .deposit(DEPOSIT)
            .gas(Gas::from_tgas(80))
            .transact()
    };
    assert!(register(&s.f.council[0]).await?.json::<bool>()?);
    assert!(!register(&s.f.outsider).await?.json::<bool>()?);
    let readers: Vec<Value> = s
        .sealed
        .view("readers")
        .args_json(json!({ "vault": s.f.vault.id() }))
        .await?
        .json()?;
    assert_eq!(readers.len(), 1);
    assert_eq!(readers[0]["account"], s.f.council[0].id().as_str());
    Ok(())
}
