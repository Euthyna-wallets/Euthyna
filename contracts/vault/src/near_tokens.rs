//! NEAR tokens: agents send NEP-141 tokens held by the vault account itself to
//! listed receivers within a budget. The vault only ever calls `ft_transfer`
//! on a token listed in the role's permissions.
//!
//! Stored under raw keys (not new struct fields), so the vault's state layout
//! is unchanged and existing vaults can move to this version by a DAO upgrade.
use crate::*;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

const KEY_PERMISSIONS: &[u8] = b"near:p:";
const KEY_OPERATION: &[u8] = b"near:o:";
const MAX_PERMISSIONS: usize = 16;
const MAX_RECEIVERS: usize = 32;
const MAX_MEMO_CHARS: usize = 120;

pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
pub const FT_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Gas `execute_near` itself needs besides the two attached calls.
const EXECUTE_OVERHEAD_GAS: Gas = Gas::from_tgas(10);
pub const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
/// NEP-145 registration (the usual 0.00125 NEAR); the token refunds any excess.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct NearPermission {
    /// NEP-141 contract the role may send.
    pub token: AccountId,
    /// Accounts that may receive it (card accounts, suppliers).
    pub receivers: Vec<AccountId>,
    /// Budget charged with the amount, in the token's base units.
    pub allowance: AllowanceKey,
    /// Smallest transfer accepted. Each transfer stores a record paid by the
    /// vault's NEAR balance: a floor bounds how many records a budget can buy.
    pub min_per_transfer: U128,
    pub max_per_transfer: U128,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct NearTransferRequest {
    pub token: AccountId,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum NearOperationState {
    Pending,
    Confirmed,
    Failed,
    /// The callback never ran (e.g. out of gas): released by anyone after the
    /// unconfirmed timeout, with the budget kept spent, since the transfer may
    /// have happened.
    Unconfirmed,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct NearOperation {
    pub op_id: OperationId,
    pub member: AccountId,
    pub role: String,
    pub request: NearTransferRequest,
    pub consumption: AllowanceConsumption,
    pub state: NearOperationState,
    pub created_at_ns: U64,
}

#[near(serializers = [json])]
pub struct NearCheck {
    pub allowed: bool,
    pub reason: Option<String>,
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key)
        .map(|bytes| T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("ERR_NEAR_STATE")))
}
fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(
        key,
        &borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("ERR_NEAR_STATE")),
    );
}
fn key(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    [prefix, suffix].concat()
}
pub(crate) fn permissions_of(role: &str) -> Vec<NearPermission> {
    read(&key(KEY_PERMISSIONS, role.as_bytes())).unwrap_or_default()
}
pub(crate) fn set_permissions(role: &str, permissions: Vec<NearPermission>) {
    let storage_key = key(KEY_PERMISSIONS, role.as_bytes());
    if permissions.is_empty() {
        env::storage_remove(&storage_key);
    } else {
        write(&storage_key, &permissions);
    }
}
pub(crate) fn validate_permissions(permissions: &[NearPermission]) {
    require!(permissions.len() <= MAX_PERMISSIONS, "ERR_NEAR_PERMISSIONS");
    let vault = env::current_account_id();
    for permission in permissions {
        require!(
            !permission.receivers.is_empty() && permission.receivers.len() <= MAX_RECEIVERS,
            "ERR_NEAR_RECEIVERS"
        );
        require!(
            permission.min_per_transfer.0 > 0
                && permission.min_per_transfer.0 <= permission.max_per_transfer.0,
            "ERR_NEAR_MIN_PER_TRANSFER"
        );
        require!(
            permission.token != vault && !permission.receivers.contains(&vault),
            "ERR_NEAR_SELF"
        );
    }
}
fn operation(op_id: &OperationId) -> NearOperation {
    read(&key(KEY_OPERATION, op_id)).unwrap_or_else(|| env::panic_str("ERR_OPERATION_NOT_FOUND"))
}
fn store(op: &NearOperation) {
    write(&key(KEY_OPERATION, &op.op_id), op);
}

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[allow(dead_code)]
#[ext_contract(ext_near_self)]
trait ExtNearSelf {
    fn on_near_transfer(&mut self, op_id: OperationId);
}

/// DAO-voted registration of the vault on a token, so it can receive it.
pub(crate) fn storage_deposit(token: AccountId) -> Promise {
    ext_ft::ext(token)
        .with_attached_deposit(STORAGE_DEPOSIT)
        .with_static_gas(STORAGE_DEPOSIT_GAS)
        .storage_deposit(Some(env::current_account_id()), Some(true))
}

#[near]
impl Vault {
    pub fn get_near_permissions(&self, role: String) -> Vec<NearPermission> {
        permissions_of(&role)
    }

    pub fn get_near_operation(&self, op_id: OperationId) -> Option<NearOperation> {
        read(&key(KEY_OPERATION, &op_id))
    }

    /// The NEAR token transfer an agent started with this reference, if any.
    pub fn get_near_operation_by_reference(
        &self,
        role: String,
        reference: String,
    ) -> Option<NearOperation> {
        self.references
            .get(&ReferenceKey { role, reference })
            .and_then(|op_id| read(&key(KEY_OPERATION, op_id)))
    }

    /// Dry run: would `execute_near` accept this from `member`?
    pub fn check_near(
        &self,
        role: String,
        member: AccountId,
        request: NearTransferRequest,
    ) -> NearCheck {
        match self.near_permission(&role, &member, &request, env::block_timestamp()) {
            Ok(_) => NearCheck {
                allowed: true,
                reason: None,
            },
            Err(reason) => NearCheck {
                allowed: false,
                reason: Some(reason.to_owned()),
            },
        }
    }

    /// Agent: checked, charged to the budget, then `ft_transfer` from the vault.
    pub fn execute_near(&mut self, role: String, request: NearTransferRequest) -> Promise {
        self.assert_not_paused();
        require!(
            env::prepaid_gas()
                >= FT_TRANSFER_GAS
                    .saturating_add(FT_CALLBACK_GAS)
                    .saturating_add(EXECUTE_OVERHEAD_GAS),
            "ERR_NEAR_CALLBACK_GAS"
        );
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let allowance = self
            .near_permission(&role, &member, &request, now)
            .unwrap_or_else(|reason| env::panic_str(&format!("ERR_PERMISSION_DENIED:{reason}")));

        // Same accounting as EVM and Solana: budget, membership use, role in use, reference.
        let amount = request.amount.0;
        let budget = self
            .allowances
            .get_mut(&allowance)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        Self::refill_allowance(budget, now);
        require!(
            amount <= budget.balance.0.saturating_sub(budget.reserved.0),
            "ERR_ALLOWANCE_EXCEEDED"
        );
        budget.reserved = U128(budget.reserved.0.saturating_add(amount));
        self.reserve_membership_use(&MembershipKey {
            role: role.clone(),
            member: member.clone(),
        });
        let reservations = self.role_reservations.entry(role.clone()).or_insert(0);
        *reservations = reservations.saturating_add(1);
        let reference_key = ReferenceKey {
            role: role.clone(),
            reference: request.reference.clone(),
        };
        require!(
            !self.references.contains_key(&reference_key),
            "ERR_REFERENCE_ALREADY_USED"
        );

        let op_id = self.next_operation_id(&member, 0);
        self.references.insert(reference_key, op_id);
        store(&NearOperation {
            op_id,
            member,
            role,
            consumption: AllowanceConsumption {
                key: allowance,
                amount: U128(amount),
                calls_only: false,
            },
            request: request.clone(),
            state: NearOperationState::Pending,
            created_at_ns: U64(now),
        });
        env::log_str(&format!("OMNIROLES_NEAR_OPERATION:{}", hex::encode(op_id)));
        ext_ft::ext(request.token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(request.receiver_id, request.amount, request.memo)
            .then(
                ext_near_self::ext(env::current_account_id())
                    .with_static_gas(FT_CALLBACK_GAS)
                    .on_near_transfer(op_id),
            )
    }

    /// Success spends the budget; failure releases it. The reference stays used.
    #[private]
    pub fn on_near_transfer(&mut self, op_id: OperationId) -> NearOperationState {
        let op = operation(&op_id);
        require!(op.state == NearOperationState::Pending, "ERR_NOT_PENDING");
        let succeeded = env::promise_result_checked(0, 1024).is_ok();
        let state = if succeeded {
            NearOperationState::Confirmed
        } else {
            NearOperationState::Failed
        };
        self.release_near(op, state.clone());
        state
    }

    /// Anyone, after the unconfirmed timeout, for an operation whose callback
    /// never ran: frees the role and the membership, keeps the budget spent.
    pub fn release_near_unconfirmed(&mut self, op_id: OperationId) {
        let op = operation(&op_id);
        require!(op.state == NearOperationState::Pending, "ERR_NOT_PENDING");
        require!(
            env::block_timestamp()
                >= op
                    .created_at_ns
                    .0
                    .saturating_add(self.settlement_config.unconfirmed_after_ns.0),
            "ERR_UNCONFIRMED_TOO_EARLY"
        );
        self.release_near(op, NearOperationState::Unconfirmed);
    }
}

impl Vault {
    fn near_permission(
        &self,
        role: &str,
        member: &AccountId,
        request: &NearTransferRequest,
        now: u64,
    ) -> Result<AllowanceKey, &'static str> {
        if self.paused {
            return Err("ERR_PAUSED");
        }
        if request.reference.is_empty() {
            return Err("ERR_EMPTY_REFERENCE");
        }
        if request
            .memo
            .as_ref()
            .is_some_and(|memo| memo.chars().count() > MAX_MEMO_CHARS)
        {
            return Err("ERR_MEMO_TOO_LONG");
        }
        let state = self.roles.get(role).ok_or("ERR_ROLE_NOT_FOUND")?;
        if !state.config.enabled {
            return Err("ERR_ROLE_DISABLED");
        }
        if state.config.guard_required {
            return Err("ERR_VISA_REQUIRED");
        }
        let membership = self
            .memberships
            .get(&MembershipKey {
                role: role.to_owned(),
                member: member.clone(),
            })
            .ok_or("ERR_MEMBERSHIP_NOT_FOUND")?;
        if !membership.active
            || now < membership.starts_at_ns.0
            || membership.ends_at_ns.is_some_and(|end| now > end.0)
            || membership.max_uses.is_some_and(|max| {
                membership
                    .used_uses
                    .saturating_add(membership.reserved_uses)
                    >= max
            })
        {
            return Err("ERR_MEMBERSHIP_UNAVAILABLE");
        }
        if request.amount.0 == 0 {
            return Err("ERR_ZERO_AMOUNT");
        }
        if request.receiver_id == env::current_account_id() {
            return Err("ERR_SELF_TRANSFER");
        }
        let permissions = permissions_of(role);
        if !permissions.iter().any(|p| p.token == request.token) {
            return Err("TokenNotAllowed");
        }
        let permission = permissions
            .into_iter()
            .find(|p| p.token == request.token && p.receivers.contains(&request.receiver_id))
            .ok_or("FunctionNotAllowed")?;
        if request.amount.0 < permission.min_per_transfer.0 {
            return Err("ERR_MIN_PER_TRANSFER");
        }
        if request.amount.0 > permission.max_per_transfer.0 {
            return Err("ERR_MAX_PER_TRANSFER");
        }
        let mut budget = self
            .allowances
            .get(&permission.allowance)
            .ok_or("ERR_ALLOWANCE_NOT_FOUND")?
            .clone();
        Self::refill_allowance(&mut budget, now);
        if request.amount.0 > budget.balance.0.saturating_sub(budget.reserved.0) {
            return Err("ERR_ALLOWANCE_EXCEEDED");
        }
        Ok(permission.allowance)
    }

    fn release_near(&mut self, mut op: NearOperation, terminal: NearOperationState) {
        let failed = terminal == NearOperationState::Failed;
        // Confirmed, or unknown (Unconfirmed): the tokens may have left, so the
        // budget and the membership use stay spent.
        let confirmed = !failed;
        let reservations = self
            .role_reservations
            .get_mut(&op.role)
            .expect("ERR_ROLE_RESERVATION_MISSING");
        *reservations = reservations.saturating_sub(1);
        let membership = self
            .memberships
            .get_mut(&MembershipKey {
                role: op.role.clone(),
                member: op.member.clone(),
            })
            .expect("ERR_MEMBERSHIP_NOT_FOUND");
        membership.reserved_uses = membership.reserved_uses.saturating_sub(1);
        if confirmed {
            membership.used_uses = membership.used_uses.saturating_add(1);
        }
        let budget = self
            .allowances
            .get_mut(&op.consumption.key)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        budget.reserved = U128(budget.reserved.0.saturating_sub(op.consumption.amount.0));
        if confirmed {
            budget.balance = U128(budget.balance.0.saturating_sub(op.consumption.amount.0));
        }
        let label = match terminal {
            NearOperationState::Confirmed => "CONFIRMED",
            NearOperationState::Unconfirmed => "UNCONFIRMED",
            _ => "FAILED",
        };
        op.state = terminal;
        store(&op);
        env::log_str(&format!("OMNIROLES_NEAR_{label}:{}", hex::encode(op.op_id)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};

    const TOKEN: &str = "usdc.testnet";
    const CARD: &str = "card.testnet";
    const AGENT: &str = "agent.testnet";
    const BUDGET: AllowanceKey = [9; 32];
    const SIX_HOURS: u64 = 21_600_000_000_000;

    fn context(caller: &str, now: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("vault.testnet".parse().unwrap())
                .predecessor_account_id(caller.parse().unwrap())
                .signer_account_id(caller.parse().unwrap())
                .block_timestamp(now)
                .prepaid_gas(Gas::from_tgas(300))
                .build()
        );
    }

    fn permission(min: u128, max: u128) -> NearPermission {
        NearPermission {
            token: TOKEN.parse().unwrap(),
            receivers: vec![CARD.parse().unwrap()],
            allowance: BUDGET,
            min_per_transfer: U128(min),
            max_per_transfer: U128(max),
        }
    }

    fn vault() -> Vault {
        near_sdk::mock::with_mocked_blockchain(|b| {
            b.take_storage();
        });
        context("owner.testnet", 1);
        let mut v = Vault::new(
            "acme".into(),
            "owner.testnet".parse().unwrap(),
            "mpc.testnet".parse().unwrap(),
            Base64VecU8(vec![7; 32]),
            Base64VecU8(vec![8; 32]),
            1,
            1,
            1_000_000_000,
            10,
            100,
            vec!["council.testnet".parse().unwrap()],
            None,
        );
        v.apply_rule_change(
            RuleChange::SetRole {
                role: "cards".into(),
                config: Vault::dao_gas_config(),
            },
            1,
        );
        v.apply_rule_change(
            RuleChange::GrantMembership {
                role: "cards".into(),
                member: AGENT.parse().unwrap(),
                kind: MembershipKind::Agent,
                starts_at_ns: U64(0),
                ends_at_ns: None,
                max_uses: None,
            },
            1,
        );
        v.apply_rule_change(
            RuleChange::SetAllowance {
                key: BUDGET,
                balance: U128(10_000_000),
                refill: U128(0),
                max_refill: U128(10_000_000),
                period_ns: 0,
            },
            1,
        );
        let permissions = vec![permission(1_000_000, 5_000_000)];
        validate_permissions(&permissions);
        v.apply_rule_change(
            RuleChange::SetNearPermissions {
                role: "cards".into(),
                permissions,
            },
            1,
        );
        v
    }

    fn request(amount: u128, reference: &str) -> NearTransferRequest {
        NearTransferRequest {
            token: TOKEN.parse().unwrap(),
            receiver_id: CARD.parse().unwrap(),
            amount: U128(amount),
            memo: None,
            reference: reference.into(),
        }
    }

    #[test]
    fn transfers_below_the_floor_are_refused() {
        let v = vault();
        context(AGENT, 2);
        let check = v.check_near(
            "cards".into(),
            AGENT.parse().unwrap(),
            request(999_999, "tiny"),
        );
        assert!(!check.allowed);
        assert_eq!(check.reason.as_deref(), Some("ERR_MIN_PER_TRANSFER"));
        let check = v.check_near(
            "cards".into(),
            AGENT.parse().unwrap(),
            request(1_000_000, "floor"),
        );
        assert!(check.allowed);
    }

    #[test]
    #[should_panic(expected = "ERR_PERMISSION_DENIED:ERR_MIN_PER_TRANSFER")]
    fn execute_refuses_below_the_floor() {
        let mut v = vault();
        context(AGENT, 2);
        let _ = v.execute_near("cards".into(), request(1, "dust"));
    }

    #[test]
    #[should_panic(expected = "ERR_NEAR_MIN_PER_TRANSFER")]
    fn floor_must_be_positive() {
        validate_permissions(&[permission(0, 5_000_000)]);
    }

    #[test]
    #[should_panic(expected = "ERR_NEAR_MIN_PER_TRANSFER")]
    fn floor_cannot_exceed_the_cap() {
        validate_permissions(&[permission(6_000_000, 5_000_000)]);
    }

    fn pending_operation(v: &mut Vault) -> OperationId {
        context(AGENT, 2);
        let _ = v.execute_near("cards".into(), request(2_000_000, "card-refill"));
        let op = v
            .get_near_operation_by_reference("cards".into(), "card-refill".into())
            .expect("operation stored");
        assert_eq!(op.state, NearOperationState::Pending);
        assert_eq!(v.allowances.get(&BUDGET).unwrap().reserved.0, 2_000_000);
        op.op_id
    }

    #[test]
    #[should_panic(expected = "ERR_UNCONFIRMED_TOO_EARLY")]
    fn stuck_operation_cannot_be_released_early() {
        let mut v = vault();
        let id = pending_operation(&mut v);
        context("stranger.testnet", 3);
        v.release_near_unconfirmed(id);
    }

    #[test]
    fn stuck_operation_is_released_with_the_budget_kept_spent() {
        let mut v = vault();
        let id = pending_operation(&mut v);
        context("stranger.testnet", 2 + SIX_HOURS + 1);
        v.release_near_unconfirmed(id);
        let op = v.get_near_operation(id).unwrap();
        assert_eq!(op.state, NearOperationState::Unconfirmed);
        let budget = v.allowances.get(&BUDGET).unwrap();
        assert_eq!(budget.reserved.0, 0);
        assert_eq!(budget.balance.0, 8_000_000);
        assert_eq!(*v.role_reservations.get("cards").unwrap(), 0);
        let membership = v
            .memberships
            .get(&MembershipKey {
                role: "cards".into(),
                member: AGENT.parse().unwrap(),
            })
            .unwrap();
        assert_eq!(membership.reserved_uses, 0);
        assert_eq!(membership.used_uses, 1);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_PENDING")]
    fn released_operation_cannot_be_released_twice() {
        let mut v = vault();
        let id = pending_operation(&mut v);
        context("stranger.testnet", 2 + SIX_HOURS + 1);
        v.release_near_unconfirmed(id);
        v.release_near_unconfirmed(id);
    }
}
