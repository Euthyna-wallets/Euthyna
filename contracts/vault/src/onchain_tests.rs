use super::*;
use near_sdk::serde_json::{from_value, json};
use near_sdk::{test_utils::VMContextBuilder, testing_env};
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
fn fixture(guard_required: bool, unlimited: bool) -> (Vault, OperationId) {
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
        },
    );
    let conditions = if unlimited {
        vec![]
    } else {
        omniroles_conditions::presets::erc20_transfer_in_list([1; 20], "suppliers", [5; 32])
            .conditions
    };
    let mut config = Vault::dao_gas_config();
    config.guard_required = guard_required;
    config.permissions = vec![Permission {
        chain_id: 84532,
        target: [1; 20],
        selector: Some([0xa9, 5, 0x9c, 0xbb]),
        conditions,
        allow_value: false,
    }];
    v.apply_rule_change(
        RuleChange::SetRole {
            role: "payments".into(),
            config,
        },
        1,
    );
    v.apply_rule_change(
        RuleChange::AddListAddress {
            list: "suppliers".into(),
            address: [2; 20],
            label: "Vendor".into(),
        },
        1,
    );
    v.apply_rule_change(
        RuleChange::GrantMembership {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
            kind: MembershipKind::Agent,
            starts_at_ns: U64(0),
            ends_at_ns: None,
            max_uses: Some(1),
        },
        1,
    );
    v.apply_rule_change(
        RuleChange::SetAllowance {
            key: [5; 32],
            balance: U128(100),
            refill: U128(0),
            max_refill: U128(100),
            period_ns: 0,
        },
        1,
    );
    let mut calldata = vec![0xa9, 5, 0x9c, 0xbb];
    calldata.extend([0; 12]);
    calldata.extend([2; 20]);
    calldata.extend([0; 16]);
    calldata.extend(10u128.to_be_bytes());
    context("agent.testnet", 2);
    let request=from_value(json!({"chain_id":84532,"target":vec![1;20],"value":"0","calldata":calldata,"allowance_amount":if unlimited {"0"} else {"10"},"reference":"invoice","gas_limit":"21000","max_fee_per_gas":"2","max_priority_fee_per_gas":"1"})).unwrap();
    let op = v.prepare("payments".into(), request);
    (v, op.op_id)
}
fn signed(v: &mut Vault, id: OperationId) {
    let _ = v.authorize(id, None);
    v.operations.get_mut(&id).unwrap().signed_transaction = Some(vec![2, 4, 6]);
}
fn response(payload_hash: [u8; 32]) -> foreign::VerifyResponse {
    from_value(json!({"payload_hash":hex::encode(payload_hash),"signature":{"scheme":"Secp256k1","big_r":{"affine_point":"00"},"s":{"scalar":"00"},"recovery_id":0}})).unwrap()
}
fn proof_args(v: &Vault, id: OperationId, cancel: bool) -> ([u8; 32], [u8; 32]) {
    let op = v.operations.get(&id).unwrap();
    let raw = if cancel {
        op.cancellation
            .as_ref()
            .unwrap()
            .signed_transaction
            .as_ref()
            .unwrap()
    } else {
        op.signed_transaction.as_ref().unwrap()
    };
    let tx_hash = env::keccak256_array(raw);
    (tx_hash, foreign::payload_hash(6, tx_hash, [9; 32]))
}
fn verify(v: &mut Vault, id: OperationId, cancel: bool, valid: bool) {
    let _ = if cancel {
        v.settle_cancellation(id, [9; 32])
    } else {
        v.settle(id, [9; 32])
    };
    let (tx_hash, expected) = proof_args(v, id, cancel);
    context("vault.testnet", 3);
    v.on_settle_verified(
        id,
        cancel,
        tx_hash,
        expected,
        Ok(response(if valid { expected } else { [0; 32] })),
    );
}

#[test]
fn unguarded_success_spends_and_frees() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    verify(&mut v, id, false, true);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Confirmed
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 90);
    assert!(v.wallets.get(&84532).unwrap().active_operation.is_none());
}
#[test]
#[should_panic(expected = "ERR_VISA_REQUIRED")]
fn guarded_role_refuses_no_visa() {
    let (mut v, id) = fixture(true, false);
    let _ = v.authorize(id, None);
}
#[test]
fn wrong_proof_cannot_refund() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    verify(&mut v, id, false, false);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::PossiblySigned
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().reserved.0, 10);
}
#[test]
fn cancellation_proof_refunds() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    context("stranger.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(id);
    v.operations
        .get_mut(&id)
        .unwrap()
        .cancellation
        .as_mut()
        .unwrap()
        .signed_transaction = Some(vec![8, 9]);
    verify(&mut v, id, true, true);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 100);
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().reserved.0, 0);
}
#[test]
fn timeout_spends_and_unlimited_frees() {
    for unlimited in [false, true] {
        let (mut v, id) = fixture(false, unlimited);
        signed(&mut v, id);
        context("stranger.testnet", 21_600_000_000_003);
        v.release_unconfirmed(id);
        assert_eq!(
            v.operations.get(&id).unwrap().state,
            OperationState::Unconfirmed
        );
        assert!(v.wallets.get(&84532).unwrap().active_operation.is_none());
        assert_eq!(v.wallets.get(&84532).unwrap().next_nonce, 1);
        assert_eq!(
            v.allowances.get(&[5; 32]).unwrap().balance.0,
            if unlimited { 100 } else { 90 }
        );
    }
}
#[test]
#[should_panic(expected = "ERR_UNCONFIRMED_TOO_EARLY")]
fn early_release_fails() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    v.release_unconfirmed(id);
}
#[test]
#[should_panic(expected = "ERR_CANCEL_TOO_EARLY")]
fn early_cancel_fails() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    let _ = v.cancel_nonce(id);
}
#[test]
fn bogus_proofs_do_not_block_valid_proof_and_success_is_idempotent() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    for i in 0..20 {
        context("attacker.testnet", 10 + i);
        let _ = v.settle(id, [i as u8; 32]);
    }
    let (hash, expected) = proof_args(&v, id, false);
    verify(&mut v, id, false, true);
    v.on_settle_verified(id, false, hash, expected, Ok(response(expected)));
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Confirmed
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 90);
    assert_eq!(
        v.memberships
            .get(&MembershipKey {
                role: "payments".into(),
                member: "agent.testnet".parse().unwrap()
            })
            .unwrap()
            .used_uses,
        1
    );
}

#[test]
fn lists_go_through_delay_and_veto() {
    let (mut v, _) = fixture(false, true);
    context("owner.testnet", 5);
    let entry = v.queue_rule_change(RuleChange::AddListAddress {
        list: "suppliers".into(),
        address: [4; 20],
        label: "New".into(),
    });
    context("council.testnet", 6);
    v.veto_rule_change(entry.queue_id);
    context("stranger.testnet", 20);
    assert_eq!(v.get_address_list("suppliers".into()).len(), 1);
    context("owner.testnet", 21);
    let entry = v.queue_rule_change(RuleChange::AddListAddress {
        list: "suppliers".into(),
        address: [4; 20],
        label: "New".into(),
    });
    context("stranger.testnet", 32);
    v.execute_rule_change(entry.queue_id);
    assert_eq!(v.get_address_list("suppliers".into()).len(), 2);
}
#[test]
#[should_panic(expected = "ERR_CANCELLATION_ALREADY_REQUESTED")]
fn cancel_only_once() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    context("stranger.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(id);
    let _ = v.cancel_nonce(id);
}
#[test]
fn bogus_proofs_do_not_block_timeout() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    for i in 0..20 {
        context("attacker.testnet", 10 + i);
        let _ = v.settle(id, [i as u8; 32]);
    }
    context("stranger.testnet", 21_600_000_000_003);
    v.release_unconfirmed(id);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Unconfirmed
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 90);
}

#[test]
#[should_panic(expected = "ERR_CANCELLATION_PROOF_REQUIRED")]
fn trusted_cancellation_cannot_refund() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    context("owner.testnet", 3);
    v.confirm_cancellation(id, [0; 32]);
}
#[test]
#[should_panic(expected = "ERR_FAILURE_REPORT_DISABLED")]
fn agent_cannot_claim_failure() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    let report = SignedStatusReport {
        report: StatusReport {
            client_id: "acme".into(),
            op_id: id,
            kind: StatusKind::Failed,
            tx_hash: [0; 32],
            report_nonce: 1,
            block_number: 1,
        },
        signature: Base64VecU8(vec![0; 64]),
    };
    v.report_status(report, None);
}
#[test]
#[should_panic(expected = "ERR_ADDRESS_LIST_FULL")]
fn list_limit() {
    let (mut v, _) = fixture(false, true);
    for i in 0..256u16 {
        let mut address = [0; 20];
        address[18..].copy_from_slice(&i.to_be_bytes());
        v.apply_rule_change(
            RuleChange::AddListAddress {
                list: "suppliers".into(),
                address,
                label: "Vendor".into(),
            },
            1,
        );
    }
}
#[test]
#[should_panic(expected = "ERR_ADDRESS_LABEL_LENGTH")]
fn label_limit() {
    Vault::validate_rule_change(&RuleChange::AddListAddress {
        list: "suppliers".into(),
        address: [1; 20],
        label: "x".repeat(65),
    });
}
#[test]
#[should_panic(expected = "ERR_ADDRESS_LIST_NAME")]
fn list_name_limit() {
    Vault::validate_rule_change(&RuleChange::RemoveListAddress {
        list: "bad name".into(),
        address: [1; 20],
    });
}
#[test]
fn wrong_hash_and_response_do_not_change_state() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    let (hash, expected) = proof_args(&v, id, false);
    context("vault.testnet", 4);
    v.on_settle_verified(id, false, [0; 32], expected, Ok(response(expected)));
    v.on_settle_verified(id, false, hash, expected, Ok(response([0; 32])));
    v.on_settle_verified(id, false, hash, expected, Err(PromiseError::Failed));
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::PossiblySigned
    );
    verify(&mut v, id, false, true);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Confirmed
    );
}

#[test]
fn supplied_visa_is_verified_and_nonce_consumed() {
    use ed25519_dalek::{Signer, SigningKey};
    let (mut v, id) = fixture(true, false);
    let key = SigningKey::from_bytes(&[7; 32]);
    v.visa_public_key = key.verifying_key().to_bytes();
    let op = v.operations.get(&id).unwrap();
    let visa = GuardVisa {
        client_id: "acme".into(),
        op_id: id,
        tx_digest: op.tx_digest,
        agent: op.member.to_string(),
        role: op.role.clone(),
        reference: op.request.reference.clone(),
        policy_version: 1,
        registry_version: 1,
        visa_nonce: 42,
        expires_at_ns: U64(999_999),
    };
    let mut message = VISA_DOMAIN.to_vec();
    message.extend(to_vec(&visa).unwrap());
    let approval = GuardApproval {
        visa,
        signature: Base64VecU8(key.sign(&message).to_bytes().to_vec()),
    };
    let _ = v.authorize(id, Some(approval));
    assert!(v.used_visa_nonces.contains(&42));
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::PossiblySigned
    );
}

#[test]
fn bogus_proofs_do_not_block_cancellation_and_late_success_does_nothing() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    for i in 0..20 {
        context("attacker.testnet", 10 + i);
        let _ = v.settle(id, [i as u8; 32]);
    }
    context("stranger.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(id);
    let op = v.operations.get_mut(&id).unwrap();
    let cancel = op.cancellation.as_mut().unwrap();
    assert_eq!(cancel.transaction.max_fee_per_gas.0, 4);
    assert_eq!(cancel.transaction.max_priority_fee_per_gas.0, 2);
    assert_eq!(cancel.transaction.nonce, op.transaction.nonce);
    cancel.signed_transaction = Some(vec![8, 9]);
    let (hash, expected) = proof_args(&v, id, true);
    context("stranger.testnet", 21_600_000_000_003);
    v.release_unconfirmed(id);
    context("vault.testnet", 21_600_000_000_004);
    v.on_settle_verified(id, true, hash, expected, Ok(response(expected)));
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Unconfirmed
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 90);
}

#[test]
#[should_panic(expected = "ERR_CONDITIONS_CHANGED")]
fn removed_supplier_is_rechecked_before_signature() {
    let (mut v, id) = fixture(false, false);
    v.apply_rule_change(
        RuleChange::RemoveListAddress {
            list: "suppliers".into(),
            address: [2; 20],
        },
        2,
    );
    let _ = v.authorize(id, None);
}

#[test]
#[should_panic(expected = "ERR_SIGNED_TRANSACTION_REQUIRED")]
fn cancellation_requires_a_stored_signed_transaction() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    let _ = v.settle_cancellation(id, [9; 32]);
}
#[test]
#[should_panic(expected = "ERR_FOREIGN_CHAIN_UNAVAILABLE")]
fn unsupported_chain_cannot_settle() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    v.operations.get_mut(&id).unwrap().request.chain_id = 11155111;
    let _ = v.settle(id, [9; 32]);
}
#[test]
#[should_panic(expected = "ERR_NOT_POSSIBLY_SIGNED")]
fn terminal_operation_cannot_settle_twice() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    verify(&mut v, id, false, true);
    let _ = v.settle(id, [9; 32]);
}

#[test]
fn migration_batch_is_one_queued_rule() {
    let (mut v, _) = fixture(false, true);
    context("owner.testnet", 5);
    let rule = v.queue_rule_change(RuleChange::AddListAddresses {
        list: "suppliers".into(),
        entries: vec![
            ListAddress {
                address: [4; 20],
                label: "A".into(),
            },
            ListAddress {
                address: [6; 20],
                label: "B".into(),
            },
        ],
    });
    assert_eq!(v.get_address_list("suppliers".into()).len(), 1);
    context("stranger.testnet", 16);
    v.execute_rule_change(rule.queue_id);
    assert_eq!(v.get_address_list("suppliers".into()).len(), 3);
}

#[test]
fn zero_original_tip_still_produces_a_replaceable_cancellation() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    v.operations
        .get_mut(&id)
        .unwrap()
        .transaction
        .max_priority_fee_per_gas = U128(0);
    context("attacker.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(id);
    let cancellation = v
        .operations
        .get_mut(&id)
        .unwrap()
        .cancellation
        .as_mut()
        .unwrap();
    assert_eq!(cancellation.transaction.max_priority_fee_per_gas.0, 1);
    cancellation.signed_transaction = Some(vec![8, 9]);
    verify(&mut v, id, true, true);
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 100);
}
