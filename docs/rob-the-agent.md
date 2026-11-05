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
| POST | `/v1/rob/hire/terms` `{ publicKey }` | Hire him: the key's account, nonce, a final height, balance |
| POST | `/v1/rob/hire/topup` `{ publicKey }` | Hire him: 1 TestUSDC on the key's implicit account, once per player |

Players are counted by a salted hash of their address; addresses are not stored.

## Run it

Set `ROB_RUGGY_ACCOUNT_ID`, `ROB_RUGGY_PRIVATE_KEY`, `ROB_VAULT_ACCOUNT_ID`, `ROB_DAO_ACCOUNT_ID`, `ROB_SUPPLIERS`
(two, comma-separated) and, for cards X and XI, `ROB_OWNER_KEYS` (`account:ed25519:…` three times) in the API's
environment (`ROB_BASE_SUPPLIERS` defaults to the two Base suppliers above), then `prisma db push` (tables `rob_key`, `rob_play`). Tests:
`pnpm --filter @mandateos/api exec vitest run src/rob`.

## Hire him (Ruggy's service on the Market)

« Can't rob him? Hire him. »: the player buys Ruggy's real service on the [Euthyna Market](market.md) for 1 TestUSDC,
from the same throwaway key, with the held cheque of any buyer agent.

| | |
| --- | --- |
| Listing | `ruggy-tx-check` (`ROB_HIRE_HANDLE`), « Check a transaction before you sign it », seller Rob the Agent Co., category security |
| Pays | 1 TestUSDC (`1000000`, 6 decimals) to the Rob vault (`payTo` = `ROB_VAULT_ACCOUNT_ID`, already registered on the token) |
| SLA | 120 s; the cheque must then live 720 s (SLA + `MARKET_SETTLEMENT_MARGIN_SECONDS`), 1,440 blocks |
| Work | the worker's deterministic `tx-check` (`@mandateos/sdk/tx-check`, the same function `apps/market-worker` runs) |

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
3. `signCheque` (`@mandateos/sdk/cheque`) signs, with the throwaway key, a NEP-366 delegate of one `ft_transfer`
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

## Not built yet

The onboarding pre-filled with Ruggy's law, the leaderboard, Rug O'Clock and the share card.
