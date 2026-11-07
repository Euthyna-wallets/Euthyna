//! Euthyna bank signer.
//!
//! Runs inside OutLayer's Intel TDX enclave. It is the only holder of the key that signs
//! requests to Noah (the regulated partner that pays IBANs), and it creates a payout only for
//! a request that comes from an Euthyna vault on chain: the vault has already checked the role,
//! the voted beneficiary, the budget and the invoice reference before calling OutLayer.
//!
//! Three locks, judged by three parties:
//! 1. the manifest below shuts the direct, HTTPS and meta-transaction doors (the worker);
//! 2. the secret rows open only when the calling contract is a vault made by Nomos (the keystore);
//! 3. this code refuses any run whose caller is not such a vault (the enclave itself).
//!
//! Input (stdin, JSON): `{"op":"pubkey"}` or
//! `{"op":"payout","vault":…,"customer_id":…,"commitment":"<hex>","sealed":"<base64>","reference":…,
//!   "crypto_amount":"5","source_address":"0x…","network":"BaseTestSepolia","crypto":"EURC_TEST",
//!   "nonce":…,"expiry":"2026-11-08T10:00:00Z"}`.
//!
//! The IBAN never appears on chain. The members voted a commitment (sha256 of the vault, the IBAN,
//! the holder and a salt) and an envelope sealed to this enclave's X25519 key; the vault forwards
//! both. The enclave opens the envelope, recomputes the commitment and refuses any mismatch, so
//! only the voted IBAN can be paid, and nothing it outputs names the IBAN or the holder (the
//! input and the output of an OutLayer run are public on NEAR).
//! Output (stdout, JSON, under 900 bytes): `{"ok":true,…}` or `{"ok":false,"error":…}`.
//!
//! Environment (OutLayer): `OUTLAYER_EXECUTION_TYPE`, `NEAR_PREDECESSOR_ID`; secrets `NOAH_API_KEY`,
//! `NOAH_API_URL`, `PROTECTED_NOAH_SEED` (32 bytes of hex, generated inside the enclave: nobody saw it).

use std::io::{self, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::EncodePublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasi_http_client::Client;

/// Embedded as the `outlayer.manifest` custom section, covered by the wasm's sha256.
#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

/// Vaults are sub-accounts of a Nomos factory. Only a call from one of them makes a payout.
const VAULT_SUFFIXES: &[&str] = &[".euthyna-nomos.testnet", ".nomos.euthyna.testnet", ".euthyna-nomos.near", ".nomos.euthyna.near"];
/// Noah verifies this audience whatever the environment.
const NOAH_AUD: &str = "https://api.noah.com";
/// A signed request is valid this long; Noah allows up to 15 minutes.
const JWT_TTL_S: u64 = 300;

#[derive(Deserialize)]
struct Input {
    op: String,
    #[serde(default)]
    vault: String,
    #[serde(default)]
    customer_id: String,
    #[serde(default)]
    commitment: String,
    #[serde(default)]
    sealed: String,
    #[serde(default)]
    reference: String,
    #[serde(default)]
    crypto_amount: String,
    #[serde(default)]
    source_address: String,
    #[serde(default)]
    network: String,
    #[serde(default)]
    crypto: String,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    expiry: String,
}

/// What the members sealed for the enclave when they voted the beneficiary.
#[derive(Deserialize)]
struct Beneficiary {
    vault: String,
    iban: String,
    name: String,
    holder_type: String,
    salt: String,
}

#[derive(Deserialize)]
struct Envelope {
    v: u8,
    epk: String,
    iv: String,
    ct: String,
}

#[derive(Serialize)]
struct Refusal<'a> {
    ok: bool,
    error: &'a str,
}

fn main() {
    let mut text = String::new();
    if io::stdin().read_to_string(&mut text).is_err() {
        return refuse("unreadable input");
    }
    let input: Input = match serde_json::from_str(&text) {
        Ok(input) => input,
        Err(error) => return refuse(&format!("bad input: {error}")),
    };
    let result = match input.op.as_str() {
        "pubkey" => pubkey(),
        "payout" => payout(&input),
        _ => Err("unknown op".into()),
    };
    match result {
        Ok(value) => emit(&value),
        Err(error) => refuse(&error),
    }
}

fn emit(value: &Value) {
    let _ = io::stdout().write_all(value.to_string().as_bytes());
    let _ = io::stdout().flush();
}

fn refuse(error: &str) {
    // Never echo secrets: errors here are short and ours.
    let text = serde_json::to_string(&Refusal { ok: false, error: &error.chars().take(300).collect::<String>() }).unwrap_or_default();
    let _ = io::stdout().write_all(text.as_bytes());
    let _ = io::stdout().flush();
}

// ---------------------------------------------------------------------------
// The key: derived from the enclave-generated seed, never written anywhere.
// ---------------------------------------------------------------------------

/// 32 bytes for one purpose, from the enclave-generated seed (HKDF: one seed, keys that never meet).
fn derived(purpose: &[u8]) -> Result<[u8; 32], String> {
    let seed_hex = std::env::var("PROTECTED_NOAH_SEED").map_err(|_| "no PROTECTED_NOAH_SEED in this run".to_string())?;
    let seed = hex::decode(seed_hex.trim()).map_err(|_| "PROTECTED_NOAH_SEED is not hex".to_string())?;
    if seed.len() < 32 {
        return Err("PROTECTED_NOAH_SEED is too short".into());
    }
    let hk = hkdf::Hkdf::<Sha256>::new(Some(b"euthyna-bank-signer"), &seed);
    let mut okm = [0u8; 32];
    hk.expand(purpose, &mut okm).map_err(|_| "hkdf".to_string())?;
    Ok(okm)
}

fn signing_key() -> Result<SigningKey, String> {
    // A 32-byte scalar outside the curve order is astronomically unlikely; refuse rather than wrap.
    SigningKey::from_slice(&derived(b"noah request signing key v1")?).map_err(|_| "derived scalar unusable".to_string())
}

/// The X25519 key beneficiaries are sealed to.
fn box_key() -> Result<x25519_dalek::StaticSecret, String> {
    Ok(x25519_dalek::StaticSecret::from(derived(b"beneficiary box key v1")?))
}

/// sha256("euthyna-bank-beneficiary-v1" 0 vault 0 IBAN 0 holder 0 holder type 0 salt), hex.
/// The salt (32 random bytes, hex) keeps an IBAN from being found by trying candidates.
pub fn commitment_of(vault: &str, iban: &str, name: &str, holder_type: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    for (index, part) in ["euthyna-bank-beneficiary-v1", vault, iban, name, holder_type, salt].iter().enumerate() {
        if index > 0 {
            hasher.update([0u8]);
        }
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Opens an envelope sealed to `secret`: AES-256-GCM under sha256(X25519(secret, epk) ‖ epk ‖ our
/// public key), the vault's account as associated data (an envelope copied to another vault fails).
fn open(sealed: &str, secret: &x25519_dalek::StaticSecret, vault: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    let std = base64::engine::general_purpose::STANDARD;
    let envelope: Envelope = serde_json::from_slice(&std.decode(sealed.trim()).map_err(|_| "sealed: not base64".to_string())?)
        .map_err(|_| "sealed: not an envelope".to_string())?;
    if envelope.v != 1 {
        return Err("sealed: unknown version".into());
    }
    let epk: [u8; 32] = std.decode(&envelope.epk).ok().and_then(|bytes| bytes.try_into().ok()).ok_or("sealed: bad key")?;
    let iv: [u8; 12] = std.decode(&envelope.iv).ok().and_then(|bytes| bytes.try_into().ok()).ok_or("sealed: bad iv")?;
    let ct = std.decode(&envelope.ct).map_err(|_| "sealed: bad ciphertext".to_string())?;
    let ours = x25519_dalek::PublicKey::from(secret);
    let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(epk));
    let mut hasher = Sha256::new();
    hasher.update(shared.as_bytes());
    hasher.update(epk);
    hasher.update(ours.as_bytes());
    let key: [u8; 32] = hasher.finalize().into();
    let cipher = aes_gcm::Aes256Gcm::new(&key.into());
    cipher
        .decrypt(&iv.into(), Payload { msg: &ct, aad: vault.as_bytes() })
        .map_err(|_| "sealed: cannot open (not for this enclave or this vault)".to_string())
}

fn pubkey() -> Result<Value, String> {
    let key = signing_key()?;
    let verifying = key.verifying_key();
    let pem = verifying.to_public_key_pem(p256::pkcs8::LineEnding::LF).map_err(|_| "pem".to_string())?;
    let sec1 = verifying.to_sec1_bytes();
    let boxed = x25519_dalek::PublicKey::from(&box_key()?);
    Ok(json!({
        "ok": true,
        "alg": "ES256",
        "public_key_pem": pem,
        "public_key_sec1_hex": hex::encode(sec1),
        "box_public_key_hex": hex::encode(boxed.as_bytes()),
    }))
}

// ---------------------------------------------------------------------------
// Noah: a signed request (JWT in Api-Signature, ES256 over method, path and body hash).
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn jwt(key: &SigningKey, method: &str, path: &str, body: Option<&[u8]>) -> String {
    let header = b64url(br#"{"alg":"ES256","typ":"JWT"}"#);
    let iat = now_s();
    let mut claims = json!({ "aud": NOAH_AUD, "iat": iat, "exp": iat + JWT_TTL_S, "method": method, "path": path });
    if let Some(body) = body {
        claims["bodyHash"] = Value::String(hex::encode(Sha256::digest(body)));
    }
    let payload = b64url(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{payload}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    format!("{signing_input}.{}", b64url(&signature.to_bytes()))
}

struct Noah {
    url: String,
    api_key: String,
    key: SigningKey,
}

impl Noah {
    fn from_env() -> Result<Self, String> {
        let url = std::env::var("NOAH_API_URL").unwrap_or_else(|_| "https://api.sandbox.noah.com/v1".into());
        let api_key = std::env::var("NOAH_API_KEY").map_err(|_| "no NOAH_API_KEY in this run".to_string())?;
        Ok(Self { url: url.trim_end_matches('/').to_string(), api_key, key: signing_key()? })
    }

    /// `path` starts with "/v1/…" (what the JWT names); the request goes to the API host.
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let bytes = body.to_string().into_bytes();
        let signature = jwt(&self.key, "POST", path, Some(&bytes));
        let host = self.url.trim_end_matches("/v1");
        let request = Client::new().post(&format!("{host}{path}")).header("X-Api-Key", self.api_key.as_str());
        #[cfg(feature = "dev-unsigned")]
        let request = if std::env::var("NOAH_DEV_UNSIGNED").is_ok() { request } else { request.header("Api-Signature", signature.as_str()) };
        #[cfg(not(feature = "dev-unsigned"))]
        let request = request.header("Api-Signature", signature.as_str());
        let response = request
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .connect_timeout(Duration::from_secs(20))
            .body(&bytes)
            .send()
            .map_err(|error| format!("noah unreachable: {error}"))?;
        let status = response.status();
        let text = String::from_utf8_lossy(&response.body().unwrap_or_default()).to_string();
        if !(200..300).contains(&status) {
            // Noah's error names the invalid fields; it never contains our secrets.
            let detail = serde_json::from_str::<Value>(&text)
                .ok()
                .map(|value| {
                    let fields = value["RequestExtension"]["Body"].as_array().map(|items| {
                        items.iter().map(|item| format!("{}: {}", item["Field"].as_str().unwrap_or(""), item["Description"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("; ")
                    });
                    format!("{}{}", value["Detail"].as_str().unwrap_or("error"), fields.map(|f| format!(": {f}")).unwrap_or_default())
                })
                .unwrap_or_else(|| text.chars().take(160).collect());
            return Err(format!("noah {status} on {path}: {detail}"));
        }
        serde_json::from_str(&text).map_err(|_| "noah: not JSON".to_string())
    }
}

// ---------------------------------------------------------------------------
// The payout: only for a vault's own call.
// ---------------------------------------------------------------------------

fn caller_is_vault(input: &Input) -> Result<(), String> {
    if std::env::var("OUTLAYER_EXECUTION_TYPE").unwrap_or_default() != "NEAR" {
        return Err("payouts are made only from a NEAR contract call".into());
    }
    let predecessor = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    if predecessor.is_empty() || !VAULT_SUFFIXES.iter().any(|suffix| predecessor.ends_with(suffix)) {
        return Err("the caller is not an Euthyna vault".into());
    }
    if input.vault != predecessor {
        return Err("the request names another vault than the caller".into());
    }
    Ok(())
}

/// The partner's customer of a vault: derived from the vault's account, so a vault can only ever
/// act for its own company (another company's KYB cannot be borrowed by voting its customer id).
/// "eut-" + 38 hex characters of sha256(vault) = 42, the partner's maximum.
pub fn customer_id_of(vault: &str) -> String {
    let digest = Sha256::digest(vault.as_bytes());
    format!("eut-{}", &hex::encode(digest)[..38])
}

fn valid_iban(iban: &str) -> bool {
    let compact: String = iban.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() < 15 || compact.len() > 34 || !compact.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    // ISO 7064 mod 97-10.
    let rotated = format!("{}{}", &compact[4..], &compact[..4]);
    let mut remainder: u32 = 0;
    for c in rotated.chars() {
        let digits = if c.is_ascii_digit() { (c as u32 - '0' as u32).to_string() } else { (c.to_ascii_uppercase() as u32 - 'A' as u32 + 10).to_string() };
        for d in digits.chars() {
            remainder = (remainder * 10 + (d as u32 - '0' as u32)) % 97;
        }
    }
    remainder == 1
}

fn payout(input: &Input) -> Result<Value, String> {
    caller_is_vault(input)?;
    if input.customer_id != customer_id_of(&input.vault) {
        return Err("the customer is not this vault's".into());
    }
    if input.crypto_amount.parse::<f64>().map(|v| v <= 0.0).unwrap_or(true) {
        return Err("invalid amount".into());
    }
    if input.source_address.len() != 42 || !input.source_address.starts_with("0x") {
        return Err("invalid source address".into());
    }
    if input.network.is_empty() || input.crypto.is_empty() || input.nonce.is_empty() || input.expiry.is_empty() || input.commitment.len() != 64 {
        return Err("missing field".into());
    }
    // The beneficiary the members voted: opened here, checked against their commitment.
    let plain = open(&input.sealed, &box_key()?, &input.vault)?;
    let beneficiary: Beneficiary = serde_json::from_slice(&plain).map_err(|_| "sealed: not a beneficiary".to_string())?;
    let iban: String = beneficiary.iban.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_ascii_uppercase()).collect();
    if beneficiary.vault != input.vault
        || commitment_of(&input.vault, &iban, &beneficiary.name, &beneficiary.holder_type, &beneficiary.salt) != input.commitment.to_ascii_lowercase()
    {
        return Err("the beneficiary is not the one the members voted".into());
    }
    if !valid_iban(&iban) {
        return Err("invalid IBAN".into());
    }
    if beneficiary.name.trim().is_empty() || beneficiary.name.len() > 255 {
        return Err("invalid holder name".into());
    }
    if !matches!(beneficiary.holder_type.as_str(), "Business" | "Individual") {
        return Err("holder_type must be Business or Individual".into());
    }
    // Errors leave the enclave in public: no IBAN, no holder name in them.
    payout_to(input, &iban, &beneficiary.name, &beneficiary.holder_type).map_err(|error| error.replace(&iban, "<iban>").replace(&beneficiary.name, "<holder>"))
}

fn payout_to(input: &Input, iban: &str, holder_name: &str, holder_type: &str) -> Result<Value, String> {
    let noah = Noah::from_env()?;
    let channel = std::env::var("NOAH_SEPA_CHANNEL_ID").map_err(|_| "no NOAH_SEPA_CHANNEL_ID in this run".to_string())?;
    // SEPA references: A-Z a-z 0-9 + - / ? . : , ( ) ' and spaces, 2 to 140 characters.
    let reference: String = input.reference.chars().filter(|c| c.is_ascii_alphanumeric() || " +-/?.:,()'".contains(*c)).take(140).collect::<String>().trim().to_string();
    let reference = if reference.len() < 2 { "Euthyna".to_string() } else { reference };
    let holder = if holder_type == "Business" {
        json!({ "AccountHolderType": "Business", "Name": holder_name })
    } else {
        let mut parts = holder_name.trim().splitn(2, ' ');
        let first = parts.next().unwrap_or("").to_string();
        let last = parts.next().unwrap_or("-").to_string();
        json!({ "AccountHolderType": "Individual", "Name": { "FirstName": first, "LastName": last } })
    };

    // 1. The beneficiary and the amount become a form session.
    let prepared = noah.post("/v1/transactions/sell/prepare", &json!({
        "ChannelID": channel,
        "CryptoCurrency": input.crypto,
        "CustomerID": input.customer_id,
        "CryptoAmount": input.crypto_amount,
        "DelayedSell": true,
        "Form": { "AccountHolderName": holder, "BankDetails": { "AccountNumber": iban }, "Reference": reference },
    }))?;
    let form_session = prepared["FormSessionID"].as_str().ok_or("noah: no FormSessionID")?.to_string();
    let fiat_amount = prepared["FiatAmount"].as_str().unwrap_or("").to_string();

    // 2. A single-use rule: exactly this amount, from the company wallet, before the expiry.
    let rule = noah.post("/v1/workflows/onchain-deposit-to-payment-method", &json!({
        "CustomerID": input.customer_id,
        "CryptoCurrency": input.crypto,
        "FormSessionID": form_session,
        "Trigger": {
            "Type": "SingleOnchainDepositSourceTriggerInput",
            "SourceAddress": input.source_address,
            "Nonce": input.nonce,
            "Expiry": input.expiry,
            "Conditions": [{ "Network": input.network, "AmountConditions": [{ "ComparisonOperator": "EQ", "Value": input.crypto_amount }] }],
        },
    }))?;
    let rule_id = rule["RuleID"].as_str().ok_or("noah: no RuleID")?.to_string();
    let deposit = rule["Conditions"][0]["DestinationAddress"]["Address"].as_str().ok_or("noah: no deposit address")?.to_string();
    Ok(json!({
        "ok": true,
        "rule_id": rule_id,
        "deposit_address": deposit,
        "crypto_amount": input.crypto_amount,
        "fiat_amount": fiat_amount,
        "expiry": input.expiry,
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn customer_is_bound_to_the_vault() {
        let id = customer_id_of("sealedprod1106.nomos.euthyna.testnet");
        assert_eq!(id.len(), 42);
        assert!(id.starts_with("eut-"));
        assert_ne!(id, customer_id_of("attacker.euthyna-nomos.testnet"));
    }

    use super::*;

    /// What a member's browser does (packages/sdk/src/bank-private.ts), here for the tests.
    pub(super) fn seal(plain: &[u8], to: &x25519_dalek::PublicKey, vault: &str, ephemeral: [u8; 32], iv: [u8; 12]) -> String {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        let std = base64::engine::general_purpose::STANDARD;
        let secret = x25519_dalek::StaticSecret::from(ephemeral);
        let epk = x25519_dalek::PublicKey::from(&secret);
        let shared = secret.diffie_hellman(to);
        let mut hasher = Sha256::new();
        hasher.update(shared.as_bytes());
        hasher.update(epk.as_bytes());
        hasher.update(to.as_bytes());
        let key: [u8; 32] = hasher.finalize().into();
        let ct = aes_gcm::Aes256Gcm::new(&key.into()).encrypt(&iv.into(), Payload { msg: plain, aad: vault.as_bytes() }).unwrap();
        std.encode(json!({ "v": 1, "epk": std.encode(epk.as_bytes()), "iv": std.encode(iv), "ct": std.encode(ct) }).to_string())
    }

    #[test]
    fn only_the_voted_beneficiary_opens() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let ours = x25519_dalek::PublicKey::from(&box_key().unwrap());
        let vault = "acme.euthyna-nomos.testnet";
        let plain = json!({ "vault": vault, "iban": "FR7630006000011234567890189", "name": "Atelier Dupont SAS", "holder_type": "Business", "salt": "ab".repeat(32) }).to_string();
        let sealed = seal(plain.as_bytes(), &ours, vault, [7; 32], [9; 12]);
        assert_eq!(open(&sealed, &box_key().unwrap(), vault).unwrap(), plain.as_bytes());
        // Copied to another vault: the associated data differs, it does not open.
        assert!(open(&sealed, &box_key().unwrap(), "other.euthyna-nomos.testnet").is_err());
        // Sealed to another key: does not open.
        let elsewhere = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from([5u8; 32]));
        assert!(open(&seal(plain.as_bytes(), &elsewhere, vault, [7; 32], [9; 12]), &box_key().unwrap(), vault).is_err());
        // The commitment the members voted, and a substituted IBAN that does not match it.
        let voted = commitment_of(vault, "FR7630006000011234567890189", "Atelier Dupont SAS", "Business", &"ab".repeat(32));
        assert_ne!(voted, commitment_of(vault, "DE89370400440532013000", "Atelier Dupont SAS", "Business", &"ab".repeat(32)));
        assert_ne!(voted, commitment_of(vault, "FR7630006000011234567890189", "Atelier Dupont SAS", "Business", &"cd".repeat(32)));
    }

    /// Sealed by packages/sdk (a member's browser), opened here: the two sides agree byte for byte.
    #[test]
    fn opens_what_the_console_seals() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let vector: Value = serde_json::from_str(include_str!("../../packages/sdk/src/fixtures/bank-sealed.json")).unwrap();
        let vault = vector["vault"].as_str().unwrap();
        let plain = open(vector["sealed"].as_str().unwrap(), &box_key().unwrap(), vault).unwrap();
        assert_eq!(String::from_utf8(plain.clone()).unwrap(), vector["plaintext"].as_str().unwrap());
        let beneficiary: Beneficiary = serde_json::from_slice(&plain).unwrap();
        assert_eq!(commitment_of(vault, &beneficiary.iban, &beneficiary.name, &beneficiary.holder_type, &beneficiary.salt), vector["commitment"].as_str().unwrap());
    }

    #[test]
    fn iban_checksum() {
        assert!(valid_iban("FR76 3000 6000 0112 3456 7890 189"));
        assert!(valid_iban("DE89370400440532013000"));
        assert!(!valid_iban("FR7630006000011234567890180"));
        assert!(!valid_iban("hello"));
    }

    #[test]
    fn jwt_binds_method_path_and_body() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let key = signing_key().unwrap();
        let token = jwt(&key, "POST", "/v1/transactions/sell/prepare", Some(b"{\"a\":1}"));
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], NOAH_AUD);
        assert_eq!(claims["method"], "POST");
        assert_eq!(claims["bodyHash"], hex::encode(Sha256::digest(b"{\"a\":1}")));
        assert_eq!(claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(), JWT_TTL_S);
        // The signature verifies under the derived public key.
        use p256::ecdsa::signature::Verifier;
        let signature = Signature::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        key.verifying_key().verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).unwrap();
    }

    #[test]
    fn same_seed_same_key() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let a = pubkey().unwrap();
        let b = pubkey().unwrap();
        assert_eq!(a["public_key_pem"], b["public_key_pem"]);
        assert!(a["public_key_pem"].as_str().unwrap().starts_with("-----BEGIN PUBLIC KEY-----"));
    }

    #[test]
    fn only_a_vault_calling_on_chain_gets_a_payout() {
        let input = Input { op: "payout".into(), vault: "acme.euthyna-nomos.testnet".into(), ..serde_json::from_str("{\"op\":\"payout\"}").unwrap() };
        std::env::set_var("OUTLAYER_EXECUTION_TYPE", "HTTPS");
        assert!(caller_is_vault(&input).is_err());
        std::env::set_var("OUTLAYER_EXECUTION_TYPE", "NEAR");
        std::env::set_var("NEAR_PREDECESSOR_ID", "attacker.testnet");
        assert!(caller_is_vault(&input).is_err());
        std::env::set_var("NEAR_PREDECESSOR_ID", "other.euthyna-nomos.testnet");
        assert!(caller_is_vault(&input).is_err());
        std::env::set_var("NEAR_PREDECESSOR_ID", "acme.euthyna-nomos.testnet");
        assert!(caller_is_vault(&input).is_ok());
        // The right vault, voting another company's customer: refused before any request.
        let borrowed = Input { customer_id: customer_id_of("victim.euthyna-nomos.testnet"), ..input };
        assert_eq!(payout(&borrowed).unwrap_err(), "the customer is not this vault's");
    }
}
