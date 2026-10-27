//! Signature scoping tests. Digests are cross-checked with alloy and the EIP-712 spec vector.

use std::collections::BTreeMap;

use alloy_primitives::{Address as AlloyAddress, B256, U256, eip191_hash_message};
use alloy_sol_types::{SolCall, SolStruct, eip712_domain, sol};
use omniroles_conditions::abi::{address_word, u128_word};
use omniroles_conditions::eip712::{TypedData, hash_typed_data};
use omniroles_conditions::monerium::ORDER_SIGNATURE;
use omniroles_conditions::*;
use serde_json::json;
use sha3::{Digest, Keccak256};

sol! {
    struct TransferWithAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce);

    struct Person { string name; address[] wallets; }
    struct Mail { Person from; Person[] to; string contents; uint8[2] tags; int64 delta; }
    function mail(Person from, Person[] to, string contents, uint8[2] tags, int64 delta);
}

const AVATAR: [u8; 20] = [0xac; 20];
const PAYEE: [u8; 20] = [0x9a; 20];
const OTHER: [u8; 20] = [0xee; 20];
const USDC: [u8; 20] = [0x03; 20];
const KEY: [u8; 32] = [0x11; 32];
const NOW: u64 = 1_800_000_000;

fn hex20(address: [u8; 20]) -> String {
    format!("0x{}", hex::encode(address))
}

fn c(parent: u16, encoding: Encoding, operator: Operator, comp: Vec<u8>) -> ConditionFlat {
    ConditionFlat {
        parent,
        param_type: encoding,
        operator,
        comp_value: comp,
    }
}

fn store(balance: u128) -> BTreeMap<[u8; 32], Allowance> {
    BTreeMap::from([(
        KEY,
        Allowance {
            refill: 0,
            max_refill: 0,
            period: 0,
            balance,
            timestamp: 0,
        },
    )])
}

#[test]
fn eip712_spec_vector() {
    let data: TypedData = serde_json::from_value(json!({
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}
            ],
            "Person": [{"name": "name", "type": "string"}, {"name": "wallet", "type": "address"}],
            "Mail": [{"name": "from", "type": "Person"}, {"name": "to", "type": "Person"}, {"name": "contents", "type": "string"}]
        },
        "primaryType": "Mail",
        "domain": {"name": "Ether Mail", "version": "1", "chainId": 1, "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"},
        "message": {
            "from": {"name": "Cow", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},
            "to": {"name": "Bob", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},
            "contents": "Hello, Bob!"
        }
    }))
    .unwrap();
    let hashed = hash_typed_data(&data).unwrap();
    assert_eq!(
        hex::encode(hashed.domain_separator),
        "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
    );
    assert_eq!(
        hex::encode(hashed.digest),
        "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2"
    );
}

fn authorization(
    from: [u8; 20],
    to: [u8; 20],
    value: u64,
    valid_before: u64,
    chain_id: u64,
) -> TypedData {
    serde_json::from_value(json!({
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}
            ]
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {"name": "USDC", "version": "2", "chainId": chain_id, "verifyingContract": hex20(USDC)},
        "message": {
            "from": hex20(from), "to": hex20(to), "value": value.to_string(),
            "validAfter": 0, "validBefore": valid_before.to_string(),
            "nonce": format!("0x{}", "42".repeat(32))
        }
    }))
    .unwrap()
}

#[test]
fn transfer_with_authorization_matches_alloy() {
    let data = authorization(AVATAR, PAYEE, 1_000, NOW + 60, 84532);
    let hashed = hash_typed_data(&data).unwrap();
    let message = TransferWithAuthorization {
        from: AlloyAddress::from(AVATAR),
        to: AlloyAddress::from(PAYEE),
        value: U256::from(1_000u64),
        validAfter: U256::ZERO,
        validBefore: U256::from(NOW + 60),
        nonce: B256::from([0x42; 32]),
    };
    let domain = eip712_domain! { name: "USDC", version: "2", chain_id: 84532, verifying_contract: AlloyAddress::from(USDC), };
    assert_eq!(hashed.digest, message.eip712_signing_hash(&domain).0);
    assert_eq!(hashed.domain_separator, domain.separator().0);
    assert_eq!(hashed.type_hash, message.eip712_type_hash().0);
    // Condition input = the same ABI layout as the token's transferWithAuthorization parameters.
    let call = transferWithAuthorizationCall {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter: message.validAfter,
        validBefore: message.validBefore,
        nonce: message.nonce,
    }
    .abi_encode();
    assert_eq!(hashed.calldata[4..], call[4..]);
    assert_eq!(hashed.calldata[..4], hashed.type_hash[..4]);
}

#[test]
fn nested_structs_arrays_and_signed_ints_match_alloy() {
    let wallets = |n: u8| vec![AlloyAddress::from([n; 20]), AlloyAddress::from([n + 1; 20])];
    let mail = Mail {
        from: Person {
            name: "Agent".into(),
            wallets: wallets(1),
        },
        to: vec![
            Person {
                name: "Bob".into(),
                wallets: wallets(5),
            },
            Person {
                name: "Eve".into(),
                wallets: vec![],
            },
        ],
        contents: "Invoice 42".into(),
        tags: [7, 9],
        delta: -5,
    };
    let domain = eip712_domain! { name: "Mail", chain_id: 1, };
    let data: TypedData = serde_json::from_value(json!({
        "types": {
            "Person": [{"name": "name", "type": "string"}, {"name": "wallets", "type": "address[]"}],
            "Mail": [
                {"name": "from", "type": "Person"}, {"name": "to", "type": "Person[]"},
                {"name": "contents", "type": "string"}, {"name": "tags", "type": "uint8[2]"}, {"name": "delta", "type": "int64"}
            ]
        },
        "primaryType": "Mail",
        "domain": {"name": "Mail", "chainId": "1"},
        "message": {
            "from": {"name": "Agent", "wallets": [hex20([1; 20]), hex20([2; 20])]},
            "to": [{"name": "Bob", "wallets": [hex20([5; 20]), hex20([6; 20])]}, {"name": "Eve", "wallets": []}],
            "contents": "Invoice 42", "tags": [7, 9], "delta": -5
        }
    }))
    .unwrap();
    let hashed = hash_typed_data(&data).unwrap();
    assert_eq!(hashed.digest, mail.eip712_signing_hash(&domain).0);
    assert_eq!(hashed.type_hash, mail.eip712_type_hash().0);
    let call = mailCall {
        from: mail.from,
        to: mail.to,
        contents: mail.contents,
        tags: mail.tags,
        delta: mail.delta,
    }
    .abi_encode();
    assert_eq!(hashed.calldata[4..], call[4..]);
}

#[test]
fn strict_typed_data() {
    let base = || serde_json::to_value(authorization(AVATAR, PAYEE, 1, NOW, 84532)).unwrap();
    let invalid = |value: serde_json::Value| {
        let data: TypedData = serde_json::from_value(value).unwrap();
        hash_typed_data(&data).is_err()
    };
    let mut extra_field = base();
    extra_field["message"]["memo"] = json!("x");
    assert!(invalid(extra_field));
    let mut missing = base();
    missing["message"].as_object_mut().unwrap().remove("nonce");
    assert!(invalid(missing));
    let mut extra_domain = base();
    extra_domain["domain"]["foo"] = json!("bar");
    assert!(invalid(extra_domain));
    let mut reordered_domain = base();
    reordered_domain["types"]["EIP712Domain"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    assert!(invalid(reordered_domain));
    let mut alias_type = base();
    alias_type["types"]["TransferWithAuthorization"][2]["type"] = json!("uint");
    assert!(invalid(alias_type));
    let mut overflow = base();
    overflow["message"]["value"] = json!("1".repeat(80));
    assert!(invalid(overflow));
    let mut float = base();
    float["message"]["validAfter"] = json!(1.5);
    assert!(invalid(float));
    let mut short_nonce = base();
    short_nonce["message"]["nonce"] = json!("0x42");
    assert!(invalid(short_nonce));
    let mut domain_primary = base();
    domain_primary["primaryType"] = json!("EIP712Domain");
    assert!(invalid(domain_primary));
}

/// x402 on Base Sepolia: the wallet pays PAYEE in USDC, within the USDC allowance,
/// with an authorization valid for less than ~1 hour.
fn x402_scope() -> RoleScope {
    let hashed = hash_typed_data(&authorization(AVATAR, PAYEE, 1, NOW, 84532)).unwrap();
    let conditions = vec![
        c(0, Encoding::AbiEncoded, Operator::Matches, vec![]),
        c(0, Encoding::Static, Operator::EqualToAvatar, vec![]),
        c(
            0,
            Encoding::Static,
            Operator::EqualTo,
            address_word(&PAYEE).to_vec(),
        ),
        c(0, Encoding::Static, Operator::WithinAllowance, KEY.to_vec()),
        c(0, Encoding::Static, Operator::Pass, vec![]),
        c(
            0,
            Encoding::Static,
            Operator::LessThan,
            u128_word(u128::from(NOW + 3_600)).to_vec(),
        ),
        c(0, Encoding::Static, Operator::Pass, vec![]),
    ];
    let mut scope = RoleScope::default();
    scope.typed_data.insert(
        (hashed.domain_separator, hashed.type_hash),
        SignatureScope {
            conditions: Some(conditions),
        },
    );
    scope
}

fn sign(scope: &RoleScope, data: &TypedData, balance: u128) -> Result<SignatureApproval, Status> {
    let allowances = store(balance);
    let environment = Environment {
        avatar: AVATAR,
        now: NOW,
        allowances: &allowances,
        address_lists: &(),
    };
    check_typed_data(scope, data, &environment)
}

#[test]
fn x402_authorization_is_scoped() {
    let scope = x402_scope();
    let approved = sign(
        &scope,
        &authorization(AVATAR, PAYEE, 400, NOW + 60, 84532),
        500,
    )
    .unwrap();
    assert_eq!(approved.consumptions[0].consumed, 400);
    assert_eq!(
        approved.digest,
        hash_typed_data(&authorization(AVATAR, PAYEE, 400, NOW + 60, 84532))
            .unwrap()
            .digest
    );
    assert_eq!(
        sign(
            &scope,
            &authorization(AVATAR, OTHER, 1, NOW + 60, 84532),
            500
        ),
        Err(Status::ParameterNotAllowed { node: 2 })
    );
    assert_eq!(
        sign(
            &scope,
            &authorization(OTHER, PAYEE, 1, NOW + 60, 84532),
            500
        ),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
    assert!(matches!(
        sign(
            &scope,
            &authorization(AVATAR, PAYEE, 501, NOW + 60, 84532),
            500
        ),
        Err(Status::AllowanceExceeded { .. })
    ));
    assert_eq!(
        sign(
            &scope,
            &authorization(AVATAR, PAYEE, 1, NOW + 7_200, 84532),
            500
        ),
        Err(Status::ParameterGreaterThanAllowed { node: 5 })
    );
    // Same message for another chain = another domain: not scoped.
    assert_eq!(
        sign(
            &scope,
            &authorization(AVATAR, PAYEE, 1, NOW + 60, 8453),
            500
        ),
        Err(Status::SignatureNotAllowed)
    );
}

#[test]
fn modified_type_definition_is_not_scoped() {
    let scope = x402_scope();
    let mut value = serde_json::to_value(authorization(AVATAR, PAYEE, 1, NOW + 60, 84532)).unwrap();
    value["types"]["TransferWithAuthorization"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "memo", "type": "string"}));
    value["message"]["memo"] = json!("x");
    let data: TypedData = serde_json::from_value(value).unwrap();
    assert_eq!(sign(&scope, &data, 500), Err(Status::SignatureNotAllowed));
}

const IBAN: &str = "DE89370400440532013000";

fn monerium_scope() -> RoleScope {
    let keccak = |data: &[u8]| Keccak256::digest(data).to_vec();
    let conditions = vec![
        c(0, Encoding::AbiEncoded, Operator::Matches, vec![]),
        c(0, Encoding::Dynamic, Operator::EqualTo, keccak(b"EUR")),
        c(0, Encoding::Static, Operator::WithinAllowance, KEY.to_vec()),
        c(
            0,
            Encoding::Dynamic,
            Operator::EqualTo,
            keccak(IBAN.as_bytes()),
        ),
        c(0, Encoding::Dynamic, Operator::EqualTo, keccak(b"")),
        c(0, Encoding::Static, Operator::Pass, vec![]),
    ];
    let mut scope = RoleScope::default();
    scope.messages.insert(
        MessageKind::MoneriumOrder,
        SignatureScope {
            conditions: Some(conditions),
        },
    );
    scope
}

fn order(message: &str, balance: u128) -> Result<SignatureApproval, Status> {
    let allowances = store(balance);
    let environment = Environment {
        avatar: AVATAR,
        now: NOW,
        allowances: &allowances,
        address_lists: &(),
    };
    check_monerium_order(&monerium_scope(), message, &environment).map(|(_, approval)| approval)
}

const EURO: u128 = 1_000_000_000_000_000_000;

#[test]
fn monerium_redemption_is_scoped() {
    // NOW = 2027-01-15T08:00:00Z
    let message = format!("Send EUR 120.50 to {IBAN} at 2027-01-15T09:01:00+01:00");
    let approved = order(&message, 200 * EURO).unwrap();
    assert_eq!(approved.consumptions[0].consumed, 120 * EURO + EURO / 2);
    assert_eq!(approved.digest, eip191_hash_message(message.as_bytes()).0);
    assert!(matches!(
        order(&message, 100 * EURO),
        Err(Status::AllowanceExceeded { .. })
    ));
    let other_iban = "GB82WEST12345698765432";
    assert_eq!(
        order(
            &format!("Send EUR 1 to {other_iban} at 2027-01-15T08:00:00Z"),
            200 * EURO
        ),
        Err(Status::ParameterNotAllowed { node: 3 })
    );
    assert_eq!(
        order(
            &format!("Send USD 1 to {IBAN} at 2027-01-15T08:00:00Z"),
            200 * EURO
        ),
        Err(Status::ParameterNotAllowed { node: 1 })
    );
    // Cross-chain order to an address: not the allowed receiver.
    let cross = format!(
        "Send EUR 1 to 0x{} on gnosis at 2027-01-15T08:00:00Z",
        hex::encode(PAYEE)
    );
    assert_eq!(
        order(&cross, 200 * EURO),
        Err(Status::ParameterNotAllowed { node: 3 })
    );
}

#[test]
fn monerium_rejects_malformed_or_stale_orders() {
    let invalid = |message: &str| {
        matches!(
            order(message, 200 * EURO),
            Err(Status::MessageInvalid { .. })
        )
    };
    assert!(
        invalid(&format!("Send EUR 1 to {IBAN} at 2027-01-15T07:50:00Z")),
        "10 minutes old"
    );
    assert!(
        invalid(&format!("Send EUR 1 to {IBAN} at 2027-01-15T08:10:00Z")),
        "10 minutes ahead"
    );
    assert!(
        invalid("Send EUR 1 to DE89370400440532013001 at 2027-01-15T08:00:00Z"),
        "bad IBAN checksum"
    );
    assert!(invalid(&format!(
        "Send EUR 1,5 to {IBAN} at 2027-01-15T08:00:00Z"
    )));
    assert!(invalid(&format!(
        "Please send EUR 1 to {IBAN} at 2027-01-15T08:00:00Z"
    )));
    assert!(invalid(&format!(
        "Send eur 1 to {IBAN} at 2027-01-15T08:00:00Z"
    )));
    // Arbitrary text is never signed without a scope for its kind.
    let allowances = store(0);
    let environment = Environment {
        avatar: AVATAR,
        now: NOW,
        allowances: &allowances,
        address_lists: &(),
    };
    let message = format!("Send EUR 1 to {IBAN} at 2027-01-15T08:00:00Z");
    assert_eq!(
        check_monerium_order(&RoleScope::default(), &message, &environment).unwrap_err(),
        Status::SignatureNotAllowed
    );
    assert_eq!(&ORDER_SIGNATURE[..14], "MoneriumOrder(");
}
