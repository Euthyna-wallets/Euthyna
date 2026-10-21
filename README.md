# MandateOS

**Let AI agents manage company funds inside mandates approved by humans, without giving an agent a treasury key.**

MandateOS assigns each agent a role, a budget, permitted assets, approved destinations and permitted operations. An agent can request an operation; it cannot sign an arbitrary treasury transaction. Every operation must pass three independent controls before funds move.

> Hackathon scope: NEAR Hackathon 2026, track 06 — AI Security & Defense.
>
> Project status: Phase 1 runs end to end on NEAR testnet + Base Sepolia: DAO-governed Vault, Guard visa, real MPC signature, Zodiac/Safe execution, 1 TestUSDC (test token) payment, signed confirmation, `0xGOV` governance and council veto. Phase 2 Intents and production deployment/hardening remain roadmap.

## Problem

AI agents can prepare invoices, rebalance assets and move funds across chains. Giving such an agent a wallet key makes its prompt, dependencies and runtime part of the treasury security boundary. A prompt injection, compromised dependency or leaked credential can then become an unrestricted signing capability.

MandateOS moves the limits outside the agent. The agent receives an API identity and a NEAR function-call key restricted to its client's Vault. The client generates that key locally. The agent never receives an EVM key. NEAR function-call keys can restrict a key to named methods on one receiver contract ([NEAR access keys][near-access-keys]).

## A mandate

The current Guard reads an explicit per-client JSON registry from `config/clients/<client>/vendors.json`. It contains exact addresses and amount ceilings; an absent case is escalated. The target control plane stores versioned drafts and immutable policy snapshots in PostgreSQL through Prisma, then compiles Guard, Vault and Zodiac artifacts from one approved snapshot.
An illustrative Phase 1 mandate contains:

| Field | Value |
|---|---|
| Client | ACME |
| Role | `researcher` |
| Agent | Better Auth client + NEAR function-call account |
| Operation | Base USDC payment |
| Vendors | ACME SAS, Data Provider |
| Maximum per transaction | 5,000 USDC |
| Monthly budget | 6,000 USDC |
| Idempotency | Contract-period or purchase-order reference |
| Gas | Governed `gasLimit`, `maxFeePerGas` and total fee |

The JSON registry is the reviewable hackathon input, not an on-chain authority. The Vault and Zodiac remain the sources of truth for active controls. The target multi-client service moves drafts and versions to PostgreSQL; the repository already contains the Prisma schema, while database-backed policy publication remains unimplemented.

## Three locks

| Lock | Location | Decision |
|---|---|---|
| **1. Guard** | TypeScript backend | Applies exact business rules to a prepared operation and signs a short-lived ed25519 visa bound to its exact transaction digest. An uncovered case is escalated to a human; it is never approved by inference. |
| **2. Vault** | Rust contract on NEAR, one per client | Enforces agent identity, role, budget, allowlist, reference idempotence, visa nonce and expiry. It builds the EIP-1559 transaction and requests an ECDSA signature from NEAR Chain Signatures. The Phase 1 builder is [`omni-transaction` 0.3][omni-transaction]. |
| **3. Zodiac Roles** | Roles Modifier attached to a Safe on Base | Restricts the target, function, calldata parameters and periodic allowance before the Safe executes the USDC transfer. Roles exposes `execTransactionWithRole` for this controlled execution path ([Roles repository][zodiac-roles]). |

```mermaid
sequenceDiagram
  participant A as AI agent
  participant V as Vault · NEAR
  participant G as Guard
  participant M as Chain Signatures MPC
  participant R as Relayer
  participant Z as Zodiac Roles
  participant S as Safe · Base

  A->>V: prepare(intent)
  V-->>A: op_id + tx_digest
  A->>G: request visa(op_id)
  G->>V: read prepared operation
  G-->>A: signed visa
  A->>V: authorize(op_id, visa)
  V->>M: sign EIP-1559 digest
  M-->>V: ECDSA signature
  V-->>R: signed raw transaction
  R->>Z: broadcast execTransactionWithRole
  Z->>S: execute allowed USDC transfer
```

The MPC address `0xAAA` is derived from `(Vault account, agent path)`. The Vault is the caller of the MPC contract, so only the Vault's code can request signatures for that derived address. Chain Signatures derives foreign-chain accounts from the NEAR caller and a derivation path ([Chain Signatures documentation][chain-signatures], [MPC repository][near-mpc]).

## Implemented

The current repository contains:

- `contracts/vault`: `prepare`, domain-separated Guard visas, EIP-1559 construction, `PossiblySigned`, permissionless `submit_signature` recovery for failed MPC callbacks, nonce cancellation and signed confirmation reports;
- `contracts/governance-relay`: DAO-only Delay calls, sequential `0xGOV` nonces, MPC signing, `PossiblySigned`, `submit_signature` recovery and same-nonce cancellation;
- `contracts/mock-mpc` and `contracts/test-ft`: sandbox dependencies, including delayed MPC response simulation;
- `contracts/tests`: nine DAO tests, ten Vault tests and six governance-relay tests using NEAR Sandbox;
- `apps/api`: Hono Guard and Base relayer, exact JSON registry evaluation, viem digest recomputation, ed25519 visas and confirmation reports;
- `apps/api` auth: Better Auth passkey sessions, organizations and memberships, per-agent API keys bound to the Vault agent account, console-only emergency route and append-only audit rows;
- `apps/api` treasury onboarding: `/v1/console/treasury/plan` returns the unsigned DAO, Vault, relay and Base plan; `/v1/console/treasury/register` re-verifies DAO code hash/policy/auto-update, Vault init parameters, relay delay/chain, zero access keys, Safe owners/threshold, module wiring and the environment-specific Delay cooldown before persisting a `Treasury`;
- `apps/api` mandates: `/v1/console/mandates/preview` compiles one role into Vault, Zodiac and Guard artifacts, a deterministic diff and unsigned DAO proposals; the console signs them with the member's NEAR wallet. `/v1/console/treasury/refresh` re-verifies a pending DAO and promotes it to active;
- `apps/api` agent payments: `POST /v1/operations/pay` (visa / escalation / refusal) with one transaction consuming the reference and storing the visa, idempotent per `opId`; `GET /v1/operations/:opId` merges DB, Vault and stored visa state; suppliers/contracts live in PostgreSQL with `registry_version` and four-eyes address changes;
- `apps/api` agent detail: `/v1/console/agents/:id` merges the stored agent with the Vault `get_agent` / `next_evm_nonce` state shown in the console;
- `apps/console`: React/Vite onboarding console — password bootstrap + passkey, organization and invitations, member wallet linking, treasury plan/wizard, treasury status gate and mandate preview/diff/proposals, plus agent registration;
- `packages/deployer`: viem deployment/configuration scripts for Safe 1.4.1, Roles 2.1.1, Delay 1.1.1, governance wiring and veto, plus the browser-agnostic `buildBaseTreasuryPlan` encoder;
- `packages/db`: validated Prisma schema for Better Auth organizations, members and API keys, plus agents, environments, vendors, policy snapshots, operations and audit rows;
- [`docs/dao-spike.md`](./docs/dao-spike.md): DAO policy, source citations and factory verification;
- [`docs/vault-testnet.md`](./docs/vault-testnet.md): Vault protocol, test coverage and testnet deployment evidence;
- [`docs/api.md`](./docs/api.md): console and agent authentication, routes, errors, audit rows and local setup;
- [`deployments/near-testnet.json`](./deployments/near-testnet.json) and [`deployments/base-sepolia.json`](./deployments/base-sepolia.json): observed addresses, policies and transaction hashes.

Phase 1 payment and governance demos run on NEAR testnet + Base Sepolia. NEP-366 sponsorship, the SDK/MCP agent, Phase 2 Intents and production hardening remain unimplemented.

## Architecture target

### Phase 1 — Base USDC payment

Phase 1 is complete only when this path runs end to end:

1. an authenticated agent calls `prepare(intent)` on its client's Vault;
2. the Vault reserves the role budget and business reference, assigns `op_id` and the next EVM nonce, builds the canonical EIP-1559 transaction and exposes `tx_digest`;
3. Guard reads that prepared operation, applies exact registry and policy rules, and signs the Borsh-encoded visa;
4. the agent calls `authorize(op_id, visa)`;
5. before calling the MPC, the Vault consumes the visa, enters `PossiblySigned` and permanently advances the EVM nonce; callback failure or timeout never releases the reservation, and a public `submit_signature` rebuilds the exact signed transaction for the original or cancellation digest;
6. a relayer broadcasts the signed transaction without modifying it, or signs a higher-fee zero-value cancellation at the same nonce after a circuit breaker;
7. Zodiac validates the USDC target, `transfer` function, recipient and allowance before the Safe executes it.

Local development uses NEAR Sandbox. UAT uses **NEAR testnet as the control plane and Base Sepolia as the execution plane**, with test assets and a 5 USDC allowance. Production remains NEAR mainnet + Base mainnet after the UAT and negative tests pass ([NEAR networks][near-networks], [Base networks][base-networks]).

Each derived Base address holds a small ETH balance funded by an approved governance action. `maxFeePerGas`, `maxPriorityFeePerGas` and `gasLimit` are part of the signed EIP-1559 transaction and therefore of `tx_digest`; the Vault also enforces `maxFeePerGas × gasLimit` against the role's fee cap. `omni-transaction` exposes the EVM signing preimage and signed transaction assembly ([omni-transaction][omni-transaction]).

### Phase 2 — swap and bridge through NEAR Intents

Phase 2 is a stretch target, not an implemented feature. The Vault derives a dedicated Intents account `0xINT` and signs ERC-191 payloads through the MPC. The Intents verifier supports ERC-191 payload recovery and `0x…` implicit account IDs ([ERC-191 implementation][intents-erc191], [public-key implementation][intents-public-key]).

- **Deposit:** the Safe may transfer Base USDC only to the POA deposit address associated with `0xINT` and returned by `deposit_address` for chain `eth:8453` ([deposit example][intents-deposit-example]).
- **Swap:** Guard provides a reference price; the Vault accepts a quote only when the minimum received satisfies that reference, then signs and publishes the intent.
- **Bridge:** the Vault signs an `ft_withdraw` intent only for a wallet registered to the client.

Funds credited to `0xINT` are protected by the Vault but no longer by Zodiac. The design therefore keeps at most one period's Intents budget in that account.

## Roadmap

- member voting accounts restricted to on-chain votes and backed by passkeys;
- multi-client deployment factory, after the single-client ACME deployment script is stable;
- NEP-366 sponsorship for agent and relayer calls;
- production `0xGOV` deployment on NEAR mainnet with Delay cooldown `86 400` seconds;
- additional assets and chains;
- on-chain or independently verified Base receipt proofs instead of trusted confirmation calls;
- audit coverage for `omni-transaction` and the MandateOS contracts before production use.

The target console uses Better Auth passkeys for login, prepares proposals and displays state. It never signs an on-chain proposal or treasury transaction ([Better Auth passkey plugin][better-auth-passkey]).

## Governance

The UAT governance path is implemented:

1. three company members vote through Sputnik/Trezu with absolute threshold `2`;
2. an approved proposal calls `gov-relay-v1.mandateos-root-20261021.testnet`;
3. the relay, owned by the DAO and without access keys, builds `Delay.execTransactionFromModule`, advances the sequential EVM nonce and asks Chain Signatures to sign for `0xGOV`;
4. `0xGOV` queues the call in Delay;
5. Base Sepolia uses a `300`-second cooldown, then `executeNextTx` forwards the call through the Safe;
6. production keeps a `86 400`-second cooldown.

`0xGOV` is `0xC9635C52861f6a68e4E27FaD8f3c663d4c11FDBb`; it is a Delay module, never a Safe owner. The Safe owners are the three council addresses listed in the deployment manifest, threshold 2/3. A council veto calls `setTxNonce`; the demonstrated post-veto `executeNextTx` reverted with `Transaction queue is empty`.

## Non-custodial properties

- MandateOS services do not hold an EVM private key for an agent, `0xAAA`, `0xINT` or `0xGOV`.
- The Guard key can approve only a prepared operation; it cannot call the Safe or force the Vault to request a signature.
- The Vault account has no access key after deployment. Policy changes and contract upgrades require the configured Trezu governance path.
- The relayer receives a complete signed transaction and only broadcasts it.
- A signature is treated as public from the moment the MPC request is made. `PossiblySigned` therefore keeps budget, reference and nonce locked through callback failure, timeout, pause and revocation.
- A compromised agent remains subject to Guard, Vault and Zodiac limits.
- A compromised Guard remains subject to Vault and Zodiac limits.

The DAO and Vault properties are exercised by automated tests. Safe/Zodiac and the complete payment path remain architecture claims until `deployments/base-sepolia.json` contains observed addresses and transaction hashes.

## Threat model

| Scenario | Required result | Bound |
|---|---|---|
| Agent calls `authorize` without a visa | Vault rejects | No payment |
| Visa is changed, expired or replayed | Vault rejects signature, digest, expiry or nonce | No payment |
| MPC response is late or its callback fails | Operation remains `PossiblySigned`; nonce cannot be reused; anyone may store the published signature with `submit_signature` | Confirmation waits for the exact signature or a same-nonce cancellation |
| Vault is paused or agent is revoked after `sign` | Reservation remains; emergency worker requests `cancel_nonce` | No automatic reopening |
| Agent requests an MPC signature directly | Derived address differs from the role member | Zodiac rejects |
| Prompt injection changes the recipient | Guard registry check, Vault allowlist and Zodiac parameter condition reject | No payment |
| Invoice reference is submitted twice | Active reservation or consumed reference rejects it | No duplicate payment |
| Guard signing key is compromised | Vault budget and Zodiac allowance still apply | Role budget/allowance |
| Vault is compromised | Zodiac still restricts Base calls | Sum of funded role allowances until intervention |
| Common policy is wrong | All three compiled targets can accept the same error | Human-approved erroneous budget |
| Phase 2 `0xINT` path is compromised | Zodiac is no longer in that path | Balance held by `0xINT` |

The detailed assumptions and state transitions are in [`Architecture.md`](./Architecture.md#modèle-de-menace).

## Repository layout

Current monorepo layout:

```text
MandateOS/
├── apps/
│   ├── api/                   # Hono Guard, Base relayer and emergency cancellation endpoint
│   └── console/               # React/Vite console: overview, agents, payments, escalations, onboarding
├── config/
│   └── clients/acme/          # Exact hackathon vendor registry
├── contracts/
│   ├── vault/
│   ├── governance-relay/
│   ├── mock-mpc/
│   ├── test-ft/
│   ├── tests/
│   └── res/
├── packages/
│   ├── db/                    # Prisma schema and shared client
│   └── deployer/              # viem Safe/Roles/Delay deployment
├── docs/
│   ├── api.md
│   ├── console/               # console screenshots
│   ├── dao-spike.md
│   └── vault-testnet.md
├── deployments/
│   ├── base-sepolia.json
│   └── near-testnet.json
├── Architecture.md
├── pnpm-workspace.yaml
└── README.md
```

Still-targeted packages are `agent-wallet`, `protocol`, `policy`, `sdk` and `cli`; the console remains roadmap work. Authentication lives in `apps/api` (Better Auth with Prisma). The API uses [Hono][hono]. [Prisma][prisma] defines the future PostgreSQL source of truth. MandateOS is independent and does not import or copy JOIN code.

## Getting started

Run all local checks:

```bash
pnpm install
DATABASE_URL=${DATABASE_URL:-postgresql://mandateos:mandateos@127.0.0.1:5432/mandateos} \
  pnpm --filter @mandateos/db exec prisma db push
pnpm typecheck
pnpm test
cd contracts
./build.sh
cargo test -p tests -- --nocapture
```

`build.sh` rebuilds the Vault and its two local test dependencies with the NEAR-compatible Rust 1.86 toolchain. The contract suite deploys Sputnik DAO and the Vault, removes their access keys and exercises DAO-only governance, visa checks, `PossiblySigned`, reservations, cancellation, EIP-1559 construction and delayed MPC responses. The TypeScript suite covers exact Guard escalation, domain-separated visas, agent/console credential separation, organization isolation and the compiled Roles recipient/allowance conditions. `apps/api/src/auth-gateway.integration.test.ts` runs the real Prisma adapter when `TEST_DATABASE_URL` points at a migrated database.

Run the local API only after filling a non-committed `.env` from [`env.example`](./env.example):

```bash
set -a
source .env
set +a
pnpm --filter @mandateos/api dev
```

The passkey relying party is `PASSKEY_RP_ID=localhost` and `BETTER_AUTH_URL=http://localhost:3000`. Email/password is enabled once to bootstrap the human account; the console immediately adds a passkey and uses it afterwards. Agent credentials are per-agent API keys in `x-api-key`, documented in [`docs/api.md`](./docs/api.md).

Run the console in another terminal:

```bash
pnpm --filter @mandateos/console dev
```

It listens on `http://localhost:5173` (`CONSOLE_ORIGIN`) and calls the API at
`VITE_API_URL` (default `http://localhost:3000`) with credentials. The API's CORS
and CSRF checks accept exactly `CONSOLE_ORIGIN`.

The Base Sepolia script performs no transaction unless every required variable is present and `BASE_DEPLOY_CONFIRM=DEPLOY_ACME_BASE_SEPOLIA`. On success it writes observed addresses, code hashes and transaction hashes to `deployments/base-sepolia.json`:

```bash
pnpm --filter @mandateos/deployer deploy:base-sepolia
```

## Demo acceptance scenario

The three-minute demonstration is considered valid only with public explorer links:

1. show the approved ACME role, budget, registry entry and corresponding Zodiac permission;
2. pay 1 TestUSDC (test token) from the Safe through the Vault/MPC path;
3. show Guard refusing to issue a visa, Vault refusing an out-of-allowlist `prepare`, and Zodiac reverting a signed direct call;
4. approve proposal `19` with two council votes to raise the researcher allowance to 10 TestUSDC (test token);
5. queue through `0xGOV`, wait 300 seconds, execute through Delay, and verify the 10 TestUSDC (test token) allowance;
6. approve malicious proposal `23`, queue it, veto with `setTxNonce(3)`, then show `executeNextTx` reverting;
7. show `cancel_nonce` keeping the same nonce and ending in `Cancelled` after cancellation confirmation.

## Deployments

The current UAT uses the security-corrected Vault and Base Sepolia chain ID `84532`. The older testnet deployment remains listed only under `superseded_deployment` in the machine-readable manifest.

| Component | NEAR testnet | Base Sepolia UAT |
|---|---|---|
| ACME DAO | `mandateos-uat-92543787.sputnikv2.testnet` | — |
| ACME Vault | `vault-v4.mandateos-root-20261021.testnet` | — |
| Test FT | `test-ft-v4.mandateos-root-20261021.testnet` | — |
| Agent | `agent-v4.mandateos-root-20261021.testnet` | `0x10EdE0F3C618321919934Fd63df173DD37F037Af` |
| MPC signer | `v1.signer-prod.testnet` | — |
| Safe 1.4.1 | — | `0x19C06E5bfCd7C31c71508f14df2f1C70d9D199cD` |
| Operational Roles 2.1.1 | — | `0x7178555779097cAE1BA20C5D7ED7205708a5ed40` |
| TestUSDC (test token) | — | `0x418A2b47911dE05e21688F7490195F5324B49474` |
| Delay 1.1.1 | — | `0xDd860F2a45b62b84A94ABF61F7f6c2f262549533` |
| Governance relay | `gov-relay-v1.mandateos-root-20261021.testnet` | `0xC9635C52861f6a68e4E27FaD8f3c663d4c11FDBb` |
| Researcher `0xAAA` | — | `0x10EdE0F3C618321919934Fd63df173DD37F037Af` |

Observed NEAR state is recorded in [`deployments/near-testnet.json`](./deployments/near-testnet.json). Base Sepolia addresses, bytecode hashes, council policy and transaction hashes are recorded in [`deployments/base-sepolia.json`](./deployments/base-sepolia.json).

On-chain verification observed Safe owners `3`, threshold `2`, Safe modules Roles + Delay, Delay module `0xGOV`, Delay `300 / 604 800`, funded gas accounts, a confirmed 1 TestUSDC (test token) payment, researcher allowance raised to 10 TestUSDC (test token), and a veto that advanced `txNonce` to `queueNonce = 3`. Separate failures prove Guard, Vault and Zodiac each reject independently.

| Governance proof | Base Sepolia transaction |
|---|---|
| Queue allowance 10 TestUSDC (test token) | `0x0a0f5f6adb19b287499abf82923300a63abb9b2cd60d4c8e39b1908b89f56f84` |
| Execute allowance after cooldown | `0x08a2fb37cf467fbfaf440b322d58093a2c2d138814d50ff77403637d09752e57` |
| Queue malicious allowance | `0xc4cdf2767f875e2b73dee0a2c0068352ec534821555ca8a5ec5d8f0b117f7586` |
| Council veto `setTxNonce(3)` | `0xab38cd090d4864c1826fdd45bff0f8291a2749f35230a0d0f1a3175a5760e324` |
| Rejected execution after veto | `0x5f24a2d514917499de2a81d8e60cb181d00c4471deda7f0b35ee288ecdbf14df` |
| Signed direct Zodiac attack rejected | `0xaddc852fa9967d6171127c424ba5c2c1e819e6ea98b98634e640faa9b1688ebb` |

## Limits

- The contracts and backend have not been audited. UAT uses deterministic/test-only Guard and council credentials and assets without financial value.
- The deployed UAT Vault (`11cb6f03…acc21`) and relay (`4f0bf6b1…3ac41`) predate the `submit_signature` recovery fix; the fix is covered by Sandbox tests and requires a governed redeployment. Local build hashes are recorded in `deployments/near-testnet.json`.
- The three council keys used for the UAT veto demo are stored in one `.env` on one machine; production requires separate hardware keys.
- The UAT `allowedRecipient` (`0xa7BE833AD5422421204198E47C04516B0026F9B6`) is also council owner 3, so the demo recipient and one veto key share an address.
- An MPC signature is considered public as soon as `sign` is called. Callback failure, timeout, pause or revocation does not release a `PossiblySigned` reservation; `submit_signature` stores the published signature after verification with `ecrecover`, otherwise a confirmed same-nonce cancellation is required.
- The Vault depends on NEAR Chain Signatures availability. Testnet uses `v1.signer-prod.testnet`; production targets `v1.signer` ([MPC repository][near-mpc]).
- `omni-transaction` 0.3 builds the EIP-1559 preimage and does not publish an audit report in its repository ([omni-transaction][omni-transaction]).
- Agent-side NEAR gas sponsorship through NEP-366 is designed but not yet implemented; testnet smoke accounts are faucet-funded ([NEAR meta-transactions][near-meta-transactions]).
- Phase 1 is confirmed end to end. The payment transaction is `0x0bf66f0c192ee3874d8f69af9fc704d0abd616f8162390521fbaed088d8e4ea4`; the Vault state is `Confirmed`, with `1_000_000` spent and no reservation.
- Phase 1 Base Sepolia uses `TestUSDC (test token)`, a 6-decimal ERC-20 deployed by the UAT script. It is not Circle USDC and has no value.
- A Guard-signed status report can only confirm the exact original transaction. Only the DAO owner can confirm an on-chain cancellation.
- A reverted transaction is never reopened automatically; DAO governance is required.
- The Safe security council retains full 2/3 emergency authority; operational policy limits it to veto and incidents.
- The common mandate is a common-mode risk: a policy error can be compiled into all three locks.
- Phase 2 assets held by `0xINT` are outside Zodiac protection; exposure is limited operationally to the period budget.
- The Base withdrawal memo and independent reference-price source remain open design points.
- Treasury onboarding deploys the Safe first, then deploys Roles/Delay and enables them in a 2/3 Safe batch. Deploying the modules inside Safe `setup` would require predicting module addresses that themselves depend on the Safe address (circular dependency).
- Financing a new role budget and depositing TestUSDC on the Safe remain operator steps; the mandate preview returns a funding payload but does not sign it.
- A DAO registered before `FactoryInfoUpdate` is stored as `pending_dao_hardening`; the console and API block agent registration until the treasury is re-registered after the proposal executes.

## License

[MIT](./LICENSE), copyright 2026 JOIN.

## Sources

- [NEAR access keys][near-access-keys]
- [NEAR Chain Signatures][chain-signatures] and the [MPC implementation][near-mpc]
- [`omni-transaction` 0.3][omni-transaction]
- [Zodiac Roles Modifier][zodiac-roles]
- [Safe signature encoding][safe-signatures]
- [Sputnik DAO v2][sputnik]
- [NEAR Intents contracts][near-intents]

[near-access-keys]: https://docs.near.org/protocol/accounts-contracts/access-keys
[chain-signatures]: https://docs.near.org/chain-abstraction/chain-signatures
[near-mpc]: https://github.com/near/mpc/blob/main/README.md
[omni-transaction]: https://github.com/near/omni-transaction-rs
[zodiac-roles]: https://github.com/gnosisguild/zodiac-modifier-roles
[safe-signatures]: https://github.com/safe-global/safe-smart-account/blob/main/docs/signatures.md
[sputnik]: https://github.com/near-daos/sputnik-dao-contract
[near-intents]: https://github.com/near/intents
[intents-erc191]: https://github.com/near/intents/blob/main/contracts/defuse/core/src/payload/erc191.rs
[intents-public-key]: https://github.com/near/intents/blob/main/contracts/defuse/core/src/public_key.rs
[intents-deposit-example]: https://github.com/near-examples/near-intents-examples/blob/main/verifier-examples/get-token-deposit-address.ts
[near-networks]: https://docs.near.org/protocol/network/networks
[base-networks]: https://docs.base.org/base-chain/network-information
[better-auth-passkey]: https://www.better-auth.com/docs/plugins/passkey
[hono]: https://hono.dev/docs/
[prisma]: https://www.prisma.io/docs/orm
[near-meta-transactions]: https://docs.near.org/protocol/transactions/meta-tx
