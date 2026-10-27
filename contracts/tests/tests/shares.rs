//! Shares: sale, votes in the Sputnik DAO, the freeze that stops one share
//! from voting twice, and revenue by epoch for the holders who voted.

use anyhow::Result;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{Value, json};
use serial_test::serial;

const DAO_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../res/sputnikdao2-2.3.1-5434a59.wasm"
));
const SHARES_WASM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/shares.wasm"));
const FT_WASM: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../res/test_ft.wasm"));

const PROPOSAL_PERIOD_NS: u64 = 30_000_000_000;
const UNLOCK_PERIOD_NS: u64 = 60_000_000_000;
const EPOCH_NS: u64 = 60_000_000_000;
const PRICE: NearToken = NearToken::from_millinear(100);
const BOND: NearToken = NearToken::from_millinear(100);

struct Fixture {
    worker: Worker<Sandbox>,
    dao: Contract,
    shares: Contract,
    usdc: Contract,
    founder: Account,
    alice: Account,
    bob: Account,
    carol: Account,
}

/// Members pass anything by 2/3; shareholders pass company calls and
/// transfers by a majority of locked shares.
fn policy(founder: &Account) -> Value {
    let token_majority = json!({"weight_kind": "TokenWeight", "quorum": "0", "threshold": [1, 2]});
    json!({
        "roles": [
            {
                "name": "council",
                "kind": {"Group": [founder.id()]},
                "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
                "vote_policy": {}
            },
            {
                "name": "shareholders",
                "kind": {"Member": "1"},
                "permissions": ["call:AddProposal", "call:VoteApprove", "call:VoteReject", "call:Finalize",
                                "transfer:AddProposal", "transfer:VoteApprove", "transfer:VoteReject", "transfer:Finalize"],
                "vote_policy": {"call": token_majority, "transfer": token_majority}
            }
        ],
        "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [2, 3]},
        "proposal_bond": BOND.as_yoctonear().to_string(),
        "proposal_period": PROPOSAL_PERIOD_NS.to_string(),
        "bounty_bond": BOND.as_yoctonear().to_string(),
        "bounty_forgiveness_period": PROPOSAL_PERIOD_NS.to_string()
    })
}

async fn setup() -> Result<Fixture> {
    let worker = near_workspaces::sandbox().await?;
    let founder = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let dao = worker.dev_deploy(DAO_WASM).await?;
    let shares = worker.dev_deploy(SHARES_WASM).await?;
    let usdc = worker.dev_deploy(FT_WASM).await?;
    dao.call("new")
        .args_json(json!({"config": {"name": "acme", "purpose": "AI company", "metadata": ""}, "policy": policy(&founder)}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    usdc.call("new").transact().await?.into_result()?;
    shares
        .call("new")
        .args_json(json!({
            "dao_id": dao.id(),
            "name": "Acme AI shares",
            "symbol": "ACME",
            "total_supply": "1000",
            "price_per_share": PRICE.as_yoctonear().to_string(),
            "unlock_period_ns": UNLOCK_PERIOD_NS.to_string(),
            "epoch_ns": EPOCH_NS.to_string(),
            "revenue_token": usdc.id(),
            "allocations": [[founder.id(), "100"]]
        }))
        .transact()
        .await?
        .into_result()?;
    // Nobody keeps a key of the shares account.
    let key = shares.as_account().secret_key().public_key();
    shares
        .as_account()
        .batch(shares.id())
        .delete_key(key)
        .transact()
        .await?
        .into_result()?;
    assert!(shares.view_access_keys().await?.is_empty());

    let fixture = Fixture {
        worker,
        dao,
        shares,
        usdc,
        founder,
        alice,
        bob,
        carol,
    };
    // The members name the shares contract as the DAO's staking contract.
    let kind = json!({"SetStakingContract": {"staking_id": fixture.shares.id()}});
    let id = add_proposal(&fixture, &fixture.founder, kind.clone()).await?;
    act(&fixture, &fixture.founder, id, "VoteApprove", kind)
        .await?
        .into_result()?;
    let staking: String = fixture.dao.view("get_staking_contract").await?.json()?;
    assert_eq!(staking, fixture.shares.id().as_str());
    Ok(fixture)
}

async fn add_proposal(fixture: &Fixture, proposer: &Account, kind: Value) -> Result<u64> {
    Ok(proposer
        .call(fixture.dao.id(), "add_proposal")
        .args_json(json!({"proposal": {"description": "test", "kind": kind}}))
        .deposit(BOND)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn act(
    fixture: &Fixture,
    voter: &Account,
    id: u64,
    action: &str,
    kind: Value,
) -> Result<ExecutionFinalResult> {
    Ok(voter
        .call(fixture.dao.id(), "act_proposal")
        .args_json(json!({"id": id, "action": action, "proposal": kind}))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?)
}

async fn status(fixture: &Fixture, id: u64) -> Result<String> {
    let proposal: Value = fixture
        .dao
        .view("get_proposal")
        .args_json(json!({"id": id}))
        .await?
        .json()?;
    Ok(proposal["status"].as_str().unwrap_or_default().to_owned())
}

async fn buy(
    fixture: &Fixture,
    buyer: &Account,
    deposit: NearToken,
) -> Result<ExecutionFinalResult> {
    Ok(buyer
        .call(fixture.shares.id(), "buy")
        .deposit(deposit)
        .gas(Gas::from_tgas(50))
        .transact()
        .await?)
}

async fn lock(fixture: &Fixture, holder: &Account, amount: u128, method: &str) -> Result<bool> {
    Ok(holder
        .call(fixture.shares.id(), method)
        .args_json(json!({"amount": amount.to_string()}))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn holder(fixture: &Fixture, account: &Account) -> Result<Value> {
    Ok(fixture
        .shares
        .view("holder_of")
        .args_json(json!({"account_id": account.id()}))
        .await?
        .json()?)
}

async fn delegated(fixture: &Fixture, account: &Account) -> Result<String> {
    let value: Value = fixture
        .dao
        .view("delegation_balance_of")
        .args_json(json!({"account_id": account.id()}))
        .await?
        .json()?;
    Ok(value.as_str().unwrap_or_default().to_owned())
}

fn assert_failure(outcome: &ExecutionFinalResult, expected: &str) {
    let failure = outcome.clone().into_result().expect_err("should fail");
    assert!(
        format!("{failure:?}").contains(expected),
        "expected {expected}, got {failure:?}"
    );
}

#[tokio::test]
#[serial]
async fn sale_pays_the_dao_and_refunds_the_rest() -> Result<()> {
    let fixture = setup().await?;
    let dao_before = fixture.dao.view_account().await?.balance;
    // 60 shares + the registration fee, plus 0.05 NEAR that buys nothing.
    let bought: String = buy(&fixture, &fixture.alice, NearToken::from_millinear(6_060))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(bought, "60");
    let dao_after = fixture.dao.view_account().await?.balance;
    assert_eq!(
        dao_after.as_yoctonear() - dao_before.as_yoctonear(),
        PRICE.as_yoctonear() * 60
    );
    assert_eq!(holder(&fixture, &fixture.alice).await?["balance"], "60");

    // The sale stops at the supply: 900 left for sale minus 60 sold.
    let rest: String = buy(&fixture, &fixture.bob, NearToken::from_near(95))
        .await?
        .into_result()?
        .json()?;
    assert_eq!(rest, "840");
    assert_failure(
        &buy(&fixture, &fixture.carol, NearToken::from_near(1)).await?,
        "ERR_NOTHING_TO_BUY",
    );
    let info: Value = fixture.shares.view("info").await?.json()?;
    assert_eq!(info["unsold"], "0");
    Ok(())
}

#[tokio::test]
#[serial]
async fn locked_shares_vote_and_a_majority_passes_a_transfer() -> Result<()> {
    let fixture = setup().await?;
    buy(&fixture, &fixture.alice, NearToken::from_millinear(60_010))
        .await?
        .into_result()?;
    buy(&fixture, &fixture.bob, NearToken::from_millinear(30_010))
        .await?
        .into_result()?;
    assert!(lock(&fixture, &fixture.alice, 600, "lock").await?);
    assert!(lock(&fixture, &fixture.bob, 300, "lock").await?);
    assert_eq!(delegated(&fixture, &fixture.alice).await?, "600");
    let total: String = fixture.dao.view("delegation_total_supply").await?.json()?;
    assert_eq!(total, "900");

    // Locked shares cannot be sold or moved.
    assert_failure(
        &fixture
            .alice
            .call(fixture.shares.id(), "ft_transfer")
            .args_json(json!({"receiver_id": fixture.bob.id(), "amount": "1"}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?,
        "ERR_NOT_ENOUGH_FREE_SHARES",
    );

    let kind = json!({"Transfer": {"token_id": "", "receiver_id": fixture.carol.id(), "amount": NearToken::from_near(1).as_yoctonear().to_string()}});
    let id = add_proposal(&fixture, &fixture.bob, kind.clone()).await?;
    act(&fixture, &fixture.bob, id, "VoteApprove", kind.clone())
        .await?
        .into_result()?;
    assert_eq!(
        status(&fixture, id).await?,
        "InProgress",
        "300 of 900 is not a majority"
    );
    act(&fixture, &fixture.alice, id, "VoteApprove", kind)
        .await?
        .into_result()?;
    assert_eq!(status(&fixture, id).await?, "Approved");
    Ok(())
}

#[tokio::test]
#[serial]
async fn unlocked_shares_cannot_vote_twice() -> Result<()> {
    let fixture = setup().await?;
    buy(&fixture, &fixture.alice, NearToken::from_millinear(60_010))
        .await?
        .into_result()?;
    buy(&fixture, &fixture.bob, NearToken::from_millinear(30_010))
        .await?
        .into_result()?;
    fixture
        .carol
        .call(fixture.shares.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    assert!(lock(&fixture, &fixture.alice, 600, "lock").await?);
    assert!(lock(&fixture, &fixture.bob, 300, "lock").await?);
    let kind = json!({"Transfer": {"token_id": "", "receiver_id": fixture.alice.id(), "amount": NearToken::from_near(1).as_yoctonear().to_string()}});
    let id = add_proposal(&fixture, &fixture.alice, kind.clone()).await?;
    act(&fixture, &fixture.bob, id, "VoteReject", kind.clone())
        .await?
        .into_result()?;

    // Bob unlocks to hand his votes to Carol: the shares are frozen.
    assert!(lock(&fixture, &fixture.bob, 300, "unlock").await?);
    assert_eq!(delegated(&fixture, &fixture.bob).await?, "0");
    let transfer = |amount: &str| {
        fixture
            .bob
            .call(fixture.shares.id(), "ft_transfer")
            .args_json(json!({"receiver_id": fixture.carol.id(), "amount": amount}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
    };
    assert_failure(&transfer("300").await?, "ERR_NOT_ENOUGH_FREE_SHARES");
    assert_failure(
        &fixture
            .bob
            .call(fixture.shares.id(), "lock")
            .args_json(json!({"amount": "300"}))
            .gas(Gas::from_tgas(150))
            .transact()
            .await?,
        "ERR_NOT_ENOUGH_FREE_SHARES",
    );

    // After the unlock period (longer than a proposal), they move again.
    let cooling_until: u64 = holder(&fixture, &fixture.bob).await?["cooling_until_ns"]
        .as_str()
        .unwrap_or_default()
        .parse()?;
    tests::wait_until_timestamp(&fixture.worker, cooling_until).await?;
    transfer("300").await?.into_result()?;
    assert_eq!(holder(&fixture, &fixture.carol).await?["balance"], "300");
    Ok(())
}

async fn advance_to_epoch(fixture: &Fixture, target: u64) -> Result<()> {
    let info: Value = fixture.shares.view("info").await?.json()?;
    let current = info["current_epoch"].as_u64().expect("current epoch");
    if current < target {
        let end: u64 = info["current_epoch_ends_ns"]
            .as_str()
            .expect("epoch end")
            .parse()?;
        let epoch_ns: u64 = info["epoch_ns"].as_str().expect("epoch duration").parse()?;
        tests::wait_until_timestamp(&fixture.worker, end + (target - current - 1) * epoch_ns)
            .await?;
    }
    Ok(())
}

async fn deposit(fixture: &Fixture, near: u128) -> Result<()> {
    fixture
        .carol
        .call(fixture.shares.id(), "deposit_revenue")
        .deposit(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn prove(fixture: &Fixture, holder: &Account, proposal: u64) -> Result<ExecutionFinalResult> {
    Ok(holder
        .call(fixture.shares.id(), "prove_vote")
        .args_json(json!({"proposal_id": proposal}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

/// Alice 600 and Bob 300 locked before epoch 1 starts; Carol holds 100 unlocked.
/// The sale is then over: 100 founder shares + 900 sold.
async fn holders_locked_for_epoch_one(fixture: &Fixture) -> Result<()> {
    buy(fixture, &fixture.alice, NearToken::from_millinear(60_010))
        .await?
        .into_result()?;
    buy(fixture, &fixture.bob, NearToken::from_millinear(30_010))
        .await?
        .into_result()?;
    // Carol gets the founder's 100 shares.
    fixture
        .carol
        .call(fixture.shares.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    fixture
        .founder
        .call(fixture.shares.id(), "ft_transfer")
        .args_json(json!({"receiver_id": fixture.carol.id(), "amount": "100"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert!(lock(fixture, &fixture.alice, 600, "lock").await?);
    assert!(lock(fixture, &fixture.bob, 300, "lock").await?);
    advance_to_epoch(fixture, 1).await
}

fn transfer_kind(fixture: &Fixture) -> Value {
    json!({"Transfer": {"token_id": "", "receiver_id": fixture.carol.id(), "amount": NearToken::from_millinear(10).as_yoctonear().to_string()}})
}

fn near(value: &Value) -> u128 {
    value
        .as_str()
        .unwrap_or_default()
        .parse()
        .unwrap_or_default()
}

#[tokio::test]
#[serial]
async fn only_voters_earn_and_the_non_voters_part_goes_to_them() -> Result<()> {
    let fixture = setup().await?;
    holders_locked_for_epoch_one(&fixture).await?;
    // Epoch 1: a proposal, Alice votes, Bob does not. 9 NEAR of revenue.
    let kind = transfer_kind(&fixture);
    let id = add_proposal(&fixture, &fixture.alice, kind.clone()).await?;
    act(&fixture, &fixture.alice, id, "VoteApprove", kind)
        .await?
        .into_result()?;
    deposit(&fixture, 9).await?;

    // Epoch 2: proof window for epoch 1.
    advance_to_epoch(&fixture, 2).await?;
    assert!(
        prove(&fixture, &fixture.alice, id)
            .await?
            .into_result()?
            .json::<bool>()?
    );
    assert!(
        !prove(&fixture, &fixture.bob, id)
            .await?
            .into_result()?
            .json::<bool>()?,
        "Bob did not vote"
    );
    assert_failure(
        &prove(&fixture, &fixture.carol, id).await?,
        "ERR_NO_SHARES_LOCKED_LAST_EPOCH",
    );
    assert_failure(
        &prove(&fixture, &fixture.alice, id).await?,
        "ERR_ALREADY_PROVED",
    );
    assert_eq!(
        holder(&fixture, &fixture.alice).await?["claimable_near"],
        "0",
        "final only after the window"
    );

    // Epoch 3: Alice was the only voter, she gets the whole 9 NEAR.
    advance_to_epoch(&fixture, 3).await?;
    assert_eq!(
        near(&holder(&fixture, &fixture.alice).await?["claimable_near"]),
        NearToken::from_near(9).as_yoctonear()
    );
    assert_eq!(holder(&fixture, &fixture.bob).await?["claimable_near"], "0");
    let before = fixture.alice.view_account().await?.balance;
    fixture
        .alice
        .call(fixture.shares.id(), "claim")
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    assert!(
        fixture.alice.view_account().await?.balance.as_yoctonear()
            > before.as_yoctonear() + NearToken::from_millinear(8_900).as_yoctonear()
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn voters_split_pro_rata_and_late_lockers_do_not_count() -> Result<()> {
    let fixture = setup().await?;
    holders_locked_for_epoch_one(&fixture).await?;
    // Dave-like late locker: Carol locks during epoch 1 and votes.
    assert!(lock(&fixture, &fixture.carol, 100, "lock").await?);
    let kind = transfer_kind(&fixture);
    let id = add_proposal(&fixture, &fixture.bob, kind.clone()).await?;
    act(&fixture, &fixture.bob, id, "VoteReject", kind.clone())
        .await?
        .into_result()?;
    act(&fixture, &fixture.carol, id, "VoteReject", kind.clone())
        .await?
        .into_result()?;
    act(&fixture, &fixture.alice, id, "VoteApprove", kind)
        .await?
        .into_result()?;
    deposit(&fixture, 9).await?;
    // Token revenue too, sent with a plain transfer (a bridge) then counted.
    fixture
        .usdc
        .call("mint")
        .args_json(json!({"account_id": fixture.carol.id(), "amount": "900"}))
        .transact()
        .await?
        .into_result()?;
    fixture
        .usdc
        .call("mint")
        .args_json(json!({"account_id": fixture.shares.id(), "amount": "0"}))
        .transact()
        .await?
        .into_result()?;
    fixture
        .carol
        .call(fixture.usdc.id(), "ft_transfer")
        .args_json(json!({"receiver_id": fixture.shares.id(), "amount": "900"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let synced: String = fixture
        .carol
        .call(fixture.shares.id(), "sync_revenue")
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(synced, "900");

    advance_to_epoch(&fixture, 2).await?;
    assert!(
        prove(&fixture, &fixture.alice, id)
            .await?
            .into_result()?
            .json::<bool>()?
    );
    assert!(
        prove(&fixture, &fixture.bob, id)
            .await?
            .into_result()?
            .json::<bool>()?
    );
    assert_failure(
        &prove(&fixture, &fixture.carol, id).await?,
        "ERR_NO_SHARES_LOCKED_LAST_EPOCH",
    );
    let last: Value = fixture.shares.view("info").await?.json::<Value>()?["last"].clone();
    assert_eq!(last["voted_shares"], "900");

    advance_to_epoch(&fixture, 3).await?;
    assert_eq!(
        near(&holder(&fixture, &fixture.alice).await?["claimable_near"]),
        NearToken::from_near(6).as_yoctonear()
    );
    assert_eq!(
        near(&holder(&fixture, &fixture.bob).await?["claimable_near"]),
        NearToken::from_near(3).as_yoctonear()
    );
    assert_eq!(
        holder(&fixture, &fixture.alice).await?["claimable_token"],
        "600"
    );

    // Bob is not registered on the token: his token payment fails and stays owed.
    fixture
        .bob
        .call(fixture.shares.id(), "claim")
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let bob = holder(&fixture, &fixture.bob).await?;
    assert_eq!(bob["claimable_near"], "0");
    assert_eq!(bob["claimable_token"], "300");
    fixture
        .bob
        .call(fixture.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    fixture
        .bob
        .call(fixture.shares.id(), "claim")
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let balance: String = fixture
        .usdc
        .view("ft_balance_of")
        .args_json(json!({"account_id": fixture.bob.id()}))
        .await?
        .json()?;
    assert_eq!(balance, "300");
    Ok(())
}

#[tokio::test]
#[serial]
async fn without_voters_revenue_moves_to_the_current_epoch() -> Result<()> {
    let fixture = setup().await?;
    holders_locked_for_epoch_one(&fixture).await?;
    deposit(&fixture, 4).await?; // epoch 1, nobody votes
    advance_to_epoch(&fixture, 3).await?;
    deposit(&fixture, 1).await?; // settles epoch 1 into epoch 3
    let info: Value = fixture.shares.view("info").await?.json()?;
    assert_eq!(
        near(&info["current"]["near"]),
        NearToken::from_near(5).as_yoctonear()
    );
    let epoch_one: Value = fixture
        .shares
        .view("epoch_of")
        .args_json(json!({"epoch": 1}))
        .await?
        .json()?;
    assert_eq!(epoch_one["near"], "0");
    Ok(())
}
