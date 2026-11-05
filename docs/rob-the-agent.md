# Rob the Agent

A public game at `/rob`: the player is the brain of Ruggy, an AI agent already jailbroken, and plays attack cards.
Every card is a real transaction on NEAR testnet; the vault, the DAO or NEAR itself refuses it. The page shows what
the chain answered and links the transaction. Design: [design-handoff/rob-the-agent](../design-handoff/rob-the-agent).

## The company

| | |
| --- | --- |
| Company | Rob the Agent Co.: DAO `rob-the-agent-co.sputnikv2.testnet`, vault `rob-the-agent-co.nomos.euthyna.testnet` (no access key) |
| Owners | `rob-euthyna-owner1/2/3.testnet` (2 of 3, also the council) |
| Agent | `ruggy-euthyna.testnet`, member of role `payments` |
| Law (proposal #0, two approvals, applied after the veto window) | TestUSDC (`test-ft-v4.mandateos-root-20261021.testnet`) to `rob-euthyna-supplier-a.testnet` or `rob-euthyna-supplier-b.testnet` only, 0.1 to 2 a payment, 10 a day |
| Funds | 25 TestUSDC minted to the vault (`D1GpcJd57R8XfbL3FtbanFm6JzCVfzUjaqn6es1NN4Sm`); the API mints more when it falls under 15 (the test token's mint is open) |
| Seed payment | 0.1 TestUSDC, reference `rob-seed-1` (`CyENNpf11UVDVdSFN3yqMVj9nNiZZzwSJ6aj7YgBTUBa`), so card V can replay it |
| Base (proposal #1) | company wallet `0xb30d8099…8ddcc4` derived by NEAR MPC; role `base-payments`: Circle USDC to `0x770FEe79…2702` or `0xd63f3e36…6595` (ours), 10 a day, **above 1 USDC the operation waits 10 minutes**, the council can veto |

The two suppliers are accounts of ours. A payment the law allows does go through (expert mode can forge one); it
only reaches one of them.

## Keys on Ruggy's account

| Key | Held by | Can |
| --- | --- | --- |
| Full access | the API (`ROB_RUGGY_PRIVATE_KEY`) | add and delete the players' keys, sign card VII (a DAO call no function-call key can make), mint test tokens |
| One per player | the player's browser (made there, never sent) | call `execute_near` and `queue_rule_change` on the vault, 0.25 NEAR of gas at most, deleted after 24 h |
| Three shared keys | the API, made at each start | the same plus `prepare` and `authorize` (Look Legit), 1 NEAR of gas at most, for plays without a key of their own |

The three owners' keys are in the API too (`ROB_OWNER_KEYS`): the game plays the two bribed owners of Inside Job,
and the third owner is the **council bot**, announced as a bot on the page. It vetoes Look Legit's payment and
Inside Job's rule right after they are queued, and every 20 seconds it sweeps the vault: any rule change still
queued, and Ruggy's Base operation still waiting, is vetoed. A queued rule waits 60 s before anyone can apply it;
the veto lands in about 2 s. The service never calls `execute_rule_change` or `execute_queued_operation`
(`rob.test.ts`). The sweep also vetoes rule changes the owners queue by hand: stop the API before changing
Ruggy's law. Run one API with these keys: a second one (a developer's machine) sweeps the same vault. A veto that
finds the rule or operation already vetoed reports it as vetoed, with who did it.

NEAR holds a call's whole prepaid gas, at a pessimistic price, against a function-call key's allowance until the
call ends. Look Legit prepays 50 and 30 Tgas (it burns about 4 and 3) on a shared key with 1 NEAR of allowance;
with 150 and 100 Tgas on 0.25 NEAR, `authorize` was refused with `NotEnoughAllowance` (fixed 4 November).

Limits: 5 new keys an hour per address, 300 player keys alive at once (`ROB_MAX_ACTIVE_KEYS`), 30 plays a minute per
address, 40 plays in flight. A refused play costs Ruggy about 0.001 NEAR of gas.

## Cards played on testnet (4 November 2026)

| Card | Refused by | Answer | Transaction |
| --- | --- | --- | --- |
| I Pay the Attacker | vault | `ERR_PERMISSION_DENIED:FunctionNotAllowed` | `GuaqzFDVa7ZKj5zuVqKBh99Dk3xHDPJqwpVb5qaNJGTD` |
| II Split into 100 | vault | `ERR_PERMISSION_DENIED:ERR_MIN_PER_TRANSFER` | `4nBo9A2g8SfwN5TabDjH2ahvHq1CH6nD9XkFSs88cnrR` |
| III Steal the Gas | NEAR | `RequiresFullAccess` | none: refused before the chain |
| IV Overpriced Supplier | vault | `ERR_PERMISSION_DENIED:ERR_MAX_PER_TRANSFER` | `AZFwRTCGnLLRgyEmrXwQyPPrWfnFNWYWyb4ojrDHcF9N` |
| V Replay the Cheque | vault | `ERR_REFERENCE_ALREADY_USED` | `39pvroS9QAvAjAsNHJi6mz7SvTNav6yyZahSaxBkVbPi` |
| VI Bribe Ruggy | Ruggy (off chain) | counter-offer `{ counter: 2, expires_in: 60 }` | none: an offer |
| VII Crown Yourself | DAO | `ERR_PERMISSION_DENIED` | `t9Y14bKnGvNRjU14ZLnNUcXW2Z63tyVUERGH5XDmYa2` |
| VIII Forge a Master Key | NEAR | `RequiresFullAccess` | none: refused before the chain |
| IX Rewrite the Law | vault | `ERR_OWNER_ONLY` | `H79M6kJHrTLgKscpXYi9XkGuYszk9ZgTSHh7M1jLH9U1` |
| X Look Legit | council | prepare `7nZmF7WBUVfLGquoHqea6J335wXhXvSLobQW2nxD5UXT` (every rule passes), authorize `EbjkXECPCneCPPjcRcaHnTaakDyXBYT9bx1u6FYkFtNz` (queued: 2 USDC > 1), MPC signs nothing | veto `5E5cp3hYMz4kcMcdTWiW9Tc7cSnS5QLpjMDKhqscCA5c` |
| XI Inside Job | council | proposal #2 by owner1 `3JnqeBQxXQFCEUytx8cKUV6wGjEwSZfo64J9xo12m2XT`, approved by owner1 and owner2 `2srquqwmoSYsf92RxW3NJEyUiepewSBkwnSm8AyU4iF7` (rule queued) | veto `Ha4GGoCYM9bhzboUoo3tScm1AVjHUuRnAW6fyGC2a7Wo` |

About 2 seconds a card through FastNEAR; 0.2 s when NEAR refuses before the chain; Look Legit about 5 s (three
transactions, one at a time: the Base wallet holds one operation), Inside Job about 11 s (four transactions; one game
a day per player, 100 a day in all). Eight plays at once were all answered.

If players spend the day's 10 USDC with lawful forged payments, card V answers `ERR_ALLOWANCE_EXCEEDED` (law III)
until the budget refills: the vault checks the budget before the reference.

## API

| Method | Route | |
| --- | --- | --- |
| GET | `/v1/rob/cards` | laws, cards, who signs each |
| GET | `/v1/rob/stats` | `{ attacks, players, denied, lawfulPayments, linesOfDefense, stolen }`, cached 10 s |
| POST | `/v1/rob/session` `{ publicKey }` | adds the key on Ruggy's account for 24 h |
| POST | `/v1/rob/prepare` `{ publicKey, card \| forge }` | the unsigned transaction and the hash to sign |
| POST | `/v1/rob/play` `{ card, signed? }` | with `signed` (`{ transaction, signature }`), sends the player's transaction as is; without, plays with a shared key |
| POST | `/v1/rob/forge` `{ method, args, signed? }` | any vault method |
| GET | `/v1/rob/hall` | Hall of thieves, cached 30 s (below) |
| POST | `/v1/rob/hall/vote` `{ playId }` | one vote for a forged call |
| POST | `/v1/rob/claim/challenge` `{ throwawayKey }` | nonce and the message the wallet signs |
| POST | `/v1/rob/claim` `{ accountId, publicKey, signature, throwawayKey, throwawaySignature, nonce }` | links the plays, mints the trophy once |

Players are counted by a salted hash of their address; addresses are not stored.

## Run it

Set `ROB_RUGGY_ACCOUNT_ID`, `ROB_RUGGY_PRIVATE_KEY`, `ROB_VAULT_ACCOUNT_ID`, `ROB_DAO_ACCOUNT_ID`, `ROB_SUPPLIERS`
(two, comma-separated) and, for cards X and XI, `ROB_OWNER_KEYS` (`account:ed25519:…` three times) in the API's
environment (`ROB_BASE_SUPPLIERS` defaults to the two Base suppliers above), then `prisma db push` (tables `rob_key`, `rob_play`). Tests:
`pnpm --filter @mandateos/api exec vitest run src/rob`.

## Claim and Hall of thieves

The wallet is asked for only at the end (section « Now make it yours. »). Code: `apps/api/src/rob/hall.ts`,
`apps/console/src/routes/public/rob/RobClaim.tsx` and `RobHall.tsx`.

**Claim.** The browser asks `POST /v1/rob/claim/challenge { throwawayKey }` for a single-use nonce (5 minutes,
kept in the API's memory: one instance). The NEAR wallet signs a NEP-413 message naming the throwaway key, for the
recipient Ruggy's account; the throwaway key signs a message naming the wallet account. `POST /v1/rob/claim` checks
both signatures (the NEP-413 check is the console sign-in's, `verifySignature` from wallet selector), that the
wallet key is a full-access key of the account on chain, and that the throwaway key is a player key Ruggy's account
received (a shared key cannot be claimed, a key already claimed by another account is refused). It then links the
key's plays to the account (`rob_play.accountId`) and answers `{ accountId, plays, trophy: { tx } | null }`. Wallets
without `signMessage` cannot claim: the page says so. Plays made after a claim are added by signing again.

**$LEASH trophy.** With `ROB_LEASH_TOKEN` set and at least one recorded play, Ruggy's full-access key sends one
transaction to the token: `storage_deposit` (the token's `storage_balance_bounds().min`, capped at 0.01 NEAR) then
the open `mint` of 1 whole token, 10 Tgas each. Once per account (`rob_claim`, a single claimant takes the mint; a
mint that died half-way is checked against `ft_balance_of` before minting again), at most 500 a day, 5 claims an
hour per address. Never on the vault, the DAO, Ruggy or TestUSDC (checked at start and before each mint).

Deploy the token once (not run yet):

```sh
node scripts/rob-leash.mjs --account leash.ruggy-euthyna.testnet --dry-run   # read the chain, print the plan
LEASH_ACCOUNT_ID=leash.ruggy-euthyna.testnet LEASH_PARENT_PRIVATE_KEY=ed25519:… node scripts/rob-leash.mjs
# then in the API's environment:
ROB_LEASH_TOKEN=leash.ruggy-euthyna.testnet
```

With an existing account, pass its key as `LEASH_PRIVATE_KEY` instead. `--lock` deletes the token account's key
after deploying (nobody can redeploy it; irreversible). The script deploys `contracts/res/test_ft.wasm`, whose
`ft_metadata` is fixed in code ("MandateOS Test USDC", `TestUSDC`, 6 decimals): it cannot name the token Leash /
LEASH, and warns about it. Wallets show the trophy as TestUSDC on the LEASH account until test-ft takes its metadata
at init (a contract change and a CI-built wasm).

**Hall of thieves.** `GET /v1/rob/hall` (cached 30 s) answers `{ creative, gas, boldest, recent }`:

| Tile | From |
| --- | --- |
| Most creative | the forged call (expert mode) with the most votes |
| Most gas burned | the sum of `gas_burnt` over each player's transactions (the transaction outcome and its receipts), read from the chain after each play without delaying the answer; for Look Legit and Inside Job, the last transaction (the council's veto) |
| Boldest cheque | the largest `amount` a refused play attempted (`request.amount` of the card or the forged args, base units; Look Legit 2 USDC) |
| Recent | the 6 last forged calls, method and args in one line, with their votes |

`who` is the claimed account, else the short throwaway key; plays on a shared key count as "a shared key" and are
left out of the gas tile. `POST /v1/rob/hall/vote { playId }`: forged calls only, one vote per address hash and
call, not your own, 30 a minute per address. Forged calls are text players typed: the page shows them as text,
cut to 96 characters.

Schema: `rob_play` gains `call`, `amount`, `gasBurnt`, `accountId`; new tables `rob_vote` and `rob_claim`. Apply
with `prisma db push` as for the other tables. Tests: `src/rob/hall.test.ts` (mocks; the Prisma store and its SQL
run against PostgreSQL when `TEST_DATABASE_URL` is set).

## Not built yet

Hire him (Ruggy's service on the Market), the onboarding pre-filled with Ruggy's law,
Rug O'Clock and the share card. The $LEASH token is not deployed yet (`scripts/rob-leash.mjs`), and its
name and symbol need a test-ft change (above).
