//! Engine tests. Calldata is produced with alloy (independent ABI encoder).

use std::collections::BTreeMap;

use alloy_primitives::{Address as AlloyAddress, Bytes, I256, U256};
use alloy_sol_types::{SolCall, sol};
use omniroles_conditions::abi::{address_word, u128_word};
use omniroles_conditions::*;
use sha3::{Digest, Keccak256};

sol! {
    function transfer(address to, uint256 amount);
    function batch(address[] to, uint256[] amounts);
    function exec(address to, bytes data);
    struct Order { address tokenIn; address tokenOut; uint256 amount; }
    function swap(Order order, string memo);
    struct Note { uint256 id; bytes body; }
    function post(Note note);
    function adjust(int256 delta);
    function flags(bytes32 word);
}

const ALICE: [u8; 20] = [0xa1; 20];
const BOB: [u8; 20] = [0xb0; 20];
const EVE: [u8; 20] = [0xee; 20];
const AVATAR: [u8; 20] = [0xac; 20];
const USDC: [u8; 20] = [0x05; 20];
const KEY: [u8; 32] = [0x11; 32];
const NOW: u64 = 1_800_000_000;

fn a(address: [u8; 20]) -> AlloyAddress {
    AlloyAddress::from(address)
}

fn c(
    parent: u16,
    encoding: Encoding,
    operator: Operator,
    comp: impl Into<Vec<u8>>,
) -> ConditionFlat {
    ConditionFlat {
        parent,
        param_type: encoding,
        operator,
        comp_value: comp.into(),
    }
}

fn none() -> Vec<u8> {
    Vec::new()
}

fn word(value: u128) -> Vec<u8> {
    u128_word(value).to_vec()
}

fn addr(address: [u8; 20]) -> Vec<u8> {
    address_word(&address).to_vec()
}

fn keccak(data: &[u8]) -> Vec<u8> {
    Keccak256::digest(data).to_vec()
}

fn allowances(balance: u128) -> BTreeMap<[u8; 32], Allowance> {
    let allowance = Allowance {
        refill: 100,
        max_refill: 100,
        period: 86_400,
        balance,
        timestamp: NOW - 10,
    };
    BTreeMap::from([(KEY, allowance)])
}

fn run(
    conditions: &[ConditionFlat],
    calldata: &[u8],
    value: u128,
    store: &BTreeMap<[u8; 32], Allowance>,
) -> Result<Vec<Consumption>, Status> {
    let context = Context {
        calldata,
        value,
        avatar: AVATAR,
        now: NOW,
        allowances: store,
    };
    evaluate(conditions, &context)
}

use Encoding as E;
use Operator as O;

/// transfer(to == BOB, amount within allowance KEY)
fn transfer_to_bob() -> Vec<ConditionFlat> {
    vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::EqualTo, addr(BOB)),
        c(0, E::Static, O::WithinAllowance, KEY.to_vec()),
    ]
}

fn transfer(to: [u8; 20], amount: u64) -> Vec<u8> {
    transferCall {
        to: a(to),
        amount: U256::from(amount),
    }
    .abi_encode()
}

#[test]
fn transfer_within_allowance_passes_and_reports_consumption() {
    let store = allowances(100);
    let consumptions = run(&transfer_to_bob(), &transfer(BOB, 60), 0, &store).unwrap();
    assert_eq!(consumptions.len(), 1);
    assert_eq!(consumptions[0].consumed, 60);
    assert_eq!(consumptions[0].balance_after(), 40);
    assert!(!consumptions[0].calls_only);
}

#[test]
fn transfer_to_other_recipient_is_refused() {
    let store = allowances(100);
    assert_eq!(
        run(&transfer_to_bob(), &transfer(EVE, 1), 0, &store),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
}

#[test]
fn transfer_above_allowance_is_refused() {
    let store = allowances(100);
    let error = run(&transfer_to_bob(), &transfer(BOB, 101), 0, &store).unwrap_err();
    assert!(matches!(error, Status::AllowanceExceeded { node: 2, .. }));
}

#[test]
fn allowance_refills_after_a_period_up_to_max() {
    let mut store = allowances(0);
    store.get_mut(&KEY).unwrap().timestamp = NOW - 3 * 86_400 - 5;
    let consumptions = run(&transfer_to_bob(), &transfer(BOB, 100), 0, &store).unwrap();
    assert_eq!(consumptions[0].balance, 100, "capped at max_refill");
    assert_eq!(consumptions[0].timestamp, NOW - 5);
    assert!(run(&transfer_to_bob(), &transfer(BOB, 101), 0, &store).is_err());
}

#[test]
fn unknown_allowance_fails_closed() {
    let store = BTreeMap::new();
    assert!(matches!(
        run(&transfer_to_bob(), &transfer(BOB, 1), 0, &store),
        Err(Status::UnknownAllowance { .. })
    ));
}

#[test]
fn or_accepts_any_branch() {
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::None, O::Or, none()),
        c(0, E::Static, O::Pass, none()),
        c(1, E::Static, O::EqualTo, addr(ALICE)),
        c(1, E::Static, O::EqualTo, addr(BOB)),
    ];
    let store = BTreeMap::new();
    assert!(run(&conditions, &transfer(ALICE, 5), 0, &store).is_ok());
    assert!(run(&conditions, &transfer(BOB, 5), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &transfer(EVE, 5), 0, &store),
        Err(Status::ParameterNotOneOfAllowed { node: 1 })
    );
}

#[test]
fn or_rolls_back_consumption_of_failed_branch() {
    // Or( And(amount within KEY, to == ALICE), to == BOB-or-anything via Pass on amount )
    let conditions = vec![
        c(0, E::None, O::Or, none()),
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::AbiEncoded, O::Matches, none()),
        c(1, E::Static, O::EqualTo, addr(ALICE)),
        c(1, E::Static, O::WithinAllowance, KEY.to_vec()),
        c(2, E::Static, O::EqualTo, addr(BOB)),
        c(2, E::Static, O::Pass, none()),
    ];
    let store = allowances(100);
    // Field order: first branch checks `to` first and fails before consuming; make
    // a branch that consumes first and fails after.
    let consuming_first = vec![
        c(0, E::None, O::Or, none()),
        c(0, E::None, O::And, none()),
        c(0, E::AbiEncoded, O::Matches, none()),
        c(1, E::AbiEncoded, O::Matches, none()),
        c(1, E::AbiEncoded, O::Matches, none()),
        c(2, E::Static, O::EqualTo, addr(BOB)),
        c(2, E::Static, O::Pass, none()),
        c(3, E::Static, O::Pass, none()),
        c(3, E::Static, O::WithinAllowance, KEY.to_vec()),
        c(4, E::Static, O::EqualTo, addr(ALICE)),
        c(4, E::Static, O::Pass, none()),
    ];
    assert_eq!(
        run(&conditions, &transfer(BOB, 50), 0, &store).unwrap(),
        vec![]
    );
    assert_eq!(
        run(&consuming_first, &transfer(BOB, 50), 0, &store).unwrap(),
        vec![]
    );
    assert_eq!(
        run(&consuming_first, &transfer(ALICE, 50), 0, &store).unwrap()[0].consumed,
        50
    );
}

fn batch(to: &[[u8; 20]], amounts: &[u64]) -> Vec<u8> {
    batchCall {
        to: to.iter().map(|x| a(*x)).collect(),
        amounts: amounts.iter().map(|x| U256::from(*x)).collect(),
    }
    .abi_encode()
}

/// batch(every to in {ALICE, BOB}, every amount < 80 and within KEY in total)
fn batch_conditions() -> Vec<ConditionFlat> {
    vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Array, O::ArrayEvery, none()),
        c(0, E::Array, O::ArrayEvery, none()),
        c(1, E::None, O::Or, none()),
        c(2, E::None, O::And, none()),
        c(3, E::Static, O::EqualTo, addr(ALICE)),
        c(3, E::Static, O::EqualTo, addr(BOB)),
        c(4, E::Static, O::LessThan, word(80)),
        c(4, E::Static, O::WithinAllowance, KEY.to_vec()),
    ]
}

#[test]
fn array_every_checks_each_element_and_sums_allowance() {
    let store = allowances(100);
    let ok = run(
        &batch_conditions(),
        &batch(&[ALICE, BOB], &[30, 70]),
        0,
        &store,
    )
    .unwrap();
    assert_eq!(ok[0].consumed, 100);
    assert_eq!(
        run(
            &batch_conditions(),
            &batch(&[ALICE, EVE], &[1, 1]),
            0,
            &store
        ),
        Err(Status::NotEveryArrayElementPasses { node: 1 })
    );
    assert_eq!(
        run(&batch_conditions(), &batch(&[ALICE], &[80]), 0, &store),
        Err(Status::NotEveryArrayElementPasses { node: 2 })
    );
    assert_eq!(
        run(
            &batch_conditions(),
            &batch(&[ALICE, BOB], &[40, 70]),
            0,
            &store
        ),
        Err(Status::NotEveryArrayElementPasses { node: 2 })
    );
}

#[test]
fn array_some_needs_one_element() {
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Array, O::ArraySome, none()),
        c(0, E::Array, O::Pass, none()),
        c(1, E::Static, O::EqualTo, addr(BOB)),
        c(2, E::Static, O::Pass, none()),
    ];
    let store = BTreeMap::new();
    assert!(run(&conditions, &batch(&[EVE, BOB], &[1, 2]), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &batch(&[EVE], &[1]), 0, &store),
        Err(Status::NoArrayElementPasses { node: 1 })
    );
    assert_eq!(
        run(&conditions, &batch(&[], &[]), 0, &store),
        Err(Status::NoArrayElementPasses { node: 1 })
    );
}

#[test]
fn nested_abi_in_bytes_is_decoded() {
    // exec(to == USDC, data = transfer(to == BOB, amount < 1000))
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::EqualTo, addr(USDC)),
        c(0, E::AbiEncoded, O::Matches, none()),
        c(2, E::Static, O::EqualTo, addr(BOB)),
        c(2, E::Static, O::LessThan, word(1000)),
    ];
    let store = BTreeMap::new();
    let call = |to, amount| {
        execCall {
            to: a(USDC),
            data: Bytes::from(transfer(to, amount)),
        }
        .abi_encode()
    };
    assert!(run(&conditions, &call(BOB, 999), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &call(EVE, 1), 0, &store),
        Err(Status::ParameterNotAllowed { node: 3 })
    );
    assert_eq!(
        run(&conditions, &call(BOB, 1000), 0, &store),
        Err(Status::ParameterGreaterThanAllowed { node: 4 })
    );
}

#[test]
fn static_tuple_and_dynamic_string() {
    let memo = "invoice 42";
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Tuple, O::Matches, none()),
        c(0, E::Dynamic, O::EqualTo, keccak(memo.as_bytes())),
        c(1, E::Static, O::EqualTo, addr(USDC)),
        c(1, E::Static, O::EqualToAvatar, none()),
        c(1, E::Static, O::GreaterThan, word(10)),
    ];
    let store = BTreeMap::new();
    let call = |token_out, amount: u64, memo: &str| {
        swapCall {
            order: Order {
                tokenIn: a(USDC),
                tokenOut: a(token_out),
                amount: U256::from(amount),
            },
            memo: memo.into(),
        }
        .abi_encode()
    };
    assert!(run(&conditions, &call(AVATAR, 11, memo), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &call(EVE, 11, memo), 0, &store),
        Err(Status::ParameterNotAllowed { node: 4 })
    );
    assert_eq!(
        run(&conditions, &call(AVATAR, 10, memo), 0, &store),
        Err(Status::ParameterLessThanAllowed { node: 5 })
    );
    assert_eq!(
        run(&conditions, &call(AVATAR, 11, "other"), 0, &store),
        Err(Status::ParameterNotAllowed { node: 2 })
    );
}

#[test]
fn equal_to_static_tuple_hash() {
    let order = Order {
        tokenIn: a(USDC),
        tokenOut: a(BOB),
        amount: U256::from(5u64),
    };
    let call = swapCall {
        order: order.clone(),
        memo: "x".into(),
    }
    .abi_encode();
    let inline = &call[4..4 + 96];
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Tuple, O::EqualTo, keccak(inline)),
        c(0, E::Dynamic, O::Pass, none()),
        c(1, E::Static, O::Pass, none()),
        c(1, E::Static, O::Pass, none()),
        c(1, E::Static, O::Pass, none()),
    ];
    let store = BTreeMap::new();
    assert!(run(&conditions, &call, 0, &store).is_ok());
    let other = swapCall {
        order: Order {
            amount: U256::from(6u64),
            ..order
        },
        memo: "x".into(),
    }
    .abi_encode();
    assert_eq!(
        run(&conditions, &other, 0, &store),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
}

#[test]
fn dynamic_tuple_fields() {
    let body = b"hello".to_vec();
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Tuple, O::Matches, none()),
        c(1, E::Static, O::LessThan, word(100)),
        c(1, E::Dynamic, O::EqualTo, keccak(&body)),
    ];
    let store = BTreeMap::new();
    let call = |id: u64, body: &[u8]| {
        postCall {
            note: Note {
                id: U256::from(id),
                body: Bytes::from(body.to_vec()),
            },
        }
        .abi_encode()
    };
    assert!(run(&conditions, &call(7, &body), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &call(7, b"hellp"), 0, &store),
        Err(Status::ParameterNotAllowed { node: 3 })
    );
    assert_eq!(
        run(&conditions, &call(100, &body), 0, &store),
        Err(Status::ParameterGreaterThanAllowed { node: 2 })
    );
}

#[test]
fn signed_comparison() {
    let minus_ten = I256::try_from(-10i64)
        .unwrap()
        .into_raw()
        .to_be_bytes::<32>()
        .to_vec();
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::SignedIntGreaterThan, minus_ten),
    ];
    let store = BTreeMap::new();
    let call = |delta: i64| {
        adjustCall {
            delta: I256::try_from(delta).unwrap(),
        }
        .abi_encode()
    };
    assert!(run(&conditions, &call(-9), 0, &store).is_ok());
    assert!(run(&conditions, &call(5), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &call(-10), 0, &store),
        Err(Status::ParameterLessThanAllowed { node: 1 })
    );
    assert!(run(&conditions, &call(-11), 0, &store).is_err());
}

#[test]
fn bitmask_on_static_word() {
    let mut comp = vec![0u8; 32];
    comp[1] = 0; // offset 0
    comp[2] = 0xf0; // mask first byte high nibble
    comp[17] = 0xa0; // expected
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::Bitmask, comp),
    ];
    let store = BTreeMap::new();
    let call = |first: u8| {
        let mut w = [0u8; 32];
        w[0] = first;
        flagsCall { word: w.into() }.abi_encode()
    };
    assert!(run(&conditions, &call(0xa7), 0, &store).is_ok());
    assert_eq!(
        run(&conditions, &call(0xb7), 0, &store),
        Err(Status::BitmaskNotAllowed { node: 1 })
    );
}

#[test]
fn native_transfer_with_ether_allowance() {
    let conditions = vec![
        c(0, E::None, O::And, none()),
        c(0, E::None, O::Empty, none()),
        c(0, E::EtherValue, O::WithinAllowance, KEY.to_vec()),
    ];
    let store = allowances(100);
    assert_eq!(run(&conditions, &[], 100, &store).unwrap()[0].consumed, 100);
    assert!(matches!(
        run(&conditions, &[], 101, &store),
        Err(Status::AllowanceExceeded { .. })
    ));
    assert_eq!(
        run(&conditions, &transfer(BOB, 1), 1, &store),
        Err(Status::NotEmpty { node: 1 })
    );
}

#[test]
fn call_within_allowance_counts_calls() {
    let mut conditions = transfer_to_bob();
    conditions[2] = c(0, E::Static, O::Pass, none());
    conditions.push(c(0, E::None, O::CallWithinAllowance, KEY.to_vec()));
    let mut store = allowances(2);
    let first = run(&conditions, &transfer(BOB, 1), 0, &store).unwrap();
    assert_eq!(first[0].consumed, 1);
    assert!(first[0].calls_only, "call counter, not an amount");
    store.get_mut(&KEY).unwrap().balance = first[0].balance_after() - 1;
    assert!(matches!(
        run(&conditions, &transfer(BOB, 1), 0, &store),
        Err(Status::AllowanceExceeded { node: 3, .. })
    ));
}

#[test]
fn malformed_calldata_fails_closed() {
    let store = allowances(100);
    let good = transfer(BOB, 1);
    assert_eq!(
        run(&transfer_to_bob(), &good[..40], 0, &store),
        Err(Status::CalldataOutOfBounds)
    );
    assert_eq!(
        run(&transfer_to_bob(), &good[..2], 0, &store),
        Err(Status::CalldataTooShort)
    );
    // exec with a bytes offset pointing far outside the data.
    let mut bad = execCall {
        to: a(USDC),
        data: Bytes::from(good.clone()),
    }
    .abi_encode();
    bad[4 + 32 + 24..4 + 64].copy_from_slice(&u64::MAX.to_be_bytes());
    let conditions = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::Pass, none()),
        c(0, E::AbiEncoded, O::Matches, none()),
        c(2, E::Static, O::EqualTo, addr(BOB)),
    ];
    assert_eq!(
        run(&conditions, &bad, 0, &store),
        Err(Status::CalldataOutOfBounds)
    );
    // An array claiming more elements than the data holds.
    let mut huge = batch(&[ALICE], &[1]);
    let length_at = 4 + 64 + 24;
    huge[length_at..length_at + 8].copy_from_slice(&(1u64 << 40).to_be_bytes());
    assert_eq!(
        run(&batch_conditions(), &huge, 0, &store),
        Err(Status::CalldataOutOfBounds)
    );
}

#[test]
fn integrity_rejects_bad_trees() {
    assert_eq!(validate(&[]), Err(IntegrityError::Empty));
    assert_eq!(
        validate(&[c(1, E::AbiEncoded, O::Matches, none())]),
        Err(IntegrityError::RootParent)
    );
    let unsupported = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::WithinRatio, word(1)),
    ];
    assert!(matches!(
        validate(&unsupported),
        Err(IntegrityError::Unsupported { node: 1, .. })
    ));
    let out_of_order = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Tuple, O::Matches, none()),
        c(1, E::Static, O::Pass, none()),
        c(0, E::Static, O::Pass, none()),
    ];
    assert_eq!(
        validate(&out_of_order),
        Err(IntegrityError::ParentOrder { node: 3 })
    );
    let short_comp = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Static, O::EqualTo, vec![1, 2]),
    ];
    assert_eq!(
        validate(&short_comp),
        Err(IntegrityError::CompValueLength { node: 1 })
    );
    let mismatched_or = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::None, O::Or, none()),
        c(1, E::Static, O::EqualTo, word(1)),
        c(1, E::Dynamic, O::EqualTo, word(1)),
    ];
    assert_eq!(
        validate(&mismatched_or),
        Err(IntegrityError::BranchLayoutMismatch { node: 1 })
    );
    let static_root = vec![c(0, E::Static, O::EqualTo, word(1))];
    assert_eq!(validate(&static_root), Err(IntegrityError::RootEncoding));
    let wrong_encoding = vec![
        c(0, E::AbiEncoded, O::Matches, none()),
        c(0, E::Dynamic, O::GreaterThan, word(1)),
    ];
    assert_eq!(
        validate(&wrong_encoding),
        Err(IntegrityError::EncodingMismatch { node: 1 })
    );
    // Invalid stored trees fail closed at evaluation.
    assert_eq!(
        run(&unsupported, &transfer(BOB, 1), 0, &BTreeMap::new()),
        Err(Status::ConditionsInvalid)
    );
}

#[test]
fn sdk_shaped_json_round_trips() {
    let json = r#"[{"parent":0,"paramType":5,"operator":5,"compValue":"0x"},
                   {"parent":0,"paramType":1,"operator":16,"compValue":"0x000000000000000000000000b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"},
                   {"parent":0,"paramType":1,"operator":28,"compValue":"0x1111111111111111111111111111111111111111111111111111111111111111"}]"#;
    let parsed: Vec<ConditionFlat> = serde_json::from_str(json).unwrap();
    assert_eq!(parsed, transfer_to_bob());
    let back = serde_json::to_string(&parsed).unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<ConditionFlat>>(&back).unwrap(),
        parsed
    );
    assert!(
        serde_json::from_str::<Vec<ConditionFlat>>(
            r#"[{"parent":0,"paramType":9,"operator":5,"compValue":"0x"}]"#
        )
        .is_err()
    );
}

fn scope() -> RoleScope {
    let selector: [u8; 4] = transferCall::SELECTOR;
    let mut scope = RoleScope::default();
    scope.targets.insert(
        USDC,
        TargetScope {
            clearance: Clearance::Function,
            options: ExecutionOptions::None,
            conditions: None,
        },
    );
    scope.functions.insert(
        (USDC, selector),
        FunctionScope {
            options: ExecutionOptions::None,
            conditions: Some(transfer_to_bob()),
        },
    );
    scope.targets.insert(
        ALICE,
        TargetScope {
            clearance: Clearance::Target,
            options: ExecutionOptions::Send,
            conditions: None,
        },
    );
    scope
}

fn check(
    scope: &RoleScope,
    to: [u8; 20],
    value: u128,
    data: &[u8],
    operation: Operation,
) -> Result<Vec<Consumption>, Status> {
    let store = allowances(100);
    let environment = Environment {
        avatar: AVATAR,
        now: NOW,
        allowances: &store,
    };
    check_call(
        scope,
        &Call {
            to,
            value,
            data,
            operation,
        },
        &environment,
    )
}

#[test]
fn role_scope_resolution() {
    let scope = scope();
    assert_eq!(
        check(&scope, USDC, 0, &transfer(BOB, 10), Operation::Call).unwrap()[0].consumed,
        10
    );
    assert_eq!(
        check(&scope, USDC, 0, &transfer(EVE, 10), Operation::Call),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
    let approve = [0x09, 0x5e, 0xa7, 0xb3, 0, 0, 0, 0];
    assert_eq!(
        check(&scope, USDC, 0, &approve, Operation::Call),
        Err(Status::FunctionNotAllowed)
    );
    assert_eq!(
        check(&scope, EVE, 0, &transfer(BOB, 1), Operation::Call),
        Err(Status::TargetNotAllowed)
    );
    assert_eq!(
        check(&scope, USDC, 1, &transfer(BOB, 1), Operation::Call),
        Err(Status::SendNotAllowed)
    );
    assert_eq!(
        check(&scope, USDC, 0, &transfer(BOB, 1), Operation::DelegateCall),
        Err(Status::DelegateCallNotAllowed)
    );
    // Target clearance: any function, native value allowed, no delegate call.
    assert_eq!(check(&scope, ALICE, 5, &[], Operation::Call), Ok(vec![]));
    assert_eq!(
        check(&scope, ALICE, 0, &approve, Operation::Call),
        Ok(vec![])
    );
    assert_eq!(
        check(&scope, ALICE, 0, &[], Operation::DelegateCall),
        Err(Status::DelegateCallNotAllowed)
    );
    assert_eq!(
        check(&scope, ALICE, 0, &[1, 2], Operation::Call),
        Err(Status::CalldataTooShort)
    );
}

#[test]
fn global_function_applies_on_any_target_with_conditions() {
    let mut scope = RoleScope::default();
    scope.global_functions.insert(
        transferCall::SELECTOR,
        FunctionScope {
            options: ExecutionOptions::None,
            conditions: Some(transfer_to_bob()),
        },
    );
    assert!(check(&scope, EVE, 0, &transfer(BOB, 1), Operation::Call).is_ok());
    assert_eq!(
        check(&scope, EVE, 0, &transfer(EVE, 1), Operation::Call),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
}
