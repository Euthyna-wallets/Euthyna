use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::{
    AccountId, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env,
    ext_contract, near, require,
};

const DAO_INIT_GAS: Gas = Gas::from_tgas(100);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const MIN_DAO_BALANCE: NearToken = NearToken::from_millinear(100);

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtSelf {
    fn on_create(
        &self,
        creator: AccountId,
        amount: U128,
        dao_id: AccountId,
    ) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct DaoFactory {
    owner_id: AccountId,
    dao_code_hash: CryptoHash,
}

#[near]
impl DaoFactory {
    #[init]
    pub fn new(owner_id: AccountId, dao_code_hash: Base58CryptoHash) -> Self {
        Self {
            owner_id,
            dao_code_hash: dao_code_hash.into(),
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_default_code_hash(&self) -> Base58CryptoHash {
        self.dao_code_hash.into()
    }

    pub fn dao_account(&self, name: String) -> AccountId {
        parse_dao_account(&name)
    }

    #[payable]
    pub fn create(&mut self, name: String, args: Base64VecU8) -> Promise {
        let amount = env::attached_deposit();
        require!(amount >= MIN_DAO_BALANCE, "ERR_DAO_BALANCE_TOO_LOW");

        let creator = env::predecessor_account_id();
        let dao_id = parse_dao_account(&name);
        Promise::new(dao_id.clone())
            .create_account()
            .transfer(amount)
            .use_global_contract(self.dao_code_hash)
            .function_call("new".to_owned(), args, NearToken::from_yoctonear(0), DAO_INIT_GAS)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_create(creator, U128(amount.as_yoctonear()), dao_id),
            )
    }

    #[private]
    pub fn on_create(
        &self,
        creator: AccountId,
        amount: U128,
        dao_id: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            env::log_str(&format!("DAO_CREATED:{dao_id}"));
            true
        } else {
            Promise::new(creator).transfer(NearToken::from_yoctonear(amount.0)).detach();
            env::log_str(&format!("DAO_CREATE_FAILED:{dao_id}"));
            false
        }
    }
}

fn parse_dao_account(name: &str) -> AccountId {
    require!(name.len() >= 2 && name.len() <= 32, "ERR_DAO_NAME_LENGTH");
    require!(
        !name.starts_with('-')
            && !name.ends_with('-')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "ERR_DAO_NAME"
    );
    format!("{name}.{}", env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("ERR_DAO_ACCOUNT"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
    use near_sdk::testing_env;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn context(predecessor: &str, deposit: NearToken) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account("factory-v2.mandateos.testnet"))
                .predecessor_account_id(account(predecessor))
                .attached_deposit(deposit)
                .build()
        );
    }

    #[test]
    fn creates_keyless_account_using_immutable_global_hash() {
        context("founder.testnet", NearToken::from_millinear(250));
        let hash = [7u8; 32];
        let mut factory = DaoFactory::new(account("mandateos.testnet"), hash.into());
        drop(factory.create("acme".to_owned(), Base64VecU8(br#"{"config":{}}"#.to_vec())));

        let receipt = get_created_receipts()
            .into_iter()
            .find(|receipt| receipt.receiver_id == account("acme.factory-v2.mandateos.testnet"))
            .expect("DAO receipt");
        assert!(receipt.actions.iter().any(|action| matches!(action, MockAction::CreateAccount { .. })));
        assert!(receipt.actions.iter().any(|action| matches!(
            action,
            MockAction::Transfer { deposit, .. } if *deposit == NearToken::from_millinear(250)
        )));
        assert!(receipt.actions.iter().any(|action| matches!(action, MockAction::UseGlobalContract { .. })));
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
    #[should_panic(expected = "ERR_DAO_BALANCE_TOO_LOW")]
    fn rejects_underfunded_dao() {
        context("mandateos.testnet", NearToken::from_millinear(99));
        let mut factory = DaoFactory::new(account("mandateos.testnet"), [7u8; 32].into());
        drop(factory.create("acme".to_owned(), Base64VecU8(vec![])));
    }

    #[test]
    #[should_panic(expected = "ERR_DAO_NAME")]
    fn rejects_invalid_name() {
        context("mandateos.testnet", NearToken::from_millinear(250));
        let mut factory = DaoFactory::new(account("mandateos.testnet"), [7u8; 32].into());
        drop(factory.create("Acme".to_owned(), Base64VecU8(vec![])));
    }
}
