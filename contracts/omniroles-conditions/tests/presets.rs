//! Protocol sheets checked with real ABIs (alloy) and the attacks they must stop.

use std::collections::BTreeMap;

use alloy_primitives::{Address as AlloyAddress, Bytes, U160, U256, aliases::U24};
use alloy_sol_types::{SolCall, sol};
use omniroles_conditions::presets::{self, PresetPermission};
use omniroles_conditions::*;

sol! {
    function approve(address spender, uint256 amount);
    function transfer(address to, uint256 amount);
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams params);
    function multicall(bytes[] data);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline);
}

// Base Sepolia deployments (developers.uniswap.org; V2 router checked on-chain:
// factory() / WETH() answer).
const V3_ROUTER: [u8; 20] = hex20("94cC0AaC535CCDB3C01d6787D6413C739ae12bc4");
const V2_ROUTER: [u8; 20] = hex20("1689E7B1F10000AE47eBfE339a4f69dECd19F602");
const USDC: [u8; 20] = hex20("418A2b47911dE05e21688F7490195F5324B49474");
const TOKEN_A: [u8; 20] = [0xaa; 20];
const TOKEN_B: [u8; 20] = [0xbb; 20];
const TOKEN_C: [u8; 20] = [0xcc; 20];
const WALLET: [u8; 20] = [0xac; 20];
const ATTACKER: [u8; 20] = [0xee; 20];
const SWAPS: [u8; 32] = [0x5a; 32];
const MAX_APPROVE: u128 = 10_000_000_000; // 10k USDC per approval
const MONTH: u64 = 30 * 86_400;
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

/// Role "swap": Uniswap V3 + Uniswap V2, USDC -> A or B, 100k USDC / 30 days.
fn swap_role() -> RoleScope {
    let sheets: Vec<PresetPermission> = vec![
        presets::erc20_approve(USDC, &[V3_ROUTER, V2_ROUTER], MAX_APPROVE),
        presets::uniswap_v3_exact_input_single(V3_ROUTER, USDC, &[TOKEN_A, TOKEN_B], SWAPS),
        presets::uniswap_v2_swap_exact_tokens_for_tokens(
            V2_ROUTER,
            &[vec![USDC, TOKEN_A], vec![USDC, TOKEN_B]],
            SWAPS,
        ),
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

fn allowances(balance: u128) -> BTreeMap<[u8; 32], Allowance> {
    BTreeMap::from([(
        SWAPS,
        Allowance {
            refill: 100_000_000_000,
            max_refill: 100_000_000_000,
            period: MONTH,
            balance,
            timestamp: NOW,
        },
    )])
}

fn check(to: [u8; 20], data: Vec<u8>, balance: u128) -> Result<Vec<Consumption>, Status> {
    let store = allowances(balance);
    let environment = Environment {
        avatar: WALLET,
        now: NOW,
        allowances: &store,
        address_lists: &(),
    };
    check_call(
        &swap_role(),
        &Call {
            to,
            value: 0,
            data: &data,
            operation: Operation::Call,
        },
        &environment,
    )
}

const USDC_100K: u128 = 100_000_000_000;

fn v3_swap(
    token_in: [u8; 20],
    token_out: [u8; 20],
    recipient: [u8; 20],
    amount_in: u128,
    min_out: u64,
) -> Vec<u8> {
    exactInputSingleCall {
        params: ExactInputSingleParams {
            tokenIn: a(token_in),
            tokenOut: a(token_out),
            fee: U24::from(3000),
            recipient: a(recipient),
            amountIn: U256::from(amount_in),
            amountOutMinimum: U256::from(min_out),
            sqrtPriceLimitX96: U160::ZERO,
        },
    }
    .abi_encode()
}

fn v2_swap(path: &[[u8; 20]], to: [u8; 20], amount_in: u128, min_out: u64) -> Vec<u8> {
    swapExactTokensForTokensCall {
        amountIn: U256::from(amount_in),
        amountOutMin: U256::from(min_out),
        path: path.iter().map(|hop| a(*hop)).collect(),
        to: a(to),
        deadline: U256::from(NOW + 600),
    }
    .abi_encode()
}

fn approve(spender: [u8; 20], amount: u128) -> Vec<u8> {
    approveCall {
        spender: a(spender),
        amount: U256::from(amount),
    }
    .abi_encode()
}

#[test]
fn selectors_match_the_real_abis() {
    assert_eq!(presets::ERC20_APPROVE, approveCall::SELECTOR);
    assert_eq!(presets::ERC20_TRANSFER, transferCall::SELECTOR);
    assert_eq!(
        presets::UNISWAP_V3_EXACT_INPUT_SINGLE,
        exactInputSingleCall::SELECTOR
    );
    assert_eq!(
        presets::UNISWAP_V2_SWAP_EXACT_TOKENS_FOR_TOKENS,
        swapExactTokensForTokensCall::SELECTOR
    );
}

#[test]
fn approve_swap_revoke_on_uniswap_v3() {
    let amount = 60_000_000_000; // 60k USDC
    assert_eq!(
        check(USDC, approve(V3_ROUTER, MAX_APPROVE), USDC_100K),
        Ok(vec![])
    );
    let swapped = check(
        V3_ROUTER,
        v3_swap(USDC, TOKEN_A, WALLET, amount, 1),
        USDC_100K,
    )
    .unwrap();
    assert_eq!(swapped[0].consumed, amount);
    assert!(!swapped[0].calls_only);
    assert_eq!(
        check(USDC, approve(V3_ROUTER, 0), USDC_100K),
        Ok(vec![]),
        "revoke"
    );
}

#[test]
fn uniswap_v3_attacks_are_refused() {
    // Output token outside the list.
    assert_eq!(
        check(V3_ROUTER, v3_swap(USDC, TOKEN_C, WALLET, 1, 1), USDC_100K),
        Err(Status::ParameterNotOneOfAllowed { node: 3 })
    );
    // Output sent to the attacker.
    assert_eq!(
        check(V3_ROUTER, v3_swap(USDC, TOKEN_A, ATTACKER, 1, 1), USDC_100K),
        Err(Status::ParameterNotAllowed { node: 5 })
    );
    // Selling another token than USDC.
    assert_eq!(
        check(
            V3_ROUTER,
            v3_swap(TOKEN_B, TOKEN_A, WALLET, 1, 1),
            USDC_100K
        ),
        Err(Status::ParameterNotAllowed { node: 2 })
    );
    // No minimum output: open to sandwiching.
    assert_eq!(
        check(V3_ROUTER, v3_swap(USDC, TOKEN_A, WALLET, 1, 0), USDC_100K),
        Err(Status::ParameterLessThanAllowed { node: 7 })
    );
    // Above the monthly budget left.
    assert!(matches!(
        check(
            V3_ROUTER,
            v3_swap(USDC, TOKEN_B, WALLET, 50_000_000_000, 1),
            40_000_000_000
        ),
        Err(Status::AllowanceExceeded { node: 6, .. })
    ));
    // multicall would wrap anything: not scoped.
    let wrapped = multicallCall {
        data: vec![Bytes::from(v3_swap(USDC, TOKEN_A, ATTACKER, 1, 1))],
    }
    .abi_encode();
    assert_eq!(
        check(V3_ROUTER, wrapped, USDC_100K),
        Err(Status::FunctionNotAllowed)
    );
}

#[test]
fn uniswap_v2_paths_must_match_exactly() {
    let ok = check(
        V2_ROUTER,
        v2_swap(&[USDC, TOKEN_B], WALLET, 5_000_000, 1),
        USDC_100K,
    )
    .unwrap();
    assert_eq!(ok[0].consumed, 5_000_000);
    // Unknown output, hop through another token, reversed path, longer path.
    for path in [
        vec![USDC, TOKEN_C],
        vec![USDC, TOKEN_C, TOKEN_A],
        vec![TOKEN_A, USDC],
        vec![USDC, TOKEN_A, TOKEN_A],
    ] {
        assert_eq!(
            check(V2_ROUTER, v2_swap(&path, WALLET, 1, 1), USDC_100K),
            Err(Status::ParameterNotOneOfAllowed { node: 3 }),
            "{path:?}"
        );
    }
    assert_eq!(
        check(
            V2_ROUTER,
            v2_swap(&[USDC, TOKEN_A], ATTACKER, 1, 1),
            USDC_100K
        ),
        Err(Status::ParameterNotAllowed { node: 4 })
    );
    assert_eq!(
        check(
            V2_ROUTER,
            v2_swap(&[USDC, TOKEN_A], WALLET, 1, 0),
            USDC_100K
        ),
        Err(Status::ParameterLessThanAllowed { node: 2 })
    );
}

#[test]
fn approvals_only_to_listed_routers_and_capped() {
    assert_eq!(
        check(USDC, approve(ATTACKER, 1), USDC_100K),
        Err(Status::ParameterNotOneOfAllowed { node: 1 })
    );
    assert_eq!(
        check(USDC, approve(V2_ROUTER, MAX_APPROVE + 1), USDC_100K),
        Err(Status::ParameterGreaterThanAllowed { node: 2 })
    );
    assert_eq!(
        check(USDC, approve(V2_ROUTER, u128::MAX), USDC_100K),
        Err(Status::ParameterGreaterThanAllowed { node: 2 }),
        "no unlimited approval"
    );
    // transfer is not part of the swap role.
    let transfer = transferCall {
        to: a(ATTACKER),
        amount: U256::from(1u64),
    }
    .abi_encode();
    assert_eq!(
        check(USDC, transfer, USDC_100K),
        Err(Status::FunctionNotAllowed)
    );
}

#[test]
fn single_value_sheets_use_plain_equality() {
    let sheet = presets::erc20_transfer(USDC, &[TOKEN_A], SWAPS);
    assert_eq!(sheet.conditions.len(), 3);
    validate(&sheet.conditions).unwrap();
    let path =
        presets::uniswap_v2_swap_exact_tokens_for_tokens(V2_ROUTER, &[vec![USDC, TOKEN_A]], SWAPS);
    validate(&path.conditions).unwrap();
    let store = allowances(USDC_100K);
    let context = Context {
        calldata: &v2_swap(&[USDC, TOKEN_A], WALLET, 1, 1),
        value: 0,
        avatar: WALLET,
        now: NOW,
        allowances: &store,
        address_lists: &(),
    };
    assert!(evaluate(&path.conditions, &context).is_ok());
    let context = Context {
        calldata: &v2_swap(&[USDC, TOKEN_B], WALLET, 1, 1),
        value: 0,
        avatar: WALLET,
        now: NOW,
        allowances: &store,
        address_lists: &(),
    };
    assert_eq!(
        evaluate(&path.conditions, &context),
        Err(Status::ParameterNotAllowed { node: 3 })
    );
}
