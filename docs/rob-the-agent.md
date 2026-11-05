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

Players are counted by a salted hash of their address; addresses are not stored.

## Run it

Set `ROB_RUGGY_ACCOUNT_ID`, `ROB_RUGGY_PRIVATE_KEY`, `ROB_VAULT_ACCOUNT_ID`, `ROB_DAO_ACCOUNT_ID`, `ROB_SUPPLIERS`
(two, comma-separated) and, for cards X and XI, `ROB_OWNER_KEYS` (`account:ed25519:…` three times) in the API's
environment (`ROB_BASE_SUPPLIERS` defaults to the two Base suppliers above), then `prisma db push` (tables `rob_key`, `rob_play`). Tests:
`pnpm --filter @mandateos/api exec vitest run src/rob`.

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

## Not built yet

Hire him (Ruggy's service on the Market), the onboarding pre-filled with Ruggy's law,
the leaderboard and the share card.
