//! Ready-made permissions for common protocols ("protocol sheets").
//!
//! The DAO picks protocols for a role; the console turns each sheet into vault
//! permissions (`target`, `selector`, `conditions`). Every sheet pins the
//! recipient of the output to the wallet itself and charges amounts to a
//! named allowance, so an agent can only move what the policy measures.
//!
//! Approvals are capped per transaction and never unlimited: an approval left
//! open on a router becomes a liability if that router is later exploited.
//! Agents approve the exact amount, swap, then reset the approval to 0.

use crate::abi::{address_word, u128_word};
use crate::types::{ConditionFlat, Encoding, Operator};
use sha3::{Digest, Keccak256};

pub type Address = [u8; 20];

/// One vault permission produced by a sheet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresetPermission {
    pub target: Address,
    pub selector: [u8; 4],
    pub conditions: Vec<ConditionFlat>,
}

/// `approve(address,uint256)`
pub const ERC20_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// `transfer(address,uint256)`
pub const ERC20_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`
pub const UNISWAP_V3_EXACT_INPUT_SINGLE: [u8; 4] = [0x04, 0xe4, 0x5a, 0xaf];
/// UniswapV2Router02 `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)`
pub const UNISWAP_V2_SWAP_EXACT_TOKENS_FOR_TOKENS: [u8; 4] = [0x38, 0xed, 0x17, 0x39];
/// Aave V3 Pool `supply(address,uint256,address,uint16)`
pub const AAVE_V3_SUPPLY: [u8; 4] = [0x61, 0x7b, 0xa0, 0x37];
/// Aave V3 Pool `withdraw(address,uint256,address)`
pub const AAVE_V3_WITHDRAW: [u8; 4] = [0x69, 0x32, 0x8d, 0xec];

fn node(parent: u16, encoding: Encoding, operator: Operator, comp: Vec<u8>) -> ConditionFlat {
    ConditionFlat {
        parent,
        param_type: encoding,
        operator,
        comp_value: comp,
    }
}

fn word(value: u128) -> Vec<u8> {
    u128_word(value).to_vec()
}

fn address(value: &Address) -> Vec<u8> {
    address_word(value).to_vec()
}

/// Field node accepting one of `values`, plus the `EqualTo` alternatives to
/// append later (BFS order) when there is more than one value.
fn one_of(parent: u16, values: &[Address]) -> (ConditionFlat, Vec<ConditionFlat>) {
    if values.len() == 1 {
        return (
            node(
                parent,
                Encoding::Static,
                Operator::EqualTo,
                address(&values[0]),
            ),
            Vec::new(),
        );
    }
    (
        node(parent, Encoding::None, Operator::Or, Vec::new()),
        values
            .iter()
            .map(|value| node(0, Encoding::Static, Operator::EqualTo, address(value)))
            .collect(),
    )
}

/// Fix the parent index of nodes produced by [`one_of`] once their parent's index is known.
fn with_parent(mut nodes: Vec<ConditionFlat>, parent: u16) -> Vec<ConditionFlat> {
    for node in &mut nodes {
        node.parent = parent;
    }
    nodes
}

/// `token.approve(spender in spenders, amount <= max_amount)`. Approving 0 (revoke) is included.
pub fn erc20_approve(token: Address, spenders: &[Address], max_amount: u128) -> PresetPermission {
    assert!(!spenders.is_empty(), "at least one spender");
    let (spender, alternatives) = one_of(0, spenders);
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        spender,
        node(
            0,
            Encoding::Static,
            Operator::LessThan,
            word(max_amount.checked_add(1).expect("cap below u128::MAX")),
        ),
    ];
    conditions.extend(with_parent(alternatives, 1));
    PresetPermission {
        target: token,
        selector: ERC20_APPROVE,
        conditions,
    }
}

/// `token.transfer(to in recipients, amount within allowance)`.
pub fn erc20_transfer(
    token: Address,
    recipients: &[Address],
    allowance: [u8; 32],
) -> PresetPermission {
    assert!(!recipients.is_empty(), "at least one recipient");
    let (recipient, alternatives) = one_of(0, recipients);
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        recipient,
        node(
            0,
            Encoding::Static,
            Operator::WithinAllowance,
            allowance.to_vec(),
        ),
    ];
    conditions.extend(with_parent(alternatives, 1));
    PresetPermission {
        target: token,
        selector: ERC20_TRANSFER,
        conditions,
    }
}

/// Uniswap V3 SwapRouter02 `exactInputSingle`:
/// `tokenIn == token_in`, `tokenOut in tokens_out`, `recipient == wallet`,
/// `amountIn` within allowance, `amountOutMinimum > 0`.
pub fn uniswap_v3_exact_input_single(
    router: Address,
    token_in: Address,
    tokens_out: &[Address],
    allowance: [u8; 32],
) -> PresetPermission {
    assert!(!tokens_out.is_empty(), "at least one output token");
    let (token_out, alternatives) = one_of(1, tokens_out);
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        // ExactInputSingleParams
        node(0, Encoding::Tuple, Operator::Matches, Vec::new()),
        node(1, Encoding::Static, Operator::EqualTo, address(&token_in)), // 2 tokenIn
        token_out,                                                        // 3 tokenOut
        node(1, Encoding::Static, Operator::Pass, Vec::new()),            // 4 fee
        node(1, Encoding::Static, Operator::EqualToAvatar, Vec::new()),   // 5 recipient
        node(
            1,
            Encoding::Static,
            Operator::WithinAllowance,
            allowance.to_vec(),
        ), // 6 amountIn
        node(1, Encoding::Static, Operator::GreaterThan, word(0)),        // 7 amountOutMinimum
        node(1, Encoding::Static, Operator::Pass, Vec::new()),            // 8 sqrtPriceLimitX96
    ];
    conditions.extend(with_parent(alternatives, 3));
    PresetPermission {
        target: router,
        selector: UNISWAP_V3_EXACT_INPUT_SINGLE,
        conditions,
    }
}

/// keccak256 of an ABI-encoded `address[]` content (`length || elements`).
fn path_hash(path: &[Address]) -> Vec<u8> {
    let mut encoded = u128_word(path.len() as u128).to_vec();
    for hop in path {
        encoded.extend_from_slice(&address_word(hop));
    }
    Keccak256::digest(&encoded).to_vec()
}

/// UniswapV2Router02 `swapExactTokensForTokens`:
/// `path` exactly one of `paths`, `to == wallet`, `amountIn` within allowance,
/// `amountOutMin > 0`.
pub fn uniswap_v2_swap_exact_tokens_for_tokens(
    router: Address,
    paths: &[Vec<Address>],
    allowance: [u8; 32],
) -> PresetPermission {
    assert!(!paths.is_empty(), "at least one path");
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        node(
            0,
            Encoding::Static,
            Operator::WithinAllowance,
            allowance.to_vec(),
        ), // 1 amountIn
        node(0, Encoding::Static, Operator::GreaterThan, word(0)), // 2 amountOutMin
    ];
    // 3 path
    let path_index = 3u16;
    if paths.len() == 1 {
        conditions.push(node(
            0,
            Encoding::Array,
            Operator::EqualTo,
            path_hash(&paths[0]),
        ));
    } else {
        conditions.push(node(0, Encoding::None, Operator::Or, Vec::new()));
    }
    conditions.push(node(
        0,
        Encoding::Static,
        Operator::EqualToAvatar,
        Vec::new(),
    )); // 4 to
    conditions.push(node(0, Encoding::Static, Operator::Pass, Vec::new())); // 5 deadline
    if paths.len() == 1 {
        // element type of the path array
        conditions.push(node(
            path_index,
            Encoding::Static,
            Operator::Pass,
            Vec::new(),
        ));
    } else {
        let first_option = conditions.len() as u16;
        for path in paths {
            conditions.push(node(
                path_index,
                Encoding::Array,
                Operator::EqualTo,
                path_hash(path),
            ));
        }
        for offset in 0..paths.len() as u16 {
            conditions.push(node(
                first_option + offset,
                Encoding::Static,
                Operator::Pass,
                Vec::new(),
            ));
        }
    }
    PresetPermission {
        target: router,
        selector: UNISWAP_V2_SWAP_EXACT_TOKENS_FOR_TOKENS,
        conditions,
    }
}

/// Transfer to a supplier in a governance-managed list, charged to an allowance.
pub fn erc20_transfer_in_list(token: Address, list: &str, allowance: [u8; 32]) -> PresetPermission {
    PresetPermission {
        target: token,
        selector: ERC20_TRANSFER,
        conditions: vec![
            node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
            node(
                0,
                Encoding::Static,
                Operator::InAddressList,
                list.as_bytes().to_vec(),
            ),
            node(
                0,
                Encoding::Static,
                Operator::WithinAllowance,
                allowance.to_vec(),
            ),
        ],
    }
}

/// Aave V3 Pool `supply`: `asset in assets`, `amount` within allowance,
/// `onBehalfOf == wallet` (the deposit is credited to the company only).
pub fn aave_v3_supply(pool: Address, assets: &[Address], allowance: [u8; 32]) -> PresetPermission {
    assert!(!assets.is_empty(), "at least one asset");
    let (asset, alternatives) = one_of(0, assets);
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        asset, // 1 asset
        node(
            0,
            Encoding::Static,
            Operator::WithinAllowance,
            allowance.to_vec(),
        ), // 2 amount
        node(0, Encoding::Static, Operator::EqualToAvatar, Vec::new()), // 3 onBehalfOf
        node(0, Encoding::Static, Operator::Pass, Vec::new()), // 4 referralCode
    ];
    conditions.extend(with_parent(alternatives, 1));
    PresetPermission {
        target: pool,
        selector: AAVE_V3_SUPPLY,
        conditions,
    }
}

/// Aave V3 Pool `withdraw`: `asset in assets`, any amount, `to == wallet`.
/// Withdrawing only returns the company's own deposit to the company wallet,
/// so it is not charged to a budget.
pub fn aave_v3_withdraw(pool: Address, assets: &[Address]) -> PresetPermission {
    assert!(!assets.is_empty(), "at least one asset");
    let (asset, alternatives) = one_of(0, assets);
    let mut conditions = vec![
        node(0, Encoding::AbiEncoded, Operator::Matches, Vec::new()),
        asset,                                                          // 1 asset
        node(0, Encoding::Static, Operator::Pass, Vec::new()),          // 2 amount
        node(0, Encoding::Static, Operator::EqualToAvatar, Vec::new()), // 3 to
    ];
    conditions.extend(with_parent(alternatives, 1));
    PresetPermission {
        target: pool,
        selector: AAVE_V3_WITHDRAW,
        conditions,
    }
}
