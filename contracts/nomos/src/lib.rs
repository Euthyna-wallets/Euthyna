//! Nomos: creates company vaults and keeps the published vault versions.
//!
//! The factory has no power over a vault once it exists. A vault is created
//! without any access key, owned by the company DAO, and only that DAO can move
//! it to another published version (by its code hash, through the vault's own
//! rule delay). The owner of Nomos can publish versions, nothing else.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U64, U128};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env,
    ext_contract, near, require,
};

const VAULT_INIT_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Kept on the vault on top of its code, for its own state.
const VAULT_STATE_RESERVE: NearToken = NearToken::from_millinear(500);

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_create(&self, creator: AccountId, amount: U128, vault_id: AccountId) -> bool;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    /// sha256 of the WASM: the same hash NEAR reports as the account's code hash.
    pub code_hash: Base58CryptoHash,
    pub size: u64,
    pub notes: String,
    pub published_at_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Nomos {
    owner_id: AccountId,
    versions: Vector<Version>,
    codes: LookupMap<CryptoHash, Vec<u8>>,
}

#[near]
impl Nomos {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            versions: Vector::new(b"v"),
            codes: LookupMap::new(b"c"),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// Owner only: hand publishing over (for example to a multisig).
    pub fn set_owner(&mut self, owner_id: AccountId) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
        env::log_str(&format!("NOMOS_OWNER:{owner_id}"));
        self.owner_id = owner_id;
    }

    /// Published versions, oldest first.
    pub fn versions(&self) -> Vec<Version> {
        self.versions.iter().cloned().collect()
    }

    pub fn latest_version(&self) -> Option<Version> {
        self.versions.iter().last().cloned()
    }

    /// The account a vault named `name` would get.
    pub fn vault_account(&self, name: String) -> AccountId {
        parse_vault_account(&name)
    }

    /// NEAR to attach to `create_vault` for a version.
    pub fn vault_deposit(&self, code_hash: Option<Base58CryptoHash>) -> U128 {
        let size = self.code(code_hash.map(Into::into)).len() as u128;
        U128(deposit_for(size).as_yoctonear())
    }

    /// Owner only. The WASM is the raw call input (no JSON), so a 700 KB vault
    /// fits in one transaction. Attach enough NEAR for its storage.
    #[payable]
    pub fn publish_version(&mut self) -> Base58CryptoHash {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
        let code = env::input().unwrap_or_default();
        require!(
            !code.is_empty() && code.starts_with(b"\0asm"),
            "ERR_NOT_WASM"
        );
        let code_hash = env::sha256_array(&code);
        require!(!self.codes.contains_key(&code_hash), "ERR_VERSION_EXISTS");
        let version = Version {
            code_hash: code_hash.into(),
            size: code.len() as u64,
            notes: String::new(),
            published_at_ns: U64(env::block_timestamp()),
        };
        self.codes.insert(code_hash, code);
        self.versions.push(version.clone());
        env::log_str(&format!(
            "NOMOS_VERSION_PUBLISHED:{}",
            String::from(&version.code_hash)
        ));
        version.code_hash
    }

    /// Owner only: a short note on what a version changes.
    pub fn set_version_notes(&mut self, code_hash: Base58CryptoHash, notes: String) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_OWNER_ONLY"
        );
        require!(notes.chars().count() <= 280, "ERR_NOTES_LENGTH");
        let index = self
            .versions
            .iter()
            .position(|version| version.code_hash == code_hash)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_VERSION"));
        self.versions
            .get_mut(index as u32)
            .expect("ERR_UNKNOWN_VERSION")
            .notes = notes;
    }

    /// Raw WASM of a published version (not JSON). Vaults call it to upgrade
    /// and check the hash themselves, so this contract is not trusted for it.
    pub fn code_of(&self, code_hash: Base58CryptoHash) {
        env::value_return(self.code(Some(code_hash.into())));
    }

    /// Anyone, for their company: creates `<name>.<this account>` with no key,
    /// deploys a published version (the latest by default) and calls `new`
    /// with `args` (the vault's JSON init arguments, owner = the company DAO).
    #[payable]
    pub fn create_vault(
        &mut self,
        name: String,
        args: Base64VecU8,
        code_hash: Option<Base58CryptoHash>,
    ) -> Promise {
        let amount = env::attached_deposit();
        let code = self.code(code_hash.map(Into::into)).to_vec();
        require!(
            amount >= deposit_for(code.len() as u128),
            "ERR_VAULT_DEPOSIT_TOO_LOW"
        );
        let creator = env::predecessor_account_id();
        let vault_id = parse_vault_account(&name);
        Promise::new(vault_id.clone())
            .create_account()
            .transfer(amount)
            .deploy_contract(code)
            .function_call(
                "new".to_owned(),
                args.0,
                NearToken::from_yoctonear(0),
                VAULT_INIT_GAS,
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_create(creator, U128(amount.as_yoctonear()), vault_id),
            )
    }

    #[private]
    pub fn on_create(
        &self,
        creator: AccountId,
        amount: U128,
        vault_id: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            env::log_str(&format!("NOMOS_VAULT_CREATED:{vault_id}"));
            true
        } else {
            // The batch failed as a whole: the deposit came back here.
            Promise::new(creator)
                .transfer(NearToken::from_yoctonear(amount.0))
                .detach();
            env::log_str(&format!("NOMOS_VAULT_CREATE_FAILED:{vault_id}"));
            false
        }
    }
}

impl Nomos {
    fn code(&self, code_hash: Option<CryptoHash>) -> &Vec<u8> {
        let hash = code_hash.unwrap_or_else(|| {
            self.versions
                .iter()
                .last()
                .map(|version| version.code_hash.into())
                .unwrap_or_else(|| env::panic_str("ERR_NO_VERSION"))
        });
        self.codes
            .get(&hash)
            .unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_VERSION"))
    }
}

/// Code storage plus a reserve for the vault's own state.
fn deposit_for(code_size: u128) -> NearToken {
    env::storage_byte_cost()
        .saturating_mul(code_size)
        .saturating_add(VAULT_STATE_RESERVE)
}

fn parse_vault_account(name: &str) -> AccountId {
    require!(name.len() >= 2 && name.len() <= 32, "ERR_VAULT_NAME_LENGTH");
    require!(
        !name.starts_with('-')
            && !name.ends_with('-')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "ERR_VAULT_NAME"
    );
    format!("{name}.{}", env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("ERR_VAULT_ACCOUNT"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
    use near_sdk::testing_env;

    const WASM: &[u8] = b"\0asm\x01\0\0\0vault-code";

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn context(predecessor: &str, deposit: NearToken, input: &[u8]) {
        let mut context = VMContextBuilder::new()
            .current_account_id(account("nomos.euthyna.testnet"))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(100))
            .build();
        context.input = input.into();
        testing_env!(context);
    }

    fn published() -> Nomos {
        context("euthyna.testnet", NearToken::from_yoctonear(0), WASM);
        let mut nomos = Nomos::new(account("euthyna.testnet"));
        nomos.publish_version();
        nomos
    }

    #[test]
    fn publishes_by_code_hash() {
        let nomos = published();
        let latest = nomos.latest_version().unwrap();
        assert_eq!(
            latest.code_hash,
            Base58CryptoHash::from(env::sha256_array(WASM))
        );
        assert_eq!(latest.size, WASM.len() as u64);
    }

    #[test]
    #[should_panic(expected = "ERR_OWNER_ONLY")]
    fn only_the_owner_publishes() {
        context("euthyna.testnet", NearToken::from_yoctonear(0), WASM);
        let mut nomos = Nomos::new(account("euthyna.testnet"));
        context("stranger.testnet", NearToken::from_yoctonear(0), WASM);
        nomos.publish_version();
    }

    #[test]
    #[should_panic(expected = "ERR_VERSION_EXISTS")]
    fn a_version_is_published_once() {
        let mut nomos = published();
        context("euthyna.testnet", NearToken::from_yoctonear(0), WASM);
        nomos.publish_version();
    }

    #[test]
    fn creates_a_keyless_vault_with_the_published_code() {
        let mut nomos = published();
        context("founder.testnet", NearToken::from_near(1), &[]);
        drop(nomos.create_vault(
            "acme".to_owned(),
            Base64VecU8(br#"{"owner_id":"acme-dao.testnet"}"#.to_vec()),
            None,
        ));
        let receipt = get_created_receipts()
            .into_iter()
            .find(|receipt| receipt.receiver_id == account("acme.nomos.euthyna.testnet"))
            .expect("vault receipt");
        assert!(
            receipt
                .actions
                .iter()
                .any(|action| matches!(action, MockAction::CreateAccount { .. }))
        );
        assert!(receipt.actions.iter().any(
            |action| matches!(action, MockAction::DeployContract { code, .. } if code == WASM)
        ));
        assert!(receipt.actions.iter().any(|action| matches!(
            action,
            MockAction::FunctionCallWeight { method_name, .. } if method_name == b"new"
        )));
        assert!(!receipt.actions.iter().any(|action| matches!(
            action,
            MockAction::AddKeyWithFullAccess { .. } | MockAction::AddKeyWithFunctionCall { .. }
        )));
    }

    #[test]
    #[should_panic(expected = "ERR_VAULT_DEPOSIT_TOO_LOW")]
    fn refuses_an_underfunded_vault() {
        let mut nomos = published();
        context("founder.testnet", NearToken::from_millinear(499), &[]);
        drop(nomos.create_vault("acme".to_owned(), Base64VecU8(vec![]), None));
    }

    #[test]
    #[should_panic(expected = "ERR_UNKNOWN_VERSION")]
    fn refuses_an_unpublished_version() {
        let mut nomos = published();
        context("founder.testnet", NearToken::from_near(1), &[]);
        drop(nomos.create_vault(
            "acme".to_owned(),
            Base64VecU8(vec![]),
            Some([9u8; 32].into()),
        ));
    }

    #[test]
    #[should_panic(expected = "ERR_VAULT_NAME")]
    fn refuses_an_invalid_name() {
        let mut nomos = published();
        context("founder.testnet", NearToken::from_near(1), &[]);
        drop(nomos.create_vault("Acme".to_owned(), Base64VecU8(vec![]), None));
    }
}
