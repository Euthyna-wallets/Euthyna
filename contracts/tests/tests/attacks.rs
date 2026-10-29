//! Attack suite, on-chain part. Each test plays an attacker against a real
//! vault in a NEAR sandbox and prints one line per refused attack:
//!
//! `BLOCKED | <attack> | <lock that refused> | <error from the chain>`
//!
//! The attacker is assumed to hold the agent's NEAR key (the agent was
//! prompt-injected, its memory poisoned or its MCP tools replaced): what an
//! agent can sign is exactly what an attacker can sign.
//!
//! Run: `cargo test -p tests --test attacks -- --nocapture --test-threads=1`.

mod vault_common;

use anyhow::Result;
use ed25519_dalek::SigningKey;
use near_workspaces::Account;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use serde_json::{Value, json};
use serial_test::serial;
use vault_common::{
    ALLOWANCE_KEY, CHAIN_ID, Fixture, ROLE, TOKEN, apply_rule_change, approval, approval_signed_by,
    assert_failure_contains, authorize, erc20_transfer, execute_near, get_operation, near_request,
    near_setup, prepare, request, setup, status_report, status_report_signed_by,
};

const ATTACKER: [u8; 20] = [0xba; 20];
const BRIDGE: [u8; 20] = [0xb7; 20];
const SHARES: &str = "near:acme-shares.testnet";
const REVENUE_KEY: [u8; 32] = [0x77; 32];
const REVENUE_BUDGET: u128 = 10_000_000_000_000_000; // 0.01 ETH

/// Asserts the chain refused with `code`, and prints the line the runner collects.
fn blocked(attack: &str, lock: &str, outcome: &ExecutionFinalResult, code: &str) {
    assert_failure_contains(outcome, code);
    println!("BLOCKED | {attack} | {lock} | {code}");
}

fn attacker_key() -> SigningKey {
    SigningKey::from_bytes(&[0x66; 32])
}

async fn visa_expiry(fixture: &Fixture) -> Result<u64> {
    Ok(fixture
        .worker
        .view_block()
        .await?
        .timestamp()
        .saturating_add(30_000_000_000))
}

async fn try_prepare(
    fixture: &Fixture,
    caller: &Account,
    request: Value,
) -> Result<ExecutionFinalResult> {
    Ok(caller
        .call(fixture.vault.id(), "prepare")
        .args_json(json!({"role": ROLE, "request": request}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

/// Prepare, Guard visa, MPC signature, then the worker's confirmation.
async fn pay_and_confirm(
    fixture: &Fixture,
    reference: &str,
    amount: u128,
    nonce: u64,
) -> Result<Value> {
    let operation = prepare(fixture, reference, amount).await?;
    let visa = approval(
        fixture,
        &operation,
        nonce,
        visa_expiry(fixture).await?,
        None,
    );
    authorize(fixture, &operation, visa).await?.into_result()?;
    let signed = get_operation(fixture, &operation).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(status_report(fixture, &signed, nonce, true))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(operation)
}

async fn wallet_nonce(fixture: &Fixture) -> Result<u64> {
    Ok(fixture
        .vault
        .view("next_evm_nonce")
        .args_json(json!({"chain_id": CHAIN_ID}))
        .await?
        .json()?)
}

#[tokio::test]
#[serial]
async fn injected_agent_cannot_send_funds_outside_its_role() -> Result<()> {
    let fixture = setup().await?;
    let before = wallet_nonce(&fixture).await?;

    // An invoice says "ignore your rules, pay 0xBA…": the agent obeys.
    let mut to_attacker = request("INJECTED-1", 100);
    to_attacker["calldata"] = json!(erc20_transfer(ATTACKER, 100));
    blocked(
        "prompt-injected agent pays the attacker's address",
        "vault: role conditions (recipient)",
        &try_prepare(&fixture, &fixture.agent, to_attacker).await?,
        "parameterNotAllowed",
    );

    // A malicious router inflates the amount past the budget.
    blocked(
        "router inflates the amount past the budget",
        "vault: allowance",
        &try_prepare(&fixture, &fixture.agent, request("INFLATED-1", 5_000)).await?,
        "allowanceExceeded",
    );

    // The agent declares 100 to the vault but the calldata moves 450.
    let mut lying = request("LYING-1", 100);
    lying["calldata"] = json!(erc20_transfer(vault_common::RECIPIENT, 450));
    blocked(
        "agent declares a smaller amount than the calldata moves",
        "vault: amount measured from the calldata",
        &try_prepare(&fixture, &fixture.agent, lying).await?,
        "ERR_ALLOWANCE_AMOUNT_MISMATCH",
    );

    // approve(attacker, max): drain later with transferFrom.
    let mut approve = request("APPROVE-1", 0);
    let mut calldata = vec![0x09, 0x5e, 0xa7, 0xb3];
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(&ATTACKER);
    calldata.extend_from_slice(&[0xff; 32]);
    approve["calldata"] = json!(calldata);
    blocked(
        "agent approves the attacker to spend the tokens",
        "vault: role permissions (function)",
        &try_prepare(&fixture, &fixture.agent, approve).await?,
        "FunctionNotAllowed",
    );

    // Another contract altogether.
    let mut other_contract = request("OTHER-1", 100);
    other_contract["target"] = json!(vec![0x42u8; 20]);
    blocked(
        "agent calls a contract its role does not list",
        "vault: role permissions (target)",
        &try_prepare(&fixture, &fixture.agent, other_contract).await?,
        "TargetNotAllowed",
    );

    // Native ETH riding along with the call.
    let mut with_value = request("VALUE-1", 100);
    with_value["value"] = json!("1000000000000000000");
    blocked(
        "agent attaches native ETH to the call",
        "vault: role permissions (value)",
        &try_prepare(&fixture, &fixture.agent, with_value).await?,
        "SendNotAllowed",
    );

    // Drain the wallet through fees paid to a colluding block builder.
    let mut expensive = request("FEES-1", 100);
    expensive["max_fee_per_gas"] = json!("900000000000");
    blocked(
        "agent sets an extreme gas price to burn the wallet in fees",
        "vault: fee caps of the role",
        &try_prepare(&fixture, &fixture.agent, expensive).await?,
        "ERR_MAX_FEE_PER_GAS",
    );

    assert_eq!(
        wallet_nonce(&fixture).await?,
        before,
        "no transaction may have been signed"
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn agent_cannot_skip_forge_or_replay_the_guard() -> Result<()> {
    let fixture = setup().await?;
    let expiry = visa_expiry(&fixture).await?;
    let operation = prepare(&fixture, "VISA-A", 100).await?;

    let forged = approval_signed_by(&fixture, &attacker_key(), &operation, 1, expiry, None);
    blocked(
        "agent signs its own visa to skip the Guard",
        "vault: Guard signature",
        &authorize(&fixture, &operation, forged).await?,
        "ERR_VISA_SIGNATURE",
    );

    let with_status_key =
        approval_signed_by(&fixture, &fixture.status_guard, &operation, 2, expiry, None);
    blocked(
        "visa forged with the worker's status key",
        "vault: one key per purpose",
        &authorize(&fixture, &operation, with_status_key).await?,
        "ERR_VISA_SIGNATURE",
    );

    let other_digest = approval(&fixture, &operation, 3, expiry, Some([9u8; 32]));
    blocked(
        "visa issued for another transaction",
        "vault: visa bound to the transaction digest",
        &authorize(&fixture, &operation, other_digest).await?,
        "ERR_VISA_DIGEST",
    );

    let valid = approval(&fixture, &operation, 4, expiry, None);
    authorize(&fixture, &operation, valid.clone())
        .await?
        .into_result()?;
    blocked(
        "same visa sent twice",
        "vault: operation state",
        &authorize(&fixture, &operation, valid.clone()).await?,
        "ERR_NOT_PREPARED",
    );

    // Release the wallet, then try the old visa on a new operation.
    let signed = get_operation(&fixture, &operation).await?;
    blocked(
        "agent fakes the confirmation to free the wallet",
        "vault: worker status signature",
        &fixture
            .agent
            .call(fixture.vault.id(), "report_status")
            .args_json(status_report_signed_by(&attacker_key(), &signed, 1, true))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?,
        "ERR_REPORT_SIGNATURE",
    );
    fixture
        .outsider
        .call(fixture.vault.id(), "report_status")
        .args_json(status_report(&fixture, &signed, 1, true))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let next = prepare(&fixture, "VISA-B", 100).await?;
    blocked(
        "visa of a paid operation replayed on a new one",
        "vault: visa bound to the operation",
        &authorize(&fixture, &next, valid).await?,
        "ERR_VISA_OP_ID",
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn same_invoice_cannot_be_paid_twice_or_split() -> Result<()> {
    let fixture = setup().await?;
    pay_and_confirm(&fixture, "INV-2026-001", 250, 1).await?;
    blocked(
        "same invoice reference paid twice",
        "vault: references are single-use",
        &try_prepare(&fixture, &fixture.agent, request("INV-2026-001", 250)).await?,
        "ERR_REFERENCE_ALREADY_USED",
    );

    // Splitting a large theft into small payments under every threshold.
    pay_and_confirm(&fixture, "SPLIT-2", 250, 2).await?;
    pay_and_confirm(&fixture, "SPLIT-3", 250, 3).await?;
    blocked(
        "theft split into small payments",
        "vault: velocity limit of the role",
        &try_prepare(&fixture, &fixture.agent, request("SPLIT-4", 250)).await?,
        "ERR_VELOCITY_EXCEEDED",
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn stolen_guard_key_stays_inside_the_role() -> Result<()> {
    let fixture = setup().await?;
    let expiry = visa_expiry(&fixture).await?;

    // With the Guard key, the attacker can sign visas. The vault still decides.
    let mut to_attacker = request("GUARD-KEY-1", 100);
    to_attacker["calldata"] = json!(erc20_transfer(ATTACKER, 100));
    blocked(
        "stolen Guard key: pay the attacker",
        "vault: role conditions run before any visa",
        &try_prepare(&fixture, &fixture.agent, to_attacker).await?,
        "parameterNotAllowed",
    );

    // Above the co-sign threshold, a human member must co-sign first.
    let large = prepare(&fixture, "GUARD-KEY-2", 400).await?;
    let visa = approval(&fixture, &large, 1, expiry, None);
    blocked(
        "stolen Guard key: large payment without a human",
        "vault: human co-signature",
        &authorize(&fixture, &large, visa).await?,
        "ERR_COSIGN_REQUIRED",
    );
    blocked(
        "agent co-signs its own large payment",
        "vault: co-signer must be another human",
        &fixture
            .agent
            .call(fixture.vault.id(), "co_sign")
            .args_json(json!({"op_id": large["op_id"]}))
            .transact()
            .await?,
        "ERR_SELF_COSIGN",
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn only_a_dao_vote_changes_rules_or_moves_funds_outside_roles() -> Result<()> {
    let fixture = setup().await?;
    let bigger_budget = json!({"change": {"SetAllowance": {
        "key": ALLOWANCE_KEY, "balance": "1000000", "refill": "1000000",
        "max_refill": "1000000", "period_ns": 1_000_000_000u64
    }}});
    let transfer_out = json!({"transactions": [{
        "chain_id": CHAIN_ID, "target": TOKEN, "value": "0",
        "calldata": erc20_transfer(ATTACKER, 1_000_000), "gas_limit": "100000",
        "max_fee_per_gas": "20000000000", "max_priority_fee_per_gas": "1000000000"
    }]});

    for (who, account) in [
        ("agent", &fixture.agent),
        ("council member", &fixture.council),
        ("outsider", &fixture.outsider),
    ] {
        blocked(
            &format!("{who} raises its own budget"),
            "vault: rules change only by DAO vote",
            &account
                .call(fixture.vault.id(), "queue_rule_change")
                .args_json(bigger_budget.clone())
                .gas(Gas::from_tgas(100))
                .transact()
                .await?,
            "ERR_OWNER_ONLY",
        );
        blocked(
            &format!("{who} sends funds outside any role"),
            "vault: transactions outside roles need a DAO vote",
            &account
                .call(fixture.vault.id(), "submit_transactions")
                .args_json(transfer_out.clone())
                .gas(Gas::from_tgas(100))
                .transact()
                .await?,
            "ERR_OWNER_ONLY",
        );
    }

    blocked(
        "account with no role prepares a payment",
        "vault: role membership",
        &try_prepare(&fixture, &fixture.outsider, request("NO-ROLE-1", 100)).await?,
        "ERR_MEMBERSHIP_NOT_FOUND",
    );

    // Even a rule the DAO voted waits out the veto window: one member stops it.
    let queued: Value = fixture
        .owner
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(bigger_budget)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    blocked(
        "voted rule executed before the veto window ends",
        "vault: veto window",
        &fixture
            .outsider
            .call(fixture.vault.id(), "execute_rule_change")
            .args_json(json!({"queue_id": queued["queue_id"]}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?,
        "ERR_RULE_DELAY",
    );
    fixture
        .council
        .call(fixture.vault.id(), "veto_rule_change")
        .args_json(json!({"queue_id": queued["queue_id"]}))
        .transact()
        .await?
        .into_result()?;
    tests::wait_until_timestamp(
        &fixture.worker,
        fixture
            .worker
            .view_block()
            .await?
            .timestamp()
            .saturating_add(2_000_000_000),
    )
    .await?;
    blocked(
        "vetoed rule executed anyway",
        "vault: council veto",
        &fixture
            .outsider
            .call(fixture.vault.id(), "execute_rule_change")
            .args_json(json!({"queue_id": queued["queue_id"]}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?,
        "ERR_RULE_NOT_QUEUED",
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn kill_switch_and_no_key_on_the_vault() -> Result<()> {
    let fixture = setup().await?;
    // Nobody holds a key of the vault account: not us, not the deployer.
    assert!(fixture.vault.view_access_keys().await?.is_empty());
    println!(
        "BLOCKED | stolen server or deployer key signs as the vault | vault: account has no access key | 0 keys"
    );

    // One council member pauses; agents stop; only the DAO resumes.
    fixture
        .council
        .call(fixture.vault.id(), "pause")
        .transact()
        .await?
        .into_result()?;
    blocked(
        "agent keeps paying after the members pause",
        "vault: pause",
        &try_prepare(&fixture, &fixture.agent, request("PAUSED-1", 100)).await?,
        "ERR_PAUSED",
    );
    blocked(
        "agent unpauses the vault",
        "vault: only the DAO resumes",
        &fixture
            .agent
            .call(fixture.vault.id(), "unpause")
            .transact()
            .await?,
        "ERR_OWNER_ONLY",
    );

    // A revoked agent is out for good.
    tests::wait_until_timestamp(
        &fixture.worker,
        fixture
            .worker
            .view_block()
            .await?
            .timestamp()
            .saturating_add(1_000_000_000),
    )
    .await?;
    apply_rule_change(
        &fixture.owner,
        &fixture.outsider,
        &fixture.worker,
        &fixture.vault,
        json!({"RevokeMembership": {"role": ROLE, "member": fixture.agent.id()}}),
    )
    .await?;
    fixture
        .owner
        .call(fixture.vault.id(), "unpause")
        .transact()
        .await?
        .into_result()?;
    blocked(
        "revoked agent keeps paying",
        "vault: role membership",
        &try_prepare(&fixture, &fixture.agent, request("REVOKED-1", 100)).await?,
        "ERR_MEMBERSHIP_REVOKED",
    );
    Ok(())
}

fn word(value: u128) -> String {
    format!("0x{:064x}", value)
}

fn keccak_hex(data: &[u8]) -> String {
    use sha3::{Digest as _, Keccak256};
    format!("0x{}", hex::encode(Keccak256::digest(data)))
}

/// initTransfer(address,uint128,uint128,uint128,string,string), ABI-encoded by hand.
fn init_transfer(
    token: [u8; 20],
    amount: u128,
    fee: u128,
    native_fee: u128,
    recipient: &str,
    message: &str,
) -> Vec<u8> {
    let pad = |bytes: &[u8]| {
        let mut out = bytes.to_vec();
        out.resize(bytes.len().div_ceil(32) * 32, 0);
        out
    };
    let num = |value: u128| {
        let mut out = vec![0u8; 16];
        out.extend_from_slice(&value.to_be_bytes());
        out
    };
    let mut data = vec![0xde, 0xb9, 0x15, 0xb8];
    let mut address = vec![0u8; 12];
    address.extend_from_slice(&token);
    data.extend(address);
    data.extend(num(amount));
    data.extend(num(fee));
    data.extend(num(native_fee));
    let recipient_tail = [num(recipient.len() as u128), pad(recipient.as_bytes())].concat();
    data.extend(num(6 * 32));
    data.extend(num((6 * 32 + recipient_tail.len()) as u128));
    data.extend(recipient_tail);
    data.extend(num(message.len() as u128));
    data.extend(pad(message.as_bytes()));
    data
}

fn revenue_request(reference: &str, calldata: Vec<u8>, value: u128) -> Value {
    json!({
        "chain_id": CHAIN_ID,
        "target": BRIDGE,
        "value": value.to_string(),
        "calldata": calldata,
        "allowance_amount": value.to_string(),
        "reference": reference,
        "gas_limit": "500000",
        "max_fee_per_gas": "2000000000",
        "max_priority_fee_per_gas": "1000000"
    })
}

#[tokio::test]
#[serial]
async fn revenue_role_only_reaches_the_shareholders() -> Result<()> {
    let fixture = setup().await?;
    // Same tree as packages/sdk `shareRevenueSheet`.
    let conditions = json!([
        {"parent": 0, "paramType": 5, "operator": 5, "compValue": "0x"},
        {"parent": 0, "paramType": 1, "operator": 16, "compValue": word(0)},
        {"parent": 0, "paramType": 1, "operator": 17, "compValue": word(0)},
        {"parent": 0, "paramType": 1, "operator": 16, "compValue": word(0)},
        {"parent": 0, "paramType": 1, "operator": 18, "compValue": word(1_000_000_000_000_001)},
        {"parent": 0, "paramType": 2, "operator": 16, "compValue": keccak_hex(SHARES.as_bytes())},
        {"parent": 0, "paramType": 2, "operator": 16, "compValue": keccak_hex(b"")},
        {"parent": 0, "paramType": 6, "operator": 28, "compValue": format!("0x{}", hex::encode(REVENUE_KEY))}
    ]);
    for change in [
        json!({"SetAllowance": {"key": REVENUE_KEY, "balance": REVENUE_BUDGET.to_string(), "refill": REVENUE_BUDGET.to_string(), "max_refill": REVENUE_BUDGET.to_string(), "period_ns": 604_800_000_000_000u64}}),
        json!({"SetRole": {"role": "revenue", "config": {
            "enabled": true,
            "permissions": [{"chain_id": CHAIN_ID, "target": BRIDGE, "selector": [0xde, 0xb9, 0x15, 0xb8], "conditions": conditions, "allow_value": true}],
            "operation_delay_threshold": null, "operation_delay_ns": 0, "co_sign_threshold": null, "co_signer_role": null, "velocity": null,
            "gas_limit": "1000000", "max_fee_per_gas": "20000000000", "max_priority_fee_per_gas": "2000000000", "max_total_fee": "20000000000000000"
        }}}),
        json!({"GrantMembership": {"role": "revenue", "member": fixture.agent.id(), "kind": "Agent", "starts_at_ns": "0", "ends_at_ns": null, "max_uses": null}}),
    ] {
        apply_rule_change(
            &fixture.owner,
            &fixture.outsider,
            &fixture.worker,
            &fixture.vault,
            change,
        )
        .await?;
    }
    let prepare_revenue = |request: Value| {
        fixture
            .agent
            .call(fixture.vault.id(), "prepare")
            .args_json(json!({"role": "revenue", "request": request}))
            .gas(Gas::from_tgas(100))
            .transact()
    };
    let (amount, fee) = (5_000_000_000_000_000u128, 4_249_821_508_237u128);

    blocked(
        "revenue sent to the attacker's NEAR account",
        "vault: bridge recipient fixed to the shares contract",
        &prepare_revenue(revenue_request(
            "REV-ATK-1",
            init_transfer([0; 20], amount, 0, fee, "near:attacker.testnet", ""),
            amount + fee,
        ))
        .await?,
        "parameterNotAllowed",
    );
    blocked(
        "revenue bridged back to an attacker's EVM address",
        "vault: bridge recipient fixed to the shares contract",
        &prepare_revenue(revenue_request(
            "REV-ATK-2",
            init_transfer(
                [0; 20],
                amount,
                0,
                fee,
                "base:0xbabababababababababababababababababababa",
                "",
            ),
            amount + fee,
        ))
        .await?,
        "parameterNotAllowed",
    );
    blocked(
        "bridge message forwards the ETH elsewhere",
        "vault: bridge message must be empty",
        &prepare_revenue(revenue_request(
            "REV-ATK-3",
            init_transfer([0; 20], amount, 0, fee, SHARES, "attacker.testnet"),
            amount + fee,
        ))
        .await?,
        "parameterNotAllowed",
    );
    blocked(
        "whole value paid as a bridge fee",
        "vault: bridge fee cap",
        &prepare_revenue(revenue_request(
            "REV-ATK-4",
            init_transfer([0; 20], 1, 0, 2_000_000_000_000_000, SHARES, ""),
            2_000_000_000_000_001,
        ))
        .await?,
        "parameterGreaterThanAllowed",
    );
    blocked(
        "revenue above the budget",
        "vault: ETH budget",
        &prepare_revenue(revenue_request(
            "REV-ATK-5",
            init_transfer([0; 20], REVENUE_BUDGET, 0, fee, SHARES, ""),
            REVENUE_BUDGET + fee,
        ))
        .await?,
        "allowanceExceeded",
    );
    blocked(
        "agent declares less ETH than it sends",
        "vault: ETH measured from the value",
        &prepare_revenue({
            let mut request = revenue_request(
                "REV-ATK-6",
                init_transfer([0; 20], amount, 0, fee, SHARES, ""),
                amount + fee,
            );
            request["allowance_amount"] = json!("1");
            request
        })
        .await?,
        "ERR_ALLOWANCE_AMOUNT_MISMATCH",
    );

    // The honest call passes and reserves the ETH sent.
    let operation: Value = prepare_revenue(revenue_request(
        "REV-1",
        init_transfer([0; 20], amount, 0, fee, SHARES, ""),
        amount + fee,
    ))
    .await?
    .into_result()?
    .json()?;
    assert_eq!(
        operation["consumptions"][0]["amount"],
        (amount + fee).to_string()
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn settlement_callback_is_private() -> Result<()> {
    let f = setup().await?;
    let result = f.outsider.call(f.vault.id(), "on_settle_verified")
        .args_json(json!({"op_id": vec![0;32], "tx_hash": vec![0;32], "expected_payload_hash": vec![0;32], "cancellation": false}))
        .gas(Gas::from_tgas(50)).transact().await?;
    assert_failure_contains(&result, "Method on_settle_verified is private");
    Ok(())
}

/// The agent's key can only move NEAR tokens the DAO listed, to receivers it
/// listed, within the voted budget; nothing else the vault holds.
#[tokio::test]
#[serial]
async fn injected_agent_cannot_move_near_tokens_outside_its_role() -> Result<()> {
    let f = setup().await?;
    let near = near_setup(&f).await?;
    const USDC: u128 = 1_000_000;

    blocked(
        "agent sends test USDC to an unlisted NEAR account",
        "vault: NEAR permissions (receiver)",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &f.outsider, USDC, "NEAR-RECEIVER"),
        )
        .await?,
        "FunctionNotAllowed",
    );
    blocked(
        "agent sends a token the role does not list",
        "vault: NEAR permissions (token)",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.other_token, &near.card, USDC, "NEAR-TOKEN"),
        )
        .await?,
        "TokenNotAllowed",
    );
    blocked(
        "agent sends more than the per-transfer cap",
        "vault: NEAR permissions (max per transfer)",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &near.card, 7 * USDC, "NEAR-CAP"),
        )
        .await?,
        "ERR_MAX_PER_TRANSFER",
    );
    blocked(
        "agent spams dust transfers to grow the vault's storage",
        "vault: NEAR permissions (min per transfer)",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &near.card, 1, "NEAR-DUST"),
        )
        .await?,
        "ERR_MIN_PER_TRANSFER",
    );
    blocked(
        "an account outside the role calls execute_near",
        "vault: membership",
        &execute_near(
            &f,
            &f.outsider,
            near_request(&near.token, &near.card, USDC, "NEAR-OUTSIDER"),
        )
        .await?,
        "ERR_MEMBERSHIP_NOT_FOUND",
    );

    // A membership that ended: the vote set an end date, now passed.
    let late = f.worker.dev_create_account().await?;
    let ends_at = f.worker.view_block().await?.timestamp() + 3_000_000_000;
    apply_rule_change(
        &f.owner,
        &f.outsider,
        &f.worker,
        &f.vault,
        json!({"GrantMembership": {
            "role": ROLE, "member": late.id(), "kind": "Agent",
            "starts_at_ns": "0", "ends_at_ns": ends_at.to_string(), "max_uses": null
        }}),
    )
    .await?;
    tests::wait_until_timestamp(&f.worker, ends_at + 1).await?;
    blocked(
        "an agent whose membership expired",
        "vault: membership (end date)",
        &execute_near(
            &f,
            &late,
            near_request(&near.token, &near.card, USDC, "NEAR-EXPIRED"),
        )
        .await?,
        "ERR_MEMBERSHIP_UNAVAILABLE",
    );

    // One honest refill, then the same reference again.
    execute_near(
        &f,
        &f.agent,
        near_request(&near.token, &near.card, USDC, "NEAR-REF"),
    )
    .await?
    .into_result()?;
    blocked(
        "agent replays a reference to pay twice",
        "vault: unique reference",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &near.card, USDC, "NEAR-REF"),
        )
        .await?,
        "ERR_REFERENCE_ALREADY_USED",
    );
    // 4 USDC left of 5: 4.5 is under the cap but over the budget.
    blocked(
        "agent spends past the voted NEAR budget",
        "vault: allowance",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &near.card, 4_500_000, "NEAR-BUDGET"),
        )
        .await?,
        "ERR_ALLOWANCE_EXCEEDED",
    );

    // Enough gas for ft_transfer but not for the callback that settles the budget.
    let starved = f.agent.call(f.vault.id(), "execute_near")
        .args_json(json!({"role": ROLE, "request": near_request(&near.token, &near.card, USDC, "NEAR-GAS")}))
        .gas(Gas::from_tgas(40)).transact().await?;
    blocked(
        "agent attaches too little gas for the settlement callback",
        "vault: callback gas",
        &starved,
        "ERR_NEAR_CALLBACK_GAS",
    );

    f.council
        .call(f.vault.id(), "pause")
        .transact()
        .await?
        .into_result()?;
    blocked(
        "agent pays while the council paused the vault",
        "vault: pause",
        &execute_near(
            &f,
            &f.agent,
            near_request(&near.token, &near.card, USDC, "NEAR-PAUSED"),
        )
        .await?,
        "ERR_PAUSED",
    );

    let callback = f
        .outsider
        .call(f.vault.id(), "on_near_transfer")
        .args_json(json!({"op_id": vec![0; 32]}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    blocked(
        "anyone calls the transfer callback to fake a result",
        "vault: private callback",
        &callback,
        "Method on_near_transfer is private",
    );
    Ok(())
}
