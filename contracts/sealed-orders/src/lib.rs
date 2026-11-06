//! Sealed orders: limit orders a company's treasury places without showing them.
//!
//! An order is one hash, the commitment of the circuit in `circuits/sealed-order`: the pair, the
//! fee tier, and three hidden terms (the worst rate it accepts, the most it sells in total, and a
//! deadline), with a salt and the vault's tag. Nothing else about it is on chain, before or after a
//! fill.
//!
//! Who places one: the vault's owner (its DAO, by a vote) or a member of the vault role named in the
//! order (an agent with a swap role). This contract must itself be a member of that role: the role
//! is where the members decided the router, the pair, the recipient and the budget, and every fill
//! goes through it. The proof adds the hidden terms on top of the role; it never replaces it.
//!
//! A fill proves (Noir, UltraHonk, verified here on NEAR's BN254 host functions) that the rate the
//! swap demands is at least the hidden limit, that the running total stays under the hidden cap and
//! that the deadline holds. The swap's minimum output comes from that rate, so a fill claiming a
//! better rate than the market reverts on Base: a false rate makes a fill fail, never trade worse. A
//! fill whose swap reverts still counts against the hidden cap; a failure only ever trades less.
//!
//! The terms can travel with the order, encrypted for the company's members (`terms`): each member
//! registers an X25519 key derived from a signature of their own wallet, and whoever seals encrypts
//! the terms to those keys. This contract stores the ciphertext and never reads it.
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
const MAX_ORDERS_PER_VAULT: u64 = 1_000;
const MAX_TERMS_BYTES: usize = 8_192;
const MAX_READERS: usize = 20;
/// Storage for an order or a reader key, paid by whoever adds it (refunded when refused).
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// Uniswap SwapRouter02 `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`.
const EXACT_INPUT_SINGLE: [u8; 4] = [0x04, 0xe4, 0x5a, 0xaf];
/// ERC-20 `approve(address,uint256)`.
const APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];

const VIEW_GAS: Gas = Gas::from_tgas(5);
const PREPARE_GAS: Gas = Gas::from_tgas(50);
const AUTHORIZE_GAS: Gas = Gas::from_tgas(90);
const ON_AUTHORIZED_GAS: Gas = Gas::from_tgas(10);
const ON_PREPARED_GAS: Gas = Gas::from_tgas(115);
const ON_SEAL_GAS: Gas = Gas::from_tgas(20);
/// The approval's check callback then prepares, authorizes and records it.
const ON_APPROVE_CHECKED_GAS: Gas = Gas::from_tgas(190);
const ON_READER_GAS: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Orders,
    NextIds,
    Readers,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub id: u64,
    pub vault: AccountId,
    /// The vault role this contract fills through: router, pair, recipient and budget.
    pub role: String,
    pub chain_id: u64,
    /// The company wallet on `chain_id`, the swap's recipient (0x…), read when sealed.
    pub wallet: String,
    /// Who sealed it: the vault's owner (a vote) or a member of `role`.
    pub sealer: AccountId,
    /// The circuit's Poseidon2 commitment (0x…, a BN254 field).
    pub commitment: String,
    /// How far below the proven rate a fill may execute.
    pub slippage_bps: u16,
    /// Sum of the amounts asked for so far, public: each proof binds to it.
    pub filled: U128,
    pub fills: u32,
    pub cancelled: bool,
    pub sealed_at_ns: U64,
    /// The terms, encrypted for the members' registered keys (opaque here).
    pub terms: Option<String>,
}

/// A member's X25519 key for reading sealed terms (base64), registered by the member.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reader {
    pub account: AccountId,
    pub public_key: String,
}

/// Who may act for a vault, read with one view each: its owner and a role membership.
struct Authority {
    owner: Option<AccountId>,
    member_active: bool,
}

fn authority(
    owner: Result<AccountId, PromiseError>,
    membership: Result<Option<Value>, PromiseError>,
) -> Authority {
    Authority {
        owner: owner.ok(),
        member_active: membership
            .ok()
            .flatten()
            .is_some_and(|membership| membership["active"].as_bool() == Some(true)),
    }
}

impl Authority {
    fn allows(&self, caller: &AccountId) -> bool {
        self.owner.as_ref() == Some(caller) || self.member_active
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SealedOrders {
    orders: LookupMap<(AccountId, u64), Order>,
    next_ids: LookupMap<AccountId, u64>,
    readers: LookupMap<AccountId, Vec<Reader>>,
}

fn view(account: &AccountId, method: &str, args: Value) -> Promise {
    Promise::new(account.clone()).function_call(
        method.to_string(),
        args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        VIEW_GAS,
    )
}

#[near]
impl SealedOrders {
    #[init]
    pub fn new() -> Self {
        Self {
            orders: LookupMap::new(Key::Orders),
            next_ids: LookupMap::new(Key::NextIds),
            readers: LookupMap::new(Key::Readers),
        }
    }

    // ---------------------------------------------------------------- sealing

    /// Seals an order for `vault`. The caller must be the vault's owner or an active member of
    /// `role`, and this contract must be a member of `role` too; the wallet on `chain_id` is read
    /// now. Returns the order (or null, with the deposit back, when refused).
    #[payable]
    pub fn seal(
        &mut self,
        vault: AccountId,
        role: String,
        chain_id: u64,
        commitment: String,
        slippage_bps: u16,
        terms: Option<String>,
    ) -> Promise {
        require!(
            env::attached_deposit() >= STORAGE_DEPOSIT,
            "ERR_STORAGE_DEPOSIT"
        );
        require!(slippage_bps <= MAX_SLIPPAGE_BPS, "ERR_SLIPPAGE");
        require!(!role.is_empty() && role.len() <= 64, "ERR_ROLE");
        require!(
            terms
                .as_ref()
                .is_none_or(|terms| terms.len() <= MAX_TERMS_BYTES),
            "ERR_TERMS_SIZE"
        );
        parse_field(&commitment);
        let caller = env::predecessor_account_id();
        view(&vault, "owner_id", json!({}))
            .and(view(
                &vault,
                "get_membership",
                json!({ "role": role, "member": caller }),
            ))
            .and(view(
                &vault,
                "get_membership",
                json!({ "role": role, "member": env::current_account_id() }),
            ))
            .and(view(&vault, "get_wallet", json!({ "chain_id": chain_id })))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_SEAL_GAS)
                    .on_seal(
                        caller,
                        vault,
                        role,
                        chain_id,
                        commitment,
                        slippage_bps,
                        terms,
                    ),
            )
    }

    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_seal(
        &mut self,
        caller: AccountId,
        vault: AccountId,
        role: String,
        chain_id: u64,
        commitment: String,
        slippage_bps: u16,
        terms: Option<String>,
        #[callback_result] owner: Result<AccountId, PromiseError>,
        #[callback_result] caller_membership: Result<Option<Value>, PromiseError>,
        #[callback_result] own_membership: Result<Option<Value>, PromiseError>,
        #[callback_result] wallet: Result<Option<Value>, PromiseError>,
    ) -> Option<Order> {
        let allowed = authority(owner, caller_membership).allows(&caller);
        let filler = authority(Err(PromiseError::Failed), own_membership).member_active;
        let wallet = wallet
            .ok()
            .flatten()
            .and_then(|wallet| address_of_json(&wallet["address"]));
        let refusal = if !allowed {
            Some("ERR_NOT_OWNER_OR_MEMBER")
        } else if !filler {
            Some("ERR_CONTRACT_NOT_IN_ROLE")
        } else if wallet.is_none() {
            Some("ERR_NO_WALLET")
        } else {
            None
        };
        if let Some(reason) = refusal {
            Promise::new(caller).transfer(STORAGE_DEPOSIT).detach();
            env::log_str(reason);
            return None;
        }
        let id = self.next_ids.get(&vault).copied().unwrap_or(0);
        if id >= MAX_ORDERS_PER_VAULT {
            Promise::new(caller).transfer(STORAGE_DEPOSIT).detach();
            env::log_str("ERR_TOO_MANY_ORDERS");
            return None;
        }
        self.next_ids.insert(vault.clone(), id + 1);
        let order = Order {
            id,
            vault: vault.clone(),
            role,
            chain_id,
            wallet: hex0x(&wallet.unwrap()),
            sealer: caller,
            commitment: hex0x(&parse_field(&commitment)),
            slippage_bps,
            filled: U128(0),
            fills: 0,
            cancelled: false,
            sealed_at_ns: U64(env::block_timestamp()),
            terms,
        };
        event(
            "sealed",
            &json!({ "vault": vault, "id": id, "sealer": order.sealer, "commitment": order.commitment }),
        );
        self.orders.insert((vault, id), order.clone());
        Some(order)
    }

    /// The sealer cancels at once; the vault's owner too (checked on chain).
    pub fn cancel(&mut self, vault: AccountId, id: u64) -> PromiseOrValue<bool> {
        let caller = env::predecessor_account_id();
        let order = self
            .orders
            .get(&(vault.clone(), id))
            .expect("ERR_ORDER_NOT_FOUND");
        if order.sealer == caller {
            self.mark_cancelled(&vault, id);
            return PromiseOrValue::Value(true);
        }
        PromiseOrValue::Promise(
            view(&vault, "owner_id", json!({})).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_cancel(caller, vault, id),
            ),
        )
    }

    #[private]
    pub fn on_cancel(
        &mut self,
        caller: AccountId,
        vault: AccountId,
        id: u64,
        #[callback_result] owner: Result<AccountId, PromiseError>,
    ) -> bool {
        if owner.ok().as_ref() != Some(&caller) {
            env::log_str("ERR_NOT_SEALER_OR_OWNER");
            return false;
        }
        self.mark_cancelled(&vault, id);
        true
    }

    // --------------------------------------------------------------- approval

    /// Lets the router take `token` from the company wallet, through the vault and within `role`
    /// (the role caps the amount). For the vault's owner or a member of the role.
    #[allow(clippy::too_many_arguments)]
    pub fn approve(
        &mut self,
        vault: AccountId,
        role: String,
        chain_id: u64,
        token: String,
        router: String,
        amount: U128,
        gas_limit: U128,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
    ) -> Promise {
        parse_address(&token);
        parse_address(&router);
        let caller = env::predecessor_account_id();
        view(&vault, "owner_id", json!({}))
            .and(view(
                &vault,
                "get_membership",
                json!({ "role": role, "member": caller }),
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_APPROVE_CHECKED_GAS)
                    .on_approve_checked(
                        caller,
                        vault,
                        role,
                        chain_id,
                        token,
                        router,
                        amount,
                        [gas_limit, max_fee_per_gas, max_priority_fee_per_gas],
                    ),
            )
    }

    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_approve_checked(
        &mut self,
        caller: AccountId,
        vault: AccountId,
        role: String,
        chain_id: u64,
        token: String,
        router: String,
        amount: U128,
        gas: [U128; 3],
        #[callback_result] owner: Result<AccountId, PromiseError>,
        #[callback_result] membership: Result<Option<Value>, PromiseError>,
    ) -> PromiseOrValue<bool> {
        if !authority(owner, membership).allows(&caller) {
            env::log_str("ERR_NOT_OWNER_OR_MEMBER");
            return PromiseOrValue::Value(false);
        }
        let mut calldata = APPROVE.to_vec();
        calldata.extend_from_slice(&address_word(&parse_address(&router)));
        calldata.extend_from_slice(&word(amount.0));
        let reference = format!("sealed-approve-{}", env::block_height());
        event(
            "approve_requested",
            &json!({ "vault": vault, "token": token, "router": router, "amount": amount }),
        );
        PromiseOrValue::Promise(
            self.prepare_and_sign(
                &vault,
                &role,
                chain_id,
                parse_address(&token),
                calldata,
                U128(0),
                reference,
                gas,
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_PREPARED_GAS)
                    .on_prepared(vault.clone(), None, U128(0)),
            ),
        )
    }

    // ------------------------------------------------------------------ fills

    /// Anyone with a proof: verifies it, then asks the vault for the swap.
    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &mut self,
        vault: AccountId,
        id: u64,
        router: String,
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
        let order = self
            .orders
            .get(&(vault.clone(), id))
            .cloned()
            .expect("ERR_ORDER_NOT_FOUND");
        require!(!order.cancelled, "ERR_ORDER_CANCELLED");
        let token_in_bytes = parse_address(&token_in);
        let token_out_bytes = parse_address(&token_out);

        let pubs: Vec<[u8; 32]> = vec![
            parse_field(&order.commitment),
            vault_tag(&vault),
            word(order.chain_id as u128),
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

        let stored = self
            .orders
            .get_mut(&(vault.clone(), id))
            .expect("ERR_ORDER_NOT_FOUND");
        stored.filled = U128(
            order
                .filled
                .0
                .checked_add(amount_in.0)
                .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW")),
        );
        stored.fills += 1;
        let reference = format!("sealed-{}-{}", id, stored.fills);

        let min_out = min_out(amount_in.0, rate.0, order.slippage_bps);
        let calldata = exact_input_single(
            &token_in_bytes,
            &token_out_bytes,
            fee,
            &parse_address(&order.wallet),
            amount_in.0,
            min_out,
        );
        event(
            "fill_requested",
            &json!({ "vault": vault, "id": id, "amount_in": amount_in, "rate": rate, "min_out": U128(min_out), "reference": reference }),
        );
        self.prepare_and_sign(
            &vault,
            &order.role,
            order.chain_id,
            parse_address(&router),
            calldata,
            amount_in,
            reference,
            [gas_limit, max_fee_per_gas, max_priority_fee_per_gas],
            Self::ext(env::current_account_id())
                .with_static_gas(ON_PREPARED_GAS)
                .on_prepared(vault.clone(), Some(id), amount_in),
        )
    }

    /// `id` is the order of a fill, none for an approval.
    #[private]
    pub fn on_prepared(
        &mut self,
        vault: AccountId,
        id: Option<u64>,
        amount_in: U128,
        #[callback_result] operation: Result<Value, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(operation) = operation else {
            self.undo(&vault, id, amount_in.0, "vault refused");
            return PromiseOrValue::Value(false);
        };
        let op_id = operation["op_id"].clone();
        PromiseOrValue::Promise(
            Promise::new(vault.clone())
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
                        .on_authorized(vault, id, amount_in, op_id),
                ),
        )
    }

    #[private]
    pub fn on_authorized(
        &mut self,
        vault: AccountId,
        id: Option<u64>,
        amount_in: U128,
        op_id: Value,
    ) -> bool {
        // authorize answers nothing, or the MPC callback's value: only success matters.
        if env::promise_result_checked(0, 16_384).is_err() {
            self.undo(&vault, id, amount_in.0, "vault did not sign");
            return false;
        }
        match id {
            Some(id) => event(
                "filled",
                &json!({ "vault": vault, "id": id, "amount_in": amount_in, "op_id": op_id }),
            ),
            None => event("approved", &json!({ "vault": vault, "op_id": op_id })),
        }
        true
    }

    // ---------------------------------------------------------------- readers

    /// A member of the vault's DAO registers the key their sealed terms are encrypted to (X25519,
    /// base64). Checked on chain: the vault's owner, then that DAO's policy.
    #[payable]
    pub fn register_reader(&mut self, vault: AccountId, public_key: String) -> Promise {
        require!(
            env::attached_deposit() >= STORAGE_DEPOSIT,
            "ERR_STORAGE_DEPOSIT"
        );
        require!(
            public_key.len() == 44 && public_key.ends_with('='),
            "ERR_PUBLIC_KEY"
        );
        let caller = env::predecessor_account_id();
        view(&vault, "owner_id", json!({})).then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_READER_GAS)
                .on_reader_owner(caller, vault, public_key),
        )
    }

    #[private]
    pub fn on_reader_owner(
        &mut self,
        caller: AccountId,
        vault: AccountId,
        public_key: String,
        #[callback_result] owner: Result<AccountId, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(dao) = owner else {
            Promise::new(caller).transfer(STORAGE_DEPOSIT).detach();
            return PromiseOrValue::Value(false);
        };
        PromiseOrValue::Promise(
            view(&dao, "get_policy", json!({})).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_reader_policy(caller, vault, public_key),
            ),
        )
    }

    #[private]
    pub fn on_reader_policy(
        &mut self,
        caller: AccountId,
        vault: AccountId,
        public_key: String,
        #[callback_result] policy: Result<Value, PromiseError>,
    ) -> bool {
        let member = policy.ok().is_some_and(|policy| {
            policy["roles"].as_array().is_some_and(|roles| {
                roles.iter().any(|role| {
                    role["kind"]["Group"].as_array().is_some_and(|group| {
                        group
                            .iter()
                            .any(|account| account.as_str() == Some(caller.as_str()))
                    })
                })
            })
        });
        let mut readers = self.readers.get(&vault).cloned().unwrap_or_default();
        readers.retain(|reader| reader.account != caller);
        if !member || readers.len() >= MAX_READERS {
            Promise::new(caller).transfer(STORAGE_DEPOSIT).detach();
            env::log_str(if member {
                "ERR_TOO_MANY_READERS"
            } else {
                "ERR_NOT_A_MEMBER"
            });
            return false;
        }
        readers.push(Reader {
            account: caller.clone(),
            public_key,
        });
        event("reader", &json!({ "vault": vault, "account": caller }));
        self.readers.insert(vault, readers);
        true
    }

    // ------------------------------------------------------------------ views

    pub fn order(&self, vault: AccountId, id: u64) -> Option<Order> {
        self.orders.get(&(vault, id)).cloned()
    }

    /// The vault's orders, newest first (at most `limit`, 50 by default).
    pub fn orders(&self, vault: AccountId, limit: Option<u64>) -> Vec<Order> {
        let next = self.next_ids.get(&vault).copied().unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (0..next)
            .rev()
            .take(limit as usize)
            .filter_map(|id| self.orders.get(&(vault.clone(), id)).cloned())
            .collect()
    }

    pub fn readers(&self, vault: AccountId) -> Vec<Reader> {
        self.readers.get(&vault).cloned().unwrap_or_default()
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
    fn mark_cancelled(&mut self, vault: &AccountId, id: u64) {
        if let Some(order) = self.orders.get_mut(&(vault.clone(), id)) {
            order.cancelled = true;
            event("cancelled", &json!({ "vault": vault, "id": id }));
        }
    }

    /// The vault refused or did not sign: a fill's amount goes back to its order.
    fn undo(&mut self, vault: &AccountId, id: Option<u64>, amount_in: u128, why: &str) {
        if let Some(id) = id
            && let Some(order) = self.orders.get_mut(&(vault.clone(), id))
        {
            order.filled = U128(order.filled.0.saturating_sub(amount_in));
        }
        event(
            "failed",
            &json!({ "vault": vault, "id": id, "reason": why }),
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_and_sign(
        &self,
        vault: &AccountId,
        role: &str,
        chain_id: u64,
        target: [u8; 20],
        calldata: Vec<u8>,
        allowance_amount: U128,
        reference: String,
        gas: [U128; 3],
        then: Promise,
    ) -> Promise {
        let request = json!({
            "role": role,
            "request": {
                "chain_id": chain_id,
                "target": target,
                "value": "0",
                "calldata": calldata,
                "allowance_amount": allowance_amount,
                "reference": reference,
                "gas_limit": gas[0],
                "max_fee_per_gas": gas[1],
                "max_priority_fee_per_gas": gas[2],
            }
        });
        Promise::new(vault.clone())
            .function_call(
                "prepare".to_string(),
                request.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                PREPARE_GAS,
            )
            .then(then)
    }
}

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
    fn authority_is_the_owner_or_an_active_member() {
        let owner: AccountId = "dao.testnet".parse().unwrap();
        let agent: AccountId = "agent.testnet".parse().unwrap();
        let active = Ok(Some(json!({ "active": true })));
        assert!(authority(Ok(owner.clone()), Ok(None)).allows(&owner));
        assert!(!authority(Ok(owner.clone()), Ok(None)).allows(&agent));
        assert!(authority(Ok(owner.clone()), active).allows(&agent));
        assert!(!authority(Ok(owner), Ok(Some(json!({ "active": false })))).allows(&agent));
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
