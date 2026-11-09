# Euthyna — OmniRoles architecture

## Authority

OmniRoles is the NEAR vault that authorizes an agent or human member's exact EVM transaction. Each chain has one MPC-derived wallet, one nonce stream and at most one active operation. The DAO owns the vault; governed changes pass through a veto window. Agents do not vote to exercise permissions already granted to their role.

An agent can use NEAR RPC and a public EVM RPC directly. The API, Guard, operation database, worker and relayer are optional for roles with `guard_required = false` (the default). The MCP server uses this direct path. The legacy API client remains available for roles that explicitly require Guard approval.

## Execution

1. `prepare(role, request)` checks membership, chain, target, selector, conditions, gas caps and budgets. It reserves allowance, velocity and membership use, and locks the chain wallet.
2. `authorize(op_id, approval)` accepts `null` for an unguarded role. Any supplied visa is verified and its nonce consumed. Guarded roles require a visa. Existing delay and human co-signature thresholds still apply.
3. Once ready, the vault advances the wallet nonce, marks the operation `PossiblySigned`, records its timestamp and asks NEAR MPC to sign the exact transaction. Delayed operations use `execute_queued_operation`.
4. The MPC callback stores the signed transaction. Anyone can broadcast those bytes. The direct client reads the operation from NEAR and submits the raw transaction to an EVM RPC.
5. After finalization, anyone calls `settle(op_id, block_hash)`. The block hash is an untrusted hint; it is bound into the payload the MPC must verify. A valid proof confirms the operation, consumes its reserved budget and frees the wallet.

The client validates the RPC chain id before preparing. The vault maps configured testnet/mainnet EVM chain ids explicitly to supported MPC chains. Unknown chains, including Ethereum while unavailable from MPC, cannot be settled through ForeignTx.

## Permissions and suppliers

Named address lists live in the vault. Names use `[a-z0-9_-]{1,32}`, labels contain at most 64 Unicode characters, and each list has at most 256 unique addresses. `AddListAddress` and `RemoveListAddress` use the normal DAO rule queue and veto window. Adding an existing address updates its label.

The pure condition engine receives an `AddressListSource`. `InAddressList` is operator 40, with Static encoding, no children and list-name bytes as its comparison value. It rejects dirty high bytes in an ABI address word. The suppliers transfer preset combines `InAddressList("suppliers")` with `WithinAllowance`; the calldata amount determines the charge.

The console proposes supplier changes to the DAO. Existing active Base suppliers can be proposed together in one migration vote when the on-chain list is empty. Migration uses one bounded `AddListAddresses` rule change, so a single vote queues the complete list and activation is atomic after its veto window. This avoids unbounded DAO action counts and cumulative gas reservations.

## Settlement and cancellation

The vault calls `verify_foreign_transaction` on its configured MPC account, using ForeignTx domain 3 by default, payload version 1, `[BlockHash]` extraction, `Finalized` finality, 1 yoctoNEAR and 15 Tgas. The private callback has 25 Tgas. These parameters were checked against `v1.signer-prod.testnet` and near/mpc interface commit `6326b7d5062fd4eb99afce8dc63c5cc927c8db44`.

The V1 payload hash is SHA-256 of the upstream Borsh representation of the request and extracted block hash. `expected_payload_hash` binds the chain, transaction hash, extractor, finality and extracted value. The private callback receives the operation id, cancellation flag, transaction hash and expected payload hash from the originating promise. It checks the stored raw transaction's Keccak-256 hash, the MPC response binding and the operation state. An error changes no reservations.

Verifications do not acquire a lock or persist an attempt. Anyone may request concurrent proofs, including proofs for the original and cancellation. The first valid success releases the operation; subsequent callbacks see a terminal state and return without changing budget. Bogus hints cannot prevent another proof, cancellation, a Confirmed report or conservative timeout release. Original and cancellation transactions share the same EVM nonce, so both cannot be finalized on the same canonical chain. If Unconfirmed wins the race, a later cancellation proof does nothing and budget stays spent.

Default cancellation delay is one hour. After that, anyone can call `cancel_nonce`. If MPC signing fails, anyone can retry until a signed cancellation is stored; retries re-sign the exact stored transaction and digest, even if role fee caps subsequently change. Once a signature is stored, further requests are rejected, and late duplicate signing callbacks cannot replace it. It signs a zero-value self transaction at the original nonce using a fixed gas limit of 21,000. The vault computes twice the original fee cap and tip, capped by the role's per-gas and total-fee limits. Each field must still increase by at least 12.5% (rounded up, with a minimum increase of one); a zero original tip becomes at least one. If the caps cannot accommodate that increase, the call fails without consuming the cancellation attempt. Callers supply only the operation id and cannot select a zero tip. `settle_cancellation(op_id, block_hash)` verifies its finalized success before refunding reservations and marking `Cancelled`. The old `confirm_cancellation` method always rejects: a trusted caller cannot substitute for a proof.

Default unconfirmed timeout is six hours. `release_unconfirmed` is permissionless after that deadline regardless of outstanding proofs. It frees the wallet and leaves the budget spent, including for reverted original transactions. Unlimited roles use the same queue-release paths. `SetSettlementConfig` can change timeouts through governance; the unconfirmed timeout must exceed the cancellation delay by at least one hour.

`report_status` remains an optional signed Confirmed fast path and can only consume budget. Failed reports are rejected. Unsigned operations may still refund through pre-signature cancellation, expiry or veto. Once signing may have happened, only a finalized cancellation proof can refund.

Freeing the vault queue does not guarantee that an EVM nonce gap has disappeared. An original transaction that never reached the chain may still need its already-signed original or cancellation broadcast before subsequent EVM nonces can execute. Unconfirmed also does not prove that the original transaction failed.

## Trust and availability

Fund authorization and budget refunds do not trust the backend. They trust NEAR execution, the deployed vault code and governance, and the NEAR MPC threshold together with its whitelisted foreign-chain RPC providers. Public RPC responses supplied by clients are hints, never refund evidence. MPC or foreign-chain unavailability can prevent proof settlement; the conservative timeout frees the NEAR queue without restoring budget.

Guard invoice checks are advisory business-data checks. A role can explicitly require Guard visas, trading backend independence for that additional requirement. The optional signed Confirmed path trusts its reporter to consume a reservation early; it never restores spend or changes the signed transaction.

## Deployment compatibility

The Borsh layout changes for the vault, role configuration and operations. This branch provides no in-place migration. Redeploy testnet vaults using the new initializer (`settlement_config` may be null for defaults), recreate wallets and approved roles/memberships/budgets/lists, and reprovision agent function-call keys. A new vault account changes the MPC derivation identity and EVM address: settle old operations first and transfer funds under the old vault's governance. Do not simply overwrite a funded existing vault's code.

Agent keys are function-call keys on the vault, for the 16 methods of `AGENT_FUNCTION_CALL_METHODS` (`packages/sdk/src/index.ts`): `prepare`, `prepare_with_approval`, `authorize`, `cancel_nonce`, `settle`, `settle_cancellation`, `release_unconfirmed`, `execute_queued_operation`, `cancel_prepared`, `renounce_role`, `execute_solana`, `settle_solana`, `release_solana_unconfirmed`, `execute_near`, `release_near_unconfirmed`, `request_bank_payout`. None of them can pay outside the role: `prepare`, `prepare_with_approval`, `authorize`, `execute_solana`, `execute_near` and `request_bank_payout` check the agent's membership and role on chain; the settle, release and cancel methods only finish or undo an operation the role already allowed (some, like `cancel_nonce` after its delay, are open to anyone). The key has no gas allowance cap (`allowance: null`): gas comes from the agent's own account, never from the vault. Keys made before NEAR transfers lack `execute_near` and `release_near_unconfirmed`; keys made before 9 November 2026 lack `prepare_with_approval` (and older ones `request_bank_payout`): hire the agent again. Views require no signing permission. Existing keys and signer agent records must be updated explicitly; changing defaults does not modify previously provisioned keys.

The signer daemon lives in `signer/` (`euthyna-signer`, Rust); its `DEFAULT_METHODS` must match this method list, which `packages/sdk/src/signer-methods.test.ts` checks. No contract or UI rename is part of this change.


## Build and sandbox

Rust is pinned to 1.99.1 (edition 2024), near-sdk and near-contract-standards to 5.29.1. The SDK's own Cargo.toml declares `[package.metadata.near] min_protocol_version = 84`. Build all six contracts with `bash contracts/build.sh`, using cargo-near 0.22.0; do not generate checked-in WASM with plain `cargo rustc`.

Every contract restores reproducible-build metadata with the verified image `sourcescan/cargo-near:0.22.0-rust-1.99.1` and digest `sha256:c9655eaf7436b90c87ea8b25739f91063032c5c30ba24cfeafe72c142943b5bb`. The tag and digest were checked through the registry's tag API. This identifies the build image; a container reproducibility run is distinct from the local cargo-near build.

Tests use near-workspaces 0.23.0 and explicitly select the official nearcore 2.14.0 sandbox through `NEAR_SANDBOX_BIN_PATH`. The CI workflow downloads the pinned 2.14.0 archive and checks its SHA-256 (`a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691`). The sandbox host must allow a file descriptor limit of at least 65535. All GitHub Actions are pinned by full commit SHA. CI retains the six built WASM artifacts and requires a byte-for-byte match with the checked-in `res/` files before running sandbox tests. The pinned container image and its stable checkout path define the build environment; a green CI run therefore tests the exact committed bytes. Local builds at other paths can differ and must not replace verified release artifacts without passing this comparison. Test time advances through one shared `wait_until_timestamp` helper; block count is not treated as elapsed seconds. Run `cargo test -p tests --no-fail-fast` with that sandbox path. CI retains per-file results.
