# MandateOS API

Base URL: `http://localhost:3000`. All bodies are JSON. The server never stores an
agent's NEAR function-call private key: the console registers only its public key.

## Identities

| Identity | Credential | Header | Routes |
|---|---|---|---|
| Console member | Better Auth passkey session (email profile identifier) | `Cookie` | `/api/auth/*`, `/v1/console/*`, `/v1/emergency/cancel`, `/v1/relayer/broadcast` |
| Agent | Better Auth API key bound to the agent user | `x-api-key` | `/v1/operations/*` |

Rate limits: `/api/register/passkey-start` permits 5 requests per remote IP per
15 minutes and 3 requests per normalized email per hour. Agent API keys allow
60 requests/minute; the HTTP layer adds 120 requests/minute per agent and 600
requests/minute per organization. Registration counters are in-memory per API
instance; wallet and agent-account sponsorship share one durable PostgreSQL
daily cap.

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
and one `AddKey`. That key is FunctionCall-only, has allowance
`NEAR_AGENT_FC_ALLOWANCE_YOCTO`, receiver = Vault, and exactly
`prepare`, `authorize`, `cancel_nonce`, `request_derived_public_key`. No
full-access key is added
([`apps/api/src/agent-provisioning.ts`](../apps/api/src/agent-provisioning.ts),
[`apps/api/src/near.ts`](../apps/api/src/near.ts)).

`GET /v1/console/agents/:id/provision` returns the server observation.
`POST /v1/console/agents/:id/provision-confirm` repeats the RPC attestation and
stores the admin confirmation. The browser independently calls
`view_access_key_list` and displays every expected/observed field before that
confirmation ([`apps/console/src/wallets.ts`](../apps/console/src/wallets.ts)).

Observed testnet integration (the reserve was overridden to `0.03 NEAR` for
this isolated proof; UAT default remains `0.3 NEAR`):

- account `pr-a-1761141000-agent.mandateos.testnet`;
- transaction
  [`4VxqUr3CyDpF5n8b7HwwtcqPUPtwy41BuEFWX23Qmf4Y`](https://testnet.nearblocks.io/txns/4VxqUr3CyDpF5n8b7HwwtcqPUPtwy41BuEFWX23Qmf4Y);
- finalized block `274267811`;
- exactly one key, `FunctionCall`, allowance `0.01 NEAR`, receiver
  `vault-v4.mandateos-root-20261021.testnet`, and the four documented methods;
- local key file permission observed as `0600`.

`request_derived_public_key` requires no attached deposit. Its focused Sandbox
run burnt `6.306 Tgas`; the SDK attaches `50 Tgas` to cover the MPC call and
callback ([`contracts/tests/tests/vault_operations.rs`](../contracts/tests/tests/vault_operations.rs)).

![Agent restricted-key attestation](./console/agent-provisioning.webp)

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

### `POST /v1/operations/pay`

Agent credential (`x-api-key`), body `{ "opId": [..32 bytes..] }`. The agent has
already called `prepare` on the Vault with its client-held function-call key.

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

### `POST /v1/console/mandates/preview`

Compiles one role into the three locks and returns a diff plus unsigned proposals:

- Vault `set_role` config (`role_key`, token, Recipient allowlist, caps, gas);
- Zodiac permission (`scopeTarget`, `scopeFunction` with recipient conditions and allowance,
  `assignRoles` once the agent EVM address exists);
- Guard policy snapshot;
- DAO `add_proposal` payloads for the Vault, funding and relay calls. The console
  signs each proposal with the member's NEAR wallet; the server never signs.

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
