# MandateOS API

Base URL: `http://localhost:3000`. All bodies are JSON. The server never stores an
agent's NEAR function-call private key: the console registers only its public key.

## Identities

| Identity | Credential | Header | Routes |
|---|---|---|---|
| Console member | Better Auth passkey session (email profile identifier) | `Cookie` | `/api/auth/*`, `/v1/console/*`, `/v1/emergency/cancel`, `/v1/relayer/broadcast` |
| Agent | Better Auth API key bound to the agent user | `x-api-key` | `/v1/operations/*` |

Rate limits: `/api/register/passkey-start` permits 5 requests per remote IP per
15 minutes and 3 requests per normalized email per hour by default. The explicit
hackathon setting `UAT_DEMO_WALLETS_ENABLED=1` disables only these in-memory
registration limits so interrupted local WebAuthn ceremonies can be retried;
sponsorship limits remain enforced. Agent API keys allow 60 requests/minute; the
HTTP layer adds 120 requests/minute per agent and 600 requests/minute per
organization. Registration counters are in-memory per API instance; wallet and
agent-account sponsorship share one durable PostgreSQL daily cap.

Console sessions and agent credentials are disjoint: an agent key on a console route
returns `401`, and a console cookie on an agent route returns `401`. Every console
query is scoped to the session's `activeOrganizationId`; changing that id does not
grant access because the membership row is re-read on every request.

Creating or revoking an agent requires the console role `admin` (or `owner`). A
revoked agent fails closed twice: the API key is disabled and `agent.active` is
`false`, so an already-cached key stops resolving.

### Passwordless console bootstrap

`POST /api/register/passkey-start` rejects emails that already have a passkey
and returns a signed, 10-minute registration context. The browser passes it to
Better Auth's sessionless passkey ceremony. The server validates the context in
`resolveUser`, creates the profile with `emailVerified=false`, stores the
passkey and creates the session. It sends no email and stores no magic token or
password; direct email/password routes return `404`.

The email is a profile identifier in the hackathon build, not a verified
credential. Better Auth email-invitation acceptance therefore returns `403
wallet_proof_required`; membership is claimed by proving both declared wallets.
Console API identity requires an enrolled passkey.
In explicit `VITE_UAT_DEMO_MODE=1`, only the NEAR/EVM transaction wallets are
generated locally; the Better Auth passkey flow is unchanged. Outside demo,
users connect through NEAR Wallet Selector and MetaMask/Rabby and no private key
is written to localStorage.

## Agent routes

### `POST /v1/guard/visas`

Reads the operation from the Vault, refuses when the authenticated agent is not the
operation's `agent`, then applies the exact Guard rules. A case outside the rules
returns `409` with `decision: "escalate"`; no visa is signed.

```bash
curl -sS -X POST http://localhost:3000/v1/guard/visas \
  -H 'content-type: application/json' \
  -H "x-api-key: $AGENT_API_KEY" \
  -d '{"vaultAccountId":"vault-v4.mandateos-root-20261021.testnet","opId":[1,2,3]}'
```

| Status | Meaning |
|---|---|
| `200` | Visa signed for the exact prepared digest |
| `401` | Missing, disabled or unknown agent credential |
| `403` | `agent_mismatch` or `vault_not_owned_by_agent` |
| `409` | Escalation; `reasons` lists the failed rule |

## Console routes

### `GET /v1/console/agents`

Lists agents of the session organization only.

```bash
curl -sS http://localhost:3000/v1/console/agents -H "Cookie: $SESSION_COOKIE"
```

### `POST /v1/console/agents`

Creates the off-chain agent identity and one-time API key. The admin supplies
the name, role and public ed25519 key printed by `mandateos agent init`; the
server derives `<slug>-agent.<NEAR_ACCOUNT_PARENT>`. The private key never
leaves `AGENT_KEY_PATH` ([`packages/sdk/src/cli.ts`](../packages/sdk/src/cli.ts),
[`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts)).

```json
{
  "name": "Compta Bot",
  "role": "researcher",
  "nearPublicKey": "ed25519:...",
  "vaultAccountId": "acme-v.mandateos.testnet",
  "mpcPath": "agents/researcher/base"
}
```

### `POST /v1/console/agents/:id/provision`

Admin only, 10 requests/hour per admin and subject to the shared durable daily
NEAR sponsorship cap. The relayer emits one transaction containing
`CreateAccount`, `Transfer` (`NEAR_AGENT_GAS_RESERVE_YOCTO`, default 0.3 NEAR)
and one `AddKey`. That key is FunctionCall-only, has unlimited gas allowance
(`allowance = null`), receiver = Vault, and exactly `prepare`, `authorize`,
`cancel_nonce`, `request_derived_public_key`. No full-access key is added. The
account balance therefore bounds gas spend without making the only key
permanently unusable when a finite allowance reaches zero
([`apps/api/src/agent-provisioning.ts`](../apps/api/src/agent-provisioning.ts),
[`apps/api/src/near.ts`](../apps/api/src/near.ts)).

`GET /v1/console/agents/:id/provision` returns the server observation.
`POST /v1/console/agents/:id/provision-confirm` repeats the RPC attestation and
stores the admin confirmation. The browser independently calls
`view_access_key_list` and requires `allowance = null` before confirmation
([`apps/console/src/wallets.ts`](../apps/console/src/wallets.ts)).

Observed testnet integration (the reserve was overridden to `0.02 NEAR` for
this isolated proof; UAT default remains `0.3 NEAR`):

- account `pr-a-unlimited-1761142000-agent.mandateos.testnet`;
- transaction
  [`FQBV3EDzq2pTPdEgprKbJR6Rw9H6ECKoPVgzJnmizbAw`](https://testnet.nearblocks.io/txns/FQBV3EDzq2pTPdEgprKbJR6Rw9H6ECKoPVgzJnmizbAw);
- finalized block `274271995`;
- exactly one key, `FunctionCall`, `allowance = null`, receiver
  `vault-v4.mandateos-root-20261021.testnet`, and the four documented methods;
- local key file permission observed as `0600`.

`request_derived_public_key` requires no attached deposit. Its focused Sandbox
run burnt `6.306 Tgas`; the SDK attaches `50 Tgas` to cover the MPC call and
callback ([`contracts/tests/tests/vault_operations.rs`](../contracts/tests/tests/vault_operations.rs)).
On NEAR testnet, `prepare` burnt `3.144851013726 Tgas`
([tx](https://testnet.nearblocks.io/txns/2K8YMFDYFBFocSDZWSf1aRPq15w3n6giuA3XKuVGwjK3))
and `authorize` burnt `14.311476888041 Tgas`
([tx](https://testnet.nearblocks.io/txns/GgU8kFUeypkLjAuB9mQED1TULhqvW1NBSy5KF6dvKWWZ)).
The SDK attaches `10 Tgas` to `prepare` and `50 Tgas` to `authorize`; the latter
must also reserve the Vault's `15 Tgas` MPC receipt and `20 Tgas` callback
([`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts),
[`contracts/vault/src/lib.rs`](../contracts/vault/src/lib.rs)).

The API and payment worker compare the agent account balance with
`NEAR_AGENT_GAS_LOW_YOCTO` (default `0.05 NEAR`). A low balance does not block a
payment attempt: recharge the existing account with a simple NEAR transfer;
do not replace or add a key
([`apps/api/src/console-data.ts`](../apps/api/src/console-data.ts),
[`apps/api/src/operation-worker.ts`](../apps/api/src/operation-worker.ts)).

![Agent restricted-key attestation](./console/agent-provisioning.webp)
![Agent low gas balance alert](./console/agent-gas-low.webp)

### `POST /v1/console/agents/:id/revoke`

Disables the agent and all of its API keys immediately. Returns `404` when the agent
belongs to another organization.

### `POST /v1/emergency/cancel`

Console members only. Two append-only audit rows are written (`requested`, then
`submitted` or `rejected`) and the Vault `cancel_nonce` is called through the NEAR
relayer.

```bash
curl -sS -X POST http://localhost:3000/v1/emergency/cancel \
  -H "Cookie: $SESSION_COOKIE" \
  -H 'content-type: application/json' \
  -d '{"vaultAccountId":"vault-v4...","opId":[1,2,3],"gasLimit":"21000","maxFeePerGas":"30000000000","maxPriorityFeePerGas":"2000000000"}'
```

### `POST /v1/relayer/broadcast`

Console-admin fallback for one operation. Normal operation uses the separate
`worker.ts` process; this route remains available for incident recovery.

## Agent payments and escalations

### `POST /v1/operations/gas-quote`

Agent credential. Before `prepare`, the SDK asks the API to encode the actual
`Roles.execTransactionWithRole(token.transfer(recipient, amount))` call from
the agent's derived `0xAAA`. The API requires `eth_estimateGas` to succeed,
adds a 30% gas margin, reads p50 priority rewards from `eth_feeHistory`, and
sets `maxFeePerGas = 3 × baseFee + priority`. It also includes the OP Stack L1
data fee and returns a warning when the agent balance is below
`gasLimit × maxFeePerGas + l1Fee`. The SDK refuses `prepare` while that warning
is present. Role gas fields are governance caps, not transaction defaults.

### `POST /v1/operations/pay`

Agent credential (`x-api-key`). The agent has already called `prepare` on the
Vault with its client-held function-call key. Body:

```json
{
  "opId": [0, 1],
  "invoice": {
    "text": "untrusted invoice text",
    "claimedRecipient": "0x..."
  }
}
```

`invoice.claimedRecipient` is compared with the registry-approved recipient
already committed by the Vault. A mismatch produces an escalation and no visa.
Invoice text is stored as evidence and never executed as instructions.
Instruction-like text (`ignore previous rules`, policy override, secret
exfiltration or attacker-payment directives) is deterministically rejected as
`422 prompt_injection_detected`; no visa is created.

- `200 {visa, signature}`: Guard approved and the visa is stored (also returned by
  `GET /v1/operations/:opId`).
- `202 {escalationId, reasons}`: uncovered case, queued for a human.
- `422 {error, message}`: hard refusal (recipient, amount cap, token, consumed
  reference, state).
- Repeating the same `opId` returns the stored visa/escalation, never a second one.

### `POST /v1/operations/:opId/authorization`

Agent credential. After the client-held NEAR key calls Vault `authorize`, the
agent records the finalized NEAR transaction hash here. The server verifies
that the Vault operation belongs to that agent and is `PossiblySigned` or
`Confirmed`. The worker uses this hash to recover a published MPC response and
call permissionless `submit_signature` when the callback missed it. A different
hash for the same operation is rejected with `409 authorization_tx_conflict`.

### `POST /v1/operations/:opId/cancellation`

Agent credential. After SDK `cancel()` calls the agent-authorized Vault
`cancel_nonce`, this route stores the finalized NEAR transaction hash. The
worker can then recover a missed cancellation callback through
`submit_signature`. Conflicting hashes are rejected.

### `GET /v1/operations/:opId`

Agent only, own operations. Merges the DB (`Prepared`, `Escalated`, `Rejected`,
`Broadcast`, `Confirmed`, `Cancelled`, `Reverted`) with the Vault state and the
stored visa/escalation.

### Payment worker

Run `pnpm --filter @mandateos/api worker` as a separate process. PostgreSQL
`WorkerLease` permits one active worker; an expired lease lets another process
resume. Each tick re-reads the Vault as the source of truth:

1. recover missing original/cancellation signatures from the stored NEAR
   transaction receipt and call `submit_signature`;
2. derive the exact raw-transaction hash, broadcast idempotently and persist it
   before polling;
3. wait for `WORKER_CONFIRMATIONS` Base blocks (default `5`) after a successful
   receipt, then sign and submit `report_status`;
4. on a revert, store `Reverted` without releasing budget or reference;
5. on timeout, request a higher-fee same-nonce `cancel_nonce` only after Vault
   pause or agent revocation, as required by the contract;
6. broadcast and follow the cancellation receipt;
7. release the PostgreSQL consumed reference only after the Vault reports
   `Cancelled` or `Expired`.

A mined cancellation remains `CancellationMined` until the DAO calls
`confirm_cancellation`; the worker cannot bypass the Vault's DAO-only finalizer.
Every side effect is recoverable: after a crash it recomputes transaction hashes,
checks receipts before rebroadcasting, and reconciles terminal Vault state.

A transaction with no receipt that times out while the Vault is neither paused
nor the agent revoked remains `Broadcast`: the worker is intentionally not
authorized to call `cancel_nonce` in that state. Resolution is either a human
Vault pause followed by worker cancellation, or `cancel_nonce` signed directly
by the agent, which the Vault explicitly authorizes.

### Console registry (suppliers)

- `GET /v1/console/registry`
- `POST /v1/console/suppliers` → pending `supplier_create`
- `POST /v1/console/suppliers/:id/wallets` → pending `wallet_add`
- `POST /v1/console/contracts` → pending `contract_create`
- `PATCH /v1/console/contracts/:id` → pending `contract_update`
- `POST /v1/console/registry-changes/:id/decision` (`approve|reject`)

Every write is staged. Nothing is created or modified, and `registry_version` does
not move, until **another** member approves; the author cannot approve their own
change. Guard reads suppliers, contracts and version from PostgreSQL.

### Console escalations

- `GET /v1/console/escalations`
- `POST /v1/console/escalations/:id/decision` (`approve|reject`)

The console labels `approve` as **Re-check**. It re-reads the Vault operation,
re-runs Guard against the current registry and only then stores the visa; if the
gap is still present it returns `422 still_escalated`. There is no out-of-rules
override: the correction is a separate four-eyes registry change. Rejection marks
the operation `Rejected` (the Vault reservation expires on its own). An escalation
never modifies the registry.

## Treasury onboarding

All `/v1/console/*`, `/v1/profile/*` and `/v1/emergency/*` requests require
`Origin: CONSOLE_ORIGIN`. State-changing methods must also send
`Content-Type: application/json`; otherwise the API returns `403` or `415`.

### `POST /v1/profile/wallet-proof/challenge`

Requires a passkey session but not an existing organization membership. It
creates a one-time 10-minute challenge bound to the member id, organization,
declared NEAR account, checksum EVM address, NEAR recipient and Base Sepolia
chain id.

### `POST /v1/profile/wallet-proof/verify`

Verifies a NEP-413 signature, checks that its public key is currently a
full-access key on the declared NEAR account, and recovers the EIP-191 signer.
Both signatures cover the same domain-separated challenge. Successful
verification consumes the challenge, stores both proofs and `verifiedAt`, and
claims an admin-created pending membership for the authenticated passkey
profile. Challenges cannot be replayed.

Normal mode requires the NEP-413 public key to be a current full-access key
returned by NEAR RPC. Only with explicit `UAT_DEMO_WALLETS_ENABLED=1` may an
unfunded `w-<sha256(public-key)>.<parent>` account pass this association check;
the signature still verifies cryptographically, and DAO-time sponsorship must
later create that exact account with that exact key.

### `GET /v1/console/members`

Returns members of the session organization with their `nearAccountId`,
`evmAddress`, `walletProofClaimable` and `walletProofVerifiedAt` state. Better
Auth's own member listing does not expose these application-specific columns.

### `POST /v1/console/members`

Admin only. Declares a pending wallet membership for the MVP. The declaration
does not prove wallet control and is excluded from DAO council and Safe owners.
The generated `/onboarding?member=<id>` claim link becomes effective only when
the recipient signs the NEP-413 and EIP-191 challenge from a passkey session.

```json
{ "name": "Alice", "nearAccountId": "alice.testnet", "evmAddress": "0x..." }
```

Both fields accept a pasted wallet label: only the first token is kept and a
trailing `(...)` suffix is stripped, so `busyvideo615.testnet (*testnet)` is
stored as `busyvideo615.testnet`. The EVM address is checksum-normalized.

### `PATCH /v1/console/members/:id/wallets`

Admin only. Replaces a declaration and clears every previous wallet proof,
challenge and deployment confirmation. The member remains outside the council
until both new signatures verify.

### `POST /v1/console/treasury/plan`

Available to every organization member so each signer can independently inspect
the deterministic plan. Only members with a stored NEP-413 and EIP-191 proof
appear in the DAO council and Safe owners. It never signs and never receives a
private key.
The plan is rejected unless at least three proven members remain and the
absolute threshold is strictly lower than the council size. Registration
rechecks both liveness invariants against the direct `get_policy` result
([`apps/api/src/treasury.ts`](../apps/api/src/treasury.ts)).

```json
{ "environment": "uat", "daoName": "acme", "founderNearAccountId": "alice.testnet" }
```

The response contains:

- `daoCreate`: Sputnik factory `create` arguments and attached deposit;
- `vault` / `relay`: wasm base64, SHA-256, init arguments and the exact
  `CreateAccount → Transfer → DeployContract → FunctionCall new` actions;
- `govAddress`: `0xGOV` derived off-chain from the MPC view for the relay account
  and `governance/base-sepolia` path;
- `base`: Safe deployment, Roles and Delay deployment, and the three Safe module
  calls to sign. The Safe is deployed before the modules because their initializers
  reference its address; enabling them is a separate 2/3 Safe batch.

### Browser-signed DAO creation

There is no server `create-dao` route. The console displays `daoCreate.args`,
every council account and the absolute threshold, then requires the founder
(`founderNearAccountId`) to confirm and sign the factory `create` call locally.
The attached 0.25 NEAR comes from the founder wallet. In explicit demo mode,
MandateOS creates and pre-funds that deterministic client wallet only
immediately before this call. The permissionless factory refunds the caller if
asynchronous creation fails.

### `POST /v1/console/treasury/deploy-contracts`

Admin only. Creates and deploys the Vault and governance relay accounts with the
relayer (`CreateAccount → Transfer → DeployContract → new`), paying from
`NEAR_RELAYER_ACCOUNT_ID`. Both contracts are initialized with the DAO as owner and
hold no access key of their own.

### Deployment attestation and member confirmation

After deployment, each proven council member uses the browser to query NEAR RPC
directly. The console checks zero access keys, reproducible `code_hash`,
`owner_id`, MPC contract/path, EVM chain, Vault token/Guard/TTL and relay delay.
Only an all-match result can call
`POST /v1/console/treasury/deployment-confirmations/confirm`. The server repeats
the same RPC checks, computes an immutable deployment digest and stores one
confirmation per member. The Safe deployment stays disabled until every proven
council member confirms that digest. `treasury/register` enforces the same gate.

`POST /v1/console/treasury/deployment-confirmations/status` re-verifies the
accounts and returns the required and confirmed member ids.

### `GET /v1/console/treasury/sponsor-status`

Returns the public on-chain balance of the configured MandateOS parent account.
The console uses it only for the separately sponsored Vault/relay deployment;
DAO creation is caller-funded from the founder wallet.


### `POST /v1/console/treasury/sponsor-founder-wallet`

UAT demo admin only. Immediately before founder-signed DAO creation, reserves a
durable sponsorship row, validates that the deterministic account is the
authenticated member's proved wallet, enforces
`NEAR_SPONSOR_DAILY_WALLET_LIMIT`, then creates/funds it with
`NEAR_SPONSOR_WALLET_AMOUNT_YOCTO`. The operation is
idempotent by account/public key; failed chain creation releases the reservation.
Normal wallet-selector accounts do not use this route.

### Funding model

Treasury deposits are one-time storage-backed account balances, not per-payment
fees. `factory-v2.mandateos.testnet` references the official immutable global
Sputnik hash, so a new Company + DAO receives 0.25 NEAR from its founder and
stores no duplicate WASM. A full payment treasury adds 5 NEAR for the Vault and
3.5 NEAR for the relay (8.75 NEAR total). Registration separately pre-funds the
client-owned `w-<hex>.mandateos.testnet` wallet with 0.5 NEAR once.

Observed testnet storage is 150,623 bytes for the permissionless factory and 810
bytes (0.00810 NEAR minimum) for a global DAO. Current-artifact sandbox
measurements after `new` and access-key removal are 439,560 bytes (4.39560 NEAR
minimum) for the Vault and 285,313 bytes (2.85313 NEAR minimum) for the relay.
Testnet
protocol configuration reports `10^19` yoctoNEAR per byte; all API amounts use
`1 NEAR = 10^24` yoctoNEAR. The observed 14.288425743215 Tgas Vault
authorization costs about 0.00142885 NEAR at `10^8` yoctoNEAR/gas.

### `POST /v1/console/treasury/refresh`

Admin only. Re-runs every treasury check and refreshes observed addresses and
hashes. `get_factory_info().auto_update === true` is recorded as
`dao_auto_update_enabled`, but does not change the active status for the
immutable-hash, keyless MandateOS factory.

### `GET /v1/console/agents/:id`

Returns the stored agent plus its on-chain Vault state (`get_agent`,
`next_evm_nonce`). The console lists agents and shows this state per agent.

### `GET /v1/console/treasury/budget-token`

Returns the configured FT metadata, DAO/Vault storage registration and DAO
balance. `ft_metadata.decimals` must equal USDC's `6`; any other value is
rejected. `POST /v1/console/treasury/budget-token/plan` accepts a positive
integer `amount` and returns unsigned `storage_deposit` calls for missing DAO or
Vault registrations followed by `mint` to the DAO. The browser submits these
calls with the connected member wallet. `mint` is exposed only by the UAT
`test-ft`; production must configure a real six-decimal FT and obtain funds
through that token's normal issuance or transfer path
([`contracts/test-ft/src/lib.rs`](../contracts/test-ft/src/lib.rs),
[`apps/api/src/mandates.ts`](../apps/api/src/mandates.ts),
[`apps/console/src/routes/OnboardingPage.tsx`](../apps/console/src/routes/OnboardingPage.tsx)).

Testnet metadata and repeatable minting were deployed in
[`7BUDD5yePCzWd86Tx3cuTV15xUmCUfcTHbkCbeZS2DVj`](https://testnet.nearblocks.io/txns/7BUDD5yePCzWd86Tx3cuTV15xUmCUfcTHbkCbeZS2DVj):
`TestUSDC`, `6` decimals, code hash
`D169mWBjhe8vYDYo4tjXVQoM8PNEQ1CQcPcaWa4mJCg1`. Two subsequent mints to the
already-registered DAO passed in
[`45g1nd…`](https://testnet.nearblocks.io/txns/45g1ndvpzkVsq7pRUPondccgXGLAVQH6Y3hWB9VEqgEN)
and [`FPAYYB…`](https://testnet.nearblocks.io/txns/FPAYYBoaHrfdwpj1w7GFhcQQg9gv5Zk949zQs8RFwRjn)
([`deployments/near-testnet.json`](../deployments/near-testnet.json)).

### `POST /v1/console/mandates/preview`

Compiles one role into the three locks and returns a diff plus unsigned proposals:

- Vault `set_role` config (`role_key`, token, Recipient allowlist, caps, gas);
- Zodiac permission (`scopeTarget`, `scopeFunction` with recipient conditions and allowance,
  `assignRoles` once the agent EVM address exists);
- Guard policy snapshot;
- DAO `add_proposal` payloads for the Vault, funding and relay calls. The console
  signs each proposal with the member's NEAR wallet; the server never signs.

The funding proposal follows Sputnik DAO 2.3.1's exact `Transfer` shape:
`token_id`, `receiver_id`, `amount`, `msg`. `token_id` is
`BUDGET_TOKEN_ACCOUNT_ID`; omitting it is invalid
([immutable upstream `ProposalKind::Transfer`](https://github.com/near-daos/sputnik-dao-contract/blob/317ea4fb1/sputnikdao2/src/proposals.rs),
[`apps/api/src/mandates.test.ts`](../apps/api/src/mandates.test.ts)).

The console discovers deterministic proposal descriptions through direct NEAR
RPC, then reads every `get_proposal` status. Steps are strictly ordered:
`set_role → register_agent → funding → Zodiac`; a step remains disabled until
the previous status is `Approved` (displayed as **Executed**). `Expired`,
`Rejected`, and other terminal failures display **Re-propose**
([`apps/console/src/wallets.ts`](../apps/console/src/wallets.ts),
[`apps/console/src/routes/OnboardingPage.tsx`](../apps/console/src/routes/OnboardingPage.tsx)).

Zodiac configuration is one relay proposal, not four: the payload calls the
canonical Safe **MultiSendCallOnly 1.4.1**
[`0x9641…02e2`](https://sepolia.basescan.org/address/0x9641d764fc13c8B624c04430C7356C1C7C8102e2)
with `operation = 1`; its four packed children are `Call` operations to the
single Roles instance in this order: `assignRoles`, `scopeTarget`,
`scopeFunction`, `setAllowance`. The relay rejects any DelegateCall whose target
is not its immutable, attested MultiSendCallOnly address. This removes the
non-Call variants exposed by the general MultiSend runtime
([Safe 1.4.1 deployment registry used by `treasury-plan.ts`](../packages/deployer/src/treasury-plan.ts),
[`apps/api/src/mandates.ts`](../apps/api/src/mandates.ts),
[`contracts/governance-relay/src/lib.rs`](../contracts/governance-relay/src/lib.rs)).

The deployed Roles 2.1.1 mastercopy at
[`0xF296…3D5`](https://base-sepolia.blockscout.com/address/0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5?tab=contract)
defines `setAllowance` in `contracts/PermissionBuilder.sol`—the deployed source
does not call this file `core/Setup.sol`. Its ABI order, verified again by
[`apps/api/src/mandates.test.ts`](../apps/api/src/mandates.test.ts), is:

| Position | Parameter | MandateOS value |
|---:|---|---|
| 1 | `key` | compiled allowance key |
| 2 | `balance` | period budget on first creation; `min(current on-chain balance, new budget)` on an update |
| 3 | `maxRefill` | period budget |
| 4 | `refill` | period budget |
| 5 | `period` | `periodDays × 86,400` |
| 6 | `timestamp` | server time when `POST /v1/console/mandates/zodiac-proposal` creates the proposal |

The update balance is a proposal-time snapshot. Zodiac may refill the allowance
between proposal creation and execution; executing `setAllowance` then writes
the encoded snapshot and can reduce that newly refilled balance. It never raises
the balance above the new budget. Re-propose when a fresh execution-time balance
is required
([`apps/api/src/mandates.ts`](../apps/api/src/mandates.ts),
[`apps/api/src/mandates.test.ts`](../apps/api/src/mandates.test.ts)).

### `POST /v1/console/governance/relay-operation`

After a Zodiac proposal reaches `Approved`, the browser records the public final
vote hash and signer account. The server verifies that the signer is a proven
member, the proposal is the deterministic Zodiac batch, and the relay has the
corresponding active operation; it never receives a private key
([`apps/api/src/governance.ts`](../apps/api/src/governance.ts),
[`apps/console/src/routes/OnboardingPage.tsx`](../apps/console/src/routes/OnboardingPage.tsx)).

Classification never trusts the proposal description. The API decodes the
on-chain DAO `FunctionCall`, requires one `propose` call to the registered
relay, compares its target/value/data/operation byte-for-byte with the active
relay operation, then accepts only the canonical Zodiac batch or a `Call` to
the registered Safe whose selector is `swapOwner` or
`addOwnerWithThreshold`. Descriptions remain display-only
([`apps/api/src/governance-calldata.ts`](../apps/api/src/governance-calldata.ts),
[`apps/api/src/governance.ts`](../apps/api/src/governance.ts)).

Before returning any relay proposal, the API estimates the exact
`0xGOV → Delay.execTransactionFromModule(...)` call. `gasLimit` is
`ceil(eth_estimateGas × 1.30)`, priority fee is the median of the p50 rewards
returned by `eth_feeHistory`, and `maxFeePerGas = 3 × baseFee + priority`.
Estimation failure rejects the proposal before voting. The quote includes the
OP Stack L1 data fee and checks that `0xGOV` covers
`gasLimit × maxFeePerGas + l1Fee`; insufficient funding is returned as a
blocking console warning.

Environment values are ceilings only:
`BASE_TX_GAS_LIMIT_CAP`, `BASE_TX_MAX_FEE_PER_GAS_CAP_WEI`, and
`BASE_TX_MAX_PRIORITY_FEE_PER_GAS_CAP_WEI`. Startup rejects a priority cap
above the max-fee cap.

The governance job shares the payment worker lease. It recovers a missing MPC
signature from that NEAR transaction, broadcasts the immutable 0xGOV
transaction, waits `WORKER_CONFIRMATIONS`, and checkpoints the Delay entry.
`txCooldown`, `txExpiration`, `txCreatedAt`, `txNonce`, `queueNonce`, and
`txHash(entryNonce)` are read on-chain; the worker rejects a queue hash that
does not match `keccak256(abi.encodePacked(to,value,data,operation))`. The gas
wallet signs only the exact `executeNextTx` call; its raw transaction is
persisted before broadcast.

Delay 1.1.1 does not emit a `TransactionExecuted` event. Execution evidence is
therefore the Safe's `ExecutionFromModuleSuccess(module = Delay)` event plus the
event transaction decoded as the exact
`Delay.executeNextTx(to,value,data,operation)` queue entry. This evidence is
checked first, including when the worker observes it after the expiry time.
Roles state and events are post-execution verification only; they never classify
an operation as executed.

Without execution evidence, `TxNonceSet(newNonce > entryNonce)` proves a veto
only when a historical `txNonce` read at the block immediately before that event
was still `<= entryNonce`. Without either proof, an elapsed
`txCreatedAt + txCooldown + txExpiration` classifies the entry as `Expired`.
A generic non-Zodiac operation uses the same Safe/calldata execution proof and
records receipt-only post-verification. Reverted queue or `executeNextTx`
transactions become `Failed`.

Execution and veto log scans persist separate
`executionScannedThroughBlock` / `vetoScannedThroughBlock` cursors on the
governance job. They advance only through
`latest - WORKER_CONFIRMATIONS`, leaving a reorg/indexing window. A poll starts
at the next confirmed unscanned block instead of replaying from the queue
receipt. An execution or veto initially hidden in the last N blocks is therefore
picked up after it crosses the confirmation boundary; the job cannot become
`Expired` merely because that recent evidence is not indexed yet
([`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma),
[`apps/api/src/governance-worker.ts`](../apps/api/src/governance-worker.ts)).

The console labels an active operation **Underpriced** when the current Base
base fee exceeds its signed `maxFeePerGas`. A council member can propose the
relay's DAO-only `cancel_nonce` with a fresh dynamic quote. The worker
broadcasts the signed same-nonce cancellation; after confirmations it reports
the original operation `Failed`, releases the relay, and links back to Mandates
for deterministic re-proposal.

Guard signs the exact 0xGOV transaction hash, Base block number, and final status
under `mandateos:relay-status:v1`; `Executed`, `Vetoed`, `Expired`, and `Failed`
reports all release the relay's active operation. A compromised Guard can submit
`Failed` before broadcast and release the relay even though the already signed
0xGOV transaction remains broadcastable. If that transaction is later queued,
the council's Delay veto remains the safety path. The DAO-only
`confirm_original` remains the recovery path
([Safe ModuleManager source](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/base/ModuleManager.sol),
[`apps/api/src/governance-worker.ts`](../apps/api/src/governance-worker.ts),
[`apps/api/src/governance-base.ts`](../apps/api/src/governance-base.ts),
[`contracts/governance-relay/src/lib.rs`](../contracts/governance-relay/src/lib.rs)).

### `GET /v1/console/governance`

Returns recent DAO proposals, persisted governance jobs, and direct Base reads
of Delay `txNonce`, `queueNonce`, `txCooldown`, `txExpiration`,
`txCreatedAt`, current block time, plus the Safe threshold. The Governance page
renders `DAO vote → signed by 0xGOV → broadcast → Delay queue → terminal state`
and computes its countdown only from these on-chain timestamps. **Veto** builds
the exact Safe EIP-712 transaction `Delay.setTxNonce(queueNonce)`, collects the
on-chain Safe threshold of council signatures, then submits it through the
Safe; MandateOS never signs for the council
([`apps/api/src/console-data.ts`](../apps/api/src/console-data.ts),
[`apps/console/src/routes/GovernancePage.tsx`](../apps/console/src/routes/GovernancePage.tsx),
[`apps/console/src/safe.ts`](../apps/console/src/safe.ts)).

### `POST /v1/console/governance/unblock-proposal`

For a terminal operation that still occupies an older relay's
`active_operation`, returns an unsigned DAO `add_proposal` for
`confirm_original`. A connected council member proposes it and council members
approve it from the Governance page; the server receives no council key
([`apps/api/src/governance.ts`](../apps/api/src/governance.ts),
[`apps/console/src/routes/GovernancePage.tsx`](../apps/console/src/routes/GovernancePage.tsx)).

![Council relay rescue proposal](./console/governance-relay-rescue.webp)

### `POST /v1/console/governance/swap-owner-proposal`

Admin only. While the relay is idle, reads the current Safe owners directly
from Base and returns an unsigned DAO proposal for
`Safe.swapOwner(prevOwner, oldOwner, newOwner)`. It rejects an absent old owner
or an existing replacement. Council votes, 0xGOV, Delay and the normal
governance worker remain on the execution path; no server key is made a Safe
owner.

### `POST /v1/console/governance/add-owner-proposal`

Admin only, and limited to recovery of a two-owner Safe. Returns an unsigned
DAO proposal for `Safe.addOwnerWithThreshold(newOwner, 2)`, producing the
required 2/3 Safe after execution. The console records either recovery proposal
as a generic governance operation; successful execution is classified from
the exact Safe `ExecutionFromModuleSuccess` evidence and receipt rather than
Zodiac state
([`apps/api/src/governance.ts`](../apps/api/src/governance.ts),
[`apps/console/src/routes/GovernancePage.tsx`](../apps/console/src/routes/GovernancePage.tsx)).

![Governance worker timeline and veto](./console/governance-worker-timeline.webp)

Fresh PR C UAT treasury (no migration):

| Component | Address/account |
|---|---|
| DAO | `pr-c-uat-1.factory-v2.mandateos.testnet` |
| Vault | `pr-c-uat-v.mandateos.testnet` |
| Relay | `pr-c-uat-r.mandateos.testnet` |
| Safe | `0xD1bBa371CA1e013df74354e6B85Cb25072c4b8f9` |
| Roles | `0xE2d84feE72C88ee7572e8F7D010334Da0179c84f` |
| Delay | `0x8Dc2b027F8cF72519C1C8e908A612b95F5B3b9ff` |
| 0xGOV | `0x3961FA54D0ebDf4DbDe073466f580D48Daac7928` |
| Relay-attested MultiSend (initial UAT, superseded) | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` |

This initial UAT predates the MultiSendCallOnly correction and remains recorded
as historical evidence; its immutable relay still attests regular MultiSend.
The corrected code and browser attestation require canonical
MultiSendCallOnly `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`. Both NEAR
contracts have zero keys and match the hashes recorded for that run. Base reads
confirm three owners, threshold 2, Roles + Delay enabled on the Safe, 0xGOV
enabled on Delay, cooldown 300 and expiration 604,800
([NEAR manifest](../deployments/near-testnet.json),
[Base manifest](../deployments/base-sepolia.json)).

The corrected relay artifact was built reproducibly from commit
`7dbee92054dd32dd2cc624fe50a13c64136992bb` with
`sourcescan/cargo-near:0.20.3-rust-1.86.0@sha256:a84b…adf`. Its SHA-256 is
`a03b744e59d2738d8e6b6e11cc2945aab076d85ec8fcaff512eedac6c352fdcc`
([`contracts/governance-relay`](../contracts/governance-relay),
[`contracts/res/governance_relay.wasm`](../contracts/res/governance_relay.wasm)).
This artifact is not claimed as deployed on the superseded UAT relay above.

Corrected CallOnly UAT treasury, initially created as 2/2 entirely from the
console (except the allowed `mandateos agent init` command), then recovered to
2/3 through the same DAO → relay → Delay path:

| Component | Address/account |
|---|---|
| DAO | `mandateos-callonly-2of2.factory-v2.mandateos.testnet` |
| Vault | `mandateo-v.mandateos.testnet` |
| Relay | `mandateo-r.mandateos.testnet` |
| Safe | `0x62C30e9e22A4Ad79AA473BA09861F10c3A55E8E0` |
| Roles | `0x167b82E08333319539c1dfB717765173b090DA98` |
| Delay | `0xac0AF75134D5afc5884Edd7F7B9454Fdd51347dD` |
| 0xGOV | `0x73c6889E9a9e4f729409f8251a9c4EE4Fee4024D` |
| Relay MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` |

| Clean 2/2 UAT transition | Transaction |
|---|---|
| DAO creation | [`29pzvQ…`](https://testnet.nearblocks.io/txns/29pzvQ3TrQLXurMUQqeKwM5of4LbBjuR2g1CfX7Hyp1X) |
| Vault deployment | [`22euyL…`](https://testnet.nearblocks.io/txns/22euyLBoEzrRkhuUxvVD5tFajyjSbMBVAfesTZMfRaHm) |
| CallOnly relay deployment | [`A3g9cS…`](https://testnet.nearblocks.io/txns/A3g9cSAE6h6aTwaLcqTGiyivqaSAfNKMJsJkfzn8qwwF) |
| Ethereum Sepolia → Base Sepolia deposit | `0x3a3ce142f9fb4897266bf68cb634270ad1e53b474ac29755718d6a06202e7e27` |
| Safe deployment | `0x7047a241da8edaf6b92c8058d4795fd09926bdbf39c53d89d00dfb6fad51376d` |
| Roles deployment | `0xd324ff1a8fc0482adad37d0f92da39bb49ede09510bf74477ae068a3d59b441c` |
| Delay deployment | `0x423969f45ea93d1a69273676172a73ea24abec5f78ff41a0752c4e2a45ef3e0f` |
| Safe 2/2 module batch | `0x5a3956eb7ca7f17fd81e8969dc084a80d61aa8a00adc4fef79ff0f0d5a858020` |
| First Zodiac DAO final vote | [`EvN2mi…`](https://testnet.nearblocks.io/txns/EvN2miZPj7prNpmMg79uVvRxUcjMiuHZZTbsg9Nzc9FN) |
| First 0xGOV Delay queue | `0x8e2108ecb7ee2d7ced53076083b71f58dcd1437a67b7f092977c8e9ef9df5a1c` |
| First Delay execution | `0x5ce72b873d15b4e00664d6d67b212e26c340468c8537061f31ee9f5e41f7a2bf` |
| Veto-test DAO final vote | [`3eQWu2…`](https://testnet.nearblocks.io/txns/3eQWu2cP1Vu5xxMuKcgHUAHNaDieBLM6kJscWdFaFiF7) |
| Veto-test 0xGOV Delay queue | `0xc31b1dd1216591adcdffb94bffbdbb8e16465fab6044892ed7c77475efa3afdb` |
| Second Delay execution to release relay | `0xb5a9e80af1759867795b579ac7655575535f391a34afe07ee0026fcb44c90de6` |
| `swapOwner` DAO final vote | [`7BtAvU…`](https://testnet.nearblocks.io/txns/7BtAvUqHJiZWcsgM5g3HkjzU73a6qzxjBc3NKC5jyJP7) |
| `swapOwner` 0xGOV Delay queue | [`0xd463…`](https://sepolia.basescan.org/tx/0xd4639328917af0cf3a55cbfb7e7c2a5b64c19a722964b42f801e9b4e566c6178) |
| `swapOwner` Delay execution | [`0x669a…`](https://sepolia.basescan.org/tx/0x669adaf7edb644d294ca482adb8b2f721981fc7ce56ee0e8f901d425a44c9a18) |
| `addOwnerWithThreshold(…, 2)` DAO final vote | [`EvpHAY…`](https://testnet.nearblocks.io/txns/EvpHAYe6qbEBhxALteWmebLBHiaBwyFM6QzcHXnh6VMj) |
| Add third owner 0xGOV Delay queue | [`0x3a2c…`](https://sepolia.basescan.org/tx/0x3a2c61b0eeb32cd083a4ed7aa2d82c97b29e8c918d52b738561ed08242908641) |
| Add third owner Delay execution | [`0xcdcf…`](https://sepolia.basescan.org/tx/0xcdcff14aa2569f714a0bc42fba1285be02bb1ee26b1424632b533f7762660f2d) |
| Veto-target 0xGOV Delay queue | [`0xbfdd…`](https://sepolia.basescan.org/tx/0xbfddaa829d8560b848573ce71eb9bcf7f3965548af5424af8d67296b86e9ba61) |
| Council 2/3 veto | [`0xa4f0…`](https://sepolia.basescan.org/tx/0xa4f0b072edd1f5648751aa1d11b5ffcf40341c735cb8a3e5fb4a84fdd121890c) |

Both members confirmed the direct Vault/relay RPC attestation. On-chain reads
confirmed Roles and Delay enabled on the Safe and 0xGOV enabled on Delay. The
treasury registration completed. With the user's authorization, the UAT moved
to the public FastNear testnet endpoint listed by NEAR's provider documentation.
The first Zodiac operation reached `Executed`; the worker verified
`AssignRoles`, `ScopeTarget`, `ScopeFunction`, `SetAllowance`, balance
`6,000,000`, and period `2,592,000`.

The second operation was deliberately allowed to execute after the original
2/2 council lost one browser-generated EVM key; its terminal Guard report
released the relay. Proposal `7` then replaced owner `0x35150E…a0dA1e` with
`0x1D693a…9FFceb`. Proposal `8` added
`0x64f4F6…F501e8` with `addOwnerWithThreshold(..., 2)`. Direct Base reads
after execution returned exactly three owners and threshold `2`.

Proposal `9` queued a second owner replacement as the veto target. Two current
Safe owners signed `Delay.setTxNonce(5)` in the console; transaction
`0xa4f0…1890c` executed, and the worker classified the entry `Vetoed` before
submitting the terminal Guard report. No `confirm_original` vote was used.
Acceptance of a subsequent relay proposal is not yet claimed in this revision.

| Real UAT transition | Transaction |
|---|---|
| DAO final vote, single Zodiac batch | [`FMpoLG…`](https://testnet.nearblocks.io/txns/FMpoLG8EKR1zEGiiqRZNMFV7LAuHhaGVArXVe4dNvjTW) |
| 0xGOV broadcasts into Delay | [`0x6dbf…`](https://sepolia.basescan.org/tx/0x6dbf9d2a7b3ef9e52ac575cc008a79caab2a837fb3802b2f4952294b846fa6e3) |
| Gas wallet executes after cooldown | [`0xa714…`](https://sepolia.basescan.org/tx/0xa71418caa731dbf68cfe2a34a69a768fa4cce32b7cfdda977f6064af5f7c962d) |
| Second DAO final vote for veto test | [`ErxsZc…`](https://testnet.nearblocks.io/txns/ErxsZceE4Dj5v4zHZzopnsgyCF9pm5fXhU6RzBmwMSyf) |
| Second 0xGOV queue transaction | [`0x62dd…`](https://sepolia.basescan.org/tx/0x62dd2a87a8a7686a14543a5aa32a4ef3f4522edd1ca970024a60a1df5199440f) |
| Council 2/3 veto | [`0xcff3…`](https://sepolia.basescan.org/tx/0xcff3a137fed70ce4baa91a011e3bf3162d2d8c8e53ce75ce1b707b2f54bb527b) |

The first operation ended `Executed` with all four Roles events and periodic
allowance `6,000,000 / 30 days`. The second ended `Vetoed`, with no
`executeNextTx` hash. During the first run, public NEAR RPC returned transient
429 responses; persisted `Broadcast`/`Queued` checkpoints survived and the same
job resumed to `Executed`, exercising the crash/retry path without changing RPC
or rotating IPs ([`apps/api/src/governance-worker.test.ts`](../apps/api/src/governance-worker.test.ts)).

Measured execution gas:

| Executed action | Environment | Burnt gas |
|---|---|---:|
| final vote → `set_role` | Sandbox, Sputnik 2.3.1 | 8.708943134269 Tgas |
| final vote → `register_agent` | Sandbox, Sputnik 2.3.1 | 8.809192150558 Tgas |
| final vote → FT `Transfer` | Sandbox, Sputnik 2.3.1 | 13.089112041461 Tgas |
| relay `propose` + mock MPC | Sandbox | 6.574015458889 Tgas |
| final vote → relay `propose` + real MPC | NEAR testnet | 19.662169450795 Tgas |

The relay action receives `60 Tgas`: above measured burn and enough to reserve
its `15 Tgas` MPC receipt plus `20 Tgas` callback. Every browser
`act_proposal` attaches `120 Tgas`: more than six times the measured 19.662
Tgas worst case while avoiding an unnecessary 0.45 NEAR prepaid-balance
requirement. It remains below testnet protocol version 88's
`max_total_prepaid_gas = 1,000 Tgas`
([nearcore gas architecture](https://github.com/near/nearcore/blob/master/docs/architecture/how/gas.md),
[`contracts/governance-relay/src/lib.rs`](../contracts/governance-relay/src/lib.rs),
[`apps/api/src/mandates.ts`](../apps/api/src/mandates.ts),
[`apps/console/src/wallets.ts`](../apps/console/src/wallets.ts)).
The real-MPC final vote passed in proposal `26`,
[`5ypaNTsPnJbiKBT67MRwuPhoeQJ4b4f2ZAg4F7VHmeaj`](https://testnet.nearblocks.io/txns/5ypaNTsPnJbiKBT67MRwuPhoeQJ4b4f2ZAg4F7VHmeaj);
proposal `27` then closed the measurement operation through the DAO rescue path
in [`HbDvWUB2DtwBPc1vT9tpCHUd7G36Grt4D4zC3GFEbZRJ`](https://testnet.nearblocks.io/txns/HbDvWUB2DtwBPc1vT9tpCHUd7G36Grt4D4zC3GFEbZRJ).
Sandbox measurements are reproduced by
[`contracts/tests/tests/dao_governance.rs`](../contracts/tests/tests/dao_governance.rs)
and [`contracts/tests/tests/governance_relay.rs`](../contracts/tests/tests/governance_relay.rs).

![Budget token and ordered proposal execution](./console/mandate-ordered-proposals.webp)

`swap`/`bridge` are rejected until Phase 2. `maxPerTx` must not exceed the budget.

### `POST /v1/console/treasury/register`

Admin only. Verifies on-chain state before inserting `treasury`:

- DAO local or `global_contract_hash` equals the configured factory's
  `get_default_code_hash()`;
- DAO `get_policy()` has the council Group equal to the member NEAR accounts, an
  absolute `RoleWeight` threshold `ceil(2n/3)` with quorum `0`, and no other role
  carrying `Vote*` or `AddProposal` (Sputnik ORs roles); a council `vote_policy`
  is rejected unless each per-kind threshold is at least the expected threshold;
- DAO `auto_update: true` is an audit warning, not a registration blocker, because
  the factory is keyless, has no update method and references immutable code;
- Vault and relay code hashes equal the local wasm SHA-256, and both have zero
  access keys;
- Vault `mpc_contract_id`, `evm_chain_id`, `guard_public_key` (KMS key),
  `token_id` and `reservation_ttl_blocks` equal the expected values;
- Vault and relay `owner_id` equal the DAO;
- relay `evm_address` equals the registered `0xGOV`;
- Safe owners equal the council EVM addresses, threshold is `ceil(2n/3)`;
- Roles and Delay are enabled modules, `0xGOV` is enabled on Delay;
- Relay `delay_address` and `evm_chain_id` are correct;
- Delay cooldown/expiration match the environment (`uat` 300 s, `production`
  86 400 s), Roles owner/avatar/target are the Safe.

```json
{
  "environment": "uat",
  "daoAccountId": "acme.sputnikv2.testnet",
  "vaultAccountId": "acme-vault.alice.testnet",
  "relayAccountId": "acme-relay.alice.testnet",
  "safeAddress": "0x...",
  "rolesAddress": "0x...",
  "delayAddress": "0x...",
  "govAddress": "0x..."
}
```

## Auth routes

`/api/auth/*` is handled by Better Auth:

- passkey sign-up / sign-in (`/api/auth/passkey/*`);
- organizations and active organization (`/api/auth/organization/*`);
- sessions (`/api/auth/get-session`).

There is no password credential. `POST /api/register/passkey-start` creates the
user, returns a session cookie, immediately deletes the generated credential row,
and the console adds the passkey. `/sign-up/email` and `/sign-in/email` return 404. The passkey relying party is
`PASSKEY_RP_ID` and the expected origin is `BETTER_AUTH_URL`.

## Errors

| Status | Body | Cause |
|---|---|---|
| `400` | `{ "message": ... }` | Zod validation failure or malformed `id` |
| `401` | `{ "message": "unauthorized" }` | Wrong credential class, expired session, disabled key |
| `403` | `{ "message": "admin required" }` | Non-admin console role |
| `404` | `{ "error": "agent_not_found" }` | Agent outside the session organization |
| `409` | state conflict | Operation not `Prepared` / not `PossiblySigned` |
| `429` | rate-limit or `daily_sponsorship_limit` | Registration or daily wallet sponsorship cap exhausted |

## Audit

Every sensitive action appends a row to `audit_log`:

- `guard.visa.issued`, `guard.escalation`, `guard.visa.denied`;
- `agent.created`, `agent.revoked`;
- `near_wallet.sponsored`;
- `emergency.cancel.requested`, `emergency.cancel.submitted`, `emergency.cancel.rejected`.

Rows are never updated or deleted by the API. `metadata` carries the operation id,
reason, vendor, or NEAR transaction hash.

## Local setup

```bash
docker run --rm -p 5432:5432 -e POSTGRES_USER=mandateos \
  -e POSTGRES_PASSWORD=mandateos -e POSTGRES_DB=mandateos postgres:16
export DATABASE_URL=postgresql://mandateos:mandateos@127.0.0.1:5432/mandateos
pnpm --filter @mandateos/db exec prisma db push
pnpm --filter @mandateos/db build
pnpm --filter @mandateos/api dev
# separate terminal/process
pnpm --filter @mandateos/api worker
```

Passkey ceremonies use `PASSKEY_RP_ID` and `CONSOLE_ORIGIN`; the browser origin
must match `CONSOLE_ORIGIN`.
