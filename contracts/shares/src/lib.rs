//! Shares of a MandateOS company.
//!
//! One contract does four things, so that a share never leaves its ledger:
//! - a NEP-141 token (0 decimals: 1 unit = 1 share) with a fixed supply;
//! - a sale at a fixed price in NEAR, the proceeds going to the company DAO;
//! - the Sputnik staking contract of the DAO: a holder locks shares to vote,
//!   and the DAO counts locked shares as votes (`TokenWeight`);
//! - revenue sharing: NEAR, or one NEP-141 token (for example bridged from
//!   Base), split pro rata over every share held, locked or not.
//!
//! Unlocked shares stay frozen for `unlock_period_ns`. It must be longer than
//! the DAO's proposal period, so shares cannot vote twice on one proposal.
//!
//! The contract has no owner and no admin method: once deployed, its account
//! keeps no access key. Changing it means deploying a new one by DAO vote.

use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, ext_contract, near, require,
};

/// Precision of the per-share accumulators.
const SCALE: u128 = 1_000_000;
/// Paid once per holder: account entry here and delegation entry in the DAO.
const REGISTRATION_FEE: NearToken = NearToken::from_millinear(10);
const GAS_DAO_CALL: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Holders,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
struct Holder {
    balance: u128,
    /// Delegated to the DAO as votes. Not transferable.
    locked: u128,
    /// Unlocked recently. Not transferable until `cooling_until_ns`.
    cooling: u128,
    cooling_until_ns: u64,
    delegation_registered: bool,
    near_paid_per_share: u128,
    near_owed: u128,
    token_paid_per_share: u128,
    token_owed: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Shares {
    dao_id: AccountId,
    name: String,
    symbol: String,
    total_supply: u128,
    unsold: u128,
    price_per_share: u128,
    unlock_period_ns: u64,
    revenue_token: Option<AccountId>,
    holders: LookupMap<AccountId, Holder>,
    near_per_share: u128,
    token_per_share: u128,
    near_distributed: u128,
    token_distributed: u128,
    /// Revenue token balance this contract accounts for (owed + dust).
    token_accounted: u128,
    token_claims_in_flight: u32,
}

#[near(serializers = [json])]
pub struct HolderView {
    pub balance: U128,
    pub locked: U128,
    pub cooling: U128,
    pub cooling_until_ns: U64,
    pub transferable: U128,
    pub claimable_near: U128,
    pub claimable_token: U128,
}

#[near(serializers = [json])]
pub struct SharesInfo {
    pub dao_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub total_supply: U128,
    pub unsold: U128,
    pub price_per_share: U128,
    pub unlock_period_ns: U64,
    pub revenue_token: Option<AccountId>,
    pub near_distributed: U128,
    pub token_distributed: U128,
}

#[near(serializers = [json])]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[ext_contract(ext_dao)]
#[allow(dead_code)]
trait SputnikDelegation {
    fn register_delegation(&mut self, account_id: AccountId);
    fn delegate(&mut self, account_id: AccountId, amount: U128) -> (U128, U128, U128);
    fn undelegate(&mut self, account_id: AccountId, amount: U128) -> (U128, U128, U128);
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_delegate(&mut self, account_id: AccountId, amount: U128, registered_now: bool);
    fn on_undelegate(&mut self, account_id: AccountId, amount: U128, previous_until_ns: U64);
    fn on_token_claim(&mut self, account_id: AccountId, amount: U128);
    fn on_token_balance(&mut self);
}

/// `a * b / c`, still exact (rounded down) when `a * b` does not fit in 128 bits.
fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    if let Some(product) = a.checked_mul(b) {
        return product / c;
    }
    let (big, small) = if a >= b { (a, b) } else { (b, a) };
    (big / c)
        .checked_mul(small)
        .and_then(|value| value.checked_add((big % c).checked_mul(small)? / c))
        .unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"))
}

fn event(kind: &str, data: String) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"{kind}","data":[{data}]}}"#
    ));
}

#[near]
impl Shares {
    /// `allocations` are shares given at creation (founders); the rest is for sale.
    #[init]
    pub fn new(
        dao_id: AccountId,
        name: String,
        symbol: String,
        total_supply: U128,
        price_per_share: U128,
        unlock_period_ns: U64,
        revenue_token: Option<AccountId>,
        allocations: Vec<(AccountId, U128)>,
    ) -> Self {
        require!(total_supply.0 > 0, "ERR_ZERO_SUPPLY");
        require!(price_per_share.0 > 0, "ERR_ZERO_PRICE");
        require!(unlock_period_ns.0 > 0, "ERR_ZERO_UNLOCK_PERIOD");
        let mut contract = Self {
            dao_id,
            name,
            symbol,
            total_supply: total_supply.0,
            unsold: total_supply.0,
            price_per_share: price_per_share.0,
            unlock_period_ns: unlock_period_ns.0,
            revenue_token,
            holders: LookupMap::new(StorageKey::Holders),
            near_per_share: 0,
            token_per_share: 0,
            near_distributed: 0,
            token_distributed: 0,
            token_accounted: 0,
            token_claims_in_flight: 0,
        };
        for (account_id, amount) in allocations {
            require!(amount.0 <= contract.unsold, "ERR_ALLOCATIONS_EXCEED_SUPPLY");
            contract.unsold -= amount.0;
            let mut holder = contract.holders.get(&account_id).cloned().unwrap_or_default();
            holder.balance += amount.0;
            contract.holders.insert(account_id.clone(), holder);
            event("ft_mint", format!(r#"{{"owner_id":"{account_id}","amount":"{}"}}"#, amount.0));
        }
        contract
    }

    // ----- Sale -----

    /// Buys as many shares as the deposit pays for, at the fixed price. A new
    /// holder pays the registration fee from the deposit; the rest is refunded.
    #[payable]
    pub fn buy(&mut self) -> U128 {
        let buyer = env::predecessor_account_id();
        let mut deposit = env::attached_deposit().as_yoctonear();
        let mut holder = match self.holders.get(&buyer).cloned() {
            Some(holder) => self.settled(holder),
            None => {
                require!(deposit > REGISTRATION_FEE.as_yoctonear(), "ERR_DEPOSIT_BELOW_REGISTRATION_FEE");
                deposit -= REGISTRATION_FEE.as_yoctonear();
                self.settled(Holder::default())
            }
        };
        let count = std::cmp::min(deposit / self.price_per_share, self.unsold);
        require!(count > 0, "ERR_NOTHING_TO_BUY");
        let cost = count * self.price_per_share;
        self.unsold -= count;
        holder.balance += count;
        self.holders.insert(buyer.clone(), holder);
        event("ft_mint", format!(r#"{{"owner_id":"{buyer}","amount":"{count}","memo":"bought"}}"#));
        Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(cost)).detach();
        if deposit > cost {
            Promise::new(buyer).transfer(NearToken::from_yoctonear(deposit - cost)).detach();
        }
        U128(count)
    }

    // ----- Votes (Sputnik staking interface) -----

    /// Locks shares as votes in the DAO.
    pub fn lock(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let account_id = env::predecessor_account_id();
        let mut holder = self.holder(&account_id);
        require!(self.transferable(&holder) >= amount.0, "ERR_NOT_ENOUGH_FREE_SHARES");
        holder.locked += amount.0;
        let registered_now = !holder.delegation_registered;
        holder.delegation_registered = true;
        self.holders.insert(account_id.clone(), holder);
        let dao = || ext_dao::ext(self.dao_id.clone()).with_static_gas(GAS_DAO_CALL);
        let delegate = if registered_now {
            // Sputnik asks the staking contract for 16 bytes of storage.
            dao()
                .with_attached_deposit(env::storage_byte_cost().saturating_mul(16))
                .register_delegation(account_id.clone())
                .then(dao().delegate(account_id.clone(), amount))
        } else {
            dao().delegate(account_id.clone(), amount)
        };
        delegate.then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_delegate(account_id, amount, registered_now),
        )
    }

    /// Withdraws votes. The shares stay frozen for the unlock period.
    pub fn unlock(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let account_id = env::predecessor_account_id();
        let mut holder = self.holder(&account_id);
        require!(holder.locked >= amount.0, "ERR_NOT_ENOUGH_LOCKED");
        Self::expire_cooling(&mut holder);
        let previous_until_ns = holder.cooling_until_ns;
        holder.locked -= amount.0;
        holder.cooling += amount.0;
        holder.cooling_until_ns = env::block_timestamp().saturating_add(self.unlock_period_ns);
        self.holders.insert(account_id.clone(), holder);
        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_DAO_CALL)
            .undelegate(account_id.clone(), amount)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_undelegate(account_id, amount, U64(previous_until_ns)),
            )
    }

    #[private]
    pub fn on_delegate(
        &mut self,
        account_id: AccountId,
        amount: U128,
        registered_now: bool,
        #[callback_result] result: Result<(U128, U128, U128), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let mut holder = self.holder(&account_id);
        holder.locked = holder.locked.saturating_sub(amount.0);
        if registered_now {
            holder.delegation_registered = false;
        }
        self.holders.insert(account_id, holder);
        false
    }

    #[private]
    pub fn on_undelegate(
        &mut self,
        account_id: AccountId,
        amount: U128,
        previous_until_ns: U64,
        #[callback_result] result: Result<(U128, U128, U128), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        let mut holder = self.holder(&account_id);
        holder.locked += amount.0;
        holder.cooling = holder.cooling.saturating_sub(amount.0);
        if holder.cooling == 0 {
            holder.cooling_until_ns = previous_until_ns.0;
        }
        self.holders.insert(account_id, holder);
        false
    }

    // ----- Revenue sharing -----

    /// Shares the attached NEAR over every share held.
    #[payable]
    pub fn deposit_revenue(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let held = self.held();
        require!(held > 0, "ERR_NO_HOLDER");
        self.near_per_share += mul_div(amount, SCALE, held);
        self.near_distributed += amount;
        env::log_str(&format!("MANDATEOS_REVENUE:near:{amount}"));
    }

    /// Revenue token sent with `ft_transfer_call`: shared at once.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = (sender_id, msg);
        if self.revenue_token.as_ref() != Some(&env::predecessor_account_id()) || self.held() == 0 {
            return PromiseOrValue::Value(amount);
        }
        self.token_accounted += amount.0;
        self.share_token(amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// Revenue token sent with a plain `ft_transfer` (a bridge, for example):
    /// anyone can call this to share what arrived since the last time.
    pub fn sync_revenue(&mut self) -> Promise {
        let token = self.revenue_token.clone().expect("ERR_NO_REVENUE_TOKEN");
        require!(self.token_claims_in_flight == 0, "ERR_CLAIM_IN_FLIGHT");
        ext_ft::ext(token)
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_token_balance())
    }

    #[private]
    pub fn on_token_balance(&mut self, #[callback_result] balance: Result<U128, PromiseError>) -> U128 {
        let Ok(balance) = balance else { return U128(0) };
        if self.token_claims_in_flight > 0 || self.held() == 0 {
            return U128(0);
        }
        let arrived = balance.0.saturating_sub(self.token_accounted);
        if arrived > 0 {
            self.token_accounted = balance.0;
            self.share_token(arrived);
        }
        U128(arrived)
    }

    /// Pays the caller everything owed: NEAR, then the revenue token.
    pub fn claim(&mut self) -> (U128, U128) {
        let account_id = env::predecessor_account_id();
        let mut holder = self.holder(&account_id);
        let near = std::mem::take(&mut holder.near_owed);
        let token = std::mem::take(&mut holder.token_owed);
        self.holders.insert(account_id.clone(), holder);
        if near > 0 {
            Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(near)).detach();
        }
        if token > 0 {
            let revenue_token = self.revenue_token.clone().expect("ERR_NO_REVENUE_TOKEN");
            self.token_claims_in_flight += 1;
            ext_ft::ext(revenue_token)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(account_id.clone(), U128(token), Some("MandateOS revenue".into()))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_token_claim(account_id, U128(token)),
                )
                .detach();
        }
        (U128(near), U128(token))
    }

    /// A failed token payment (the holder is not registered on the token, for
    /// example) stays owed.
    #[private]
    pub fn on_token_claim(&mut self, account_id: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        self.token_claims_in_flight = self.token_claims_in_flight.saturating_sub(1);
        if result.is_ok() {
            self.token_accounted = self.token_accounted.saturating_sub(amount.0);
            return true;
        }
        let mut holder = self.holder(&account_id);
        holder.token_owed += amount.0;
        self.holders.insert(account_id, holder);
        false
    }

    // ----- NEP-141 -----

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "ERR_ONE_YOCTO");
        let sender_id = env::predecessor_account_id();
        require!(sender_id != receiver_id, "ERR_SELF_TRANSFER");
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let mut sender = self.holder(&sender_id);
        require!(self.transferable(&sender) >= amount.0, "ERR_NOT_ENOUGH_FREE_SHARES");
        let mut receiver = self
            .holders
            .get(&receiver_id)
            .cloned()
            .map(|holder| self.settled(holder))
            .unwrap_or_else(|| env::panic_str("ERR_RECEIVER_NOT_REGISTERED"));
        sender.balance -= amount.0;
        receiver.balance += amount.0;
        self.holders.insert(sender_id.clone(), sender);
        self.holders.insert(receiver_id.clone(), receiver);
        let memo = memo.map(|memo| format!(r#","memo":{}"#, near_sdk::serde_json::to_string(&memo).unwrap_or_default())).unwrap_or_default();
        event(
            "ft_transfer",
            format!(r#"{{"old_owner_id":"{sender_id}","new_owner_id":"{receiver_id}","amount":"{}"{memo}}}"#, amount.0),
        );
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.holders.get(&account_id).map_or(0, |holder| holder.balance))
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".into(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 0,
        }
    }

    /// Registers an account so it can receive shares. Pays the same fee as a first purchase.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        if self.holders.contains_key(&account_id) {
            if !deposit.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
            }
        } else {
            require!(deposit >= REGISTRATION_FEE, "ERR_DEPOSIT_BELOW_REGISTRATION_FEE");
            let holder = self.settled(Holder::default());
            self.holders.insert(account_id.clone(), holder);
            let refund = deposit.saturating_sub(REGISTRATION_FEE);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        StorageBalance { total: U128(REGISTRATION_FEE.as_yoctonear()), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.holders
            .contains_key(&account_id)
            .then(|| StorageBalance { total: U128(REGISTRATION_FEE.as_yoctonear()), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(REGISTRATION_FEE.as_yoctonear()), max: Some(U128(REGISTRATION_FEE.as_yoctonear())) }
    }

    // ----- Views -----

    pub fn info(&self) -> SharesInfo {
        SharesInfo {
            dao_id: self.dao_id.clone(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            total_supply: U128(self.total_supply),
            unsold: U128(self.unsold),
            price_per_share: U128(self.price_per_share),
            unlock_period_ns: U64(self.unlock_period_ns),
            revenue_token: self.revenue_token.clone(),
            near_distributed: U128(self.near_distributed),
            token_distributed: U128(self.token_distributed),
        }
    }

    pub fn holder_of(&self, account_id: AccountId) -> Option<HolderView> {
        let mut holder = self.settled(self.holders.get(&account_id)?.clone());
        Self::expire_cooling(&mut holder);
        Some(HolderView {
            balance: U128(holder.balance),
            locked: U128(holder.locked),
            cooling: U128(holder.cooling),
            cooling_until_ns: U64(holder.cooling_until_ns),
            transferable: U128(self.transferable(&holder)),
            claimable_near: U128(holder.near_owed),
            claimable_token: U128(holder.token_owed),
        })
    }

    // ----- Internals -----

    /// Shares in holders' hands: the unsold ones earn nothing.
    fn held(&self) -> u128 {
        self.total_supply - self.unsold
    }

    fn share_token(&mut self, amount: u128) {
        self.token_per_share += mul_div(amount, SCALE, self.held());
        self.token_distributed += amount;
        env::log_str(&format!("MANDATEOS_REVENUE:token:{amount}"));
    }

    fn holder(&self, account_id: &AccountId) -> Holder {
        let holder = self.holders.get(account_id).cloned().expect("ERR_NOT_A_HOLDER");
        self.settled(holder)
    }

    /// Moves what the holder earned since the last update into what is owed.
    fn settled(&self, mut holder: Holder) -> Holder {
        holder.near_owed += mul_div(holder.balance, self.near_per_share - holder.near_paid_per_share, SCALE);
        holder.near_paid_per_share = self.near_per_share;
        holder.token_owed += mul_div(holder.balance, self.token_per_share - holder.token_paid_per_share, SCALE);
        holder.token_paid_per_share = self.token_per_share;
        holder
    }

    fn expire_cooling(holder: &mut Holder) {
        if holder.cooling > 0 && env::block_timestamp() >= holder.cooling_until_ns {
            holder.cooling = 0;
        }
    }

    fn transferable(&self, holder: &Holder) -> u128 {
        let cooling = if env::block_timestamp() >= holder.cooling_until_ns { 0 } else { holder.cooling };
        holder.balance - holder.locked - cooling
    }
}
