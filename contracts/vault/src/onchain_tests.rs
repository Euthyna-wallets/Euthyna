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
            in_flight: Vec::new(),
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
    context("agent.testnet", 2);
    let request = payment_request("invoice", unlimited);
    let op = v.prepare("payments".into(), request);
    (v, op.op_id)
}
fn payment_request(reference: &str, unlimited: bool) -> OperationRequest {
    let mut calldata = vec![0xa9, 5, 0x9c, 0xbb];
    calldata.extend([0; 12]);
    calldata.extend([2; 20]);
    calldata.extend([0; 16]);
    calldata.extend(10u128.to_be_bytes());
    from_value(json!({"chain_id":84532,"target":vec![1;20],"value":"0","calldata":calldata,"allowance_amount":if unlimited {"0"} else {"10"},"reference":reference,"gas_limit":"21000","max_fee_per_gas":"2","max_priority_fee_per_gas":"1"})).unwrap()
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
    drop(v.execute_rule_change(entry.queue_id));
    assert_eq!(v.get_address_list("suppliers".into()).len(), 2);
}
#[test]
#[should_panic(expected = "ERR_CANCELLATION_ALREADY_SIGNED")]
fn signed_cancellation_cannot_be_requested_again() {
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
    drop(v.execute_rule_change(rule.queue_id));
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

#[test]
fn failed_cancellation_signature_can_retry_the_same_transaction() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    context("stranger.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(id);
    let attempt = v.operations.get(&id).unwrap().cancellation.clone().unwrap();
    context("vault.testnet", 3_600_000_000_004);
    v.on_cancel_signature(id, attempt.tx_digest, Err(PromiseError::Failed));
    assert!(
        v.operations
            .get(&id)
            .unwrap()
            .cancellation
            .as_ref()
            .unwrap()
            .signature
            .is_none()
    );
    v.roles.get_mut("payments").unwrap().config.max_fee_per_gas = U128(0);
    context("stranger.testnet", 3_600_000_000_005);
    let _ = v.cancel_nonce(id);
    let retried = v
        .operations
        .get(&id)
        .unwrap()
        .cancellation
        .as_ref()
        .unwrap();
    assert_eq!(retried.tx_digest, attempt.tx_digest);
    assert_eq!(
        near_sdk::serde_json::to_value(&retried.transaction).unwrap(),
        near_sdk::serde_json::to_value(&attempt.transaction).unwrap()
    );
    assert_eq!(retried.request_count, 2);
    assert_eq!(retried.requested_at_ns, 3_600_000_000_005);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::PossiblySigned
    );
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().reserved.0, 10);
}

#[test]
fn concurrent_cancellation_retries_keep_the_first_signed_transaction() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    for i in 0..3 {
        context("stranger.testnet", 3_600_000_000_003 + i);
        let _ = v.cancel_nonce(id);
    }
    let digest = v
        .operations
        .get(&id)
        .unwrap()
        .cancellation
        .as_ref()
        .unwrap()
        .tx_digest;
    let signature = |scalar: &str| {
        from_value(json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("02{}", "11".repeat(32))},"s":{"scalar":scalar.repeat(32)},"recovery_id":0})).unwrap()
    };
    context("vault.testnet", 3_600_000_000_006);
    v.on_cancel_signature(id, digest, Ok(signature("22")));
    let raw = v
        .operations
        .get(&id)
        .unwrap()
        .cancellation
        .as_ref()
        .unwrap()
        .signed_transaction
        .clone();
    assert!(raw.is_some());
    v.on_cancel_signature(id, digest, Ok(signature("33")));
    v.on_cancel_signature(id, digest, Err(PromiseError::Failed));
    let attempt = v
        .operations
        .get(&id)
        .unwrap()
        .cancellation
        .as_ref()
        .unwrap();
    assert_eq!(attempt.signed_transaction, raw);
    assert_eq!(attempt.request_count, 3);
}

/// Lets the agent prepare more than one operation.
fn unlimited_uses(v: &mut Vault) {
    v.memberships
        .get_mut(&MembershipKey {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
        })
        .unwrap()
        .max_uses = None;
}
fn next_operation(v: &mut Vault, reference: &str) -> OperationId {
    context("agent.testnet", 2);
    let id = v
        .prepare("payments".into(), payment_request(reference, false))
        .op_id;
    signed(v, id);
    id
}
fn wallet(v: &Vault) -> &ChainWallet {
    v.wallets.get(&84532).unwrap()
}

#[test]
fn signed_operation_frees_the_next_nonce() {
    let (mut v, first) = fixture(false, false);
    unlimited_uses(&mut v);
    signed(&mut v, first);
    let second = next_operation(&mut v, "invoice-2");
    assert_eq!(v.operations.get(&second).unwrap().evm_nonce, 1);
    assert_eq!(wallet(&v).in_flight, vec![first, second]);
    assert_eq!(wallet(&v).next_nonce, 2);
    // Settlement order does not matter.
    verify(&mut v, second, false, true);
    verify(&mut v, first, false, true);
    for id in [first, second] {
        assert_eq!(
            v.operations.get(&id).unwrap().state,
            OperationState::Confirmed
        );
    }
    assert!(wallet(&v).in_flight.is_empty());
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 80);
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().reserved.0, 0);
}
#[test]
#[should_panic(expected = "ERR_WALLET_QUEUE_BUSY")]
fn unsigned_operation_still_holds_the_nonce() {
    let (mut v, _first) = fixture(false, false);
    unlimited_uses(&mut v);
    context("agent.testnet", 2);
    v.prepare("payments".into(), payment_request("invoice-2", false));
}
#[test]
fn in_flight_queue_is_capped() {
    let (mut v, first) = fixture(false, false);
    unlimited_uses(&mut v);
    signed(&mut v, first);
    for n in 1..types::MAX_IN_FLIGHT {
        next_operation(&mut v, &format!("invoice-{n}"));
    }
    assert_eq!(wallet(&v).in_flight.len(), types::MAX_IN_FLIGHT);
    assert!(!wallet(&v).accepts_operation());
    context("agent.testnet", 2);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        v.prepare("payments".into(), payment_request("one-too-many", false))
    }));
    assert!(refused.is_err());
    // Settling any of them makes room again.
    verify(&mut v, first, false, true);
    let next = next_operation(&mut v, "after-settle");
    assert_eq!(
        v.operations.get(&next).unwrap().evm_nonce,
        types::MAX_IN_FLIGHT as u64
    );
}
#[test]
fn cancelled_nonce_does_not_touch_later_operations() {
    let (mut v, first) = fixture(false, false);
    unlimited_uses(&mut v);
    signed(&mut v, first);
    let second = next_operation(&mut v, "invoice-2");
    context("stranger.testnet", 3_600_000_000_003);
    let _ = v.cancel_nonce(first);
    v.operations
        .get_mut(&first)
        .unwrap()
        .cancellation
        .as_mut()
        .unwrap()
        .signed_transaction = Some(vec![8, 9]);
    verify(&mut v, first, true, true);
    assert_eq!(
        v.operations.get(&first).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(
        v.operations.get(&second).unwrap().state,
        OperationState::PossiblySigned
    );
    assert_eq!(wallet(&v).in_flight, vec![second]);
    // Only the cancelled operation is refunded.
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().balance.0, 100);
    assert_eq!(v.allowances.get(&[5; 32]).unwrap().reserved.0, 10);
}

fn code_result(code: &[u8]) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id("vault.testnet".parse().unwrap())
            .prepaid_gas(Gas::from_tgas(300))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Successful(code.to_vec())],
    );
}
#[test]
fn upgrade_deploys_only_the_voted_code() {
    let (mut v, _) = fixture(false, false);
    let code = b"\0asm\x01\0\0\0next-vault".to_vec();
    code_result(&code);
    drop(v.on_upgrade_code(env::sha256_array(&code).into()));
    let deployed = near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|receipt| receipt.actions)
        .any(|action| matches!(action, near_sdk::mock::MockAction::DeployContract { code: c, .. } if c == code));
    assert!(deployed);
}
#[test]
#[should_panic(expected = "ERR_UPGRADE_CODE_HASH")]
fn upgrade_refuses_code_with_another_hash() {
    let (mut v, _) = fixture(false, false);
    code_result(b"\0asm\x01\0\0\0swapped-by-the-factory");
    drop(v.on_upgrade_code(env::sha256_array(b"\0asm\x01\0\0\0next-vault").into()));
}
#[test]
#[should_panic(expected = "ERR_OWNER_ONLY")]
fn only_the_dao_queues_an_upgrade() {
    let (mut v, _) = fixture(false, false);
    context("factory.testnet", 3);
    v.queue_rule_change(RuleChange::Upgrade {
        code_hash: [1; 32].into(),
    });
}

mod solana_flow {
    use super::*;
    use crate::solana::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    const AGENT: &str = "agent.testnet";
    const OK_TO: [u8; 32] = [9; 32];
    const BUDGET_KEY: [u8; 32] = [0x50; 32];

    fn result_with(value: Vec<u8>) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("vault.testnet".parse().unwrap())
                .predecessor_account_id("vault.testnet".parse().unwrap())
                .prepaid_gas(Gas::from_tgas(300))
                .block_timestamp(3)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(value)],
        );
    }

    /// A vault whose role "payments" may send up to 1 SOL a day to OK_TO.
    fn setup() -> (Vault, SigningKey) {
        let (mut v, _) = fixture(false, false);
        let key = SigningKey::from_bytes(&[42; 32]);
        let public = key.verifying_key().to_bytes();
        context("owner.testnet", 3);
        drop(v.request_solana_wallet());
        result_with(format!("\"ed25519:{}\"", bs58::encode(public).into_string()).into_bytes());
        v.on_solana_public_key(Ok(format!(
            "ed25519:{}",
            bs58::encode(public).into_string()
        )));
        v.memberships
            .get_mut(&MembershipKey {
                role: "payments".into(),
                member: AGENT.parse().unwrap(),
            })
            .unwrap()
            .max_uses = None;
        v.apply_rule_change(
            RuleChange::SetAllowance {
                key: BUDGET_KEY,
                balance: U128(1_000_000_000),
                refill: U128(1_000_000_000),
                max_refill: U128(1_000_000_000),
                period_ns: 86_400_000_000_000,
            },
            3,
        );
        v.apply_rule_change(
            RuleChange::SetSolanaPermissions {
                role: "payments".into(),
                permissions: vec![SolanaPermission {
                    asset: SolanaAsset::Sol,
                    recipients: vec![OK_TO],
                    allowance: BUDGET_KEY,
                }],
            },
            3,
        );
        (v, key)
    }

    fn request(to: [u8; 32], lamports: u64, reference: &str) -> SolanaTransferRequest {
        SolanaTransferRequest {
            asset: SolanaAsset::Sol,
            to,
            amount: U64(lamports),
            recent_blockhash: [3; 32],
            reference: reference.into(),
        }
    }

    fn last_op(v: &Vault, reference: &str) -> SolanaOperation {
        let op_id = *v
            .references
            .get(&ReferenceKey {
                role: "payments".into(),
                reference: reference.into(),
            })
            .unwrap();
        v.get_solana_operation(op_id).unwrap()
    }

    #[test]
    fn derives_the_wallet_from_the_mpc_key() {
        let (v, key) = setup();
        assert_eq!(
            v.get_solana_wallet().unwrap().address,
            Some(key.verifying_key().to_bytes())
        );
    }

    #[test]
    fn signs_settles_and_spends_the_budget() {
        let (mut v, key) = setup();
        context(AGENT, 3);
        drop(v.execute_solana("payments".into(), request(OK_TO, 400_000_000, "pay-1")));
        let op = last_op(&v, "pay-1");
        assert_eq!(
            v.allowances.get(&BUDGET_KEY).unwrap().reserved.0,
            400_000_000
        );

        // A signature by any other key, or over another message, is dropped.
        let wrong = SigningKey::from_bytes(&[1; 32])
            .sign(&op.message)
            .to_bytes();
        result_with(vec![]);
        v.on_solana_signature(
            op.op_id,
            Ok(MpcSignatureResponse::Ed25519 {
                signature: wrong.to_vec(),
            }),
        );
        assert!(
            v.get_solana_operation(op.op_id)
                .unwrap()
                .signed_transaction
                .is_none()
        );

        let good = key.sign(&op.message).to_bytes();
        v.on_solana_signature(
            op.op_id,
            Ok(MpcSignatureResponse::Ed25519 {
                signature: good.to_vec(),
            }),
        );
        let signed = v.get_solana_operation(op.op_id).unwrap();
        let wire = signed.signed_transaction.unwrap();
        assert_eq!(&wire[1..65], &good);
        assert_eq!(&wire[65..], op.message.as_slice());

        // A wrong attestation does nothing; the right one confirms and spends.
        let expected = crate::solana::payload_hash(&good);
        let response = |hash: [u8; 32]| -> foreign::VerifyResponse {
            from_value(json!({"payload_hash":hex::encode(hash),"signature":{"scheme":"Ed25519","signature":[0]}})).unwrap()
        };
        v.on_solana_settled(op.op_id, expected, Ok(response([0; 32])));
        assert_eq!(
            v.get_solana_operation(op.op_id).unwrap().state,
            OperationState::PossiblySigned
        );
        v.on_solana_settled(op.op_id, expected, Ok(response(expected)));
        assert_eq!(
            v.get_solana_operation(op.op_id).unwrap().state,
            OperationState::Confirmed
        );
        let budget = v.allowances.get(&BUDGET_KEY).unwrap();
        assert_eq!((budget.balance.0, budget.reserved.0), (600_000_000, 0));
    }

    #[test]
    fn refuses_what_the_role_does_not_allow() {
        let (v, key) = setup();
        let agent: AccountId = AGENT.parse().unwrap();
        let check = |request| {
            v.check_solana("payments".into(), agent.clone(), request)
                .reason
        };
        assert_eq!(check(request(OK_TO, 1, "a")), None);
        assert_eq!(
            check(request([8; 32], 1, "a")).as_deref(),
            Some("FunctionNotAllowed")
        );
        assert_eq!(
            check(request(OK_TO, 1_000_000_001, "a")).as_deref(),
            Some("allowanceExceeded")
        );
        assert_eq!(
            check(request(key.verifying_key().to_bytes(), 1, "a")).as_deref(),
            Some("ERR_SELF_TRANSFER")
        );
        let spl = SolanaTransferRequest {
            asset: SolanaAsset::Spl { mint: [5; 32] },
            ..request(OK_TO, 1, "a")
        };
        assert_eq!(check(spl).as_deref(), Some("FunctionNotAllowed"));
        assert_eq!(
            v.check_solana(
                "payments".into(),
                "stranger.testnet".parse().unwrap(),
                request(OK_TO, 1, "a")
            )
            .reason
            .as_deref(),
            Some("ERR_MEMBERSHIP_NOT_FOUND")
        );
    }

    #[test]
    #[should_panic(expected = "ERR_REFERENCE_ALREADY_USED")]
    fn a_reference_is_used_once() {
        let (mut v, _) = setup();
        context(AGENT, 3);
        drop(v.execute_solana("payments".into(), request(OK_TO, 1, "same")));
        drop(v.execute_solana("payments".into(), request(OK_TO, 1, "same")));
    }

    #[test]
    #[should_panic(expected = "ERR_OWNER_ONLY")]
    fn only_the_dao_opens_the_solana_wallet() {
        let (mut v, _) = fixture(false, false);
        context(AGENT, 3);
        drop(v.request_solana_wallet());
    }
}

#[test]
#[should_panic(expected = "ERR_UPGRADE_NEEDS_MORE_GAS")]
fn an_upgrade_cannot_be_burned_with_little_gas() {
    let (mut v, _) = fixture(false, false);
    context("owner.testnet", 3);
    let queued = v.queue_rule_change(RuleChange::Upgrade {
        code_hash: [1; 32].into(),
    });
    testing_env!(
        VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id("stranger.testnet".parse().unwrap())
            .block_timestamp(50)
            .prepaid_gas(Gas::from_tgas(100))
            .build()
    );
    drop(v.execute_rule_change(queued.queue_id));
}

fn revoke_agent(v: &mut Vault) {
    v.apply_rule_change(
        RuleChange::RevokeMembership {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
        },
        3,
    );
}
fn agent_membership(v: &Vault) -> &Membership {
    v.memberships
        .get(&MembershipKey {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
        })
        .unwrap()
}

#[test]
fn agent_with_a_signed_operation_in_flight_is_revoked_at_once() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    assert_eq!(agent_membership(&v).reserved_uses, 1);
    revoke_agent(&mut v);
    assert!(!agent_membership(&v).active);
    // The signed transaction still settles and frees its reservation.
    verify(&mut v, id, false, true);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Confirmed
    );
    assert_eq!(agent_membership(&v).reserved_uses, 0);
    assert!(!agent_membership(&v).active);
}

#[test]
fn unconfirmed_operation_of_a_revoked_agent_still_times_out() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    revoke_agent(&mut v);
    let after = 2 + v.settlement_config.unconfirmed_after_ns.0;
    context("stranger.testnet", after);
    v.release_unconfirmed(id);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Unconfirmed
    );
    assert_eq!(agent_membership(&v).reserved_uses, 0);
}

#[test]
#[should_panic(expected = "ERR_MEMBERSHIP_REVOKED")]
fn prepared_operation_of_a_revoked_agent_is_never_signed() {
    let (mut v, id) = fixture(false, false);
    revoke_agent(&mut v);
    context("agent.testnet", 3);
    let _ = v.authorize(id, None);
}

#[test]
fn council_cancels_what_a_revoked_agent_left_prepared() {
    let (mut v, id) = fixture(false, false);
    revoke_agent(&mut v);
    context("council.testnet", 3);
    v.cancel_prepared(id);
    assert_eq!(
        v.operations.get(&id).unwrap().state,
        OperationState::Cancelled
    );
    assert_eq!(agent_membership(&v).reserved_uses, 0);
}

#[test]
#[should_panic(expected = "ERR_MEMBERSHIP_IN_USE")]
fn re_granting_waits_for_the_operations_in_flight() {
    let (mut v, id) = fixture(false, false);
    signed(&mut v, id);
    revoke_agent(&mut v);
    v.apply_rule_change(
        RuleChange::GrantMembership {
            role: "payments".into(),
            member: "agent.testnet".parse().unwrap(),
            kind: MembershipKind::Agent,
            starts_at_ns: U64(0),
            ends_at_ns: None,
            max_uses: Some(1),
        },
        3,
    );
}
