//! Wrapping ETH within a budget, unwrapping freely.

use std::collections::BTreeMap;

use alloy_primitives::U256;
use alloy_sol_types::{SolCall, sol};
use omniroles_conditions::presets;
use omniroles_conditions::*;

sol! {
    function deposit();
    function withdraw(uint256 wad);
    function transfer(address to, uint256 amount);
}

const WETH: [u8; 20] = [0x42; 20];
const WALLET: [u8; 20] = [0xac; 20];
const WRAPS: [u8; 32] = [0x77; 32];
const BUDGET: u128 = 1_000_000_000_000_000; // 0.001 ETH
const NOW: u64 = 1_800_000_000;

fn role() -> RoleScope {
    let mut scope = RoleScope::default();
    for (sheet, options) in [
        (presets::weth_wrap(WETH, WRAPS), ExecutionOptions::Send),
        (presets::weth_unwrap(WETH), ExecutionOptions::None),
    ] {
        validate(&sheet.conditions).expect("sheet must pass integrity");
        scope.targets.entry(sheet.target).or_insert(TargetScope {
            clearance: Clearance::Function,
            options,
            conditions: None,
        });
        scope.functions.insert(
            (sheet.target, sheet.selector),
            FunctionScope {
                options,
                conditions: Some(sheet.conditions),
            },
        );
    }
    scope
}

fn check(data: Vec<u8>, value: u128) -> Result<Vec<Consumption>, Status> {
    let store = BTreeMap::from([(
        WRAPS,
        Allowance {
            refill: BUDGET,
            max_refill: BUDGET,
            period: 86_400,
            balance: BUDGET,
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
        &role(),
        &Call {
            to: WETH,
            value,
            data: &data,
            operation: Operation::Call,
        },
        &environment,
    )
}

#[test]
fn selectors_match_weth9() {
    assert_eq!(presets::WETH_DEPOSIT, depositCall::SELECTOR);
    assert_eq!(presets::WETH_WITHDRAW, withdrawCall::SELECTOR);
}

#[test]
fn wrapping_charges_the_eth_sent() {
    let consumed = check(depositCall {}.abi_encode(), BUDGET / 2).expect("within budget");
    assert_eq!(consumed.len(), 1);
    assert_eq!(consumed[0].consumed, BUDGET / 2);
    assert!(matches!(
        check(depositCall {}.abi_encode(), BUDGET + 1),
        Err(Status::AllowanceExceeded { .. })
    ));
}

#[test]
fn unwrapping_is_free_and_transfers_are_refused() {
    assert!(
        check(
            withdrawCall {
                wad: U256::from(5u64)
            }
            .abi_encode(),
            0
        )
        .is_ok()
    );
    // Unwrap carries no ETH.
    assert!(
        check(
            withdrawCall {
                wad: U256::from(5u64)
            }
            .abi_encode(),
            1
        )
        .is_err()
    );
    let transfer = transferCall {
        to: [0xee; 20].into(),
        amount: U256::from(1u64),
    }
    .abi_encode();
    assert!(check(transfer, 0).is_err());
}
