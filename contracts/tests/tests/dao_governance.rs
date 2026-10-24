mod common;

use anyhow::Result;
use near_workspaces::types::Gas;
use serde_json::{Value, json};
use serial_test::serial;

use common::{
    add_proposal, assert_failure_contains, function_call_kind, preview_queue_id, proposal_status,
    set_role_change, setup, setup_with_threshold, vote,
};

#[tokio::test]
#[serial]
async fn dao_vote_queues_rule_then_permissionless_execution_waits_for_delay() -> Result<()> {
    let fixture = setup().await?;
    let change = set_role_change("purchasing");
    let queue_id = preview_queue_id(&fixture, change.clone()).await?;
    let kind = function_call_kind(
        &fixture.vault,
        "queue_rule_change",
        json!({"change": change}),
        80,
    );
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;
    vote(&fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;
    assert_eq!(proposal_status(&fixture, proposal_id).await?, "InProgress");
    assert!(
        fixture
            .vault
            .view("get_rule_change")
            .args_json(json!({"queue_id": queue_id}))
            .await?
            .json::<Option<Value>>()?
            .is_none()
    );

    vote(&fixture, &fixture.council[1], proposal_id, kind)
        .await?
        .into_result()?;
    assert_eq!(proposal_status(&fixture, proposal_id).await?, "Approved");
    let queued: Value = fixture
        .vault
        .view("get_rule_change")
        .args_json(json!({"queue_id": queue_id}))
        .await?
        .json::<Option<Value>>()?
        .expect("queued rule");
    assert_eq!(queued["state"], "Queued");

    let early = fixture
        .outsider
        .call(fixture.vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": queue_id}))
        .transact()
        .await?;
    assert_failure_contains(&early, "ERR_RULE_DELAY");
    fixture.worker.fast_forward(2).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": queue_id}))
        .transact()
        .await?
        .into_result()?;
    assert!(
        fixture
            .vault
            .view("get_role")
            .args_json(json!({"role": "purchasing"}))
            .await?
            .json::<Option<Value>>()?
            .is_some()
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn only_dao_can_queue_rules_but_one_council_member_can_target_veto() -> Result<()> {
    let fixture = setup().await?;
    let change = set_role_change("first");
    let direct = fixture.council[0]
        .call(fixture.vault.id(), "queue_rule_change")
        .args_json(json!({"change": change.clone()}))
        .transact()
        .await?;
    assert_failure_contains(&direct, "ERR_OWNER_ONLY");

    let first_id = preview_queue_id(&fixture, change.clone()).await?;
    let first_kind = function_call_kind(
        &fixture.vault,
        "queue_rule_change",
        json!({"change": change}),
        80,
    );
    let first_proposal = add_proposal(&fixture, &fixture.council[0], first_kind.clone()).await?;
    vote(
        &fixture,
        &fixture.council[0],
        first_proposal,
        first_kind.clone(),
    )
    .await?
    .into_result()?;
    vote(&fixture, &fixture.council[1], first_proposal, first_kind)
        .await?
        .into_result()?;

    let second_change = set_role_change("second");
    let second_id = preview_queue_id(&fixture, second_change.clone()).await?;
    let second_kind = function_call_kind(
        &fixture.vault,
        "queue_rule_change",
        json!({"change": second_change}),
        80,
    );
    let second_proposal = add_proposal(&fixture, &fixture.council[0], second_kind.clone()).await?;
    vote(
        &fixture,
        &fixture.council[0],
        second_proposal,
        second_kind.clone(),
    )
    .await?
    .into_result()?;
    vote(&fixture, &fixture.council[1], second_proposal, second_kind)
        .await?
        .into_result()?;

    fixture.council[2]
        .call(fixture.vault.id(), "veto_rule_change")
        .args_json(json!({"queue_id": first_id}))
        .transact()
        .await?
        .into_result()?;
    fixture.worker.fast_forward(2).await?;
    fixture
        .outsider
        .call(fixture.vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": second_id}))
        .transact()
        .await?
        .into_result()?;
    let first: Value = fixture
        .vault
        .view("get_rule_change")
        .args_json(json!({"queue_id": first_id}))
        .await?
        .json::<Option<Value>>()?
        .expect("first");
    assert_eq!(first["state"], "Vetoed");
    assert!(
        fixture
            .vault
            .view("get_role")
            .args_json(json!({"role": "second"}))
            .await?
            .json::<Option<Value>>()?
            .is_some()
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn ratio_two_thirds_requires_all_three_in_sputnik_v2_3_1() -> Result<()> {
    let fixture = setup_with_threshold(json!([2, 3])).await?;
    let change = set_role_change("ratio-role");
    let kind = function_call_kind(
        &fixture.vault,
        "queue_rule_change",
        json!({"change": change}),
        80,
    );
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;
    vote(&fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;
    vote(&fixture, &fixture.council[1], proposal_id, kind.clone())
        .await?
        .into_result()?;
    assert_eq!(proposal_status(&fixture, proposal_id).await?, "InProgress");
    vote(&fixture, &fixture.council[2], proposal_id, kind)
        .await?
        .into_result()?;
    assert_eq!(proposal_status(&fixture, proposal_id).await?, "Approved");
    Ok(())
}

#[tokio::test]
#[serial]
async fn final_vote_and_rule_execution_gas_are_measured() -> Result<()> {
    let fixture = setup().await?;
    let change = set_role_change("gas-role");
    let queue_id = preview_queue_id(&fixture, change.clone()).await?;
    let kind = function_call_kind(
        &fixture.vault,
        "queue_rule_change",
        json!({"change": change}),
        80,
    );
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;
    vote(&fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;
    let vote_outcome = vote(&fixture, &fixture.council[1], proposal_id, kind).await?;
    let vote_gas = vote_outcome.total_gas_burnt.as_gas();
    vote_outcome.into_result()?;
    fixture.worker.fast_forward(2).await?;
    let execute = fixture
        .outsider
        .call(fixture.vault.id(), "execute_rule_change")
        .args_json(json!({"queue_id": queue_id}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let execute_gas = execute.total_gas_burnt.as_gas();
    execute.into_result()?;
    println!(
        "OMNIROLES_GOVERNANCE_GAS={}",
        serde_json::to_string(
            &json!({"final_vote": vote_gas, "execute_rule_change": execute_gas})
        )?
    );
    assert!(vote_gas > 0 && execute_gas > 0);
    Ok(())
}
