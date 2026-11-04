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

The two suppliers are accounts of ours. A payment the law allows does go through (expert mode can forge one); it
only reaches one of them.

## Keys on Ruggy's account

| Key | Held by | Can |
| --- | --- | --- |
| Full access | the API (`ROB_RUGGY_PRIVATE_KEY`) | add and delete the players' keys, sign card VII (a DAO call no function-call key can make), mint test tokens |
| One per player | the player's browser (made there, never sent) | call `execute_near` and `queue_rule_change` on the vault, 0.25 NEAR of gas at most, deleted after 24 h |
| Three shared keys | the API, made at each start | the same, for plays without a key of their own (AI judges, a full arena) |

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
| X Look Legit, XI Inside Job | | not open yet (shown as SOON) | |

About 2 seconds a card through FastNEAR; 0.2 s when NEAR refuses before the chain. Eight plays at once were all
answered.

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
(two, comma-separated) in the API's environment, then `prisma db push` (tables `rob_key`, `rob_play`). Tests:
`pnpm --filter @mandateos/api exec vitest run src/rob`.

## Not built yet

Cards X (Look Legit: a Base payment delayed and vetoed by a council bot) and XI (Inside Job: two owners vote a bad
rule, the council vetoes it), Hire him (Ruggy's service on the Market), the onboarding pre-filled with Ruggy's law,
the leaderboard, Rug O'Clock and the share card.
