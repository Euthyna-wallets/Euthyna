//! EIP-712 typed structured data (`eth_signTypedData_v4` JSON).
//!
//! The vault never signs a digest supplied by an agent: it recomputes the
//! digest from the typed data, and evaluates the role's conditions on the very
//! values it hashes. Input is strict: unknown or missing fields, non-canonical
//! types, extra domain fields and ambiguous numbers are refused.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha3::{Digest, Keccak256};

use crate::abi::Word;
use crate::encode::{AbiValue, encode_params, parse_integer};

/// Maximum nesting of structs and arrays.
const MAX_DEPTH: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypedField {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// `eth_signTypedData_v4` payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedData {
    pub types: BTreeMap<String, Vec<TypedField>>,
    pub primary_type: String,
    pub domain: serde_json::Map<String, Value>,
    pub message: Value,
}

/// Everything the vault needs from a typed data payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashedTypedData {
    pub domain_separator: Word,
    /// `keccak256(encodeType(primaryType))`: pins the full type definition.
    pub type_hash: Word,
    /// `keccak256(0x1901 || domainSeparator || hashStruct(message))`: what the MPC signs.
    pub digest: Word,
    /// `typeHash[0..4] || abi.encode(message fields)`: what the conditions read,
    /// shaped like calldata so conditions are written as for a function call.
    pub calldata: Vec<u8>,
}

/// Canonical EIP712Domain fields, in the order the standard defines.
const DOMAIN_FIELDS: [(&str, &str); 5] = [
    ("name", "string"),
    ("version", "string"),
    ("chainId", "uint256"),
    ("verifyingContract", "address"),
    ("salt", "bytes32"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum FieldType {
    Uint(u32),
    Int(u32),
    Address,
    Bool,
    FixedBytes(usize),
    Bytes,
    String,
    Struct(String),
    Array(Box<FieldType>, Option<usize>),
}

fn invalid(reason: impl Into<String>) -> String {
    reason.into()
}

fn parse_type(text: &str, types: &BTreeMap<String, Vec<TypedField>>) -> Result<FieldType, String> {
    if let Some(open) = text.rfind('[') {
        let inner = &text[..open];
        let suffix = &text[open..];
        let size = suffix
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .ok_or_else(|| invalid(format!("bad type {text}")))?;
        let size = if size.is_empty() {
            None
        } else {
            let length: usize = size
                .parse()
                .map_err(|_| invalid(format!("bad array size in {text}")))?;
            if length == 0 || size.starts_with('0') {
                return Err(invalid(format!("bad array size in {text}")));
            }
            Some(length)
        };
        return Ok(FieldType::Array(Box::new(parse_type(inner, types)?), size));
    }
    let sized = |prefix: &str| -> Option<Result<u32, String>> {
        let digits = text.strip_prefix(prefix)?;
        Some(match digits.parse::<u32>() {
            Ok(bits) if bits % 8 == 0 && (8..=256).contains(&bits) && !digits.starts_with('0') => {
                Ok(bits)
            }
            _ => Err(invalid(format!("non-canonical type {text}"))),
        })
    };
    Ok(match text {
        "address" => FieldType::Address,
        "bool" => FieldType::Bool,
        "bytes" => FieldType::Bytes,
        "string" => FieldType::String,
        _ if text.starts_with("uint") => FieldType::Uint(sized("uint").expect("prefix")?),
        _ if text.starts_with("int") => FieldType::Int(sized("int").expect("prefix")?),
        _ if text.starts_with("bytes") => {
            let size: usize = text[5..]
                .parse()
                .map_err(|_| invalid(format!("bad type {text}")))?;
            if !(1..=32).contains(&size) || text[5..].starts_with('0') {
                return Err(invalid(format!("bad type {text}")));
            }
            FieldType::FixedBytes(size)
        }
        _ if types.contains_key(text) && text != "EIP712Domain" => {
            FieldType::Struct(text.to_string())
        }
        _ => return Err(invalid(format!("unknown type {text}"))),
    })
}

fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

struct Encoder<'a> {
    types: &'a BTreeMap<String, Vec<TypedField>>,
}

impl Encoder<'_> {
    fn check_types(&self) -> Result<(), String> {
        for (name, fields) in self.types {
            if !is_identifier(name) {
                return Err(invalid(format!("bad type name {name}")));
            }
            let mut seen = BTreeSet::new();
            for field in fields {
                if !is_identifier(&field.name) || !seen.insert(field.name.as_str()) {
                    return Err(invalid(format!(
                        "bad or duplicate field {}.{}",
                        name, field.name
                    )));
                }
                if name != "EIP712Domain" {
                    parse_type(&field.kind, self.types)?;
                }
            }
        }
        Ok(())
    }

    fn base_struct(kind: &FieldType) -> Option<&str> {
        match kind {
            FieldType::Struct(name) => Some(name),
            FieldType::Array(inner, _) => Self::base_struct(inner),
            _ => None,
        }
    }

    fn dependencies(&self, name: &str, found: &mut BTreeSet<String>) -> Result<(), String> {
        if !found.insert(name.to_string()) {
            return Ok(());
        }
        for field in &self.types[name] {
            if let Some(dependency) = Self::base_struct(&parse_type(&field.kind, self.types)?) {
                self.dependencies(dependency, found)?;
            }
        }
        Ok(())
    }

    fn encode_type(&self, primary: &str) -> Result<String, String> {
        let mut found = BTreeSet::new();
        self.dependencies(primary, &mut found)?;
        found.remove(primary);
        let mut out = String::new();
        for name in std::iter::once(primary.to_string()).chain(found) {
            let fields: Vec<String> = self.types[&name]
                .iter()
                .map(|f| format!("{} {}", f.kind, f.name))
                .collect();
            out.push_str(&format!("{}({})", name, fields.join(",")));
        }
        Ok(out)
    }

    fn type_hash(&self, primary: &str) -> Result<Word, String> {
        Ok(keccak(self.encode_type(primary)?.as_bytes()))
    }

    /// Returns (EIP-712 encoded word, ABI value) for one value.
    fn value(
        &self,
        kind: &FieldType,
        value: &Value,
        depth: usize,
    ) -> Result<(Word, AbiValue), String> {
        if depth > MAX_DEPTH {
            return Err(invalid("typed data nested too deeply"));
        }
        match kind {
            FieldType::Struct(name) => self.structure(name, value, depth + 1),
            FieldType::Array(inner, size) => {
                let items = value
                    .as_array()
                    .ok_or_else(|| invalid("expected an array"))?;
                if size.is_some_and(|size| size != items.len()) {
                    return Err(invalid("fixed array length mismatch"));
                }
                let mut concatenated = Vec::with_capacity(items.len() * 32);
                let mut values = Vec::with_capacity(items.len());
                for item in items {
                    let (word, abi) = self.value(inner, item, depth + 1)?;
                    concatenated.extend_from_slice(&word);
                    values.push(abi);
                }
                let abi = if size.is_some() {
                    AbiValue::Tuple(values)
                } else {
                    AbiValue::Array(values)
                };
                Ok((keccak(&concatenated), abi))
            }
            FieldType::Bytes => {
                let bytes = hex_value(value, None)?;
                Ok((keccak(&bytes), AbiValue::Bytes(bytes)))
            }
            FieldType::String => {
                let text = value.as_str().ok_or_else(|| invalid("expected a string"))?;
                Ok((
                    keccak(text.as_bytes()),
                    AbiValue::Bytes(text.as_bytes().to_vec()),
                ))
            }
            atomic => {
                let word = atomic_word(atomic, value)?;
                Ok((word, AbiValue::Word(word)))
            }
        }
    }

    fn structure(
        &self,
        name: &str,
        value: &Value,
        depth: usize,
    ) -> Result<(Word, AbiValue), String> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid(format!("expected an object for {name}")))?;
        let fields = &self.types[name];
        if object.len() != fields.len() {
            return Err(invalid(format!("{name}: fields do not match the type")));
        }
        let mut encoded = self.type_hash(name)?.to_vec();
        let mut values = Vec::with_capacity(fields.len());
        for field in fields {
            let item = object
                .get(&field.name)
                .ok_or_else(|| invalid(format!("{name}.{} missing", field.name)))?;
            let (word, abi) = self.value(&parse_type(&field.kind, self.types)?, item, depth)?;
            encoded.extend_from_slice(&word);
            values.push(abi);
        }
        Ok((keccak(&encoded), AbiValue::Tuple(values)))
    }
}

fn atomic_word(kind: &FieldType, value: &Value) -> Result<Word, String> {
    let integer = |bits: u32, signed: bool| -> Result<Word, String> {
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) if number.is_u64() || number.is_i64() => number.to_string(),
            _ => return Err(invalid("expected an integer")),
        };
        parse_integer(&text, bits, signed)
            .ok_or_else(|| invalid(format!("integer out of range: {text}")))
    };
    match kind {
        FieldType::Uint(bits) => integer(*bits, false),
        FieldType::Int(bits) => integer(*bits, true),
        FieldType::Bool => {
            let flag = value
                .as_bool()
                .ok_or_else(|| invalid("expected a boolean"))?;
            let mut word = [0u8; 32];
            word[31] = u8::from(flag);
            Ok(word)
        }
        FieldType::Address => {
            let bytes = hex_value(value, Some(20))?;
            let mut word = [0u8; 32];
            word[12..].copy_from_slice(&bytes);
            Ok(word)
        }
        FieldType::FixedBytes(size) => {
            let bytes = hex_value(value, Some(*size))?;
            let mut word = [0u8; 32];
            word[..*size].copy_from_slice(&bytes);
            Ok(word)
        }
        _ => unreachable!("not atomic"),
    }
}

fn hex_value(value: &Value, length: Option<usize>) -> Result<Vec<u8>, String> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid("expected a 0x hex string"))?;
    let digits = text
        .strip_prefix("0x")
        .ok_or_else(|| invalid("expected a 0x hex string"))?;
    let bytes = hex::decode(digits).map_err(|_| invalid("bad hex"))?;
    if length.is_some_and(|length| length != bytes.len()) {
        return Err(invalid("hex value has the wrong length"));
    }
    Ok(bytes)
}

fn keccak(data: &[u8]) -> Word {
    Keccak256::digest(data).into()
}

/// Hash typed data and build the condition input.
pub fn hash_typed_data(data: &TypedData) -> Result<HashedTypedData, String> {
    if data.primary_type == "EIP712Domain" || !data.types.contains_key(&data.primary_type) {
        return Err(invalid("unknown primary type"));
    }
    // Domain type: the canonical fields present in `domain`, in canonical order.
    for key in data.domain.keys() {
        if !DOMAIN_FIELDS.iter().any(|(name, _)| name == key) {
            return Err(invalid(format!("unsupported domain field {key}")));
        }
    }
    let domain_type: Vec<TypedField> = DOMAIN_FIELDS
        .iter()
        .filter(|(name, _)| data.domain.contains_key(*name))
        .map(|(name, kind)| TypedField {
            name: name.to_string(),
            kind: kind.to_string(),
        })
        .collect();
    if let Some(declared) = data.types.get("EIP712Domain")
        && *declared != domain_type
    {
        return Err(invalid(
            "EIP712Domain type must list the domain fields in canonical order",
        ));
    }
    let mut types = data.types.clone();
    types.insert("EIP712Domain".to_string(), domain_type);
    let encoder = Encoder { types: &types };
    encoder.check_types()?;

    let (domain_separator, _) =
        encoder.structure("EIP712Domain", &Value::Object(data.domain.clone()), 0)?;
    let type_hash = encoder.type_hash(&data.primary_type)?;
    let (message_hash, abi) = encoder.structure(&data.primary_type, &data.message, 0)?;
    let AbiValue::Tuple(fields) = abi else {
        unreachable!("structs encode as tuples")
    };

    let mut preimage = vec![0x19, 0x01];
    preimage.extend_from_slice(&domain_separator);
    preimage.extend_from_slice(&message_hash);
    let mut calldata = type_hash[..4].to_vec();
    calldata.extend(encode_params(&fields));
    Ok(HashedTypedData {
        domain_separator,
        type_hash,
        digest: keccak(&preimage),
        calldata,
    })
}

/// `keccak256(encodeType(primary))` for a type set, for authoring scopes.
pub fn type_hash(types: &BTreeMap<String, Vec<TypedField>>, primary: &str) -> Result<Word, String> {
    if !types.contains_key(primary) {
        return Err(invalid("unknown primary type"));
    }
    let encoder = Encoder { types };
    encoder.check_types()?;
    encoder.type_hash(primary)
}
