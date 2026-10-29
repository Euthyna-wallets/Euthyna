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
            permission.max_per_transfer.0 > 0,
            "ERR_NEAR_MAX_PER_TRANSFER"
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
        let confirmed = terminal == NearOperationState::Confirmed;
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
        op.state = terminal;
        store(&op);
        env::log_str(&format!(
            "OMNIROLES_NEAR_{}:{}",
            if confirmed { "CONFIRMED" } else { "FAILED" },
            hex::encode(op.op_id)
        ));
    }
}
