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
| A voted role can be edited: the browser reads it from the vault, rebuilds the draft that compiles to exactly that role (or refuses), and the vote only re-sends what changed (unchanged budgets keep what was spent, removed members are revoked) | Code, Testnet | `packages/sdk/src/roles.ts` (`roleDraftFromChain`, `unchangedBudgets`) and `roles-edit.test.ts`; `apps/console/src/lib/role-edit.ts`; testnet: proposal #11 of `sealedprod1106.sputnikv2.testnet` (budget 5 → 6, sealed orders off) applied |
| Rob the Agent · Rug O'Clock: each hour a real LLM reads the most voted invoice and its tool call is sent as a real `execute_near`; the vault answers | Testnet | `apps/api/src/rob/rugoclock.ts` (+ tests); each reading (LLM output, verdict, tx) is stored on its invoice and shown with its nearblocks link; off, never simulated, without an LLM |
| Rob the Agent: every card is a real testnet transaction, refused by the vault, the DAO or NEAR; 0 USDC stolen | Testnet | [docs/rob-the-agent.md](./docs/rob-the-agent.md) (hashes per card); the vault pays only its two listed suppliers, accounts of ours; `/v1/rob/stats` counts the recorded plays |
| Rob the Agent Hall of thieves: gas burned read from the chain, boldest cheque from the amounts refused, votes by players; a wallet claims the plays with a signed message and gets a $LEASH testnet trophy | Code | `apps/api/src/rob/hall.ts`, `hall.test.ts`; [docs/rob-the-agent.md](./docs/rob-the-agent.md#claim-and-hall-of-thieves). The LEASH token is not deployed yet (`scripts/rob-leash.mjs`) |
| Rob the Agent bounty: the testnet NEAR in `bounty.ruggy-euthyna.testnet` go to whoever makes the vault pay outside its law | Testnet | [docs/rob-the-agent.md](./docs/rob-the-agent.md#bounty); the balance is on nearblocks |
| Euthyna Market: companies sell agent work, buyers pay with a card; the payment is held until delivery | Code | [docs/market.md](./docs/market.md), `apps/api/src/market/e2e.integration.test.ts` |
| Rob the Agent, Hire him: the player buys Ruggy's tx-check for 1 TestUSDC from the throwaway key, the cheque held and cashed on delivery, no gas paid | Code | [docs/rob-the-agent.md](./docs/rob-the-agent.md#hire-him-ruggys-service-on-the-market), `apps/api/src/rob/hire.test.ts`; not run on testnet yet: add the settlement hash |

## Euro bank account

| Claim | Status | Proof |
| --- | --- | --- |
| A company opens a euro IBAN (Noah); a SEPA transfer arrives as EURC in the company wallet, and only there (the address is read from the vault) | Testnet (Noah sandbox) | [docs/bank.md](./docs/bank.md), `apps/api/src/bank/service.test.ts` |
| Those euros leave by a members' vote, signed by the vault through NEAR MPC | Testnet (Noah sandbox) | [docs/bank.md](./docs/bank.md) |
| An agent pays suppliers in EURC within a role's EURC budget | Code | EURC is a Base Sepolia token of the payment roles (`packages/sdk/src/roles.ts`); the same role pays USDC on testnet |
| Activity exports a CSV of the entries shown, with each transaction hash, formulas neutralised | Code | `apps/console/src/lib/activity-csv.test.ts` |
| An agent pays a supplier's IBAN in euros under a vault rule: IBAN in the voted list, amount within the role's EURC budget and ceiling, reference used once; the partner's API key lives in an OutLayer enclave that answers only the vault | Code | `contracts/vault/src/bank.rs` and `bank_tests.rs` (unknown IBAN refused, ceiling, budget reserved and released, callback queues the exact EURC transfer, the signer cannot change the amount); `bank-signer/` (manifest and code refuse any caller but a vault); [docs/bank.md](./docs/bank.md#euros-out-an-agent-pays-a-voted-iban) |
| The IBAN and the holder are never on chain: a salted commitment and two envelopes (the enclave's, the members'); the agent pays a beneficiary by number and the enclave pays only the committed IBAN | Testnet | `packages/sdk/src/bank-private.ts` (vector opened by `bank-signer` tests), `contracts/vault/src/bank_tests.rs`; [docs/bank.md](./docs/bank.md#the-iban-is-not-public) (state, proposal and transactions searched) |
| Invoicing: an invoice with an ISO 11649 reference and a SEPA QR (EPC069-12); the partner's signed deposit webhook matches it, and it is paid once the EURC is in the company wallet | Testnet (Noah sandbox) | `apps/api/src/bank/invoices.test.ts` (ISO 11649 vector, EPC payload, P-384 signature, matching only on the company's own account, partial payment); [docs/bank.md](./docs/bank.md#invoices): 18 EUR → 17.66 EURC `0x5ac9127b…` |
| Remittances: an agent pays a sealed payee on another rail (Pix in Brazil) in its currency, from the company's euros | Testnet | [docs/bank.md](./docs/bank.md#payroll-and-remittances): 8 EURC → 74.92 BRL by Pix |
| Payroll: members vote a standing order once; the vault pays it on each date with no agent and no new vote; a failed run goes back to its date | Testnet | `contracts/vault/src/bank_tests.rs` (standing orders), [docs/bank.md](./docs/bank.md#payroll-and-remittances): 3 EUR every 10 minutes, paid 2.87 EUR by SEPA |
| A Pix payee is paid again and again (the partner refused a saved payee's form): the enclave names a saved payee by its payment method | Testnet (Noah sandbox) | `bank-signer` tests (partner stand-in), `bank-signer/scripts/sandbox-twice.mjs` (each rail twice against the sandbox), [docs/bank.md](./docs/bank.md#enclave-updates-one-vote-or-none-with-a-veto-window): same payee paid 3 times |
| Enclave fixes without new keys: the enclave runs from an OutLayer project whose secrets follow its versions; a vault that follows it takes a new version after its veto window, with no vote, and runs exactly that hash | Testnet | `contracts/vault/src/bank_tests.rs` (queued once, vetoable, applied after the delay, Project source with the voted hash), `apps/api/src/rule-activation.test.ts`; [docs/bank.md](./docs/bank.md#enclave-updates-one-vote-or-none-with-a-veto-window): 0.2.0 → 0.2.1 with the same partner key |
| UK (Faster Payments) and US (ACH) payees | Code | the partner's sandbox refused the UK channel for our customer (`channel policy denied`); ACH not run |

## Sealed orders (private limit orders)

| Claim | Status | Proof |
| --- | --- | --- |
| A sealed order is one hash on chain: the limit price, the total and the deadline are stored nowhere on chain, before or after a fill | Code | `contracts/sealed-orders/src/lib.rs` (`seal` stores the commitment, the role, the wallet and an opaque ciphertext); `circuits/sealed-order/src/main.nr` |
| Sealed orders are an option of a swap role ("Allow sealed orders"): the contract joins the role as a member, so every fill goes through the role's router, pair, recipient and budget | Code | `apps/api/src/omniroles.ts` (`roleProposal`), `apps/console/src/routes/RolesPage.tsx`; `contracts/tests/tests/sealed_orders.rs`: 6 USDC within the hidden cap but over the 5 USDC budget is refused by the vault and the order gets it back |
| Who places one: the company's DAO by a vote (an occasional order), a human member of that role from the console, or an agent of that role (MCP `place_sealed_order`); anyone else is refused, and an order cannot be placed for a role the contract is not in. Who executes it: a member who reads its terms, from the console ("Execute now": the proof is made in the browser), or the role's agent, which a member can hand the order to (MCP `adopt_sealed_order`) | Code | `contracts/tests/tests/sealed_orders.rs` (a real Sputnik DAO owns the vault: stranger refused, agent and DAO accepted, contract outside the role refused); `apps/console/src/lib/sealed-fill.ts`; `packages/mcp/src/sealed.ts` (`adopt`) |
| A fill proves in zero knowledge that the swap's rate meets the hidden limit, stays within the hidden total and comes before the hidden deadline, for this vault and this pair; the proof is verified on NEAR (UltraHonk, BN254 host functions) and a replayed or edited proof is refused | Code | `circuits/sealed-order` (`nargo test`, 7 tests); `contracts/tests/tests/sealed_orders.rs` (real proofs made at test time; a fill burns 94 Tgas in the sandbox) |
| A false rate in a proof can only make a fill fail: the swap's minimum output comes from the proven rate | Code | `packages/sdk/scripts/sealed-order-fork.ts`: on a fork of Base Sepolia the market rate swaps and a rate 2% above reverts |
| The terms travel encrypted for the members: each member registers an X25519 key derived from a signature of their own wallet (checked against the DAO's policy on chain); whoever seals encrypts the terms to those keys | Code | `packages/sdk/src/sealed-orders.ts` (`encryptTerms`, `decryptTerms`, tests: a non-member cannot read); `register_reader` in the contract and its sandbox test |
| What stays public: each fill's amount, the pair, the rate it demanded and the company wallet (the swap is a Base transaction); the order's running total; who sealed it | Code | By design |
| A sealed order placed by an agent of a swap role and filled on testnet: the router approval and the seal from the agent, the terms decrypted from the chain by the two members who registered a key (not by one who did not), a fill proved and verified on NEAR (101.8 Tgas), the swap signed by NEAR MPC, mined on Base Sepolia and settled | Testnet | [docs/sealed-orders-testnet.md](./docs/sealed-orders-testnet.md) (v2, `euthyna-sealed-orders-v2.testnet`; the v1 run by DAO vote is below it) |

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
