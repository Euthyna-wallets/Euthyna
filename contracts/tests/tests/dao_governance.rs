mod common;

use anyhow::Result;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};
use serial_test::serial;

use common::{
    PROPOSAL_BOND_YOCTO, ROLE_BUDGET, add_proposal, approve_with_two, assert_failure_contains,
    get_role, proposal_status, role_config, set_role_kind, setup, setup_with_threshold,
    transfer_kind, vote,
};

#[tokio::test]
#[serial]
async fn function_call_requires_two_votes_and_then_executes() -> Result<()> {
    let fixture = setup().await?;
    let kind = set_role_kind(&fixture.vault, "compta-bot");
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;

    vote(&fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;

    assert_eq!(proposal_status(&fixture, proposal_id).await?, "InProgress");
    assert!(get_role(&fixture, "compta-bot").await?.is_none());

    vote(&fixture, &fixture.council[1], proposal_id, kind)
        .await?
        .into_result()?;

    assert_eq!(proposal_status(&fixture, proposal_id).await?, "Approved");
    let role = get_role(&fixture, "compta-bot")
        .await?
        .expect("role created");
    assert_eq!(role["config"]["max_per_tx"], "10000000");
    assert_eq!(role["funded"], "0");
    Ok(())
}

#[tokio::test]
#[serial]
async fn set_role_rejects_outsider_and_single_council_member() -> Result<()> {
    let fixture = setup().await?;
    let args = json!({"role": "compta-bot", "config": role_config()});

    let outsider = fixture
        .outsider
        .call(fixture.vault.id(), "set_role")
        .args_json(args.clone())
        .transact()
        .await?;
    assert_failure_contains(&outsider, "ERR_OWNER_ONLY");

    let council_member = fixture.council[0]
        .call(fixture.vault.id(), "set_role")
        .args_json(args)
        .transact()
        .await?;
    assert_failure_contains(&council_member, "ERR_OWNER_ONLY");
    assert!(get_role(&fixture, "compta-bot").await?.is_none());
    Ok(())
}

#[tokio::test]
#[serial]
async fn transfer_with_msg_credits_existing_role_atomically() -> Result<()> {
    let fixture = setup().await?;

    let create_kind = set_role_kind(&fixture.vault, "compta-bot");
    let create_id = add_proposal(&fixture, &fixture.council[0], create_kind.clone()).await?;
    let _ = approve_with_two(&fixture, create_id, create_kind).await?;

    let fund_kind = transfer_kind(&fixture.ft, &fixture.vault, "compta-bot", false);
    let fund_id = add_proposal(&fixture, &fixture.council[0], fund_kind.clone()).await?;
    let _ = approve_with_two(&fixture, fund_id, fund_kind).await?;

    let role = get_role(&fixture, "compta-bot")
        .await?
        .expect("role exists");
    assert_eq!(role["funded"], ROLE_BUDGET.to_string());
    assert_eq!(proposal_status(&fixture, fund_id).await?, "Approved");
    Ok(())
}

#[tokio::test]
#[serial]
async fn one_transfer_proposal_can_create_and_fund_role() -> Result<()> {
    let fixture = setup().await?;
    let kind = transfer_kind(&fixture.ft, &fixture.vault, "compta-bot", true);
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;

    let _ = approve_with_two(&fixture, proposal_id, kind).await?;

    let role = get_role(&fixture, "compta-bot")
        .await?
        .expect("role created");
    assert_eq!(role["config"]["max_per_tx"], "10000000");
    assert_eq!(role["funded"], ROLE_BUDGET.to_string());
    assert_eq!(proposal_status(&fixture, proposal_id).await?, "Approved");
    Ok(())
}

#[tokio::test]
#[serial]
async fn non_member_cannot_add_proposal() -> Result<()> {
    let fixture = setup().await?;
    let outcome = fixture
        .outsider
        .call(fixture.dao.id(), "add_proposal")
        .args_json(json!({
            "proposal": {
                "description": "outsider proposal",
                "kind": "Vote"
            }
        }))
        .deposit(NearToken::from_yoctonear(PROPOSAL_BOND_YOCTO))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;

    assert_failure_contains(&outcome, "ERR_PERMISSION_DENIED");
    Ok(())
}

#[tokio::test]
#[serial]
async fn factory_auto_update_can_be_disabled_by_vote() -> Result<()> {
    let fixture = setup().await?;
    let before: Value = fixture.dao.view("get_factory_info").await?.json()?;
    assert_eq!(before["auto_update"], true);

    let kind = json!({
        "FactoryInfoUpdate": {
            "factory_info": {
                "factory_id": fixture.dao.id(),
                "auto_update": false
            }
        }
    });
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;
    let _ = approve_with_two(&fixture, proposal_id, kind).await?;

    let after: Value = fixture.dao.view("get_factory_info").await?.json()?;
    assert_eq!(after["factory_id"], fixture.dao.id().to_string());
    assert_eq!(after["auto_update"], false);
    Ok(())
}

#[tokio::test]
#[serial]
async fn expired_proposal_cannot_execute() -> Result<()> {
    let fixture = setup().await?;
    let kind = set_role_kind(&fixture.vault, "expired-role");
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;

    fixture.worker.fast_forward(100).await?;

    vote(&fixture, &fixture.council[0], proposal_id, kind)
        .await?
        .into_result()?;

    assert_eq!(proposal_status(&fixture, proposal_id).await?, "Expired");
    assert!(get_role(&fixture, "expired-role").await?.is_none());
    Ok(())
}

#[tokio::test]
#[serial]
async fn vote_approve_execution_gas_is_measured() -> Result<()> {
    let fixture = setup().await?;

    let set_role = set_role_kind(&fixture.vault, "gas-role");
    let set_role_id = add_proposal(&fixture, &fixture.council[0], set_role.clone()).await?;
    vote(&fixture, &fixture.council[0], set_role_id, set_role.clone())
        .await?
        .into_result()?;
    let set_role_outcome = vote(&fixture, &fixture.council[1], set_role_id, set_role).await?;
    let set_role_gas = set_role_outcome.total_gas_burnt.as_gas();
    set_role_outcome.into_result()?;

    let register_agent = json!({
        "FunctionCall": {
            "receiver_id": fixture.vault.id(),
            "actions": [{
                "method_name": "register_agent",
                "args": STANDARD.encode(serde_json::to_vec(&json!({
                    "agent": fixture.outsider.id(),
                    "role": "gas-role",
                    "mpc_path": "agents/gas-role/base"
                }))?),
                "deposit": "0",
                "gas": Gas::from_tgas(50).as_gas().to_string()
            }]
        }
    });
    let register_id = add_proposal(&fixture, &fixture.council[0], register_agent.clone()).await?;
    vote(
        &fixture,
        &fixture.council[0],
        register_id,
        register_agent.clone(),
    )
    .await?
    .into_result()?;
    let register_outcome = vote(&fixture, &fixture.council[1], register_id, register_agent).await?;
    let register_gas = register_outcome.total_gas_burnt.as_gas();
    register_outcome.into_result()?;

    let transfer = transfer_kind(&fixture.ft, &fixture.vault, "gas-role", false);
    let transfer_id = add_proposal(&fixture, &fixture.council[0], transfer.clone()).await?;
    vote(&fixture, &fixture.council[0], transfer_id, transfer.clone())
        .await?
        .into_result()?;
    let transfer_outcome = vote(&fixture, &fixture.council[1], transfer_id, transfer).await?;
    let transfer_gas = transfer_outcome.total_gas_burnt.as_gas();
    transfer_outcome.into_result()?;

    let combined = json!({
        "FunctionCall": {
            "receiver_id": fixture.vault.id(),
            "actions": [
                {
                    "method_name": "set_role",
                    "args": STANDARD.encode(serde_json::to_vec(&json!({
                        "role": "combined-role",
                        "config": role_config()
                    }))?),
                    "deposit": "0",
                    "gas": Gas::from_tgas(50).as_gas().to_string()
                },
                {
                    "method_name": "register_agent",
                    "args": STANDARD.encode(serde_json::to_vec(&json!({
                        "agent": fixture.council[2].id(),
                        "role": "combined-role",
                        "mpc_path": "agents/combined-role/base"
                    }))?),
                    "deposit": "0",
                    "gas": Gas::from_tgas(50).as_gas().to_string()
                }
            ]
        }
    });
    let combined_id = add_proposal(&fixture, &fixture.council[0], combined.clone()).await?;
    vote(&fixture, &fixture.council[0], combined_id, combined.clone())
        .await?
        .into_result()?;
    let combined_outcome = fixture.council[1]
        .call(fixture.dao.id(), "act_proposal")
        .args_json(json!({
            "id": combined_id,
            "action": "VoteApprove",
            "proposal": combined,
            "memo": null
        }))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    let combined_gas = combined_outcome.total_gas_burnt.as_gas();
    combined_outcome.into_result()?;
    assert!(get_role(&fixture, "combined-role").await?.is_some());

    println!(
        "MANDATEOS_DAO_VOTE_GAS={}",
        serde_json::to_string(&json!({
            "set_role": set_role_gas,
            "register_agent": register_gas,
            "transfer": transfer_gas,
            "combined_set_role_register_agent": combined_gas,
        }))?
    );
    assert!(set_role_gas > 0 && register_gas > 0 && transfer_gas > 0 && combined_gas > 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn ratio_two_thirds_requires_all_three_in_sputnik_v2_3_1() -> Result<()> {
    let fixture = setup_with_threshold(json!([2, 3])).await?;
    let kind = set_role_kind(&fixture.vault, "ratio-role");
    let proposal_id = add_proposal(&fixture, &fixture.council[0], kind.clone()).await?;

    vote(&fixture, &fixture.council[0], proposal_id, kind.clone())
        .await?
        .into_result()?;
    vote(&fixture, &fixture.council[1], proposal_id, kind.clone())
        .await?
        .into_result()?;

    assert_eq!(proposal_status(&fixture, proposal_id).await?, "InProgress");
    assert!(get_role(&fixture, "ratio-role").await?.is_none());

    vote(&fixture, &fixture.council[2], proposal_id, kind)
        .await?
        .into_result()?;
    assert!(get_role(&fixture, "ratio-role").await?.is_some());
    Ok(())
}
