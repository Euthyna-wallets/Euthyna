//! The share-revenue role (packages/sdk `shareRevenueSheet`): ETH to the
//! company's shares contract on NEAR through the Omni Bridge, nowhere else.
//! Calldata is encoded with alloy, independently of the SDK.

use std::collections::BTreeMap;

use alloy_primitives::Address;
use alloy_sol_types::{SolCall, sol};
use omniroles_conditions::abi::{address_word, u128_word};
use omniroles_conditions::*;
use sha3::{Digest, Keccak256};

sol! {
    function initTransfer(address tokenAddress, uint128 amount, uint128 fee, uint128 nativeFee, string recipient, string message);
}

const KEY: [u8; 32] = [0x22; 32];
const NOW: u64 = 1_800_000_000;
const SHARES: &str = "near:acme-ai-shares.mandateos.testnet";
const MAX_FEE: u128 = 1_000_000_000_000_000;
const BUDGET: u128 = 10_000_000_000_000_000; // 0.01 ETH

fn c(parent: u16, encoding: Encoding, operator: Operator, comp: Vec<u8>) -> ConditionFlat {
    ConditionFlat {
        parent,
        param_type: encoding,
        operator,
        comp_value: comp,
    }
}

fn keccak(data: &[u8]) -> Vec<u8> {
    Keccak256::digest(data).to_vec()
}

/// Same tree, same order as the SDK.
fn sheet() -> Vec<ConditionFlat> {
    use Encoding as E;
    use Operator as O;
    vec![
        c(0, E::AbiEncoded, O::Matches, vec![]),
        c(0, E::Static, O::EqualTo, address_word(&[0u8; 20]).to_vec()),
        c(0, E::Static, O::GreaterThan, u128_word(0).to_vec()),
        c(0, E::Static, O::EqualTo, u128_word(0).to_vec()),
        c(0, E::Static, O::LessThan, u128_word(MAX_FEE + 1).to_vec()),
        c(0, E::Dynamic, O::EqualTo, keccak(SHARES.as_bytes())),
        c(0, E::Dynamic, O::EqualTo, keccak(b"")),
        c(0, E::EtherValue, O::WithinAllowance, KEY.to_vec()),
    ]
}

fn call(
    token: [u8; 20],
    amount: u128,
    fee: u128,
    native_fee: u128,
    recipient: &str,
    message: &str,
) -> Vec<u8> {
    initTransferCall {
        tokenAddress: Address::from(token),
        amount,
        fee,
        nativeFee: native_fee,
        recipient: recipient.into(),
        message: message.into(),
    }
    .abi_encode()
}

fn run(calldata: &[u8], value: u128) -> Result<Vec<Consumption>, Status> {
    let store = BTreeMap::from([(
        KEY,
        Allowance {
            refill: 0,
            max_refill: BUDGET,
            period: 86_400,
            balance: BUDGET,
            timestamp: NOW - 10,
        },
    )]);
    evaluate(
        &sheet(),
        &Context {
            calldata,
            value,
            avatar: [0xac; 20],
            now: NOW,
            allowances: &store,
            address_lists: &(),
        },
    )
}

const AMOUNT: u128 = 5_000_000_000_000_000;
const FEE: u128 = 4_249_821_508_237;

#[test]
fn the_tree_is_valid() {
    validate(&sheet()).expect("valid tree");
}

#[test]
fn eth_to_the_shares_contract_passes_and_counts_the_eth_sent() {
    let consumptions =
        run(&call([0; 20], AMOUNT, 0, FEE, SHARES, ""), AMOUNT + FEE).expect("allowed");
    assert_eq!(consumptions.len(), 1);
    assert_eq!(consumptions[0].consumed, AMOUNT + FEE);
}

#[test]
fn every_other_destination_or_shape_is_refused() {
    let refused = |calldata: Vec<u8>, value: u128| run(&calldata, value).is_err();
    assert!(
        refused(
            call([0; 20], AMOUNT, 0, FEE, "near:attacker.testnet", ""),
            AMOUNT + FEE
        ),
        "other NEAR account"
    );
    assert!(
        refused(
            call(
                [0; 20],
                AMOUNT,
                0,
                FEE,
                "base:0xbabababababababababababababababababababa",
                ""
            ),
            AMOUNT + FEE
        ),
        "back to an EVM address"
    );
    assert!(
        refused(
            call(
                [0; 20],
                AMOUNT,
                0,
                FEE,
                "near:ACME-AI-SHARES.mandateos.testnet",
                ""
            ),
            AMOUNT + FEE
        ),
        "look-alike"
    );
    assert!(
        refused(
            call(
                [0; 20],
                AMOUNT,
                0,
                FEE,
                SHARES,
                "{\"receiver_id\":\"attacker.testnet\"}"
            ),
            AMOUNT + FEE
        ),
        "message"
    );
    assert!(
        refused(call([0x05; 20], AMOUNT, 0, FEE, SHARES, ""), 0),
        "a token instead of ETH"
    );
    assert!(
        refused(call([0; 20], AMOUNT, 1, FEE, SHARES, ""), AMOUNT + FEE),
        "token fee"
    );
    assert!(
        refused(
            call([0; 20], AMOUNT, 0, MAX_FEE + 1, SHARES, ""),
            AMOUNT + MAX_FEE + 1
        ),
        "bridge fee above the cap"
    );
    assert!(
        refused(call([0; 20], 0, 0, FEE, SHARES, ""), FEE),
        "zero amount: the whole value would be a fee"
    );
    assert!(
        refused(call([0; 20], BUDGET, 0, FEE, SHARES, ""), BUDGET + FEE),
        "over the budget"
    );
}
