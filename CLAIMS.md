# Claims and their proof

Every statement on the public site (`/`, `/whitepaper`) and what proves it. Status:

- **Testnet**: done on a testnet, with a transaction hash or a live read in this repository.
- **Code**: implemented and covered by tests here, not yet shown with a hash in this repository.
- **Reported**: stated in the whitepaper (Oct 29, 2026) as run on testnet; the transaction hash is not in this repository yet. Add it, then the status becomes Testnet.
- **NEXT**: not built. The site labels it NEXT or PLANNED.

## The infrastructure

| Claim | Status | Proof |
| --- | --- | --- |
| The vault account has no access key; the company wallet has no private key, NEAR MPC signs only what the vault asks | Testnet | `view_access_key_list` on the vault; [docs/shares.md](./docs/shares.md); the company page `/c/<dao>` reads it live |
| The agent holds a NEAR key that can only call the vault's agent methods | Code | Method list in [Architecture.md](./Architecture.md); `packages/sdk/src/index.ts` |
| A role pins chain, contract, function and calldata conditions, with budgets that refill, delays, co-signature thresholds, velocity limits | Code | `contracts/vault/src/types.rs`, `contracts/omniroles-conditions`, `contracts/tests` |
| Rule changes: DAO vote, delay, council veto; the council pauses all agents, only a vote resumes | Code | `contracts/tests/tests/dao_governance.rs`, `contracts/tests/tests/attacks.rs` |
| `check_operation` answers allowed or refused with a reason, without reserving anything | Code | `contracts/vault/src/lib.rs`; `pnpm attack:testnet` calls it on a live vault |
| Settlement uses an MPC attestation of the finalized transaction, not a server; the API is optional for execution | Code | `contracts/vault/src/foreign.rs`, `contracts/tests/tests/settlement.rs`, [Architecture.md](./Architecture.md) |
| 48 attacks, 48 refused | Code | `pnpm attack:all`, [docs/attacks.md](./docs/attacks.md) |
| Vault versions published on Nomos by hash and upgraded by DAO vote, state kept | Code | `contracts/tests` (upgrade tests); the whitepaper reports three versions live on testnet |
| Roles for payments, Uniswap swaps, Aave lending, WETH wrapping, Solana transfers, NEAR token transfers, revenue sharing | Code | `packages/sdk/src/roles.ts`, `contracts/omniroles-conditions/src/presets.rs` |
| Euthyna Market: companies sell agent work, buyers pay with a card; the payment is held until delivery | Code | [docs/market.md](./docs/market.md), `apps/api/src/market/e2e.integration.test.ts` |

## Chains

| Claim | Status | Proof |
| --- | --- | --- |
| Base Sepolia: payments signed by MPC and broadcast | Testnet | [docs/shares.md](./docs/shares.md), [docs/vault-testnet.md](./docs/vault-testnet.md) |
| Solana devnet: the vault builds the transaction, MPC signs ed25519, MPC attests finality | Code, Reported | `contracts/vault/src/solana.rs`, `packages/sdk/src/solana.ts` and tests; whitepaper reports an 18 second devnet transfer. **Add the signature to the docs.** |
| Ethereum Sepolia | Code, Reported | API, SDK and console support chain 11155111 (`apps/api/src/omniroles.ts`). The MPC settlement table in `contracts/vault/src/foreign.rs` lists Base, Arbitrum, BNB, Polygon and Avalanche, **not Ethereum**. Confirm how Ethereum settles and add a hash. |
| Arbitrum, BSC, Plasma, Tron, Bitcoin | NEXT | Whitepaper, "Chains" and "Next". Arbitrum, BNB, Polygon and Avalanche are mapped in `foreign.rs` for settlement, not demonstrated. |

## Recovery

| Claim | Status | Proof |
| --- | --- | --- |
| A founder who lost their NEAR account gets their DAO seat back: a zero-knowledge proof of the enrolled mailbox (ZK Email: DKIM, proved in the browser, only a salted hash of the address), **verified on chain** by `euthyna-recovery.testnet` (no access key), a waiting period the contract enforces and the lost account can cancel, then the founders' vote | Testnet | [docs/recovery.md](./docs/recovery.md); `contracts/email-recovery`, `contracts/tests/tests/email_recovery.rs`, `circuits/email-recovery`; deploy `9TQFJBzjXRJ1iEsqGmNJzBcw2UeqCcH6E1h1dmLN7x3g`, enroll `6Cgo1kQcuqfSShZz5ohYHGhfpzLvu98WajdinoxEoFBP`, request `4T4dcaZkUBpRifivsuYRGRMGah7h6ACrsTTjGm7Ugp4b` on `eut-rec-11526.sputnikv2.testnet`. A real iCloud email is proved and verified on chain in the sandbox suite. |
| Recovery of a member's NEAR account with passkey, ZKPassport or a trusted contact, 2 factors | NEXT | Whitepaper, "Recovery and identity (planned)". No code yet. |
| Company last-resort recovery by a director's ZKPassport proof, 14 to 30 day delay | NEXT | Same |

## Atlantis (built with EUTHYNA)

| Claim | Status | Proof |
| --- | --- | --- |
| A company is a Sputnik DAO with a keyless vault from Nomos | Code | `contracts/dao-factory`, `apps/console/src/routes/OnboardingPage.tsx` |
| Shares sold for NEAR; revenue goes to the holders who voted | Testnet | [docs/shares.md](./docs/shares.md) |
| An agent sends revenue through Omni Bridge to the shares contract, and nowhere else | Testnet | [docs/shares.md](./docs/shares.md) |
| Companies are listed in a registry by DAO vote; a visitor inspects a company without a wallet | Testnet | [docs/registry.md](./docs/registry.md), [docs/explore.md](./docs/explore.md) |
| The Atlantis map on `/` shows companies read from the registry; when it is empty or unreachable it shows labelled examples | Code | `apps/console/src/routes/public/atlantis/AtlantisLanding.tsx` |

## Distribution

| Claim | Status | Proof |
| --- | --- | --- |
| `npx -y @euthyna/mcp` | NEXT | Not on npm yet. The server runs from a clone of the repository (`pnpm --silent --dir <clone>/packages/mcp exec tsx src/server.ts`, see [docs/api.md](./docs/api.md)); started this way against the real euthyna-signer on Oct 31, 2026 (14 tools listed). |

## Use cases (site section "Use cases")

| Claim | Status | Proof |
| --- | --- | --- |
| Supplier payouts on Base or Solana, treasury yield (wrap, Uniswap swap, Aave), revenue sharing, an AI company on Atlantis: "Testnet" | Reported | Whitepaper, "Use cases". Revenue sharing has hashes in [docs/shares.md](./docs/shares.md); add hashes for the others. |
| Freelance agent: "Possible" with payment roles | Code | `payments` block in `packages/sdk/src/roles.ts` |
| Rebalancing across chains, retail wallet | NEXT | Whitepaper, "Next" |

## Site wording

| Claim | Status | Proof |
| --- | --- | --- |
| If our servers go down, agents keep transacting through public RPCs | Code | [Architecture.md](./Architecture.md#trust-and-availability); `packages/sdk/src/onchain.ts` |
| The vault flags any transaction that left a wallet without it (integrity check) | Reported | Whitepaper, "Operation lifecycle"; console code on `main` |
| Problem figures (43.8% of $2.2B, 17-23% of bitcoin, $1.4B Bybit) | Outside sources | Linked under each figure on the site and in the whitepaper |

## Outside sources

See the whitepaper's "The problem" and "Sources": Chainalysis (via Benzinga and PaymentsNext), NCC Group on the Bybit hack.
