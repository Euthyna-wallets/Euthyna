//! Founder seat recovery with ZK Email, verified on chain. The proofs are real: emails from a
//! test mail domain, DKIM-signed by mailauth and proved with the circuit
//! (apps/api/scripts/email-recovery-fixtures.ts writes them).

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use serial_test::serial;

const RECOVERY_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/email_recovery.wasm"
));
const PROOFS: &str = include_str!("fixtures/email-recovery/proofs.json");
const DEPOSIT: NearToken = NearToken::from_millinear(50);
const DELAY_SECONDS: u64 = 60;

fn proofs() -> Value {
    serde_json::from_str(PROOFS).unwrap()
}

fn failure(outcome: &ExecutionFinalResult) -> String {
    format!("{:?}", outcome.clone().into_result().err())
}

fn burnt_tgas(outcome: &ExecutionFinalResult) -> u64 {
    outcome.total_gas_burnt.as_tgas()
}

struct Setup {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    recovery: Contract,
    keeper: Account,
    dao: Account,
    alice: Account,
    bob: Account,
    outsider: Account,
}

async fn setup(with_key: bool) -> Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mut accounts = Vec::new();
    for name in ["keeper", "acme", "alice", "bob", "outsider"] {
        accounts.push(
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(20))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let [keeper, dao, alice, bob, outsider]: [Account; 5] = accounts.try_into().unwrap();
    let recovery = worker.dev_deploy(RECOVERY_WASM).await?;
    recovery
        .call("new")
        .args_json(json!({ "keeper_id": keeper.id(), "delay_seconds": DELAY_SECONDS.to_string() }))
        .transact()
        .await?
        .into_result()?;
    if with_key {
        let p = proofs();
        keeper
            .call(recovery.id(), "add_dkim_key")
            .args_json(json!({ "domain": p["domain"], "modulus_hex": p["modulus_hex"] }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(Setup {
        worker,
        recovery,
        keeper,
        dao,
        alice,
        bob,
        outsider,
    })
}

async fn enroll(s: &Setup, who: &Account, case: &str) -> Result<ExecutionFinalResult> {
    let p = proofs();
    Ok(who
        .call(s.recovery.id(), "enroll")
        .args_json(json!({ "dao_id": s.dao.id(), "proof": p[case]["proof"], "public_inputs": p[case]["public_inputs"] }))
        .deposit(DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn request(
    s: &Setup,
    who: &Account,
    lost: &Account,
    case: &str,
) -> Result<ExecutionFinalResult> {
    let p = proofs();
    Ok(who
        .call(s.recovery.id(), "request")
        .args_json(json!({
            "dao_id": s.dao.id(), "lost_account_id": lost.id(),
            "proof": p[case]["proof"], "public_inputs": p[case]["public_inputs"]
        }))
        .deposit(DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

#[tokio::test]
#[serial]
async fn only_the_keeper_manages_dkim_keys() -> Result<()> {
    let s = setup(false).await?;
    let p = proofs();
    let outsider = s
        .outsider
        .call(s.recovery.id(), "add_dkim_key")
        .args_json(json!({ "domain": p["domain"], "modulus_hex": p["modulus_hex"] }))
        .transact()
        .await?;
    assert!(failure(&outsider).contains("ERR_KEEPER_ONLY"));
    let short = s
        .keeper
        .call(s.recovery.id(), "add_dkim_key")
        .args_json(json!({ "domain": "example.com", "modulus_hex": "ffff" }))
        .transact()
        .await?;
    assert!(failure(&short).contains("ERR_DKIM_KEY_SIZE"));
    let hash: String = s
        .keeper
        .call(s.recovery.id(), "add_dkim_key")
        .args_json(json!({ "domain": p["domain"], "modulus_hex": p["modulus_hex"] }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    // The TypeScript SDK (dkimKeyHash) computes the same key hash as the contract.
    assert_eq!(hash, p["key_hash"].as_str().unwrap());
    let keys: Vec<String> = s
        .recovery
        .view("dkim_keys")
        .args_json(json!({ "domain": p["domain"] }))
        .await?
        .json()?;
    assert_eq!(keys, vec![hash.clone()]);
    s.keeper
        .call(s.recovery.id(), "remove_dkim_key")
        .args_json(json!({ "domain": p["domain"], "key_hash": hash }))
        .transact()
        .await?
        .into_result()?;
    let keys: Vec<String> = s
        .recovery
        .view("dkim_keys")
        .args_json(json!({ "domain": p["domain"] }))
        .await?
        .json()?;
    assert!(keys.is_empty());
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_founder_enrolls_with_a_proof_bound_to_their_account() -> Result<()> {
    let s = setup(false).await?;
    // A key the keeper never added: refused before the proof is even checked.
    let unknown = enroll(&s, &s.alice, "enroll_alice").await?;
    assert!(
        failure(&unknown).contains("ERR_DKIM_KEY_UNKNOWN"),
        "{}",
        failure(&unknown)
    );

    let s = setup(true).await?;
    // Alice's enrollment email names alice.test.near: Bob cannot use it.
    let stolen = enroll(&s, &s.bob, "enroll_alice").await?;
    assert!(
        failure(&stolen).contains("ERR_WRONG_SUBJECT"),
        "{}",
        failure(&stolen)
    );
    // One flipped bit in the address hash: the proof no longer verifies.
    let p = proofs();
    let mut inputs = STANDARD.decode(p["enroll_alice"]["public_inputs"].as_str().unwrap())?;
    inputs[37 * 32 + 31] ^= 1;
    let forged = s
        .alice
        .call(s.recovery.id(), "enroll")
        .args_json(json!({ "dao_id": s.dao.id(), "proof": p["enroll_alice"]["proof"], "public_inputs": STANDARD.encode(&inputs) }))
        .deposit(DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(
        failure(&forged).contains("ERR_PROOF_INVALID"),
        "{}",
        failure(&forged)
    );
    // The real one.
    let enrolled = enroll(&s, &s.alice, "enroll_alice").await?;
    println!("enroll: {} Tgas burnt", burnt_tgas(&enrolled));
    assert!(
        burnt_tgas(&enrolled) < 200,
        "enroll burnt {} Tgas",
        burnt_tgas(&enrolled)
    );
    let enrollment: Value = enrolled.into_result()?.json()?;
    assert_eq!(enrollment["account_id"], "alice.test.near");
    assert_eq!(enrollment["domain"], p["domain"]);
    let listed: Vec<Value> = s
        .recovery
        .view("enrollments_of")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .await?
        .json()?;
    assert_eq!(listed.len(), 1);
    // Enrolling again replaces the enrollment.
    enroll(&s, &s.alice, "enroll_alice").await?.into_result()?;
    let listed: Vec<Value> = s
        .recovery
        .view("enrollments_of")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .await?
        .json()?;
    assert_eq!(listed.len(), 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_new_account_asks_and_the_lost_one_can_cancel_until_the_delay() -> Result<()> {
    let s = setup(true).await?;
    // Nothing enrolled yet.
    let early = request(&s, &s.bob, &s.alice, "recovery_bob").await?;
    assert!(
        failure(&early).contains("ERR_NOT_ENROLLED"),
        "{}",
        failure(&early)
    );
    enroll(&s, &s.alice, "enroll_alice").await?.into_result()?;

    // Another mailbox, or the right mailbox with another salt: refused.
    let other = request(&s, &s.bob, &s.alice, "recovery_bob_other_mailbox").await?;
    assert!(
        failure(&other).contains("ERR_DIFFERENT_MAILBOX"),
        "{}",
        failure(&other)
    );
    let salt = request(&s, &s.bob, &s.alice, "recovery_bob_other_salt").await?;
    assert!(
        failure(&salt).contains("ERR_WRONG_SALT"),
        "{}",
        failure(&salt)
    );
    // Bob's proof names bob.test.near: the outsider cannot use it.
    let stolen = request(&s, &s.outsider, &s.alice, "recovery_bob").await?;
    assert!(
        failure(&stolen).contains("ERR_WRONG_SUBJECT"),
        "{}",
        failure(&stolen)
    );

    // The real request: waiting, not ready.
    let asked = request(&s, &s.bob, &s.alice, "recovery_bob").await?;
    println!("request: {} Tgas burnt", burnt_tgas(&asked));
    let asked: Value = asked.into_result()?.json()?;
    assert_eq!(asked["new_account_id"], "bob.test.near");
    assert_eq!(asked["state"], "Waiting");
    assert_eq!(asked["ready"], false);
    let again = request(&s, &s.bob, &s.alice, "recovery_bob").await?;
    assert!(
        failure(&again).contains("ERR_RECOVERY_OPEN"),
        "{}",
        failure(&again)
    );

    // Only the lost account cancels.
    let outsider = s
        .outsider
        .call(s.recovery.id(), "cancel")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .transact()
        .await?;
    assert!(
        failure(&outsider).contains("ERR_NO_RECOVERY"),
        "{}",
        failure(&outsider)
    );
    s.alice
        .call(s.recovery.id(), "cancel")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .transact()
        .await?
        .into_result()?;
    let open: Option<Value> = s
        .recovery
        .view("recovery")
        .args_json(json!({ "dao_id": s.dao.id(), "lost_account_id": s.alice.id() }))
        .await?
        .json()?;
    assert!(open.is_none());

    // Right after a cancel the seat rests a full waiting period: whoever holds the mailbox
    // cannot ask again and again until one request goes unnoticed.
    let history: Vec<Value> = s
        .recovery
        .view("recoveries_of")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .await?
        .json()?;
    let cancelled_at: u64 = history[0]["cancelled_at_ns"].as_str().unwrap().parse()?;
    let resting = request(&s, &s.bob, &s.alice, "recovery_bob").await?;
    assert!(
        failure(&resting).contains("ERR_RECOVERY_COOLDOWN"),
        "{}",
        failure(&resting)
    );
    while s.worker.view_block().await?.timestamp() < cancelled_at + DELAY_SECONDS * 1_000_000_000 {
        s.worker.fast_forward(50).await?;
    }

    // Asked again, and nobody cancels: after the delay, the members can vote.
    request(&s, &s.bob, &s.alice, "recovery_bob")
        .await?
        .into_result()?;
    let waiting: Value = s
        .recovery
        .view("recovery")
        .args_json(json!({ "dao_id": s.dao.id(), "lost_account_id": s.alice.id() }))
        .await?
        .json()?;
    assert_eq!(waiting["ready"], false);
    let not_before: u64 = waiting["not_before_ns"].as_str().unwrap().parse()?;
    while s.worker.view_block().await?.timestamp() < not_before {
        s.worker.fast_forward(50).await?;
    }
    let ready: Value = s
        .recovery
        .view("recovery")
        .args_json(json!({ "dao_id": s.dao.id(), "lost_account_id": s.alice.id() }))
        .await?
        .json()?;
    assert_eq!(ready["ready"], true);
    let history: Vec<Value> = s
        .recovery
        .view("recoveries_of")
        .args_json(json!({ "dao_id": s.dao.id() }))
        .await?
        .json()?;
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["state"], "Cancelled");
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_real_icloud_email_proof_verifies_on_chain() -> Result<()> {
    let s = setup(false).await?;
    let p = proofs();
    let valid: bool = s
        .recovery
        .view("verify_proof")
        .args_json(json!({ "proof": p["icloud_hello"]["proof"], "public_inputs": p["icloud_hello"]["public_inputs"] }))
        .await?
        .json()?;
    assert!(valid);
    // The same proof, claimed for another email's public inputs: refused.
    let swapped: bool = s
        .recovery
        .view("verify_proof")
        .args_json(json!({ "proof": p["icloud_hello"]["proof"], "public_inputs": p["enroll_alice"]["public_inputs"] }))
        .await?
        .json()?;
    assert!(!swapped);
    Ok(())
}
