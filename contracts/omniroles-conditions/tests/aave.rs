//! Aave V3 sheets checked with the real Pool ABI, and the attacks they must stop.

use std::collections::BTreeMap;

use alloy_primitives::{Address as AlloyAddress, U256};
use alloy_sol_types::{SolCall, sol};
use omniroles_conditions::presets::{self, PresetPermission};
use omniroles_conditions::*;

sol! {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode);
    function withdraw(address asset, uint256 amount, address to);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf);
    function approve(address spender, uint256 amount);
}

// Base Sepolia, read on chain: Pool and its WETH / test-USDC reserves.
const POOL: [u8; 20] = hex20("8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27");
const WETH: [u8; 20] = hex20("4200000000000000000000000000000000000006");
const AAVE_USDC: [u8; 20] = hex20("ba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f");
const OTHER: [u8; 20] = [0xcc; 20];
const WALLET: [u8; 20] = [0xac; 20];
const ATTACKER: [u8; 20] = [0xee; 20];
const DEPOSITS: [u8; 32] = [0xde; 32];
const BUDGET: u128 = 5_000_000_000_000_000_000; // 5 WETH
const NOW: u64 = 1_800_000_000;

const fn hex20(text: &str) -> [u8; 20] {
    let bytes = text.as_bytes();
    let mut out = [0u8; 20];
    let mut index = 0;
    while index < 20 {
        out[index] = nibble(bytes[2 * index]) * 16 + nibble(bytes[2 * index + 1]);
        index += 1;
    }
    out
}

const fn nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => byte - b'A' + 10,
    }
}

fn a(address: [u8; 20]) -> AlloyAddress {
    AlloyAddress::from(address)
}

/// Role "treasury": approve the Pool (capped), supply WETH or test USDC within
/// one budget, withdraw them back to the wallet.
fn treasury_role() -> RoleScope {
    let sheets: Vec<PresetPermission> = vec![
        presets::erc20_approve(WETH, &[POOL], BUDGET),
        presets::aave_v3_supply(POOL, &[WETH, AAVE_USDC], DEPOSITS),
        presets::aave_v3_withdraw(POOL, &[WETH, AAVE_USDC]),
    ];
    let mut scope = RoleScope::default();
    for sheet in sheets {
        validate(&sheet.conditions).expect("sheet must pass integrity");
        scope.targets.entry(sheet.target).or_insert(TargetScope {
            clearance: Clearance::Function,
            options: ExecutionOptions::None,
            conditions: None,
        });
        scope.functions.insert(
            (sheet.target, sheet.selector),
            FunctionScope {
                options: ExecutionOptions::None,
                conditions: Some(sheet.conditions),
            },
        );
    }
    scope
}

fn check(to: [u8; 20], data: Vec<u8>, balance: u128) -> Result<Vec<Consumption>, Status> {
    let store = BTreeMap::from([(
        DEPOSITS,
        Allowance {
            refill: BUDGET,
            max_refill: BUDGET,
            period: 30 * 86_400,
            balance,
            timestamp: NOW,
        },
    )]);
    let environment = Environment {
        avatar: WALLET,
        now: NOW,
        allowances: &store,
        address_lists: &(),
    };
    check_call(
        &treasury_role(),
        &Call {
            to,
            value: 0,
            data: &data,
            operation: Operation::Call,
        },
        &environment,
    )
}

fn supply(asset: [u8; 20], amount: u128, on_behalf_of: [u8; 20]) -> Vec<u8> {
    supplyCall {
        asset: a(asset),
        amount: U256::from(amount),
        onBehalfOf: a(on_behalf_of),
        referralCode: 0,
    }
    .abi_encode()
}

fn withdraw(asset: [u8; 20], amount: U256, to: [u8; 20]) -> Vec<u8> {
    withdrawCall {
        asset: a(asset),
        amount,
        to: a(to),
    }
    .abi_encode()
}

#[test]
fn selectors_match_the_real_abi() {
    assert_eq!(presets::AAVE_V3_SUPPLY, supplyCall::SELECTOR);
    assert_eq!(presets::AAVE_V3_WITHDRAW, withdrawCall::SELECTOR);
}

#[test]
fn supply_for_the_wallet_is_charged_to_the_budget() {
    let consumptions = check(
        POOL,
        supply(WETH, 1_000_000_000_000_000_000, WALLET),
        BUDGET,
    )
    .unwrap();
    assert_eq!(consumptions.len(), 1);
    assert_eq!(consumptions[0].key, DEPOSITS);
    assert_eq!(consumptions[0].consumed, 1_000_000_000_000_000_000);
    // Either listed asset is accepted.
    assert!(check(POOL, supply(AAVE_USDC, 1_000_000, WALLET), BUDGET).is_ok());
}

#[test]
fn withdraw_back_to_the_wallet_is_free_and_unlimited() {
    let consumptions = check(POOL, withdraw(WETH, U256::MAX, WALLET), BUDGET).unwrap();
    assert!(consumptions.is_empty());
    assert!(check(POOL, withdraw(AAVE_USDC, U256::from(1u8), WALLET), 0).is_ok());
}

#[test]
fn aave_attacks_are_refused() {
    // Deposit credited to someone else.
    assert!(check(POOL, supply(WETH, 1, ATTACKER), BUDGET).is_err());
    // Withdraw to someone else.
    assert!(check(POOL, withdraw(WETH, U256::from(1u8), ATTACKER), BUDGET).is_err());
    // Asset outside the role.
    assert!(check(POOL, supply(OTHER, 1, WALLET), BUDGET).is_err());
    assert!(check(POOL, withdraw(OTHER, U256::from(1u8), WALLET), BUDGET).is_err());
    // Over budget.
    assert!(check(POOL, supply(WETH, BUDGET + 1, WALLET), BUDGET).is_err());
    assert!(check(POOL, supply(WETH, 2, WALLET), 1).is_err());
    // Borrowing is not in the role at all.
    let borrow = borrowCall {
        asset: a(WETH),
        amount: U256::from(1u8),
        interestRateMode: U256::from(2u8),
        referralCode: 0,
        onBehalfOf: a(WALLET),
    }
    .abi_encode();
    assert_eq!(check(POOL, borrow, BUDGET), Err(Status::FunctionNotAllowed));
    // Same calls on another contract.
    assert_eq!(
        check(OTHER, supply(WETH, 1, WALLET), BUDGET),
        Err(Status::TargetNotAllowed)
    );
}

#[test]
fn pool_approval_is_capped() {
    let ok = approveCall {
        spender: a(POOL),
        amount: U256::from(BUDGET),
    }
    .abi_encode();
    assert!(check(WETH, ok, BUDGET).is_ok());
    let too_much = approveCall {
        spender: a(POOL),
        amount: U256::MAX,
    }
    .abi_encode();
    assert!(check(WETH, too_much, BUDGET).is_err());
    let elsewhere = approveCall {
        spender: a(ATTACKER),
        amount: U256::from(1u8),
    }
    .abi_encode();
    assert!(check(WETH, elsewhere, BUDGET).is_err());
}
