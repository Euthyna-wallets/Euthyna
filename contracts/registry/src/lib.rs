//! Public directory of MandateOS companies.
//!
//! A company lists itself: its DAO calls `register` (so a vote of its members
//! decides it). The registry accepts only DAOs created by the MandateOS factory
//! and checks on chain that the vault is owned by that DAO, and that the shares
//! contract (if any) belongs to it. Nobody can list a company for someone else
//! or point at another company's vault. The account is deployed without access
//! keys, so nobody can change the list but the companies themselves.

use near_sdk::json_types::U64;
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, ext_contract, near,
    require,
};

const VIEW_GAS: Gas = Gas::from_tgas(5);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const MAX_NAME: usize = 64;
const MAX_DESCRIPTION: usize = 280;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Company {
    pub dao_id: AccountId,
    pub vault_id: AccountId,
    pub shares_id: Option<AccountId>,
    pub name: String,
    pub description: String,
    pub registered_at_ns: U64,
}

#[near(serializers = [json])]
pub struct SharesDao {
    pub dao_id: AccountId,
}

#[allow(dead_code)]
#[ext_contract(ext_vault)]
trait Vault {
    fn owner_id(&self) -> AccountId;
}

#[allow(dead_code)]
#[ext_contract(ext_shares)]
trait Shares {
    fn info(&self) -> SharesDao;
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_checked(&mut self, company: Company, deposit: near_sdk::json_types::U128) -> bool;
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Companies,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    factory_id: AccountId,
    companies: IterableMap<AccountId, Company>,
}

#[near]
impl Registry {
    #[init]
    pub fn new(factory_id: AccountId) -> Self {
        Self { factory_id, companies: IterableMap::new(Key::Companies) }
    }

    /// Called by the company's DAO. Attach enough NEAR for the storage; the rest is refunded.
    #[payable]
    pub fn register(&mut self, vault_id: AccountId, shares_id: Option<AccountId>, name: String, description: String) -> Promise {
        let dao_id = env::predecessor_account_id();
        require!(self.is_factory_dao(&dao_id), "ERR_NOT_A_MANDATEOS_DAO");
        let name = name.trim().to_owned();
        require!(!name.is_empty() && name.chars().count() <= MAX_NAME, "ERR_NAME_LENGTH");
        require!(description.chars().count() <= MAX_DESCRIPTION, "ERR_DESCRIPTION_LENGTH");
        let deposit = env::attached_deposit();
        let company = Company { dao_id, vault_id: vault_id.clone(), shares_id: shares_id.clone(), name, description, registered_at_ns: U64(env::block_timestamp()) };
        let callback = ext_self::ext(env::current_account_id())
            .with_static_gas(CALLBACK_GAS)
            .on_checked(company, near_sdk::json_types::U128(deposit.as_yoctonear()));
        let vault = ext_vault::ext(vault_id).with_static_gas(VIEW_GAS).owner_id();
        match shares_id {
            Some(shares) => vault.and(ext_shares::ext(shares).with_static_gas(VIEW_GAS).info()).then(callback),
            None => vault.then(callback),
        }
    }

    #[private]
    pub fn on_checked(&mut self, company: Company, deposit: near_sdk::json_types::U128) -> bool {
        let payer = company.dao_id.clone();
        let refund_all = |reason: &str| {
            env::log_str(reason);
            if deposit.0 > 0 {
                Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            }
            false
        };
        let vault_owner: Result<AccountId, PromiseError> = promise_json(0);
        if vault_owner.ok().as_ref() != Some(&company.dao_id) {
            return refund_all("ERR_VAULT_NOT_OWNED_BY_DAO");
        }
        if company.shares_id.is_some() {
            let shares: Result<SharesDao, PromiseError> = promise_json(1);
            if shares.ok().map(|s| s.dao_id) != Some(company.dao_id.clone()) {
                return refund_all("ERR_SHARES_NOT_OF_DAO");
            }
        }
        let before = env::storage_usage();
        let dao_id = company.dao_id.clone();
        self.companies.insert(dao_id.clone(), company);
        self.companies.flush();
        let after = env::storage_usage();
        let cost = env::storage_byte_cost().as_yoctonear() * u128::from(after.saturating_sub(before));
        if cost > deposit.0 {
            self.companies.remove(&dao_id);
            self.companies.flush();
            return refund_all("ERR_STORAGE_DEPOSIT");
        }
        let freed = env::storage_byte_cost().as_yoctonear() * u128::from(before.saturating_sub(after));
        let refund = deposit.0 - cost + freed;
        if refund > 0 {
            Promise::new(dao_id.clone()).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        env::log_str(&format!("registered {dao_id}"));
        true
    }

    /// Called by the company's DAO to leave the directory; the storage deposit goes back to it.
    pub fn unregister(&mut self) {
        let dao_id = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(self.companies.remove(&dao_id).is_some(), "ERR_NOT_REGISTERED");
        self.companies.flush();
        let freed = env::storage_byte_cost().as_yoctonear() * u128::from(before.saturating_sub(env::storage_usage()));
        if freed > 0 {
            Promise::new(dao_id).transfer(NearToken::from_yoctonear(freed)).detach();
        }
    }

    pub fn factory_id(&self) -> AccountId {
        self.factory_id.clone()
    }

    pub fn company_count(&self) -> u32 {
        self.companies.len()
    }

    pub fn get_company(&self, dao_id: AccountId) -> Option<Company> {
        self.companies.get(&dao_id).cloned()
    }

    pub fn list_companies(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Company> {
        self.companies
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
}

impl Registry {
    /// `<name>.<factory>` with a single extra label, as the factory creates them.
    fn is_factory_dao(&self, account: &AccountId) -> bool {
        let suffix = format!(".{}", self.factory_id);
        account.as_str().strip_suffix(&suffix).is_some_and(|label| !label.is_empty() && !label.contains('.'))
    }
}

fn promise_json<T: serde::de::DeserializeOwned>(index: u64) -> Result<T, PromiseError> {
    match env::promise_result(index) {
        near_sdk::PromiseResult::Successful(bytes) => serde_json::from_slice(&bytes).map_err(|_| PromiseError::Failed),
        _ => Err(PromiseError::Failed),
    }
}
