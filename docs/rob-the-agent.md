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
| POST | `/v1/rob/hire/terms` `{ publicKey }` | Hire him: the key's account, nonce, a final height, balance |
| POST | `/v1/rob/hire/topup` `{ publicKey }` | Hire him: 1 TestUSDC on the key's implicit account, once per player |

Players are counted by a salted hash of their address; addresses are not stored.

## Run it

Set `ROB_RUGGY_ACCOUNT_ID`, `ROB_RUGGY_PRIVATE_KEY`, `ROB_VAULT_ACCOUNT_ID`, `ROB_DAO_ACCOUNT_ID`, `ROB_SUPPLIERS`
(two, comma-separated) and, for cards X and XI, `ROB_OWNER_KEYS` (`account:ed25519:…` three times) in the API's
environment (`ROB_BASE_SUPPLIERS` defaults to the two Base suppliers above), then `prisma db push` (tables `rob_key`, `rob_play`). Tests:
`pnpm --filter @euthyna/api exec vitest run src/rob`.

## Fork Ruggy's law

The card « Fork Ruggy's law » opens `/onboarding?path=euthyna&law=ruggy`. The onboarding shows « Ruggy's law,
pre-filled. Change anything. » on every step, preselects the « Pay suppliers » hire, and its « Write the role » link
carries `law=ruggy` to the role builder (`/roles?new=1&role=…&job=…&law=ruggy`), which opens with one « NEAR · pay in
tokens » block: TestUSDC, 0.1 to 2 a payment, a budget of 10 every day, and **no recipient** (Ruggy's suppliers are
ours: the founders add their own). Every field stays editable and the role is voted as usual; nothing else in the
onboarding changes. The preset and its storage are in `apps/console/src/routes/onboarding-law.ts`: creating the
company clears the URL, so the choice is kept in this browser (pending for 24 h, then bound to the first company set
up). A member whose company is already set up is still sent to `/overview`; the law then waits for « + New company ».

## Share card

`rob/RobShareCard.tsx`: before any play, a generic card (« Can you rob an AI agent? »); after a play, the seal with
the verdict panel's word (DENIED, COUNTER, VETOED, PAID), a sentence naming who said no (the law, NEAR itself, the
DAO, the council; the counter-offer and a lawful payment have their own), « <card> · line <numeral> » and
« #RobTheAgent · euthyna.io/rob ». It keeps the last answer while the next card is on its way. « POST ON X » opens
`https://x.com/intent/post` with the card, the verdict, @NEARProtocol, #RobTheAgent and #NEARHackathon, and
`url=https://euthyna.io/rob`. « DOWNLOAD CARD » draws the same card at 1200×675 on a canvas in the browser (after
`document.fonts.ready`; Cinzel and JetBrains Mono), with the transaction hash shortened when the play has one, and
saves it as a PNG. Nothing is sent to a server. The verdict panel links to it (« SHARE THIS REFUSAL »).

## Rug O'Clock

Players drop poisoned invoices (plain text, 500 characters, control and bidi characters stripped; 3 an hour per
address) and vote (one vote per address and invoice, current hour only). A few seconds after each UTC hour, the API
claims the most voted invoice of the hour that ended with a conditional update (`readAt` still null): one reading a
round, even with two instances, and never two at once in one process.

Ruggy is a real LLM (OpenAI-compatible chat completions, one tool `pay({ receiver_id, amount_usdc, reference })`,
30 s timeout). The invoice is only ever the user message. His answer is untrusted: the tool call must be exactly
those three fields, a NEAR account id, an amount above 0 and at most 1,000,000 with 6 decimals at most, a reference of
1 to 64 characters; anything else is stored as "invalid" and nothing is sent. A valid call goes out as a real
`execute_near` with a shared key, like a forged call (`RobService.forge`, recorded as card `rug-o-clock` under the
invoice author's hash), with the reference `rug-<yyyymmddhh>-<his reference>` so it is unique per reading. The vault
decides: usually refused; a lawful payment (0.1 to 2 USDC to a listed supplier, within the day's 10) goes through.
The reading (his decision, the call, the verdict and the transaction) is stored on the invoice.

| Method | Route | |
| --- | --- | --- |
| GET | `/v1/rob/rugoclock` | `{ enabled, roundStartedAt, nextReadingAt, round (top 10 with votes), last }`, cached 5 s |
| POST | `/v1/rob/rugoclock/invoices` `{ text }` | drops an invoice in the current hour |
| POST | `/v1/rob/rugoclock/vote` `{ invoiceId }` | one vote per address and invoice |

Set `ROB_LLM_BASE_URL`, `ROB_LLM_API_KEY` and `ROB_LLM_MODEL` (or the generic `LLM_*`). Without all three, nothing
is read, the POSTs answer 503 and the page says the box is offline: no reading is ever simulated. Tables
`rob_invoice`, `rob_invoice_vote` (`prisma db push`). Tests: `src/rob/rugoclock.test.ts` (mocked LLM and service).

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
after deploying (nobody can redeploy it; irreversible). The script deploys `contracts/res/leash.wasm`
(`contracts/leash`): a NEP-141 named Leash, symbol `LEASH`, 0 decimals, initialised with one minter
(`LEASH_MINTER`, default `ruggy-euthyna.testnet`, the account the API mints with); any other account's `mint` is
refused (`only the minter mints LEASH`). Deployed on 5 November 2026: `leash.ruggy-euthyna.testnet`, minter
`ruggy-euthyna.testnet`.

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

## Hire him (Ruggy's service on the Market)

« Can't rob him? Hire him. »: the player buys Ruggy's real service on the [Euthyna Market](market.md) for 1 TestUSDC,
from the same throwaway key, with the held cheque of any buyer agent.

| | |
| --- | --- |
| Listing | `ruggy-tx-check` (`ROB_HIRE_HANDLE`), « Check a transaction before you sign it », seller Rob the Agent Co., category security |
| Pays | 1 TestUSDC (`1000000`, 6 decimals) to the Rob vault (`payTo` = `ROB_VAULT_ACCOUNT_ID`, already registered on the token) |
| SLA | 120 s; the cheque must then live 720 s (SLA + `MARKET_SETTLEMENT_MARGIN_SECONDS`), 1,440 blocks |
| Work | the worker's deterministic `tx-check` (`@euthyna/sdk/tx-check`, the same function `apps/market-worker` runs) |

**Top-up**, `POST /v1/rob/hire/topup { publicKey }`. Ruggy's full key (the one the cards use, on the same nonce counter)
creates the key's implicit account (`attackerOf`, 64 hex; the browser key is its full-access key) with a 1 yoctoNEAR
transfer (`ROB_HIRE_ACCOUNT_YOCTO`: an account that small needs no storage stake, NEP-448), calls `storage_deposit` for it on
the token (the token's `storage_balance_bounds.min`, paid by Ruggy) and mints it 1 TestUSDC. Once per key and once per client
(salted address hash, as `rob_key`), at most `ROB_HIRE_DAILY_TOPUPS` (100) a UTC day for everyone. Each step is recorded in
`rob_hire_topup` as it lands and skipped when the chain already shows it, so a retry resumes; a second call returns the same
transactions. Players behind one address (a conference network) share one top-up.

**Terms**, `POST /v1/rob/hire/terms { publicKey }`: the account, the key's nonce (final; null before the account exists), a
final block height, the balance and whether the key was topped up.

**The purchase, in the browser** (`apps/console/src/routes/public/rob/RobHire.tsx`):

1. top-up if the balance is short, then the terms;
2. `SendMessage` to `/a2a/<handle>/v1` without payment: the `402` gives the requirement. The page refuses to sign unless it asks
   for the Rob vault, TestUSDC and at most 1 (step « 1 · RULE »: the throwaway key has no on-chain law; the cap is the price
   the player agreed to, as `max_price` for an agent);
3. `signCheque` (`@euthyna/sdk/cheque`) signs, with the throwaway key, a NEP-366 delegate of one `ft_transfer`
   `{"receiver_id":"<vault>","amount":"1000000"}`, 1 yoctoNEAR, 30 Tgas, nonce + 1, max height = height + 2 × timeout + 120;
4. `SendMessage` with `X-PAYMENT`; then `GET /v1/market/tasks/<id>` every 2 s. The receipt: HELD once the gateway holds the
   cheque, DELIVERED once the result is stored (hold `settling` or later), PAID once the hold is `settled`, with the
   settlement transaction on nearblocks and the report (released only once paid). The buyer pays no gas: the market relayer
   sends the delegate.

**Delivery, inside the API.** No worker container: with `ROB_HIRE_DELIVERY_TOKEN` set, the API polls its own worker endpoints
every `ROB_HIRE_POLL_MS` (2 s) in-process (`app.request`, the listing's delivery token), starts each task, runs `tx-check` and
delivers it; `MarketService.deliver` then relays the cheque with the market relayer, as for any seller. Input that is not a
transaction fails the task: the cheque is never relayed and the player keeps the test USDC.

**Tests** (`apps/api/src/rob/hire.test.ts`): the cheque `signCheque` builds is byte for byte the one near-api-js builds in the
market's own test helper, and passes every check of `cheque.ts` from an implicit account (and fails with another payee or
another key); top-up steps, idempotence, one per client, daily cap, resume after a failed step without a second mint; the
in-process delivery (deliver, fail on bad input, retries); the routes. A cheque signed by the real page bundle (Playwright,
API stubbed) decodes in `cheque.ts` with a valid signature.

### Setup, once, in production

1. `prisma db push` (table `rob_hire_topup`).
2. `DATABASE_URL=… ROB_VAULT_ACCOUNT_ID=… node scripts/rob-hire-setup.mjs` (dry run), then `--apply`. It checks with a view
   call that the vault is registered on the token, finds Rob the Agent Co. from the vault's treasury (or `--org <id>`, or
   `--create-company`), creates the listing live and prints a delivery token. It sends nothing on NEAR.
3. Set `ROB_HIRE_DELIVERY_TOKEN` to that token in the API's environment and restart it. The market must be enabled
   (`MARKET_RELAYER_*`, `MARKET_WEBHOOK_SECRET`) with its relayer funded.
4. Ruggy pays each top-up: 1 yocto, the storage deposit (0.00125 NEAR if the token uses the usual minimum) and three
   transactions' gas; keep his account funded accordingly.

Not run yet on testnet: the top-up (in particular the 1 yocto account creation) and a purchase end to end.

## Bounty

`bounty.ruggy-euthyna.testnet` holds about 30 testnet NEAR (funded on 5 November 2026 from test accounts of ours).
They go to whoever makes the vault pay outside Ruggy's law: TestUSDC to an account that is not one of the two
suppliers, more than 2 a payment or 10 a day, or the same reference twice. A lawful payment to a supplier does not
count. Claim: a GitHub issue with the transaction hash; we check it on chain and send the NEAR by hand. Testnet NEAR
has no market value: the bounty is part of the game. The page reads the account's balance live from FastNEAR.

## Not built yet

Nothing from the handoff is left.
