use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PanicOnDefault, PromiseOrValue, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Leash {
    token: FungibleToken,
    /// The only account that may mint: Rob the Agent's Ruggy, who mints one trophy per claimed player.
    minter: AccountId,
}

#[near]
impl Leash {
    #[init]
    pub fn new(minter: AccountId) -> Self {
        Self {
            token: FungibleToken::new(b"t".to_vec()),
            minter,
        }
    }

    pub fn minter(&self) -> AccountId {
        self.minter.clone()
    }

    /// Mints to `account_id`, registering it if needed. Only the minter.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        assert_eq!(
            near_sdk::env::predecessor_account_id(),
            self.minter,
            "only the minter mints LEASH"
        );
        if self.token.accounts.get(&account_id).is_none() {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
    }
}

#[near]
impl FungibleTokenCore for Leash {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}
#[near]
impl FungibleTokenMetadataProvider for Leash {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Leash".to_string(),
            symbol: "LEASH".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 0,
        }
    }
}

#[near]
impl FungibleTokenResolver for Leash {
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Leash {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn as_caller(account: &str) {
        let mut context = VMContextBuilder::new();
        context.predecessor_account_id(account.parse().expect("valid account"));
        testing_env!(context.build());
    }

    #[test]
    fn is_named_leash_with_whole_units() {
        as_caller("ruggy.testnet");
        let metadata = Leash::new("ruggy.testnet".parse().expect("valid account")).ft_metadata();
        assert_eq!(metadata.name, "Leash");
        assert_eq!(metadata.symbol, "LEASH");
        assert_eq!(metadata.decimals, 0);
    }

    #[test]
    fn the_minter_mints_and_registers() {
        as_caller("ruggy.testnet");
        let mut token = Leash::new("ruggy.testnet".parse().expect("valid account"));
        let player: AccountId = "player.testnet".parse().expect("valid account");
        token.mint(player.clone(), U128(1));
        token.mint(player.clone(), U128(1));
        assert_eq!(token.ft_balance_of(player), U128(2));
    }

    #[test]
    #[should_panic(expected = "only the minter mints LEASH")]
    fn nobody_else_mints() {
        as_caller("ruggy.testnet");
        let mut token = Leash::new("ruggy.testnet".parse().expect("valid account"));
        as_caller("thief.testnet");
        token.mint("thief.testnet".parse().expect("valid account"), U128(1_000));
    }
}
