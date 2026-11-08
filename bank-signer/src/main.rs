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
    salt: String,
    // v1: a SEPA account.
    #[serde(default)]
    iban: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    holder_type: String,
    // v2: any payout rail of the partner (SEPA, Pix, ACH, UK…): its channel and the payout form the
    // members filled in (`Reference`, when present, is left empty: the payout's reference goes there).
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    form: Option<Value>,
}

/// v2: sha256("euthyna-bank-beneficiary-v2" 0 vault 0 channel 0 form 0 salt), the form as compact
/// JSON with sorted keys (packages/sdk/src/bank-private.ts `canonicalJson`).
pub fn commitment_v2(vault: &str, channel_id: &str, form: &Value, salt: &str) -> String {
    let mut hasher = Sha256::new();
    let form = form.to_string();
    for (index, part) in ["euthyna-bank-beneficiary-v2", vault, channel_id, &form, salt].iter().enumerate() {
        if index > 0 {
            hasher.update([0u8]);
        }
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// Every string in a form, to keep them out of public error messages.
fn strings_of(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if text.len() >= 3 => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings_of(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings_of(item, out)),
        _ => {}
    }
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
        "version": env!("CARGO_PKG_VERSION"),
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

#[cfg(test)]
fn jwt(key: &SigningKey, method: &str, path: &str, body: Option<&[u8]>) -> String {
    jwt_with_query(key, method, path, None, body)
}

/// Noah: a GET with query parameters signs them too (`queryParams`, docs.noah.com, "Request Signing Keys").
fn jwt_with_query(key: &SigningKey, method: &str, path: &str, query: Option<&Value>, body: Option<&[u8]>) -> String {
    let header = b64url(br#"{"alg":"ES256","typ":"JWT"}"#);
    let iat = now_s();
    let mut claims = json!({ "aud": NOAH_AUD, "iat": iat, "exp": iat + JWT_TTL_S, "method": method, "path": path });
    if let Some(query) = query {
        claims["queryParams"] = query.clone();
    }
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
    fn send(&self, method: &str, path: &str, query: Option<&Value>, body: Option<&Value>) -> Result<Value, String> {
        let bytes = body.map(|body| body.to_string().into_bytes());
        let signature = jwt_with_query(&self.key, method, path, query, bytes.as_deref());
        let host = self.url.trim_end_matches("/v1");
        let query_string = query
            .and_then(Value::as_object)
            .map(|items| {
                items.iter().map(|(key, value)| format!("{}={}", url_encode(key), url_encode(&value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())))).collect::<Vec<_>>().join("&")
            })
            .filter(|text| !text.is_empty())
            .map(|text| format!("?{text}"))
            .unwrap_or_default();
        let address = format!("{host}{path}{query_string}");
        let client = Client::new();
        let request = if method == "GET" { client.get(&address) } else { client.post(&address) };
        let request = request.header("X-Api-Key", self.api_key.as_str());
        #[cfg(feature = "dev-unsigned")]
        let request = if std::env::var("NOAH_DEV_UNSIGNED").is_ok() { request } else { request.header("Api-Signature", signature.as_str()) };
        #[cfg(not(feature = "dev-unsigned"))]
        let request = request.header("Api-Signature", signature.as_str());
        let request = request.header("Accept", "application/json").connect_timeout(Duration::from_secs(20));
        let response = match bytes {
            Some(bytes) => request.header("Content-Type", "application/json").body(&bytes).send(),
            None => request.send(),
        }
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

/// What a payout needs from the partner (a trait, so the tests can stand in for it).
trait NoahApi {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String>;
    fn get(&self, path: &str, query: &Value) -> Result<Value, String>;
}

impl NoahApi for Noah {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.send("POST", path, None, Some(body))
    }
    fn get(&self, path: &str, query: &Value) -> Result<Value, String> {
        self.send("GET", path, Some(query), None)
    }
}

fn url_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The payee's method if the partner already saved it for this customer (after a first payout).
/// The partner then wants that method named (`PaymentMethodID`): sending the form again is
/// refused on some rails (Pix: "selected payment method does not belong to declared self").
fn saved_method(noah: &dyn NoahApi, customer_id: &str, form: &Value) -> Option<String> {
    let listed = noah.get("/v1/payment-methods", &json!({ "CustomerID": customer_id })).ok()?;
    let identifier = &form["IdentifierDetails"];
    let account = form["BankDetails"]["AccountNumber"].as_str().map(|text| text.replace(' ', "").to_ascii_uppercase());
    listed["Items"].as_array()?.iter().find_map(|item| {
        let shown = &item["DisplayDetails"];
        let same = if identifier.is_object() {
            shown["IdentifierType"] == identifier["IdentifierType"] && shown["Identifier"] == identifier["Identifier"] && identifier["Identifier"].is_string()
        } else {
            account.is_some() && shown["AccountNumber"].as_str().map(|text| text.replace(' ', "").to_ascii_uppercase()) == account
        };
        if same && item["Capabilities"]["PayoutTo"].as_bool() != Some(false) { item["ID"].as_str().map(str::to_string) } else { None }
    })
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
    if beneficiary.vault != input.vault {
        return Err("the beneficiary is not the one the members voted".into());
    }
    if let Some(form) = &beneficiary.form {
        let channel = &beneficiary.channel_id;
        if channel.len() != 36 || !channel.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || !form.is_object() {
            return Err("sealed: not a payout form".into());
        }
        if commitment_v2(&input.vault, channel, form, &beneficiary.salt) != input.commitment.to_ascii_lowercase() {
            return Err("the beneficiary is not the one the members voted".into());
        }
        let mut form = form.clone();
        if form.get("Reference").is_some() {
            form["Reference"] = Value::String(sepa_reference(&input.reference));
        }
        let mut secrets = Vec::new();
        strings_of(&form, &mut secrets);
        secrets.retain(|text| *text != sepa_reference(&input.reference));
        return payout_to(input, channel, &form).map_err(|error| secrets.iter().fold(error, |error, text| error.replace(text, "<redacted>")));
    }
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
    let channel = std::env::var("NOAH_SEPA_CHANNEL_ID").map_err(|_| "no NOAH_SEPA_CHANNEL_ID in this run".to_string())?;
    let form = sepa_form(&iban, &beneficiary.name, &beneficiary.holder_type, &sepa_reference(&input.reference));
    payout_to(input, &channel, &form).map_err(|error| error.replace(&iban, "<iban>").replace(&beneficiary.name, "<holder>"))
}

/// SEPA references: A-Z a-z 0-9 + - / ? . : , ( ) ' and spaces, 2 to 140 characters.
fn sepa_reference(reference: &str) -> String {
    let reference: String = reference.chars().filter(|c| c.is_ascii_alphanumeric() || " +-/?.:,()'".contains(*c)).take(140).collect::<String>().trim().to_string();
    if reference.len() < 2 { "Euthyna".to_string() } else { reference }
}

fn sepa_form(iban: &str, holder_name: &str, holder_type: &str, reference: &str) -> Value {
    let holder = if holder_type == "Business" {
        json!({ "AccountHolderType": "Business", "Name": holder_name })
    } else {
        let mut parts = holder_name.trim().splitn(2, ' ');
        let first = parts.next().unwrap_or("").to_string();
        let last = parts.next().unwrap_or("-").to_string();
        json!({ "AccountHolderType": "Individual", "Name": { "FirstName": first, "LastName": last } })
    };
    json!({ "AccountHolderName": holder, "BankDetails": { "AccountNumber": iban }, "Reference": reference })
}

fn payout_to(input: &Input, channel: &str, form: &Value) -> Result<Value, String> {
    payout_with(&Noah::from_env()?, input, channel, form)
}

fn payout_with(noah: &dyn NoahApi, input: &Input, channel: &str, form: &Value) -> Result<Value, String> {
    // 1. The beneficiary and the amount become a form session. A payee the partner already
    // saved is named by its method; a bank payee keeps its form first (it carries this payout's
    // reference) and falls back to the method if the partner refuses the form.
    let prepare = |payee: (&str, Value)| {
        let mut body = json!({
            "ChannelID": channel,
            "CryptoCurrency": input.crypto,
            "CustomerID": input.customer_id,
            "CryptoAmount": input.crypto_amount,
            "DelayedSell": true,
        });
        body[payee.0] = payee.1;
        noah.post("/v1/transactions/sell/prepare", &body)
    };
    let saved = saved_method(noah, &input.customer_id, form);
    let prepared = match (&saved, form["IdentifierDetails"].is_object()) {
        (Some(method), true) => prepare(("PaymentMethodID", Value::String(method.clone())))?,
        (Some(method), false) => prepare(("Form", form.clone())).or_else(|_| prepare(("PaymentMethodID", Value::String(method.clone()))))?,
        (None, _) => prepare(("Form", form.clone()))?,
    };
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

    /// v2 (any rail): a Pix payee sealed by packages/sdk, opened and committed the same way here.
    #[test]
    fn opens_a_v2_payee_the_console_seals() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let vector: Value = serde_json::from_str(include_str!("../../packages/sdk/src/fixtures/bank-sealed-v2.json")).unwrap();
        let vault = vector["vault"].as_str().unwrap();
        let plain = open(vector["sealed"].as_str().unwrap(), &box_key().unwrap(), vault).unwrap();
        let beneficiary: Beneficiary = serde_json::from_slice(&plain).unwrap();
        let form = beneficiary.form.expect("a v2 form");
        assert_eq!(form.to_string(), vector["form"].as_str().unwrap(), "same canonical JSON on both sides");
        assert_eq!(commitment_v2(vault, &beneficiary.channel_id, &form, &beneficiary.salt), vector["commitment"].as_str().unwrap());
        let mut found = Vec::new();
        strings_of(&form, &mut found);
        assert!(found.contains(&"ana@example.com".to_string()), "redacted from errors");
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

    /// Behaves like the partner's sandbox: a payee is saved on its first payout; after that,
    /// sending its form again is refused for an identifier rail (Pix), and accepted for a bank.
    struct FakeNoah {
        saved: std::cell::RefCell<Vec<(String, Value)>>,
        prepares: std::cell::RefCell<Vec<Value>>,
        refuse_bank_forms: bool,
    }

    impl FakeNoah {
        fn new() -> Self {
            Self { saved: Default::default(), prepares: Default::default(), refuse_bank_forms: false }
        }
    }

    impl NoahApi for FakeNoah {
        fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
            if path.starts_with("/v1/workflows") {
                return Ok(json!({ "RuleID": "rule-1", "Conditions": [{ "DestinationAddress": { "Address": "0xdeposit" } }] }));
            }
            self.prepares.borrow_mut().push(body.clone());
            if let Some(method) = body["PaymentMethodID"].as_str() {
                return if self.saved.borrow().iter().any(|(id, _)| id == method) { Ok(json!({ "FormSessionID": "fs", "FiatAmount": "46.92" })) } else { Err("noah 400: unknown method".into()) };
            }
            let form = &body["Form"];
            let display = if form["IdentifierDetails"].is_object() {
                json!({ "IdentifierType": form["IdentifierDetails"]["IdentifierType"], "Identifier": form["IdentifierDetails"]["Identifier"] })
            } else {
                json!({ "AccountNumber": form["BankDetails"]["AccountNumber"] })
            };
            let known = self.saved.borrow().iter().any(|(_, shown)| *shown == display);
            if known && (form["IdentifierDetails"].is_object() || self.refuse_bank_forms) {
                return Err("noah 500 on /v1/transactions/sell/prepare: unexpected error while processing your request".into());
            }
            if !known {
                let id = format!("Method/{}", self.saved.borrow().len() + 1);
                self.saved.borrow_mut().push((id, display));
            }
            Ok(json!({ "FormSessionID": "fs", "FiatAmount": "46.92" }))
        }

        fn get(&self, path: &str, query: &Value) -> Result<Value, String> {
            assert_eq!(path, "/v1/payment-methods");
            assert_eq!(query["CustomerID"], "eut-1");
            let items: Vec<Value> = self.saved.borrow().iter().map(|(id, shown)| json!({ "ID": id, "DisplayDetails": shown, "Capabilities": { "PayoutTo": true } })).collect();
            Ok(json!({ "Items": items }))
        }
    }

    fn payout_input() -> Input {
        serde_json::from_value(json!({ "op": "payout", "vault": "acme.euthyna-nomos.testnet", "customer_id": "eut-1", "reference": "SO4-2", "crypto_amount": "5", "crypto": "EURC_TEST" })).unwrap()
    }

    #[test]
    fn pays_the_same_pix_payee_twice() {
        let noah = FakeNoah::new();
        let form = json!({ "BeneficiaryName": { "FirstName": "Ana", "LastName": "Souza" }, "IdentifierDetails": { "IdentifierType": "Email", "Identifier": "ana@example.com" } });
        // First payout: the form; the partner saves the payee.
        assert_eq!(payout_with(&noah, &payout_input(), "pix", &form).unwrap()["ok"], true);
        // Second: the saved method, not the form (which the partner would refuse).
        assert_eq!(payout_with(&noah, &payout_input(), "pix", &form).unwrap()["ok"], true);
        let prepares = noah.prepares.borrow();
        assert!(prepares[0]["Form"].is_object() && prepares[0].get("PaymentMethodID").is_none());
        assert_eq!(prepares[1]["PaymentMethodID"], "Method/1");
        assert!(prepares[1].get("Form").is_none());
        // Another payee is not mistaken for this one.
        let other = json!({ "BeneficiaryName": { "FirstName": "Lia" }, "IdentifierDetails": { "IdentifierType": "Email", "Identifier": "lia@example.com" } });
        drop(prepares);
        payout_with(&noah, &payout_input(), "pix", &other).unwrap();
        assert!(noah.prepares.borrow()[2]["Form"].is_object());
    }

    #[test]
    fn a_bank_payee_keeps_its_form_and_falls_back_to_the_saved_method() {
        let form = json!({ "AccountHolderName": { "AccountHolderType": "Business", "Name": "Atelier Dupont SAS" }, "BankDetails": { "AccountNumber": "FR7630006000011234567890189" }, "Reference": "SO4-2" });
        let noah = FakeNoah::new();
        payout_with(&noah, &payout_input(), "sepa", &form).unwrap();
        payout_with(&noah, &payout_input(), "sepa", &form).unwrap();
        // The form (with this payout's reference) both times while the partner takes it.
        assert!(noah.prepares.borrow().iter().all(|body| body["Form"]["Reference"] == "SO4-2"));
        // If the partner starts refusing the form of a saved bank payee: the saved method.
        let strict = FakeNoah { refuse_bank_forms: true, ..FakeNoah::new() };
        payout_with(&strict, &payout_input(), "sepa", &form).unwrap();
        assert_eq!(payout_with(&strict, &payout_input(), "sepa", &form).unwrap()["ok"], true);
        assert_eq!(strict.prepares.borrow().last().unwrap()["PaymentMethodID"], "Method/1");
    }

    #[test]
    fn a_get_signs_its_query() {
        std::env::set_var("PROTECTED_NOAH_SEED", "11".repeat(32));
        let token = jwt_with_query(&signing_key().unwrap(), "GET", "/v1/payment-methods", Some(&json!({ "CustomerID": "eut-1" })), None);
        let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["queryParams"]["CustomerID"], "eut-1");
        assert!(claims.get("bodyHash").is_none());
        assert_eq!(url_encode("a b@c"), "a%20b%40c");
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
