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
//! `{"op":"payout","vault":…,"customer_id":…,"iban":…,"holder_name":…,"holder_type":"Business"|"Individual",
//!   "reference":…,"crypto_amount":"5.000000","source_address":"0x…","network":"BaseTestSepolia",
//!   "crypto":"EURC_TEST","nonce":…,"expiry":"2026-11-08T10:00:00Z"}`.
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
    iban: String,
    #[serde(default)]
    holder_name: String,
    #[serde(default = "business")]
    holder_type: String,
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

fn business() -> String {
    "Business".into()
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

fn signing_key() -> Result<SigningKey, String> {
    let seed_hex = std::env::var("PROTECTED_NOAH_SEED").map_err(|_| "no PROTECTED_NOAH_SEED in this run".to_string())?;
    let seed = hex::decode(seed_hex.trim()).map_err(|_| "PROTECTED_NOAH_SEED is not hex".to_string())?;
    if seed.len() < 32 {
        return Err("PROTECTED_NOAH_SEED is too short".into());
    }
    // HKDF with a fixed purpose: the same seed could never serve another use.
    let hk = hkdf::Hkdf::<Sha256>::new(Some(b"euthyna-bank-signer"), &seed);
    let mut okm = [0u8; 32];
    hk.expand(b"noah request signing key v1", &mut okm).map_err(|_| "hkdf".to_string())?;
    // A 32-byte scalar outside the curve order is astronomically unlikely; refuse rather than wrap.
    SigningKey::from_slice(&okm).map_err(|_| "derived scalar unusable".to_string())
}

fn pubkey() -> Result<Value, String> {
    let key = signing_key()?;
    let verifying = key.verifying_key();
    let pem = verifying.to_public_key_pem(p256::pkcs8::LineEnding::LF).map_err(|_| "pem".to_string())?;
    let sec1 = verifying.to_sec1_bytes();
    Ok(json!({
        "ok": true,
        "alg": "ES256",
        "public_key_pem": pem,
        "public_key_sec1_hex": hex::encode(sec1),
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
                .and_then(|value| {
                    let fields = value["RequestExtension"]["Body"].as_array().map(|items| {
                        items.iter().map(|item| format!("{}: {}", item["Field"].as_str().unwrap_or(""), item["Description"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("; ")
                    });
                    Some(format!("{}{}", value["Detail"].as_str().unwrap_or("error"), fields.map(|f| format!(": {f}")).unwrap_or_default()))
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
    if !valid_iban(&input.iban) {
        return Err("invalid IBAN".into());
    }
    if input.holder_name.trim().is_empty() || input.holder_name.len() > 255 {
        return Err("invalid holder name".into());
    }
    if !matches!(input.holder_type.as_str(), "Business" | "Individual") {
        return Err("holder_type must be Business or Individual".into());
    }
    if input.crypto_amount.parse::<f64>().map(|v| v <= 0.0).unwrap_or(true) {
        return Err("invalid amount".into());
    }
    if input.source_address.len() != 42 || !input.source_address.starts_with("0x") {
        return Err("invalid source address".into());
    }
    if input.customer_id.is_empty() || input.network.is_empty() || input.crypto.is_empty() || input.nonce.is_empty() || input.expiry.is_empty() {
        return Err("missing field".into());
    }
    let noah = Noah::from_env()?;
    let channel = std::env::var("NOAH_SEPA_CHANNEL_ID").map_err(|_| "no NOAH_SEPA_CHANNEL_ID in this run".to_string())?;
    let iban: String = input.iban.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_ascii_uppercase()).collect();
    // SEPA references: A-Z a-z 0-9 + - / ? . : , ( ) ' and spaces, 2 to 140 characters.
    let reference: String = input.reference.chars().filter(|c| c.is_ascii_alphanumeric() || " +-/?.:,()'".contains(*c)).take(140).collect::<String>().trim().to_string();
    let reference = if reference.len() < 2 { "Euthyna".to_string() } else { reference };
    let holder = if input.holder_type == "Business" {
        json!({ "AccountHolderType": "Business", "Name": input.holder_name })
    } else {
        let mut parts = input.holder_name.trim().splitn(2, ' ');
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
        "iban_hash": hex::encode(Sha256::digest(iban.as_bytes())),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        std::env::set_var("PROTECTED_NOAH_SEED", "22".repeat(32));
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
    }
}
