# Euthyna

**Create your AI company.** Agents do the work. Founders and investors own
the company and vote on the rules. A contract on NEAR enforces them: an agent
cannot sign anything its role does not allow, even when it is hacked.

Built for the [NEAR Hackathon](https://nearhackathon.com/) (tracks 04 Autonomous Business, 06 AI Security & Defense, 12 Social Money). Testnet only, unaudited.

**Names.** **Euthyna** is the project: this repository, its contracts, API and console. **Atlantis** is its public
site at [euthyna.io](https://euthyna.io), where anyone creates an AI company and finds the others. The code packages
are `@euthyna/*`. `MandateOS`, the project's first name, survives only in testnet account names
(`*.mandateos-root-20261021.testnet`), the local database name and the contracts' Cargo metadata (changing it would
change the wasm hashes).

**Judges:** [JUDGE-PATH.md](./JUDGE-PATH.md) walks through the product in about 20 minutes, each step with what you
should see and how to check it on chain.

## What it is

| | |
| --- | --- |
| **The company** | a Sputnik DAO on NEAR, and an **OmniRoles vault** with no access key that the DAO owns |
| **Its wallet** | one EVM address, the same on every EVM chain, derived by NEAR Chain Signatures (MPC) from the vault. Only the vault can ask for its signatures |
| **The AI employees** | agents with a NEAR key that can only ask the vault for operations, and a **role**: which chains, contracts, functions, parameters and budget |
| **The owners** | founders (members, two thirds, also the security council) and, optionally, **investors** who buy shares and vote with them |
| **The revenue** | goes to the investors who vote, epoch by epoch |

An agent never holds a key that moves funds. What its role allows is signed;
everything else is refused, and there is no escalation. Only the owners change
a role, by vote, and every change waits out a veto window.

## Security model

We assume the agent will be compromised: a prompt injection, a poisoned memory
or a replaced MCP tool lets the attacker make it sign anything its key can
sign. So no lock depends on the agent behaving, and no server holds a key that
moves funds.

| Threat | Defence | Proof |
| --- | --- | --- |
| A hijacked agent pays the attacker | The vault checks the role on chain before anything is signed: chain, contract, function, calldata conditions (recipient, amount measured from the calldata), refilling budgets, velocity limit, fee caps, single-use references | `contracts/tests/tests/attacks.rs`, [docs/attacks.md](./docs/attacks.md) |
| A large payment | A human co-signs above the role's threshold; the agent cannot co-sign its own | `ERR_COSIGN_REQUIRED`, `ERR_SELF_COSIGN` in the attack suite |
| A stolen Guard key | The role conditions run before any visa: the Guard can only refuse, never widen a role | attack suite |
| A stolen server, database or deployer key | The vault, the registry and Nomos have no access key. The company wallet has no private key: NEAR MPC signs only what the vault asks, and the vault settles from an MPC attestation of the finalized transaction, not from a server | `view_access_key_list` on the vault, `contracts/tests/tests/settlement.rs` |
| A bad rule pushed through | Rules change only by DAO vote (two thirds), then wait out a veto window. **Security council**: one council member can veto a queued change, and the council can pause every agent; only a vote resumes them | `contracts/tests/tests/dao_governance.rs` |
| A malicious code upgrade | **Nomos** (`euthyna-nomos.testnet`; companies before 2026-11-07: `nomos.euthyna.testnet`) publishes each vault version by its SHA-256 hash and creates keyless vaults as sub-accounts; it has no power over a vault once created. A vault upgrades only on a DAO `Upgrade { code_hash }` vote after the veto window, checks the hash and keeps its state. The DAO can also vote `SetCodeSource` to fetch versions from another Nomos | `contracts/tests/tests/nomos.rs` (`nomos_creates_keyless_vaults_and_only_the_dao_upgrades_them`) |
| A founder loses their NEAR account | **ZK Email recovery, verified on chain**: a zero-knowledge proof of the enrolled mailbox (DKIM, proved in the browser, the address is never revealed, only a salted hash), **verified by a NEAR contract** with no access key (`euthyna-recovery-v4.testnet`, about 85 Tgas), a waiting period the contract enforces and the lost account can cancel, then the founders' vote gives the seat back in the DAO and the vault council | [docs/recovery.md](./docs/recovery.md), `contracts/email-recovery`, `circuits/email-recovery`; `contracts/tests/tests/email_recovery.rs` (real proofs, including a real iCloud email); testnet run of 2026-11-04 on `eut-rec-11526.sputnikv2.testnet` |
| An investor majority turns hostile | The founders keep their veto on vault changes | [Owners and money](#owners-and-money) |

```bash
pnpm attack:all       # 48 attacks on a sandbox vault and the Guard: 48 refused
pnpm attack:testnet   # the same checks against the live testnet vault, view calls only
```

Every claim and its status (testnet, code, next): [CLAIMS.md](./CLAIMS.md).

## Try the seat recovery (judges)

The ZK Email proof is verified by a NEAR contract, `euthyna-recovery-v4.testnet`. On testnet the lost account can
cancel for **10 minutes** (48 hours is meant for mainnet), so the whole flow fits in one sitting.

**1. Check the contract, read-only (1 minute, no wallet).** [near CLI](https://github.com/near/near-cli-rs):

```bash
near account list-keys euthyna-recovery-v4.testnet network-config testnet now
#   → no access key: nobody can change or upgrade it
near contract call-function as-read-only euthyna-recovery-v4.testnet dkim_keys json-args '{"domain":"gmail.com"}' network-config testnet now
#   → the DKIM keys it accepts for Gmail (sha256 of the key as the circuit takes it)
near contract call-function as-read-only euthyna-recovery.testnet recoveries_of json-args '{"dao_id":"eut-rec-11526.sputnikv2.testnet"}' network-config testnet now
#   → the demo DAO's history on the first contract (euthyna-recovery.testnet): one recovery cancelled by the founder, then one left to run past its delay
#     (ready: true), after which the founders voted the seat to the new account
near contract call-function as-read-only eut-rec-11526.sputnikv2.testnet get_policy json-args '{}' network-config testnet now
#   → council: dave, carol, bob (bob replaced alice, the founder who "lost" her account)
```

The account's code hash is `Eg1Ht4oYrNVjDVaqgsGrwPgsev1ZsbfzMr4HPd5uRhPa`, base58 of the sha256 of
`contracts/res/email_recovery.wasm` (built in the pinned image the CI checks). Every transaction of the run is in
[docs/recovery.md](./docs/recovery.md#on-testnet).

**2. Re-run the proofs (5 minutes).** Real emails, real proofs, a NEAR sandbox:

```bash
cd contracts && cargo test -p tests --test email_recovery
#   → 4 passed: an unknown DKIM key, another account's email, a flipped public input, another mailbox,
#     another salt are refused; a real iCloud email verifies on chain; ready only after the delay
ZK_EMAIL_PROVE=1 pnpm --filter @euthyna/api exec vitest run src/recovery/email.prove
#   → the circuit in Node: a zero-knowledge proof verifies, a forged one does not
```

**3. In the console (about 15 minutes).** As a founder of a company: **Settings → Seat recovery**. Send yourself an
email with the subject shown (`Euthyna enroll near:<your account>`) from Gmail, Outlook, iCloud, Yahoo or Proton
(on testnet also a [YOPmail](https://yopmail.com) inbox, which has no password: testnet only), paste its source,
**Prove**, sign. → *Enrolled on chain: a mailbox at … can recover your seat.* Then, signed in with another NEAR
account, open **/recover**, give the DAO and the founder's account, send `Euthyna recovery near:<new account>` from
the same mailbox, prove and sign. → *Request recorded on chain … can cancel it until …* The founder sees it in
Settings and can **cancel**; after 10 minutes any member gets **Submit the vote**. The email never leaves the
browser; only the zero-knowledge proof and a salted hash of the address go on chain.

## Sealed orders: limit orders nobody sees

A company can place a limit order (buy WETH with USDC on Uniswap when 1 WETH costs at most X) without
showing it. The DAO votes on one hash. Whoever holds the order file (the member who sealed it) runs the
watcher; when the market meets the hidden limit, it proves in zero knowledge (Noir, UltraHonk) that the
fill meets the limit, the total and the deadline. `contracts/sealed-orders` verifies the proof on NEAR,
then asks the vault for the swap as a member of a `sealed-orders` role, so the role still decides the
router, the pair, the recipient and the budget. The hidden terms never reach the chain, not even after
a fill; the fill itself (amount, pair, rate) is a public Base transaction. Details and limits:
[CLAIMS.md](./CLAIMS.md#sealed-orders-private-limit-orders).

Turn it on with "Allow sealed orders" in a swap role (Rules); place orders by a vote (Wallet → Sealed orders) or from
an agent of that role (MCP `place_sealed_order`, or the CLI below); members read the terms with a key derived from a
signature of their wallet.

```sh
pnpm --filter @euthyna/api sealed place --key agent.json --vault <vault> --role <role> --price 1800 --cap 50 --days 7 > order.json
pnpm --filter @euthyna/api sealed watch order.json --key watcher.json
```

## Product architecture

![Product architecture: investors and the security council outside the AI company; roles, AI employees and treasury inside; clients, suppliers and the public directory around it](./docs/diagrams/product.png)

1. **Raise**: founders create the company; investors buy shares and the proceeds go to the treasury.
2. **Hire**: the owners vote a role for each AI employee. The agent plugs in over MCP.
3. **Work**: agents pay suppliers, swap and invest within their budget, and bring revenue back.
4. **Share**: each epoch, revenue goes to the investors who voted.
5. **Show**: the company lists itself in the public directory, by vote.

## Technical architecture

![Technical architecture: the agent calls the OmniRoles vault directly (prepare, authorize); the owners vote rules and suppliers through the Sputnik DAO; NEAR MPC signs for the company wallet, the signed transaction is relayed unchanged to Ethereum, Base, Arbitrum (Solana and Bitcoin next), and NEAR MPC verifies the finalized receipt so the vault settles the budget. The Guard is optional advice.](./docs/diagrams/technical.png)

| Layer | Holds keys that move funds? |
| --- | --- |
| Agent | no: a NEAR function-call key on the vault only (14 agent methods, each checked against the agent's role on chain; no NEAR transfer, no other contract, no new key) |
| API, Guard, worker | no: visa keys and broadcasting only |
| OmniRoles vault, registry, DAO factory | no access key after deployment |
| Company wallet | no private key exists; NEAR MPC signs only what the vault asks |

Contract invariants and the full key model: [Architecture.md](./Architecture.md). Diagram sources: [docs/diagrams](./docs/diagrams).

## How an agent's payment goes through

![Sequence of an agent payment: prepare on the vault, visa from the Guard, authorize, MPC signature, broadcast to Base](./docs/diagrams/payment.png)

The vault checks the role before any visa exists, so a stolen Guard key still
cannot leave the role. Without the Guard, agents stop, but founders can still
vote transactions.

## Owners and money

- **Founders** vote on everything by two thirds: roles, budgets, members, pause,
  and transactions outside any role (a multisig, also usable from any dApp via WalletConnect).
- **Investors** buy shares at a fixed price (proceeds go to the DAO) and lock
  them to vote on company calls and transfers, by majority of locked shares.
  Founders keep their veto on vault changes.
- **Revenue for voters**: what the company shares in an epoch (NEAR, or Base ETH
  bridged by Omni Bridge) goes to the holders who voted on at least one proposal
  of that epoch, pro rata. The part of the others goes to them.
- **An agent can share revenue on its own**: its role lets it send ETH through the
  Omni Bridge to the company's shares contract, and nowhere else.

Details: [docs/shares.md](./docs/shares.md).

## Market: AI companies sell to each other

Every company can sell a service (a DeFi due diligence report, a transaction check) to agents and people, paid
to its vault on NEAR. It speaks the same protocol as NEAR's AI agent market (A2A + x402 v2), on testnet.

1. **Sell.** Console → Market → New listing; create the worker token; run the worker
   (`apps/market-worker`, `tx-check` or `defi-due-diligence`); put the listing live. It appears on `/market`.
2. **Give an agent a card.** `sudo euthyna-signer card <agent>`, then a rule « Pay in NEAR tokens » to the
   agent's card with a daily budget: the vault refills it, the agent spends from it.
3. **Buy as an agent.** In the MCP: `list_market_agents`, then `hire_agent(handle, task, max_price)`. The card
   signs one `ft_transfer` cheque (NEP-366); the market holds it and relays it only when the seller delivers.
4. **Buy as a person.** `/market` → Pay and run; the wallet sends the transfer upfront (browser wallets cannot
   sign held cheques yet), the work starts once it is final.

How the cheque is checked, what the worker's agent may do, and what was tested: [docs/market.md](./docs/market.md).

## Proof

| What | Where |
| --- | --- |
| 48 attacks refused (hacked agent, stolen Guard key, stolen server, one rogue member) | `pnpm attack:all`, [docs/attacks.md](./docs/attacks.md) |
| The same attacks against a live testnet vault, read-only | `pnpm attack:testnet` |
| Shares: sale, votes, revenue only for voters, over three epochs | [docs/shares.md](./docs/shares.md) (testnet hashes) |
| An agent sends ETH from Base to the investors through Omni Bridge; the same call to another account is refused | [docs/shares.md](./docs/shares.md) (testnet hashes) |
| Keyless registry deployed; companies listed by DAO vote | [docs/registry.md](./docs/registry.md) (testnet hashes) |
| Founder seat recovery verified on chain: enroll, a request from another mailbox refused, cancel, ready after the delay, then the founders' vote | [docs/recovery.md](./docs/recovery.md) (testnet hashes), `contracts/tests/tests/email_recovery.rs` |
| Market end to end: an agent hires another company's agent, its card pays on delivery, the seller's vault receives exactly the price | `apps/api/src/market/e2e.integration.test.ts` (NEAR sandbox, PostgreSQL, the real euthyna-signer) |

## Run it

Requirements: Node 22, pnpm 12.15 (`npm i -g pnpm@12.15.0`), PostgreSQL, and
Rust with `cargo-near` for the contracts.

```bash
pnpm install
cp env.example .env            # fill it; never commit it
pnpm --filter @euthyna/db exec prisma db push
pnpm --filter @euthyna/api dev        # API on :3000
pnpm --filter @euthyna/api worker     # broadcasts what the vault signed
pnpm --filter @euthyna/console dev    # console on :5173
```

### Docker Compose

Docker runs PostgreSQL, the one-shot Prisma schema sync, API, worker and static
console. Copy and fill `.env` first; it is mounted at runtime and excluded from
the image build.

```bash
cp env.example .env
docker compose up --build -d
docker compose logs -f api worker
```

Open `http://localhost:8088`. PostgreSQL is exposed on `127.0.0.1:5434` for
local diagnostics. Override either host port without changing the containers:

```bash
MANDATEOS_HTTP_PORT=8081 MANDATEOS_POSTGRES_PORT=5435 docker compose up --build -d
```

Stop the stack while preserving PostgreSQL data with `docker compose down`.
`docker compose down --volumes` also deletes the database and is destructive.
Private keys and Guard secrets belong only in `.env` or a Docker secret; never
copy them into an image.

Checks:

```bash
pnpm typecheck && pnpm test
cd contracts && ./build.sh && cargo test --workspace
pnpm attack:all
```

## Repository

| Path | What |
| --- | --- |
| `contracts/vault` | the OmniRoles vault: roles, budgets, veto window, nonces, MPC signing |
| `contracts/omniroles-conditions` | the rule engine (condition trees on calldata, in Rust) |
| `contracts/shares` | shares: token, sale, Sputnik votes, revenue by epoch for voters |
| `contracts/dao-factory` | creates the company DAOs |
| `contracts/registry` | the public directory of companies |
| `contracts/email-recovery` | founder seat recovery: verifies ZK Email proofs on chain (UltraHonk on NEAR's BN254 host functions) |
| `circuits/email-recovery` | the ZK Email circuit (Noir); `circuits/vendor` and `contracts/vendor` hold the patched libraries |
| `contracts/tests` | sandbox tests and the on-chain attack suite |
| `apps/api` | sign-in, Guard, supplier registry, proposals, worker |
| `apps/console` | the console and the public pages (`/`, `/c/<dao>`) |
| `packages/sdk`, `packages/mcp` | the agent side: SDK and MCP server |
| `signer` | `euthyna-signer` (Rust): keeps an agent's NEAR key away from the AI and signs only requests to its vault |
| `apps/demo-agent` | a small agent that pays invoices |

## Limits

- Built today: NEAR, Base and Ethereum; roles for paying suppliers, sharing revenue and Uniswap swaps. Solana, Bitcoin, a bank account, stocks, security audits and influence campaigns are shown on the landing but not built ([docs/explore.md](./docs/explore.md)).

- Testnet only. The contracts are unaudited.
- The Guard runs on the Euthyna server; its invoice screening is a filter, not a proof.
- NEAR MPC and Sputnik DAO are trusted as deployed.
- An investor majority outvotes the others on calls and transfers; the founders' veto on vault changes is the safeguard.
- Signing in proves a NEAR account, not a distinct human.
