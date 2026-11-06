//! Sealed orders: limit orders a company's treasury places without showing them.
//!
//! A DAO seals an order by storing one hash, the commitment of the circuit in
//! `circuits/sealed-order`: the pair, the fee tier, and three hidden terms (the worst rate it
//! accepts, the most it will sell in total, and a deadline), with a salt and this vault's tag. Nothing
//! else about the order is on chain, before or after it fills.
//!
//! Whoever knows the order (a member, or the watcher the company runs) fills it with a proof that the
//! rate the swap demands is at least the hidden limit, that what was filled plus this fill stays under
//! the hidden cap, and that the order has not expired. This contract verifies the proof on chain
//! (UltraHonk on NEAR's BN254 host functions), then asks the company's vault for the swap, as a member
//! of the role the DAO gave it. The vault checks that role like any other: the router, the pair, the
//! recipient (the company wallet) and the budget. The proof adds the hidden terms on top of the role;
//! it never replaces it.
//!
//! The swap's minimum output comes from the rate in the proof, so a fill that claims a better rate
//! than the market reverts on Base: a false rate makes a fill fail, never trade worse. A fill whose
//! swap reverts still counts against the hidden cap; a failure only ever trades less.
//!
//! The account is deployed without access keys and has no owner.

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, near, require,
};
use num_bigint::BigUint;
use serde_json::{Value, json};
use ultrahonk_no_std::{ProofType, verify};

mod hooks;

/// The verification key of `circuits/sealed-order` (zero-knowledge, Keccak transcript).
/// Written by `circuits/sealed-order/build.mjs`; a new circuit means a new contract.
const VK: &[u8] = include_bytes!("vk.bin");

/// commitment, vault tag, chain, token in, token out, fee, amount in, filled before, rate, now.
const PUBLIC_INPUTS: usize = 10;
const MAX_PROOF_BYTES: usize = 16_384;
/// The rate is the output per unit of input, scaled by 1e18.
const RATE_SCALE: u128 = 1_000_000_000_000_000_000;
const MAX_SLIPPAGE_BPS: u16 = 500;
/// A proof states the time it was made; it must be this recent (and not in the future).
const MAX_PROOF_AGE_S: u64 = 600;
const MAX_FUTURE_S: u64 = 60;
const MAX_ORDERS_PER_DAO: u64 = 1_000;
/// Storage for a config or an order, paid by the DAO (unused deposit stays as storage buffer).
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Uniswap SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`.
const EXACT_INPUT_SINGLE: [u8; 4] = [0x04, 0xe4, 0x5a, 0xaf];

const VIEW_GAS: Gas = Gas::from_tgas(10);
const CONFIGURE_CALLBACK_GAS: Gas = Gas::from_tgas(15);
const PREPARE_GAS: Gas = Gas::from_tgas(50);
const AUTHORIZE_GAS: Gas = Gas::from_tgas(90);
const ON_AUTHORIZED_GAS: Gas = Gas::from_tgas(10);
const ON_PREPARED_GAS: Gas = Gas::from_tgas(115);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Configs,
    Orders,
}

/// What a DAO set for its sealed orders. The vault, its wallet and the role are checked when set.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub vault: AccountId,
    /// The vault role this contract is a member of: router, pair, recipient and budget.
    pub role: String,
    pub chain_id: u64,
    /// The swap router (0x…).
    pub router: String,
    /// The company wallet on `chain_id`, the swap's recipient (0x…).
    pub wallet: String,
    /// How far below the proven rate the swap may fill.
    pub slippage_bps: u16,
    /// sha256 of the vault account, as a field: a commitment opens for one vault only.
    pub vault_tag: String,
    pub next_id: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub id: u64,
    /// The circuit's Poseidon2 commitment (0x…, a BN254 field).
    pub commitment: String,
    /// Sum of the amounts asked for so far, public: each proof binds to it.
    pub filled: U128,
    pub fills: u32,
    pub cancelled: bool,
    pub sealed_at_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SealedOrders {
    configs: LookupMap<AccountId, Config>,
    orders: LookupMap<(AccountId, u64), Order>,
}

#[near]
impl SealedOrders {
    #[init]
    pub fn new() -> Self {
        Self {
            configs: LookupMap::new(Key::Configs),
            orders: LookupMap::new(Key::Orders),
        }
    }

    /// Called by a DAO: its vault, the role it gave this contract, the chain, the router and the
    /// slippage. The vault must say the caller is its owner; its wallet on the chain is read then.
    #[payable]
    pub fn configure(
        &mut self,
        vault: AccountId,
        role: String,
        chain_id: u64,
        router: String,
        slippage_bps: u16,
    ) -> Promise {
        require!(
            env::attached_deposit() >= STORAGE_DEPOSIT,
            "ERR_STORAGE_DEPOSIT"
        );
        require!(slippage_bps <= MAX_SLIPPAGE_BPS, "ERR_SLIPPAGE");
        require!(!role.is_empty() && role.len() <= 64, "ERR_ROLE");
        parse_address(&router);
        let dao = env::predecessor_account_id();
        Promise::new(vault.clone())
            .function_call(
                "owner_id".to_string(),
                vec![],
                NearToken::from_yoctonear(0),
                VIEW_GAS,
            )
            .and(Promise::new(vault.clone()).function_call(
                "get_wallet".to_string(),
                json!({ "chain_id": chain_id }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                VIEW_GAS,
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CONFIGURE_CALLBACK_GAS)
                    .on_configure(dao, vault, role, chain_id, router, slippage_bps),
            )
    }

    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_configure(
        &mut self,
        dao: AccountId,
        vault: AccountId,
        role: String,
        chain_id: u64,
        router: String,
        slippage_bps: u16,
        #[callback_result] owner: Result<AccountId, PromiseError>,
        #[callback_result] wallet: Result<Option<Value>, PromiseError>,
    ) -> bool {
        let wallet = wallet
            .ok()
            .flatten()
            .and_then(|wallet| address_of_json(&wallet["address"]));
        let accepted = owner.as_ref().is_ok_and(|owner| owner == &dao) && wallet.is_some();
        if !accepted {
            // Not the vault's owner, or no wallet on that chain: give the deposit back.
            Promise::new(dao).transfer(STORAGE_DEPOSIT).detach();
            env::log_str("ERR_NOT_VAULT_OWNER_OR_NO_WALLET");
            return false;
        }
        let next_id = self.configs.get(&dao).map_or(0, |config| config.next_id);
        let config = Config {
            vault_tag: hex0x(&vault_tag(&vault)),
            vault,
            role,
            chain_id,
            router: router.to_ascii_lowercase(),
            wallet: hex0x(&wallet.unwrap()),
            slippage_bps,
            next_id,
        };
        event("configured", &json!(config));
        self.configs.insert(dao, config);
        true
    }

    /// Called by a DAO (a proposal): stores a commitment. Returns the order's id.
    #[payable]
    pub fn seal(&mut self, commitment: String) -> u64 {
        require!(
            env::attached_deposit() >= STORAGE_DEPOSIT,
            "ERR_STORAGE_DEPOSIT"
        );
        let field = parse_field(&commitment);
        let dao = env::predecessor_account_id();
        let config = self.configs.get_mut(&dao).expect("ERR_NOT_CONFIGURED");
        require!(config.next_id < MAX_ORDERS_PER_DAO, "ERR_TOO_MANY_ORDERS");
        let id = config.next_id;
        config.next_id += 1;
        let order = Order {
            id,
            commitment: hex0x(&field),
            filled: U128(0),
            fills: 0,
            cancelled: false,
            sealed_at_ns: U64(env::block_timestamp()),
        };
        event("sealed", &json!({ "dao": dao, "order": order }));
        self.orders.insert((dao, id), order);
        id
    }

    /// Called by a DAO: no fill after this one.
    pub fn cancel(&mut self, id: u64) {
        let dao = env::predecessor_account_id();
        let order = self
            .orders
            .get_mut(&(dao.clone(), id))
            .expect("ERR_ORDER_NOT_FOUND");
        order.cancelled = true;
        event("cancelled", &json!({ "dao": dao, "id": id }));
    }

    /// Anyone with a proof: verifies it, then asks the vault for the swap.
    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &mut self,
        dao: AccountId,
        id: u64,
        token_in: String,
        token_out: String,
        fee: u32,
        amount_in: U128,
        rate: U128,
        now_s: U64,
        proof: Base64VecU8,
        gas_limit: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        require!(proof.0.len() <= MAX_PROOF_BYTES, "ERR_PROOF_SIZE");
        require!(amount_in.0 > 0, "ERR_AMOUNT");
        require!(rate.0 > 0, "ERR_RATE");
        require!(fee < (1 << 24), "ERR_FEE");
        let block_s = env::block_timestamp() / 1_000_000_000;
        require!(
            now_s.0 <= block_s + MAX_FUTURE_S && now_s.0 + MAX_PROOF_AGE_S >= block_s,
            "ERR_PROOF_TIME"
        );
        let config = self.configs.get(&dao).cloned().expect("ERR_NOT_CONFIGURED");
        let order = self
            .orders
            .get(&(dao.clone(), id))
            .cloned()
            .expect("ERR_ORDER_NOT_FOUND");
        require!(!order.cancelled, "ERR_ORDER_CANCELLED");
        let token_in_bytes = parse_address(&token_in);
        let token_out_bytes = parse_address(&token_out);

        let pubs: Vec<[u8; 32]> = vec![
            parse_field(&order.commitment),
            parse_field(&config.vault_tag),
            word(config.chain_id as u128),
            address_word(&token_in_bytes),
            address_word(&token_out_bytes),
            word(fee as u128),
            word(amount_in.0),
            word(order.filled.0),
            word(rate.0),
            word(now_s.0 as u128),
        ];
        debug_assert_eq!(pubs.len(), PUBLIC_INPUTS);
        if verify::<hooks::NearHooks>(VK, &ProofType::ZK(proof.0.into_boxed_slice()), &pubs)
            .is_err()
        {
            env::panic_str("ERR_PROOF_INVALID");
        }

        let filled_before = order.filled.0;
        let stored = self
            .orders
            .get_mut(&(dao.clone(), id))
            .expect("ERR_ORDER_NOT_FOUND");
        stored.filled = U128(
            filled_before
                .checked_add(amount_in.0)
                .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW")),
        );
        stored.fills += 1;
        let reference = format!("sealed-{}-{}", id, stored.fills);

        let min_out = min_out(amount_in.0, rate.0, config.slippage_bps);
        let calldata = exact_input_single(
            &token_in_bytes,
            &token_out_bytes,
            fee,
            &parse_address(&config.wallet),
            amount_in.0,
            min_out,
        );
        event(
            "fill_requested",
            &json!({ "dao": dao, "id": id, "amount_in": amount_in, "rate": rate, "min_out": U128(min_out), "reference": reference }),
        );
        let request = json!({
            "role": config.role,
            "request": {
                "chain_id": config.chain_id,
                "target": parse_address(&config.router),
                "value": "0",
                "calldata": calldata,
                "allowance_amount": amount_in,
                "reference": reference,
                "gas_limit": gas_limit,
                "max_fee_per_gas": max_fee_per_gas,
                "max_priority_fee_per_gas": max_priority_fee_per_gas,
            }
        });
        Promise::new(config.vault)
            .function_call(
                "prepare".to_string(),
                request.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                PREPARE_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PREPARED_GAS)
                    .on_prepared(dao, id, amount_in),
            )
    }

    #[private]
    pub fn on_prepared(
        &mut self,
        dao: AccountId,
        id: u64,
        amount_in: U128,
        #[callback_result] operation: Result<Value, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(operation) = operation else {
            self.undo(&dao, id, amount_in.0, "vault refused the swap");
            return PromiseOrValue::Value(false);
        };
        let config = self.configs.get(&dao).cloned().expect("ERR_NOT_CONFIGURED");
        let op_id = operation["op_id"].clone();
        PromiseOrValue::Promise(
            Promise::new(config.vault)
                .function_call(
                    "authorize".to_string(),
                    json!({ "op_id": op_id, "approval": null })
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    AUTHORIZE_GAS,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(ON_AUTHORIZED_GAS)
                        .on_authorized(dao, id, amount_in, op_id),
                ),
        )
    }

    #[private]
    pub fn on_authorized(
        &mut self,
        dao: AccountId,
        id: u64,
        amount_in: U128,
        op_id: Value,
    ) -> bool {
        // authorize answers nothing, or the MPC callback's value: only success matters.
        if env::promise_result_checked(0, 16_384).is_err() {
            self.undo(&dao, id, amount_in.0, "vault did not sign the swap");
            return false;
        }
        event(
            "filled",
            &json!({ "dao": dao, "id": id, "amount_in": amount_in, "op_id": op_id }),
        );
        true
    }

    pub fn config(&self, dao: AccountId) -> Option<Config> {
        self.configs.get(&dao).cloned()
    }

    pub fn order(&self, dao: AccountId, id: u64) -> Option<Order> {
        self.orders.get(&(dao, id)).cloned()
    }

    /// The DAO's orders, newest first (at most `limit`, 50 by default).
    pub fn orders(&self, dao: AccountId, limit: Option<u64>) -> Vec<Order> {
        let next = self.configs.get(&dao).map_or(0, |config| config.next_id);
        let limit = limit.unwrap_or(50).min(100);
        (0..next)
            .rev()
            .take(limit as usize)
            .filter_map(|id| self.orders.get(&(dao.clone(), id)).cloned())
            .collect()
    }

    pub fn verification_key(&self) -> String {
        hex::encode(VK)
    }

    /// The tag a commitment for this vault must hold (0x…).
    pub fn vault_tag_of(&self, vault: AccountId) -> String {
        hex0x(&vault_tag(&vault))
    }

    /// The swap's minimum output for an amount and a rate (what `fill` puts in the calldata).
    pub fn min_out_of(&self, amount_in: U128, rate: U128, slippage_bps: u16) -> U128 {
        U128(min_out(amount_in.0, rate.0, slippage_bps))
    }
}

impl SealedOrders {
    /// The vault refused or did not sign: the amount goes back to the order.
    fn undo(&mut self, dao: &AccountId, id: u64, amount_in: u128, why: &str) {
        if let Some(order) = self.orders.get_mut(&(dao.clone(), id)) {
            order.filled = U128(order.filled.0.saturating_sub(amount_in));
        }
        event(
            "fill_failed",
            &json!({ "dao": dao, "id": id, "reason": why }),
        );
    }
}

/// sha256 of the account id with its first byte cleared, so it is below the BN254 modulus.
fn vault_tag(vault: &AccountId) -> [u8; 32] {
    let mut tag = env::sha256_array(vault.as_bytes());
    tag[0] = 0;
    tag
}

fn min_out(amount_in: u128, rate: u128, slippage_bps: u16) -> u128 {
    let value = BigUint::from(amount_in) * BigUint::from(rate) / BigUint::from(RATE_SCALE)
        * BigUint::from(10_000u32 - slippage_bps as u32)
        / BigUint::from(10_000u32);
    u128::try_from(value).unwrap_or_else(|_| env::panic_str("ERR_MIN_OUT"))
}

fn exact_input_single(
    token_in: &[u8; 20],
    token_out: &[u8; 20],
    fee: u32,
    recipient: &[u8; 20],
    amount_in: u128,
    min_out: u128,
) -> Vec<u8> {
    let mut data = EXACT_INPUT_SINGLE.to_vec();
    data.extend_from_slice(&address_word(token_in));
    data.extend_from_slice(&address_word(token_out));
    data.extend_from_slice(&word(fee as u128));
    data.extend_from_slice(&address_word(recipient));
    data.extend_from_slice(&word(amount_in));
    data.extend_from_slice(&word(min_out));
    data.extend_from_slice(&[0u8; 32]);
    data
}

fn word(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn address_word(address: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

fn parse_hex(text: &str) -> Vec<u8> {
    hex::decode(text.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("ERR_HEX"))
}

fn parse_address(text: &str) -> [u8; 20] {
    parse_hex(text)
        .try_into()
        .unwrap_or_else(|_| env::panic_str("ERR_ADDRESS"))
}

/// A 32-byte big-endian BN254 field element.
fn parse_field(text: &str) -> [u8; 32] {
    let bytes: [u8; 32] = parse_hex(text)
        .try_into()
        .unwrap_or_else(|_| env::panic_str("ERR_FIELD"));
    // The modulus starts with 0x30644e72…; anything below 0x30 in the first byte is a field.
    require!(bytes[0] < 0x30, "ERR_FIELD");
    bytes
}

fn address_of_json(value: &Value) -> Option<[u8; 20]> {
    let bytes: Vec<u8> = value
        .as_array()?
        .iter()
        .map(|byte| byte.as_u64().and_then(|b| u8::try_from(b).ok()))
        .collect::<Option<_>>()?;
    bytes.try_into().ok()
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn event(name: &str, data: &Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "euthyna-sealed-orders", "version": "1.0.0", "event": name, "data": [data] })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calldata_is_exact_input_single() {
        let data = exact_input_single(&[0xaa; 20], &[0xbb; 20], 3000, &[0xcc; 20], 5, 7);
        assert_eq!(data.len(), 4 + 7 * 32);
        assert_eq!(&data[..4], &EXACT_INPUT_SINGLE);
        assert_eq!(&data[4 + 12..4 + 32], &[0xaa; 20]);
        assert_eq!(data[4 + 3 * 32 - 2..4 + 3 * 32], [0x0b, 0xb8]);
        assert_eq!(data[4 + 6 * 32 - 1], 7);
    }

    #[test]
    fn min_out_applies_rate_and_slippage() {
        // 1000 USDC (6 decimals) for WETH at 2500 USD: one USDC unit buys 4e8 wei, scaled by 1e18.
        let amount = 1_000_000_000u128;
        let rate = 400_000_000u128 * RATE_SCALE;
        assert_eq!(min_out(amount, rate, 0), 400_000_000_000_000_000);
        assert_eq!(min_out(amount, rate, 50), 398_000_000_000_000_000);
    }
}
