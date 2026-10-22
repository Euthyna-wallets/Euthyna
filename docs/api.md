# MandateOS API

Base URL: `http://localhost:3000`. All bodies are JSON. The server never stores an
agent's NEAR function-call private key: the console registers only its public key.

## Identities

| Identity | Credential | Header | Routes |
|---|---|---|---|
| Console member | Better Auth session (passkey) | `Cookie` | `/api/auth/*`, `/v1/console/*`, `/v1/emergency/cancel`, `/v1/relayer/broadcast` |
| Agent | Better Auth API key bound to the agent user | `x-api-key` | `/v1/guard/visas` |

Rate limits: Better Auth limits each API key to 60 requests/minute; the HTTP layer
adds 120 requests/minute per agent and 600 requests/minute per organization. Both
counters are in-memory for a single instance; a multi-instance deployment replaces
the organization limiter with a shared store.

Console sessions and agent credentials are disjoint: an agent key on a console route
returns `401`, and a console cookie on an agent route returns `401`. Every console
query is scoped to the session's `activeOrganizationId`; changing that id does not
grant access because the membership row is re-read on every request.

Creating or revoking an agent requires the console role `admin` (or `owner`). A
revoked agent fails closed twice: the API key is disabled and `agent.active` is
`false`, so an already-cached key stops resolving.

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

Creates an agent and a per-agent API key. The key is returned once and never stored
in clear. The request body:

```json
{
  "name": "Research agent",
  "role": "researcher",
  "nearAccountId": "agent-v5.example.testnet",
  "nearPublicKey": "ed25519:...",
  "vaultAccountId": "vault-v4.example.testnet",
  "mpcPath": "agents/researcher/base"
}
```

The client generates the NEAR function-call key pair locally and sends only
`nearPublicKey`. The server stores the public key and returns the API key. Signed
`add_key` / `revoke_agent` proposals are produced by the role compiler (backend D).

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

Console admin only. Broadcasts the stored signed transaction and submits the
Guard-signed confirmation report.

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

### `GET /v1/operations/:opId`

Agent only, own operations. Merges the DB (`Prepared`, `Escalated`, `Rejected`,
`Broadcast`, `Confirmed`, `Cancelled`, `Reverted`) with the Vault state and the
stored visa/escalation.

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

All `/v1/console/*` and `/v1/emergency/*` requests require
`Origin: CONSOLE_ORIGIN`. State-changing methods must also send
`Content-Type: application/json`; otherwise the API returns `403` or `415`.

### `PATCH /v1/console/members/me/wallets`

Links the session member's NEAR account and EVM address. Both are required before a
treasury plan can be built.

```json
{ "nearAccountId": "alice.testnet", "evmAddress": "0x..." }
```

### `GET /v1/console/members`

Returns members of the session organization with their linked `nearAccountId` and
`evmAddress`. Better Auth's own member listing does not expose application-specific
columns.

### `POST /v1/console/members`

Admin only. Adds a wallet-only council member for the MVP: no email invitation and
no login. The server creates a local `User` row (synthetic
`member-<uuid>@members.mandateos.invalid` email) and a `Member` row bound to the
organization, so the addresses immediately feed the DAO/Safe plan.

```json
{ "name": "Alice", "nearAccountId": "alice.testnet", "evmAddress": "0x..." }
```

Both fields accept a pasted wallet label: only the first token is kept and a trailing
`(...)` suffix is stripped, so `busyvideo615.testnet (*testnet)` is stored as
`busyvideo615.testnet`. The EVM address is checksum-normalized. Nothing is signed.

### `PATCH /v1/console/members/:id/wallets`

Admin only. Attaches or replaces the wallets of an existing organization member
(for example the owner created at signup). Uses the same normalization as
`POST /v1/console/members` and returns the updated member.

### `POST /v1/console/treasury/plan`

Admin only. Builds the unsigned DAO, Vault, relay and Base plan for the session
organization. It never signs and never receives a private key.

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

### `POST /v1/console/treasury/create-dao`

Admin only. Signs the Sputnik `create` call with the MandateOS relayer and pays the
attached deposit. The caller only supplies the same identifiers as the plan; no
member key is required.

```json
{ "environment": "uat", "daoName": "acme", "founderNearAccountId": "w-....mandateos.testnet" }
```

### `POST /v1/console/treasury/deploy-contracts`

Admin only. Creates and deploys the Vault and governance relay accounts with the
relayer (`CreateAccount → Transfer → DeployContract → new`), paying from
`NEAR_RELAYER_ACCOUNT_ID`. Both contracts are initialized with the DAO as owner and
hold no access key of their own.

### `GET /v1/console/treasury/sponsor-status`

Returns the public on-chain balance of the configured MandateOS parent account.
The console compares it independently with the DAO and Vault/relay deposits, so
an affordable DAO-only Company remains available when a full treasury is not.

### Funding model

Treasury deposits are one-time storage-backed account balances, not per-payment
fees. `factory.mandateos.testnet` references the official immutable global
Sputnik hash, so a new Company + DAO receives 0.25 NEAR and stores no duplicate
WASM. A full payment treasury adds 5 NEAR for the Vault and 3.5 NEAR for the
relay (8.75 NEAR total). Registration separately funds the client-owned
`w-<hex>.mandateos.testnet` wallet with 0.5 NEAR once.

Observed testnet storage is 150,710 bytes for the one-time factory and only 810
bytes (0.00810 NEAR minimum) for
`global-smoke.factory.mandateos.testnet`. Current-artifact sandbox measurements
after `new` and access-key removal are 439,560 bytes (4.39560 NEAR minimum) for
the Vault and 285,313 bytes (2.85313 NEAR minimum) for the relay. Testnet
protocol configuration reports `10^19` yoctoNEAR per byte; all API amounts use
`1 NEAR = 10^24` yoctoNEAR. The observed 14.288425743215 Tgas Vault
authorization costs about 0.00142885 NEAR at `10^8` yoctoNEAR/gas.

### `POST /v1/console/treasury/refresh`

Admin only. Re-runs every register check against the stored treasury and updates
its status: `pending_dao_hardening → active` once `get_factory_info().auto_update`
is `false`. The console exposes a "Re-run verification" button on that state.

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

- DAO code hash equals `sputnikv2.testnet.get_default_code_hash()`;
- DAO `get_policy()` has the council Group equal to the member NEAR accounts, an
  absolute `RoleWeight` threshold `ceil(2n/3)` with quorum `0`, and no other role
  carrying `Vote*` or `AddProposal` (Sputnik ORs roles); a council `vote_policy`
  is rejected unless each per-kind threshold is at least the expected threshold;
- DAO `get_factory_info().auto_update === false`; otherwise the treasury is stored
  as `pending_dao_hardening` and agent creation is blocked;
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
| `429` | `{ "message": "rate limit exceeded" }` | Agent or organization window exhausted |

## Audit

Every sensitive action appends a row to `audit_log`:

- `guard.visa.issued`, `guard.escalation`, `guard.visa.denied`;
- `agent.created`, `agent.revoked`;
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
```

The passkey origin must match `BETTER_AUTH_URL`; use `http://localhost:3000` for
local development, not `127.0.0.1`, so the WebAuthn RP id stays `localhost`.
