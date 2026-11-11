//! Solana: the company wallet is an ed25519 key derived by NEAR MPC (domain 1).
//! Agents send SOL or SPL tokens to allowed recipients within a budget; the
//! vault builds the exact transaction, MPC signs it, and settlement is an MPC
//! attestation that the transaction succeeded at `Finalized` on Solana.
//!
//! Stored under raw keys (not new struct fields), so the vault's state layout
//! is unchanged and existing vaults can move to this version by a DAO upgrade.
use crate::*;
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

pub type SolanaAddress = [u8; 32];

/// When a Solana transaction that has not landed can be released: its blockhash (older than the
/// signature) is long expired by then, with margin for slow slots (150 blocks is 1-2 minutes).
pub const SOLANA_EXPIRED_AFTER_NS: u64 = 15 * 60 * 1_000_000_000;

pub const SOLANA_DOMAIN_ID: u64 = 1;
const SOLANA_PATH: &str = "omniroles/solana";
const MAX_RECIPIENTS: usize = 32;
const MAX_PERMISSIONS: usize = 16;

pub const SYSTEM_PROGRAM: SolanaAddress = [0; 32];
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM: SolanaAddress = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];
/// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
pub const TOKEN_2022_PROGRAM: SolanaAddress = [
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
];

/// The program of an SPL mint. A Token-2022 mint (Noah's sandbox EURC) takes TransferChecked,
/// with its decimals: plain Transfer is refused when the mint has a transfer-fee config. Given by
/// the caller (the vault cannot read Solana): a wrong program or decimals only makes the
/// transaction fail, it cannot send elsewhere (the accounts are derived from the recipient).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenProgram {
    Classic,
    Token2022 { decimals: u8 },
}

impl TokenProgram {
    fn id(self) -> SolanaAddress {
        match self {
            TokenProgram::Classic => TOKEN_PROGRAM,
            TokenProgram::Token2022 { .. } => TOKEN_2022_PROGRAM,
        }
    }
}

/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const ASSOCIATED_TOKEN_PROGRAM: SolanaAddress = [
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
];

const KEY_WALLET: &[u8] = b"sol:w";
const KEY_PERMISSIONS: &[u8] = b"sol:p:";
const KEY_OPERATION: &[u8] = b"sol:o:";

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh, json])]
pub enum SolanaAsset {
    Sol,
    Spl { mint: SolanaAddress },
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SolanaPermission {
    pub asset: SolanaAsset,
    /// Wallet owners that may receive (for SPL: their associated token account).
    pub recipients: Vec<SolanaAddress>,
    /// Budget charged with the amount (lamports or token base units).
    pub allowance: AllowanceKey,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SolanaWallet {
    pub mpc_path: String,
    pub address: Option<SolanaAddress>,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SolanaTransferRequest {
    pub asset: SolanaAsset,
    pub to: SolanaAddress,
    pub amount: U64,
    /// Untrusted liveness hint: a stale one only makes the transaction expire.
    pub recent_blockhash: [u8; 32],
    pub reference: String,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct SolanaOperation {
    pub op_id: OperationId,
    pub member: AccountId,
    pub role: String,
    pub request: SolanaTransferRequest,
    pub consumption: AllowanceConsumption,
    /// The exact message MPC signs.
    pub message: Vec<u8>,
    pub signature: Option<Vec<u8>>,
    /// Wire transaction to broadcast (signatures + message).
    pub signed_transaction: Option<Vec<u8>>,
    pub state: OperationState,
    pub signed_at_ns: U64,
}

#[near(serializers = [json])]
pub struct SolanaCheck {
    pub allowed: bool,
    pub reason: Option<String>,
}

fn read<T: BorshDeserialize>(key: &[u8]) -> Option<T> {
    env::storage_read(key).map(|bytes| {
        T::try_from_slice(&bytes).unwrap_or_else(|_| env::panic_str("ERR_SOLANA_STATE"))
    })
}
fn write<T: BorshSerialize>(key: &[u8], value: &T) {
    env::storage_write(
        key,
        &borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("ERR_SOLANA_STATE")),
    );
}
fn key(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    [prefix, suffix].concat()
}
pub(crate) fn permissions_of(role: &str) -> Vec<SolanaPermission> {
    read(&key(KEY_PERMISSIONS, role.as_bytes())).unwrap_or_default()
}
pub(crate) fn set_permissions(role: &str, permissions: Vec<SolanaPermission>) {
    let storage_key = key(KEY_PERMISSIONS, role.as_bytes());
    if permissions.is_empty() {
        env::storage_remove(&storage_key);
    } else {
        write(&storage_key, &permissions);
    }
}
pub(crate) fn validate_permissions(permissions: &[SolanaPermission]) {
    require!(
        permissions.len() <= MAX_PERMISSIONS,
        "ERR_SOLANA_PERMISSIONS"
    );
    for permission in permissions {
        require!(
            !permission.recipients.is_empty() && permission.recipients.len() <= MAX_RECIPIENTS,
            "ERR_SOLANA_RECIPIENTS"
        );
    }
}
fn wallet() -> Option<SolanaWallet> {
    read(KEY_WALLET)
}
fn operation(op_id: &OperationId) -> SolanaOperation {
    read(&key(KEY_OPERATION, op_id)).unwrap_or_else(|| env::panic_str("ERR_OPERATION_NOT_FOUND"))
}
fn store(op: &SolanaOperation) {
    write(&key(KEY_OPERATION, &op.op_id), op);
}

// ---------------------------------------------------------------------------
// Transaction encoding (legacy message)
// ---------------------------------------------------------------------------

fn compact(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

struct Instruction {
    program: usize,
    accounts: Vec<u8>,
    data: Vec<u8>,
}

/// Keys: [fee payer (signer, writable), writable..., readonly...].
fn message(
    keys: &[SolanaAddress],
    readonly: usize,
    blockhash: [u8; 32],
    instructions: &[Instruction],
) -> Vec<u8> {
    let mut out = vec![1, 0, readonly as u8];
    compact(&mut out, keys.len());
    for key in keys {
        out.extend_from_slice(key);
    }
    out.extend_from_slice(&blockhash);
    compact(&mut out, instructions.len());
    for instruction in instructions {
        out.push(instruction.program as u8);
        compact(&mut out, instruction.accounts.len());
        out.extend_from_slice(&instruction.accounts);
        compact(&mut out, instruction.data.len());
        out.extend_from_slice(&instruction.data);
    }
    out
}

/// True when 32 bytes decode to a point on ed25519 (a PDA must not).
fn on_curve(bytes: &[u8; 32]) -> bool {
    curve25519_dalek::edwards::CompressedEdwardsY(*bytes)
        .decompress()
        .is_some()
}

pub fn associated_token_account(owner: &SolanaAddress, mint: &SolanaAddress) -> SolanaAddress {
    associated_token_account_of(owner, mint, TOKEN_PROGRAM)
}

/// The associated token account for a given token program (its id is one of the seeds).
pub fn associated_token_account_of(owner: &SolanaAddress, mint: &SolanaAddress, program: SolanaAddress) -> SolanaAddress {
    for bump in (0..=255u8).rev() {
        let mut seed = Vec::with_capacity(32 * 4 + 1 + 21);
        seed.extend_from_slice(owner);
        seed.extend_from_slice(&program);
        seed.extend_from_slice(mint);
        seed.push(bump);
        seed.extend_from_slice(&ASSOCIATED_TOKEN_PROGRAM);
        seed.extend_from_slice(b"ProgramDerivedAddress");
        let candidate = env::sha256_array(&seed);
        if !on_curve(&candidate) {
            return candidate;
        }
    }
    env::panic_str("ERR_NO_PDA")
}

/// The exact message for a transfer from `from`.
pub fn transfer_message(from: SolanaAddress, request: &SolanaTransferRequest) -> Vec<u8> {
    transfer_message_with(from, request, TokenProgram::Classic)
}

pub fn transfer_message_with(from: SolanaAddress, request: &SolanaTransferRequest, program: TokenProgram) -> Vec<u8> {
    let amount = request.amount.0.to_le_bytes();
    match &request.asset {
        SolanaAsset::Sol => {
            let mut data = vec![2, 0, 0, 0];
            data.extend_from_slice(&amount);
            message(
                &[from, request.to, SYSTEM_PROGRAM],
                1,
                request.recent_blockhash,
                &[Instruction {
                    program: 2,
                    accounts: vec![0, 1],
                    data,
                }],
            )
        }
        SolanaAsset::Spl { mint } => {
            let destination = associated_token_account_of(&request.to, mint, program.id());
            let source = associated_token_account_of(&from, mint, program.id());
            // Transfer (3): source, destination, owner. TransferChecked (12): source, mint,
            // destination, owner, and the decimals after the amount.
            let (data, accounts) = match program {
                TokenProgram::Classic => {
                    let mut data = vec![3];
                    data.extend_from_slice(&amount);
                    (data, vec![2, 1, 0])
                }
                TokenProgram::Token2022 { decimals } => {
                    let mut data = vec![12];
                    data.extend_from_slice(&amount);
                    data.push(decimals);
                    (data, vec![2, 4, 1, 0])
                }
            };
            message(
                &[
                    from,
                    destination,
                    source,
                    request.to,
                    *mint,
                    SYSTEM_PROGRAM,
                    program.id(),
                    ASSOCIATED_TOKEN_PROGRAM,
                ],
                5,
                request.recent_blockhash,
                &[
                    // Create the recipient's token account if missing (paid by the wallet).
                    Instruction {
                        program: 7,
                        accounts: vec![0, 1, 3, 4, 5, 6],
                        data: vec![1],
                    },
                    Instruction {
                        program: 6,
                        accounts,
                        data,
                    },
                ],
            )
        }
    }
}

/// V1 payload MPC signs for a Solana transaction (by signature), no extracted value.
pub(crate) fn payload_hash(signature: &[u8]) -> [u8; 32] {
    // V1=0; Solana=2; SvmTxId(64); Finalized=1; extractors: u32 0; values: u32 0.
    let mut p = vec![0, 2];
    p.extend_from_slice(signature);
    p.push(1);
    p.extend(0u32.to_le_bytes());
    p.extend(0u32.to_le_bytes());
    env::sha256_array(&p)
}

fn base58_key(public_key: &str) -> SolanaAddress {
    let encoded = public_key
        .strip_prefix("ed25519:")
        .unwrap_or_else(|| env::panic_str("ERR_NOT_ED25519_KEY"));
    bs58::decode(encoded)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str("ERR_BAD_ED25519_KEY"))
}

// ---------------------------------------------------------------------------
// Contract methods
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[ext_contract(ext_solana_self)]
trait ExtSolanaSelf {
    fn on_solana_public_key(&mut self);
    fn on_solana_signature(&mut self, op_id: OperationId);
    fn on_solana_settled(&mut self, op_id: OperationId, expected_payload_hash: [u8; 32]);
}

#[near]
impl Vault {
    pub fn get_solana_wallet(&self) -> Option<SolanaWallet> {
        wallet()
    }

    pub fn get_solana_permissions(&self, role: String) -> Vec<SolanaPermission> {
        permissions_of(&role)
    }

    pub fn get_solana_operation(&self, op_id: OperationId) -> Option<SolanaOperation> {
        read(&key(KEY_OPERATION, &op_id))
    }

    /// The Solana operation an agent started with this reference, if any.
    pub fn get_solana_operation_by_reference(
        &self,
        role: String,
        reference: String,
    ) -> Option<SolanaOperation> {
        self.references
            .get(&ReferenceKey { role, reference })
            .and_then(|op_id| read(&key(KEY_OPERATION, op_id)))
    }

    /// DAO only: derive the company's Solana address (MPC ed25519 domain).
    pub fn request_solana_wallet(&mut self) -> Promise {
        self.assert_owner();
        if let Some(existing) = wallet() {
            require!(existing.address.is_none(), "ERR_WALLET_ALREADY_DERIVED");
        }
        write(
            KEY_WALLET,
            &SolanaWallet {
                mpc_path: SOLANA_PATH.to_owned(),
                address: None,
            },
        );
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_static_gas(MPC_DERIVE_GAS)
            .derived_public_key(
                SOLANA_PATH.to_owned(),
                Some(env::current_account_id()),
                Some(SOLANA_DOMAIN_ID),
            )
            .then(
                ext_solana_self::ext(env::current_account_id())
                    .with_static_gas(MPC_DERIVE_CALLBACK_GAS)
                    .on_solana_public_key(),
            )
    }

    #[private]
    pub fn on_solana_public_key(
        &mut self,
        #[callback_result] result: Result<String, PromiseError>,
    ) {
        let address =
            base58_key(&result.unwrap_or_else(|_| env::panic_str("ERR_DERIVE_KEY_FAILED")));
        write(
            KEY_WALLET,
            &SolanaWallet {
                mpc_path: SOLANA_PATH.to_owned(),
                address: Some(address),
            },
        );
        env::log_str(&format!(
            "OMNIROLES_SOLANA_WALLET:{}",
            bs58::encode(address).into_string()
        ));
    }

    /// Dry run: would `execute_solana` accept this from `member`?
    pub fn check_solana(
        &self,
        role: String,
        member: AccountId,
        request: SolanaTransferRequest,
    ) -> SolanaCheck {
        match self.solana_permission(&role, &member, &request, env::block_timestamp()) {
            Ok(_) => SolanaCheck {
                allowed: true,
                reason: None,
            },
            Err(reason) => SolanaCheck {
                allowed: false,
                reason: Some(reason.to_owned()),
            },
        }
    }

    /// Agent: checked, charged to the budget and signed in one call, so the
    /// blockhash is still fresh when the signature comes back.
    pub fn execute_solana(
        &mut self,
        role: String,
        request: SolanaTransferRequest,
        token_2022_decimals: Option<u8>,
    ) -> Promise {
        self.assert_not_paused();
        let member = env::predecessor_account_id();
        let now = env::block_timestamp();
        let allowance = self
            .solana_permission(&role, &member, &request, now)
            .unwrap_or_else(|reason| env::panic_str(&format!("ERR_PERMISSION_DENIED:{reason}")));
        let from = wallet()
            .and_then(|w| w.address)
            .expect("ERR_WALLET_NOT_DERIVED");

        // Same accounting as EVM operations: budget, membership use, role in use, reference.
        let amount = u128::from(request.amount.0);
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
        let membership_key = MembershipKey {
            role: role.clone(),
            member: member.clone(),
        };
        self.reserve_membership_use(&membership_key);
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
        let program = match (token_2022_decimals, &request.asset) {
            (Some(decimals), SolanaAsset::Spl { .. }) => TokenProgram::Token2022 { decimals },
            _ => TokenProgram::Classic,
        };
        let message = transfer_message_with(from, &request, program);
        require!(message.len() <= 1232 - 65, "ERR_SOLANA_TX_TOO_LARGE");
        store(&SolanaOperation {
            op_id,
            member,
            role,
            consumption: AllowanceConsumption {
                key: allowance,
                amount: U128(amount),
                calls_only: false,
            },
            request,
            message: message.clone(),
            signature: None,
            signed_transaction: None,
            state: OperationState::PossiblySigned,
            signed_at_ns: U64(now),
        });
        env::log_str(&format!(
            "OMNIROLES_SOLANA_OPERATION:{}",
            hex::encode(op_id)
        ));
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(MPC_SIGN_DEPOSIT)
            .with_static_gas(MPC_SIGN_GAS)
            .sign(MpcSignRequest {
                path: SOLANA_PATH.to_owned(),
                payload_v2: MpcPayload::Eddsa(hex::encode(&message)),
                domain_id: SOLANA_DOMAIN_ID,
            })
            .then(
                ext_solana_self::ext(env::current_account_id())
                    .with_static_gas(MPC_CALLBACK_GAS)
                    .on_solana_signature(op_id),
            )
    }

    #[private]
    pub fn on_solana_signature(
        &mut self,
        op_id: OperationId,
        #[callback_result] result: Result<MpcSignatureResponse, PromiseError>,
    ) {
        let mut op = operation(&op_id);
        let Ok(MpcSignatureResponse::Ed25519 { signature }) = result else {
            return;
        };
        let from = wallet()
            .and_then(|w| w.address)
            .expect("ERR_WALLET_NOT_DERIVED");
        let Ok(signature64) = <[u8; 64]>::try_from(signature.as_slice()) else {
            return;
        };
        // Only a signature by the company key over this exact message is kept.
        if !env::ed25519_verify(&signature64, &op.message, &from) {
            return;
        }
        let mut wire = vec![1];
        wire.extend_from_slice(&signature64);
        wire.extend_from_slice(&op.message);
        op.signature = Some(signature64.to_vec());
        op.signed_transaction = Some(wire);
        store(&op);
    }

    /// Anyone: ask MPC to attest the transaction succeeded at `Finalized`.
    pub fn settle_solana(&mut self, op_id: OperationId) -> Promise {
        let op = operation(&op_id);
        require!(
            op.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let signature = op.signature.expect("ERR_SIGNATURE_MISSING");
        let expected = payload_hash(&signature);
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .verify_foreign_transaction(foreign::VerifyArgs::new(
                near_sdk::serde_json::json!({"Solana": {"tx_id": hex::encode(&signature), "finality": "Finalized", "extractors": []}}),
                self.settlement_config.foreign_tx_domain_id,
                hex::encode(expected),
            ))
            .then(
                ext_solana_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_solana_settled(op_id, expected),
            )
    }

    #[private]
    pub fn on_solana_settled(
        &mut self,
        op_id: OperationId,
        expected_payload_hash: [u8; 32],
        #[callback_result] result: Result<foreign::VerifyResponse, PromiseError>,
    ) {
        let op = operation(&op_id);
        if op.state != OperationState::PossiblySigned {
            return;
        }
        if result.is_ok_and(|response| response.payload_hash == hex::encode(expected_payload_hash))
        {
            self.release_solana(op, OperationState::Confirmed);
        }
    }

    /// Anyone, once the transaction can no longer land: the budget stays spent.
    ///
    /// A Solana transaction is valid for 150 blocks after its blockhash (one to two minutes), and the
    /// blockhash existed before the vault signed: the message has no durable nonce (the vault builds
    /// it). So `SOLANA_EXPIRED_AFTER_NS` after signing, a transaction that has not landed never
    /// will, and the role is freed then rather than after the settlement timeout.
    pub fn release_solana_unconfirmed(&mut self, op_id: OperationId) {
        let op = operation(&op_id);
        require!(
            op.state == OperationState::PossiblySigned,
            "ERR_NOT_POSSIBLY_SIGNED"
        );
        let after = self
            .settlement_config
            .unconfirmed_after_ns
            .0
            .min(SOLANA_EXPIRED_AFTER_NS);
        require!(
            env::block_timestamp() >= op.signed_at_ns.0.saturating_add(after),
            "ERR_UNCONFIRMED_TOO_EARLY"
        );
        self.release_solana(op, OperationState::Unconfirmed);
    }
}

impl Vault {
    fn solana_permission(
        &self,
        role: &str,
        member: &AccountId,
        request: &SolanaTransferRequest,
        now: u64,
    ) -> Result<AllowanceKey, &'static str> {
        if self.paused {
            return Err("ERR_PAUSED");
        }
        if request.reference.is_empty() {
            return Err("ERR_EMPTY_REFERENCE");
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
        let from = wallet()
            .and_then(|w| w.address)
            .ok_or("ERR_WALLET_NOT_DERIVED")?;
        if request.amount.0 == 0 {
            return Err("ERR_ZERO_AMOUNT");
        }
        if request.to == from {
            return Err("ERR_SELF_TRANSFER");
        }
        let permission = permissions_of(role)
            .into_iter()
            .find(|permission| {
                permission.asset == request.asset && permission.recipients.contains(&request.to)
            })
            .ok_or("FunctionNotAllowed")?;
        let budget = self
            .allowances
            .get(&permission.allowance)
            .ok_or("ERR_ALLOWANCE_NOT_FOUND")?;
        let mut budget = budget.clone();
        Self::refill_allowance(&mut budget, now);
        if u128::from(request.amount.0) > budget.balance.0.saturating_sub(budget.reserved.0) {
            return Err("allowanceExceeded");
        }
        Ok(permission.allowance)
    }

    fn release_solana(&mut self, mut op: SolanaOperation, terminal: OperationState) {
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
        membership.used_uses = membership.used_uses.saturating_add(1);
        let budget = self
            .allowances
            .get_mut(&op.consumption.key)
            .expect("ERR_ALLOWANCE_NOT_FOUND");
        budget.reserved = U128(budget.reserved.0.saturating_sub(op.consumption.amount.0));
        budget.balance = U128(budget.balance.0.saturating_sub(op.consumption.amount.0));
        op.state = terminal;
        store(&op);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_ids_decode_from_base58() {
        assert_eq!(
            bs58::decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
                .into_vec()
                .unwrap(),
            TOKEN_PROGRAM
        );
        assert_eq!(
            bs58::decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
                .into_vec()
                .unwrap(),
            ASSOCIATED_TOKEN_PROGRAM
        );
        assert_eq!(
            bs58::encode(SYSTEM_PROGRAM).into_string(),
            "11111111111111111111111111111111"
        );
    }

    /// Noah's sandbox EURC is a Token-2022 mint: the account the company wallet holds it in on
    /// devnet (read on chain) is the associated account under the Token-2022 program.
    #[test]
    fn token_2022_accounts_and_transfer_checked() {
        let decode = |text: &str| -> SolanaAddress { bs58::decode(text).into_vec().unwrap().try_into().unwrap() };
        let wallet = decode("D5Yc5dRE2odPFG9kKTj2rxFL6E1fvxiuSEUyvtSfgdrW");
        let mint = decode("7D6hWbuzWmEJJmWQ7iVz3p6oxiXoQwfTCVnsqZZ4AhnF");
        assert_eq!(bs58::encode(TOKEN_2022_PROGRAM).into_string(), "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        assert_eq!(
            bs58::encode(associated_token_account_of(&wallet, &mint, TOKEN_2022_PROGRAM)).into_string(),
            "DKEGUNxfn5wzo9TE6jYBKyPZtdP97DpZBm8RTh8z9owX"
        );
        let request = SolanaTransferRequest {
            asset: SolanaAsset::Spl { mint },
            to: [9; 32],
            amount: U64(1_000_000),
            recent_blockhash: [3; 32],
            reference: "r".into(),
        };
        let message = transfer_message_with(wallet, &request, TokenProgram::Token2022 { decimals: 6 });
        // Keys: wallet, destination, source, recipient, mint, system, Token-2022, ATA program.
        assert_eq!(&message[..4], &[1, 0, 5, 8]);
        assert_eq!(&message[4 + 32 * 6..4 + 32 * 7], &TOKEN_2022_PROGRAM);
        // Last instruction: program 6, accounts [source, mint, destination, owner],
        // TransferChecked (12), the amount, the decimals.
        let tail: Vec<u8> = [vec![6, 4, 2, 4, 1, 0, 10, 12], 1_000_000u64.to_le_bytes().to_vec(), vec![6]].concat();
        assert!(message.ends_with(&tail));
        // A classic mint is unchanged.
        assert_eq!(transfer_message_with(wallet, &request, TokenProgram::Classic), transfer_message(wallet, &request));
    }

    #[test]
    fn compact_u16_matches_solana() {
        let mut out = Vec::new();
        compact(&mut out, 0x7f);
        compact(&mut out, 0x80);
        compact(&mut out, 0x3fff);
        assert_eq!(out, vec![0x7f, 0x80, 0x01, 0xff, 0x7f]);
    }
}

#[cfg(test)]
mod fixtures {
    use super::*;

    // Decoded and checked with @solana/web3.js 1.x and @solana/spl-token 0.4:
    // fee payer, SystemProgram transfer of 1_000_000 lamports; create-idempotent
    // ATA then Token Transfer of 2_500_000 from the payer's ATA to the recipient's.
    const SOL: &str = "01000103070707070707070707070707070707070707070707070707070707070707070709090909090909090909090909090909090909090909090909090909090909090000000000000000000000000000000000000000000000000000000000000000030303030303030303030303030303030303030303030303030303030303030301020200010c0200000040420f0000000000";
    const SPL: &str = "01000508070707070707070707070707070707070707070707070707070707070707070768d8faa1d52e0499884f4423516717bf606be35593840a43f4e22bb17e6b085b2d110a48889329d55a18008a2804e57ae386af34b2e669344e1bee2d7c7a3be909090909090909090909090909090909090909090909090909090909090909090505050505050505050505050505050505050505050505050505050505050505000000000000000000000000000000000000000000000000000000000000000006ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a98c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f8590303030303030303030303030303030303030303030303030303030303030303020706000103040506010106030201000903a025260000000000";

    #[test]
    fn messages_match_the_solana_libraries() {
        let (from, to, mint) = ([7u8; 32], [9u8; 32], [5u8; 32]);
        let request = |asset| SolanaTransferRequest {
            asset,
            to,
            amount: U64(0),
            recent_blockhash: [3; 32],
            reference: "r".into(),
        };
        let sol = SolanaTransferRequest {
            amount: U64(1_000_000),
            ..request(SolanaAsset::Sol)
        };
        let spl = SolanaTransferRequest {
            amount: U64(2_500_000),
            ..request(SolanaAsset::Spl { mint })
        };
        assert_eq!(hex::encode(transfer_message(from, &sol)), SOL);
        assert_eq!(hex::encode(transfer_message(from, &spl)), SPL);
        // getAssociatedTokenAddressSync(mint, owner, true)
        assert_eq!(
            bs58::encode(associated_token_account(&to, &mint)).into_string(),
            "84HJHDLNnuLbpAaVq2Ktn6aVmhvFf8TbpvABhGvowQ58"
        );
        assert_eq!(
            bs58::encode(associated_token_account(&from, &mint)).into_string(),
            "42vRB9tuzVzm7KjUysvdV5ktptgz4ZaGRxvLBWnYXS7A"
        );
    }
}
