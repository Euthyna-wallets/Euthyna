use super::*;
use crate::bank::{BankBeneficiary, BankConfig, BankPayoutState, BankPermission};

const COMMITMENT: &str = "1111111111111111111111111111111111111111111111111111111111111111";
use near_sdk::serde_json::json;
use near_sdk::{test_utils::VMContextBuilder, testing_env};

/// Beneficiary 1, voted sealed; 2 was never voted.
const IBAN: u32 = 1;
const OTHER_IBAN: u32 = 2;

fn sealed(commitment: &str) -> RuleChange {
    RuleChange::AddSealedBankBeneficiary {
        label: "Supplier A".into(),
        commitment: commitment.into(),
        sealed_for_signer: "eyJ2IjoxfQ==".into(),
        sealed_for_members: "eyJ2IjoxfQ==".into(),
    }
}

fn context(caller: &str, now: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .signer_account_id(caller.parse().unwrap())
            .block_timestamp(now)
            .prepaid_gas(Gas::from_tgas(300))
            .build()
    );
}

fn config() -> BankConfig {
    BankConfig {
        outlayer_id: "outlayer.testnet".parse().unwrap(),
        signer_url: "https://test.fastfs.io/x/signer.wasm".into(),
        signer_hash: "ab".repeat(32),
        secrets_owner: "ops.testnet".parse().unwrap(),
        secrets_profile: "noah".into(),
        customer_id: "acme".into(),
        network: "BaseTestSepolia".into(),
        crypto: "EURC_TEST".into(),
        chain_id: 84532,
        token: [9; 20],
        decimals: 6,
        gas_limit: U128(120_000),
        max_fee_per_gas: U128(100_000_000),
        max_priority_fee_per_gas: U128(1_000_000),
    }
}

fn fixture() -> Vault {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    context("owner.testnet", 1);
    let mut v = Vault::new(
        "acme".into(),
        "owner.testnet".parse().unwrap(),
        "mpc.testnet".parse().unwrap(),
        Base64VecU8(vec![7; 32]),
        Base64VecU8(vec![8; 32]),
        1,
        1,
        1_000_000_000,
        10,
        100,
        vec!["council.testnet".parse().unwrap()],
        None,
    );
    v.wallets.insert(
        84532,
        ChainWallet {
            chain_id: 84532,
            mpc_path: "wallet".into(),
            derived_public_key: None,
            address: Some([3; 20]),
            next_nonce: 0,
            active_operation: None,
            in_flight: Vec::new(),
        },
    );
    let config_role = Vault::dao_gas_config();
    for change in [
        RuleChange::SetRole {
            role: "payments".into(),
            config: config_role,
        },
        RuleChange::GrantMembership {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
            kind: MembershipKind::Agent,
            starts_at_ns: U64(0),
            ends_at_ns: None,
            max_uses: Some(1),
        },
        RuleChange::SetAllowance {
            key: [5; 32],
            balance: U128(10_000_000),
            refill: U128(0),
            max_refill: U128(10_000_000),
            period_ns: 0,
        },
        RuleChange::SetBankConfig {
            config: Some(config()),
        },
        sealed(COMMITMENT),
        RuleChange::SetBankPermission {
            role: "payments".into(),
            permission: Some(BankPermission {
                allowance: [5; 32],
                max_per_payout: U128(5_000_000),
            }),
        },
    ] {
        Vault::validate_rule_change(&change);
        v.apply_rule_change(change, 1);
    }
    context("agent.testnet", 2);
    v
}

fn refused(v: &Vault, iban: u32, amount: u128, reference: &str) -> Option<String> {
    v.check_bank_payout(
        "payments".into(),
        "agent.testnet".parse().unwrap(),
        iban,
        U128(amount),
        reference.into(),
    )
    .reason
}

#[test]
fn only_voted_ibans_within_budget() {
    let v = fixture();
    assert_eq!(refused(&v, IBAN, 5_000_000, "inv-1"), None);
    assert_eq!(
        refused(&v, OTHER_IBAN, 1, "inv-1").as_deref(),
        Some("BeneficiaryNotAllowed")
    );
    assert_eq!(
        refused(&v, IBAN, 5_000_001, "inv-1").as_deref(),
        Some("ERR_MAX_PER_PAYOUT")
    );
    assert_eq!(
        refused(&v, IBAN, 0, "inv-1").as_deref(),
        Some("ERR_ZERO_AMOUNT")
    );
    assert_eq!(
        refused(&v, IBAN, 1, "").as_deref(),
        Some("ERR_BANK_REFERENCE")
    );
    assert_eq!(
        v.check_bank_payout(
            "payments".into(),
            "stranger.testnet".parse().unwrap(),
            IBAN,
            U128(1),
            "x".into()
        )
        .reason
        .as_deref(),
        Some("ERR_MEMBERSHIP_NOT_FOUND")
    );
    assert_eq!(
        v.check_bank_payout(
            "dao".into(),
            "agent.testnet".parse().unwrap(),
            IBAN,
            U128(1),
            "x".into()
        )
        .reason
        .as_deref(),
        Some("ERR_ROLE_NOT_FOUND")
    );
}

#[test]
fn removed_beneficiary_is_refused_and_role_without_permission_too() {
    let mut v = fixture();
    v.apply_rule_change(RuleChange::RemoveSealedBankBeneficiary { id: IBAN }, 1);
    assert!(v.list_bank_beneficiaries().is_empty());
    assert_eq!(
        refused(&v, IBAN, 1, "inv-1").as_deref(),
        Some("BeneficiaryNotAllowed")
    );
    // Voted again, it gets a new number: the old number stays refused.
    v.apply_rule_change(sealed(&"22".repeat(32)), 1);
    assert_eq!(v.list_bank_beneficiaries()[0].id, 2);
    assert_eq!(
        refused(&v, IBAN, 1, "inv-1").as_deref(),
        Some("BeneficiaryNotAllowed")
    );
    v.apply_rule_change(
        RuleChange::SetBankPermission {
            role: "payments".into(),
            permission: None,
        },
        1,
    );
    assert_eq!(
        refused(&v, 2, 1, "inv-1").as_deref(),
        Some("FunctionNotAllowed")
    );
}

#[test]
#[should_panic(expected = "ERR_BANK_CLEARTEXT_IBAN")]
fn an_iban_in_clear_cannot_be_voted() {
    let _v = fixture();
    Vault::validate_rule_change(&RuleChange::AddBankBeneficiary {
        beneficiary: BankBeneficiary {
            iban: "FR7630006000011234567890189".into(),
            name: "X".into(),
            holder_type: "Business".into(),
        },
    });
}

#[test]
#[should_panic(expected = "ERR_BANK_COMMITMENT")]
fn a_sealed_beneficiary_needs_a_commitment() {
    let _v = fixture();
    Vault::validate_rule_change(&sealed("FR7630006000011234567890189"));
}

#[test]
fn the_first_version_clear_ibans_are_erased_from_state() {
    let mut v = fixture();
    let legacy = vec![BankBeneficiary {
        iban: "FR7630006000011234567890189".into(),
        name: "Vendor SAS".into(),
        holder_type: "Business".into(),
    }];
    env::storage_write(b"bank:b", &borsh::to_vec(&legacy).unwrap());
    env::storage_write(b"bank:o:xx", b"payout in clear");
    env::storage_write(
        b"bank:i",
        &borsh::to_vec(&vec![{
            let mut id = [0u8; 32];
            id[..4].copy_from_slice(b"xx\0\0");
            id
        }])
        .unwrap(),
    );
    v.apply_rule_change(
        RuleChange::SetBankBoxKey {
            key: Some("ab".repeat(32)),
        },
        1,
    );
    assert!(env::storage_read(b"bank:b").is_none());
    assert!(env::storage_read(b"bank:i").is_none());
    assert_eq!(
        v.get_bank_box_key().as_deref(),
        Some("ab".repeat(32).as_str())
    );
}

#[test]
fn the_enclave_gets_the_sealed_envelope_and_the_commitment_never_the_iban() {
    let mut v = fixture();
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_000_000), "inv-1".into());
    let receipts = near_sdk::test_utils::get_created_receipts();
    let call: String = receipts
        .iter()
        .flat_map(|receipt| receipt.actions.iter())
        .map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } => {
                format!(
                    "{} {}",
                    String::from_utf8_lossy(method_name),
                    String::from_utf8_lossy(args)
                )
            }
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(call.contains("request_execution"));
    assert!(
        call.contains(COMMITMENT),
        "the commitment goes to the enclave"
    );
    assert!(
        call.contains("eyJ2IjoxfQ=="),
        "with the envelope the members sealed for it"
    );
    let payout = v
        .get_bank_payout_by_reference("payments".into(), "inv-1".into())
        .unwrap();
    assert_eq!(
        (payout.beneficiary_id, payout.commitment.as_str()),
        (IBAN, COMMITMENT)
    );
}

#[test]
fn request_reserves_and_callback_queues_the_euro_transfer() {
    let mut v = fixture();
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_234_500), "inv-1".into());
    let payout = v
        .get_bank_payout_by_reference("payments".into(), "inv-1".into())
        .expect("payout stored");
    assert_eq!(payout.state, BankPayoutState::Requested);
    assert_eq!(v.allowances[&[5; 32]].reserved.0, 1_234_500);
    assert_eq!(v.role_reservations["payments"], 1);
    assert_eq!(
        refused(&v, IBAN, 1, "inv-2").as_deref(),
        Some("ERR_BANK_PAYOUT_PENDING"),
        "one at a time"
    );

    context("vault.testnet", 3);
    let answer = json!({
        "ok": true,
        "rule_id": "rule-1",
        "deposit_address": "0x71c2b82c60d0e139ec2ac1bc8edb270528e1ee5a",
        "crypto_amount": "1.2345",
        "fiat_amount": "1.21",
        "expiry": "2026-11-08T00:00:00Z"
    });
    assert_eq!(
        v.on_bank_signer(payout.op_id, Ok(answer)),
        BankPayoutState::Transferring
    );
    let payout = v.get_bank_payout(payout.op_id).unwrap();
    let transfer_id = payout.transfer_op_id.expect("transfer queued");
    assert_eq!(payout.rule_id.as_deref(), Some("rule-1"));
    let transfer = v.operations.get(&transfer_id).expect("operation");
    assert_eq!(transfer.state, OperationState::Scheduled);
    assert_eq!(transfer.role, "payments");
    assert_eq!(transfer.request.target, [9; 20]);
    assert_eq!(transfer.request.allowance_amount.0, 1_234_500);
    let calldata = &transfer.request.calldata;
    assert_eq!(&calldata[..4], &[0xa9, 0x05, 0x9c, 0xbb]);
    assert_eq!(
        &calldata[16..36],
        &hex::decode("71c2b82c60d0e139ec2ac1bc8edb270528e1ee5a").unwrap()[..]
    );
    assert_eq!(
        u128::from_be_bytes(calldata[52..68].try_into().unwrap()),
        1_234_500
    );
    assert_eq!(v.dao_queue, vec![transfer_id]);
    assert_eq!(
        v.get_bank_payout_by_reference("payments".into(), "inv-1".into())
            .map(|p| p.op_id),
        Some(payout.op_id),
        "found through the transfer too"
    );
    assert_eq!(v.count_bank_payouts(), 1);
    assert_eq!(v.list_bank_payouts(None, None)[0].op_id, payout.op_id);
    assert!(v.list_bank_payouts(Some(1), None).is_empty());
    assert_eq!(
        v.allowances[&[5; 32]].reserved.0, 1_234_500,
        "the budget stays reserved until the transfer settles"
    );
    assert_eq!(
        refused(&v, IBAN, 1, "inv-1").as_deref(),
        Some("ERR_MEMBERSHIP_UNAVAILABLE"),
        "the membership use is spent"
    );

    assert_eq!(
        v.list_dao_transactions(None, None)[0].op_id,
        transfer_id,
        "the keeper sees it with the voted transactions"
    );
    // Before signing, the vault rechecks the payout, not the role's EVM permissions.
    v.recheck_bank_transfer(&payout.op_id, transfer);
    v.apply_rule_change(RuleChange::RemoveSealedBankBeneficiary { id: IBAN }, 3);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || v.recheck_bank_transfer(&payout.op_id, v.operations.get(&transfer_id).unwrap())
        ))
        .is_err(),
        "a removed beneficiary stops the transfer"
    );

    // The transfer settles like any operation: the budget is charged and the role freed.
    v.release_operation(transfer_id, OperationState::Confirmed, false);
    assert_eq!(v.allowances[&[5; 32]].reserved.0, 0);
    assert_eq!(v.allowances[&[5; 32]].balance.0, 10_000_000 - 1_234_500);
    assert_eq!(v.role_reservations["payments"], 0);
    assert!(v.dao_queue.is_empty());
}

#[test]
fn signer_failure_gives_everything_back() {
    let mut v = fixture();
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_000_000), "inv-1".into());
    let payout = v
        .get_bank_payout_by_reference("payments".into(), "inv-1".into())
        .unwrap();
    context("vault.testnet", 3);
    assert_eq!(
        v.on_bank_signer(payout.op_id, Err(PromiseError::Failed)),
        BankPayoutState::Failed
    );
    assert_eq!(v.allowances[&[5; 32]].reserved.0, 0);
    assert_eq!(v.role_reservations["payments"], 0);
    assert!(
        v.get_bank_payout_by_reference("payments".into(), "inv-1".into())
            .is_none(),
        "the reference is free again"
    );
    assert_eq!(
        v.get_bank_payout(payout.op_id).unwrap().error.as_deref(),
        Some("signer unreachable")
    );
    assert!(v.dao_queue.is_empty());
    context("agent.testnet", 4);
    assert_eq!(
        refused(&v, IBAN, 1, "inv-1"),
        None,
        "the agent can try again"
    );
}

#[test]
fn signer_cannot_change_the_amount() {
    let mut v = fixture();
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_000_000), "inv-1".into());
    let payout = v
        .get_bank_payout_by_reference("payments".into(), "inv-1".into())
        .unwrap();
    context("vault.testnet", 3);
    let answer = json!({"ok": true, "rule_id": "r", "deposit_address": "0x71c2b82c60d0e139ec2ac1bc8edb270528e1ee5a", "crypto_amount": "2"});
    assert_eq!(
        v.on_bank_signer(payout.op_id, Ok(answer)),
        BankPayoutState::Failed
    );
    assert_eq!(v.allowances[&[5; 32]].reserved.0, 0);
    let refused_answer = json!({"ok": false, "error": "rule rejected"});
    context("agent.testnet", 4);
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_000_000), "inv-2".into());
    let payout = v
        .get_bank_payout_by_reference("payments".into(), "inv-2".into())
        .unwrap();
    context("vault.testnet", 5);
    assert_eq!(
        v.on_bank_signer(payout.op_id, Ok(refused_answer)),
        BankPayoutState::Failed
    );
    assert_eq!(
        v.get_bank_payout(payout.op_id).unwrap().error.as_deref(),
        Some("rule rejected")
    );
}

#[test]
#[should_panic(expected = "BeneficiaryNotAllowed")]
fn request_to_unknown_iban_panics() {
    let mut v = fixture();
    let _ = v.request_bank_payout("payments".into(), OTHER_IBAN, U128(1), "inv-1".into());
}

fn standing_order(count: Option<u32>) -> RuleChange {
    RuleChange::AddStandingOrder {
        beneficiary_id: IBAN,
        amount: U128(2_400_000_000),
        first_at_ns: U64(1_000),
        period_ns: U64(30 * 86_400_000_000_000),
        count,
        label: "Payroll".into(),
    }
}

#[test]
fn a_standing_order_pays_the_voted_amount_on_its_date_without_any_budget() {
    let mut v = fixture();
    Vault::validate_rule_change(&standing_order(Some(2)));
    v.apply_rule_change(standing_order(Some(2)), 1);
    let order = v.list_standing_orders()[0].clone();
    context("anyone.testnet", 999);
    assert!(v.due_standing_orders().is_empty(), "not before its date");

    context("anyone.testnet", 1_000);
    assert_eq!(v.due_standing_orders(), vec![order.id]);
    let _ = v.run_standing_order(order.id);
    let payout = v.list_bank_payouts(None, None)[0].clone();
    assert_eq!(payout.role, DAO_ROLE);
    assert_eq!(payout.amount.0, 2_400_000_000);
    assert_eq!(payout.reference, "SO1-1");
    let next = &v.list_standing_orders()[0];
    assert_eq!(next.next_at_ns.0, 1_000 + 30 * 86_400_000_000_000);
    assert_eq!((next.remaining, next.runs), (Some(1), 1));
    assert_eq!(
        v.allowances[&[5; 32]].reserved.0, 0,
        "no role budget is used"
    );

    // The enclave answers: the transfer is queued like a voted transaction.
    context("vault.testnet", 1_001);
    let answer = json!({"ok": true, "rule_id": "r", "deposit_address": "0x71c2b82c60d0e139ec2ac1bc8edb270528e1ee5a", "crypto_amount": "2400"});
    assert_eq!(
        v.on_bank_signer(payout.op_id, Ok(answer)),
        BankPayoutState::Transferring
    );
    let transfer_id = v
        .get_bank_payout(payout.op_id)
        .unwrap()
        .transfer_op_id
        .unwrap();
    let transfer = v.operations.get(&transfer_id).unwrap();
    assert_eq!(transfer.role, DAO_ROLE);
    assert!(transfer.consumptions.is_empty());
    v.recheck_bank_transfer(&payout.op_id, transfer);
    v.release_operation(transfer_id, OperationState::Confirmed, false);
    assert!(v.dao_queue.is_empty());
}

#[test]
fn a_failed_standing_order_goes_back_to_its_date_and_the_last_run_removes_it() {
    let mut v = fixture();
    v.apply_rule_change(standing_order(Some(1)), 1);
    context("anyone.testnet", 1_000);
    let _ = v.run_standing_order(1);
    assert!(
        v.list_standing_orders().is_empty(),
        "its only run is under way"
    );
    let payout = v.list_bank_payouts(None, None)[0].clone();
    context("vault.testnet", 1_001);
    assert_eq!(
        v.on_bank_signer(payout.op_id, Err(PromiseError::Failed)),
        BankPayoutState::Failed
    );
    let back = &v.list_standing_orders()[0];
    assert_eq!(
        (back.next_at_ns.0, back.remaining, back.runs),
        (1_000, Some(1), 0),
        "restored: the keeper tries again"
    );
    context("anyone.testnet", 1_002);
    assert_eq!(v.due_standing_orders(), vec![1]);
}

#[test]
fn removing_a_beneficiary_cancels_its_standing_orders() {
    let mut v = fixture();
    v.apply_rule_change(standing_order(None), 1);
    v.apply_rule_change(RuleChange::RemoveSealedBankBeneficiary { id: IBAN }, 1);
    assert!(v.list_standing_orders().is_empty());
}

#[test]
#[should_panic(expected = "ERR_STANDING_ORDER_PERIOD")]
fn a_standing_order_cannot_run_every_second() {
    let _v = fixture();
    Vault::validate_rule_change(&RuleChange::AddStandingOrder {
        beneficiary_id: IBAN,
        amount: U128(1),
        first_at_ns: U64(0),
        period_ns: U64(1_000_000_000),
        count: None,
        label: String::new(),
    });
}

fn receipts_text() -> String {
    near_sdk::test_utils::get_created_receipts()
        .iter()
        .flat_map(|receipt| receipt.actions.iter())
        .map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } => {
                format!("{} {}", String::from_utf8_lossy(method_name), String::from_utf8_lossy(args))
            }
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn signer_source(project: Option<&str>, follow: bool) -> RuleChange {
    RuleChange::SetBankSignerSource { project: project.map(str::to_string), follow }
}

fn vote(v: &mut Vault, change: RuleChange) {
    Vault::validate_rule_change(&change);
    v.apply_rule_change(change, 1);
}

#[test]
#[should_panic(expected = "ERR_BANK_SIGNER_PROJECT")]
fn a_signer_project_is_owner_slash_name() {
    Vault::validate_rule_change(&signer_source(Some("not a project"), false));
}

#[test]
#[should_panic(expected = "ERR_BANK_FOLLOW_NEEDS_PROJECT")]
fn following_needs_a_project() {
    Vault::validate_rule_change(&signer_source(None, true));
}

#[test]
fn from_a_project_the_vault_still_runs_exactly_its_voted_hash() {
    let mut v = fixture();
    context("owner.testnet", 2);
    vote(&mut v, signer_source(Some("ops.testnet/bank-signer"), false));
    context("agent.testnet", 3);
    let _ = v.request_bank_payout("payments".into(), IBAN, U128(1_000_000), "inv-1".into());
    let call = receipts_text();
    assert!(call.contains(&format!(
        r#""source":{{"Project":{{"project_id":"ops.testnet/bank-signer","version_key":"{}"}}}}"#,
        "ab".repeat(32)
    )), "{call}");
    assert!(!call.contains("WasmUrl"));
    // Back to the code URL.
    let mut v = fixture();
    context("owner.testnet", 2);
    vote(&mut v, signer_source(Some("ops.testnet/bank-signer"), false));
    vote(&mut v, signer_source(None, false));
    assert!(v.get_bank_signer_source().is_none());
}

fn project(active: &str) -> Result<Option<near_sdk::serde_json::Value>, PromiseError> {
    Ok(Some(json!({ "project_id": "ops.testnet/bank-signer", "owner": "ops.testnet", "active_version": active })))
}

#[test]
fn a_followed_version_is_queued_once_like_a_vote_and_the_council_can_veto_it() {
    let mut v = fixture();
    context("owner.testnet", 2);
    vote(&mut v, signer_source(Some("ops.testnet/bank-signer"), true));
    context("anyone.testnet", 10);
    // Anyone asks the project for its active version.
    let _ = v.follow_bank_signer();
    let call = receipts_text();
    assert!(call.contains(r#"get_project {"project_id":"ops.testnet/bank-signer"}"#), "{call}");

    // The version the vault already runs: nothing to do.
    context("vault.testnet", 11);
    assert_eq!(v.on_bank_signer_project(project(&"ab".repeat(32))), None);
    // Another project's answer, or no project: ignored.
    assert_eq!(v.on_bank_signer_project(Ok(Some(json!({ "project_id": "evil.testnet/x", "active_version": "cd".repeat(32) })))), None);
    assert_eq!(v.on_bank_signer_project(Ok(None)), None);

    // A new version: queued as an ordinary rule, after the rule delay.
    let queue_id = v.on_bank_signer_project(project(&"cd".repeat(32))).expect("queued");
    let entry = v.get_rule_change(queue_id).unwrap();
    assert_eq!(entry.state, RuleChangeState::Queued);
    assert_eq!(entry.execute_after_ns.0, 11 + 10, "the vault's own rule delay (10 here)");
    match &entry.change {
        RuleChange::SetBankConfig { config: Some(next) } => {
            assert_eq!(next.signer_hash, "cd".repeat(32));
            let same = BankConfig { signer_hash: "ab".repeat(32), ..next.clone() };
            assert_eq!(near_sdk::serde_json::to_value(&same).unwrap(), near_sdk::serde_json::to_value(config()).unwrap(), "nothing else changes");
        }
        other => panic!("{other:?}"),
    }
    // Once only.
    assert_eq!(v.on_bank_signer_project(project(&"cd".repeat(32))), None);

    // The council vetoes it: the vault keeps its signer, and that version is not queued again.
    context("council.testnet", 12);
    v.veto_rule_change(queue_id);
    context("vault.testnet", 13);
    assert_eq!(v.on_bank_signer_project(project(&"cd".repeat(32))), None);
    assert_eq!(v.get_bank_config().unwrap().signer_hash, "ab".repeat(32));

    // A later version is queued and, once its delay is over, becomes the signer.
    let next = v.on_bank_signer_project(project(&"ef".repeat(32))).expect("queued");
    context("anyone.testnet", 22);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = v.execute_rule_change(next); })).is_err(), "not before its delay");
    context("anyone.testnet", 23);
    let _ = v.execute_rule_change(next);
    assert_eq!(v.get_bank_config().unwrap().signer_hash, "ef".repeat(32));
}

#[test]
#[should_panic(expected = "ERR_BANK_NOT_FOLLOWING")]
fn a_vault_that_votes_each_version_is_not_followed() {
    let mut v = fixture();
    context("owner.testnet", 2);
    vote(&mut v, signer_source(Some("ops.testnet/bank-signer"), false));
    let _ = v.follow_bank_signer();
}
