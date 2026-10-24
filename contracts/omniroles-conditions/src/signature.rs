//! Signature scoping: messages the wallet may sign for a role.
//!
//! Off-chain signatures move money too (x402 / EIP-3009 payments, Permit2,
//! Monerium redemptions). They go through the same engine as calls:
//! - EIP-712: the scope pins the exact domain (domain separator) and the exact
//!   primary type definition (type hash); the conditions read the message
//!   fields as `typeHash[0..4] || abi.encode(fields)`, so they are written like
//!   conditions on a function whose parameters are the struct fields.
//! - `personal_sign`: only known message kinds are accepted, parsed strictly
//!   (Monerium orders today). Arbitrary text is never signed.
//!
//! Allowances are shared with calls: a USDC allowance can cap both
//! `transfer` calls and x402 `TransferWithAuthorization` signatures.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use crate::abi::Word;
use crate::eip712::{TypedData, hash_typed_data};
use crate::evaluate::{Context, evaluate};
use crate::monerium::{MoneriumOrder, parse_order, personal_message_digest};
use crate::permission::Environment;
use crate::types::{ConditionFlat, Consumption, Status};

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SignatureScope {
    /// `None`: any message of this domain and type (wildcard).
    pub conditions: Option<Vec<ConditionFlat>>,
}

/// Known `personal_sign` message formats.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
#[serde(rename_all = "camelCase")]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum MessageKind {
    MoneriumOrder = 1,
}

pub trait SignatureScopeSource {
    fn typed_data(&self, domain_separator: &Word, type_hash: &Word) -> Option<SignatureScope>;
    fn message(&self, kind: MessageKind) -> Option<SignatureScope>;
}

impl SignatureScopeSource for crate::permission::RoleScope {
    fn typed_data(&self, domain_separator: &Word, type_hash: &Word) -> Option<SignatureScope> {
        self.typed_data
            .get(&(*domain_separator, *type_hash))
            .cloned()
    }
    fn message(&self, kind: MessageKind) -> Option<SignatureScope> {
        self.messages.get(&kind).cloned()
    }
}

/// An approved signature request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureApproval {
    /// The 32-byte digest to sign with the wallet key (secp256k1 via MPC).
    pub digest: Word,
    /// Allowance consumptions to persist once the signature is released.
    pub consumptions: Vec<Consumption>,
}

/// Check an EIP-712 signature request against a role.
pub fn check_typed_data(
    scope: &dyn SignatureScopeSource,
    data: &TypedData,
    environment: &Environment,
) -> Result<SignatureApproval, Status> {
    let hashed = hash_typed_data(data).map_err(|reason| Status::TypedDataInvalid { reason })?;
    let entry = scope
        .typed_data(&hashed.domain_separator, &hashed.type_hash)
        .ok_or(Status::SignatureNotAllowed)?;
    let consumptions = conditions(&entry, &hashed.calldata, environment)?;
    Ok(SignatureApproval {
        digest: hashed.digest,
        consumptions,
    })
}

/// Check a Monerium order (`personal_sign`) against a role.
pub fn check_monerium_order(
    scope: &dyn SignatureScopeSource,
    message: &str,
    environment: &Environment,
) -> Result<(MoneriumOrder, SignatureApproval), Status> {
    let order = parse_order(message, environment.now)
        .map_err(|reason| Status::MessageInvalid { reason })?;
    let entry = scope
        .message(MessageKind::MoneriumOrder)
        .ok_or(Status::SignatureNotAllowed)?;
    let consumptions = conditions(&entry, &order.calldata(), environment)?;
    let digest = personal_message_digest(message);
    Ok((
        order,
        SignatureApproval {
            digest,
            consumptions,
        },
    ))
}

fn conditions(
    entry: &SignatureScope,
    calldata: &[u8],
    environment: &Environment,
) -> Result<Vec<Consumption>, Status> {
    let Some(conditions) = &entry.conditions else {
        return Ok(Vec::new());
    };
    let context = Context {
        calldata,
        value: 0,
        avatar: environment.avatar,
        now: environment.now,
        allowances: environment.allowances,
    };
    evaluate(conditions, &context)
}
