# Shares

A MandateOS company can sell shares. Holders vote with them in the company's
Sputnik DAO. Revenue goes to the holders who vote.

## What it is

`contracts/shares` is one contract per company, deployed next to the vault
(`<company>-shares.<parent>`). Its account has no access key, so nobody can
change it, MandateOS included. It does four things:

| | |
| --- | --- |
| Token | NEP-141 with 0 decimals: 1 unit = 1 share. Fixed supply. |
| Sale | `buy()` at a fixed price in NEAR. The proceeds go to the DAO account. Unsold shares earn nothing and do not vote. |
| Votes | The contract is the DAO's staking contract. `lock(n)` delegates n shares as votes; `unlock(n)` takes them back. |
| Revenue | By epoch, for voters only (below). NEAR through `deposit_revenue()`; one NEP-141 token through `ft_transfer_call`, or `sync_revenue()` after a plain transfer (a bridge). `claim()` pays both. |

After `unlock`, shares stay frozen for twice the proposal period. They can
neither move nor vote again before the proposal they voted on is over.

## Revenue goes to voters

Time is cut into epochs: 1 hour on testnet, 7 days in production
(`OMNIROLES_SHARES_EPOCH_SECONDS`, fixed per contract).

1. Revenue that arrives during epoch N belongs to epoch N.
2. Only shares locked **since the start of N, and still locked at its end** count. Locking during N counts from N+1; unlocking during N loses those shares' part of N.
3. During N+1, a holder who voted on **at least one proposal submitted in N** calls `prove_vote(proposal_id)`. The contract reads the proposal in the DAO and checks the vote is there.
4. From N+2, epoch N's revenue is split among the provers, pro rata of their locked shares. The part of those who did not vote goes to those who did.
5. If nobody proved a vote, epoch N's revenue moves to the current epoch.

Sputnik stores who voted but not each voter's weight, so the weight is the
shares locked during the whole epoch, as this contract records them.

A vote counts whatever it says: rejecting counts as much as approving. Anyone
holding locked shares can submit a proposal (bond 0.1 NEAR), which lets
holders vote in an otherwise quiet epoch.

## An agent shares revenue on its own

Members give an agent a `share-revenue` role: it may call the Omni Bridge on
Base, with native ETH, no token fee, a bridge fee of at most 0.001 ETH, an
empty message and the recipient fixed to `near:<company>-shares.<parent>`,
within an ETH budget (the bridge fee counts). Anything else is refused by the
vault (6 attacks in `pnpm attack:all`). The agent uses `share_revenue` (MCP)
or `GET /v1/agent/share-revenue`.

### Proof on testnet (2026-10-25)

Company Atlas Labs (`atlas-labs-vault.mandateos-e2e-mvms3m2m.testnet`), role
`revenue` (0.003 ETH every 7 days) toward the epochs demo shares contract.

| Step | Result | Transaction |
| --- | --- | --- |
| Members approve the role (proposal #8), rules apply after the veto window | role active | `3swxogRiZQyFzCr9eBScd4L1oJNtG6cJ5x6STR2CAgBw` |
| Same call toward `near:attacker.testnet`, checked on the vault | refused, `parameterNotAllowed` (node 5, the recipient) | view call |
| Agent prepares 0.002 ETH + 0.0000042 ETH bridge fee | Prepared | `J2JyBWjLjFz5KMqmEguGJPtEjMszP3Xq9puKU1RAjJzg` |
| Guard visa, agent authorizes, NEAR MPC signs | PossiblySigned | `5zZkMwmRS7YP1khKwcQDKAZwkDAfG697Ja5LwhHoDfph` |
| Broadcast on Base Sepolia | success, 74473 gas | `0xaadc75c9bc6360579bc02758d5730e736253862ec7dd4f476ec87824fcc8a9d8` |
| Receipt reported to the vault | Confirmed | `9fz7qHCQAgafxnxS3yBboQy8eHFdBWLAXRvPEinGWq6F` |
| Omni Bridge delivers to the shares contract | +0.002 ETH after 23 min | |
| `sync_revenue` | 0.002 ETH counted for the current epoch's voters | `8tJh3Ra4WAdD5iHpXwNg18wHkTgnidyVF38fq1Hq2Ge1` |

In this run the Guard visa and the receipt report were signed by a script with
the test company's Guard keys, and the transaction was broadcast by it: the
same steps the API and the worker run.

## Sale proceeds to the company wallet on an EVM chain

The NEAR paid for shares sits on the DAO account. **Shares → Send proceeds to
the company wallet** moves some of it to the company wallet on Base Sepolia or
Ethereum Sepolia, as wNEAR through Omni Bridge. Members vote twice:

1. **Bridge storage.** The bridge charges storage to the account that signs the
   transaction, here the member who casts the last vote, and to the transfer
   itself (a "message account" derived from the transfer). The DAO pays both,
   for every member not yet registered on the bridge.
2. **Transfer.** `near_deposit` on `wrap.testnet`, then `ft_transfer_call` to
   `omni.n-bridge.testnet` with the company wallet as recipient and the bridge
   fee from the Omni Bridge API.

Before the wallet signs, the browser rebuilds both votes from chain data it
reads itself: the company wallet from the vault (whose owner must be the DAO),
the members from the DAO, the storage prices from the bridge. Only the bridge
fee comes from the server, and the browser refuses it above 5% of the amount.

The DAO is the sender on the bridge. If the transfer cannot complete, the
bridge refunds the DAO, not a member.

### Proof on testnet (2026-10-25)

Company Atlas Labs, DAO `atlas-labs.factory-v2.mandateos.testnet`, wallet
`0x834e5A4d6685E2B14189136Aca6fDe051266ef30` on Base Sepolia.

| Step | Result | Transaction |
| --- | --- | --- |
| First try without bridge storage | `ERR_MESSAGE_ACCOUNT_NOT_REGISTERED`, 0.1 wNEAR refunded to the DAO | |
| Members vote the bridge storage (proposal #11) | Approved, message account `01af8b02…5a89d31` | `CHSPQXP47snDNVyhqygbqNws2ztNLUNkBf1G19rxnySm` |
| Members vote 0.1 NEAR to the company wallet (proposal #12) | Approved, `InitTransferEvent` origin nonce 20241, fee 0.00218 wNEAR | `8rcfYH2uEcmUoJkcQcVkoiHQUh417cxkNNG5Q9rA3eC7` |
| Delivery on Base | pending: the transfer is stored on the bridge (`get_transfer_message`) and waits for the bridge relayer | |

On NEAR, only a trusted relayer can ask NEAR MPC to sign a transfer
(`sign_transfer`). On testnet the relayer had not signed a NEAR-origin
transfer since 2026-10-12 (last one: nonce 20238). An unrelated transfer,
nonce 20239, was still waiting at the time of this run. The relayer finalizes
on Base on its own: MandateOS has nothing to do once the transfer is stored.

## Who decides what

| Who | Votes on | Rule |
| --- | --- | --- |
| Members (council) | everything | two thirds of members |
| Shareholders | company calls (the vault: roles, budgets, transactions) and NEAR transfers | more than half of all locked shares |

A vault change voted by shareholders still waits out the veto window, where
any member can stop it. So members cannot be outvoted into a bad rule, and
shareholders do not need the members' approval to decide.

Sputnik counts the threshold against **all locked shares**, not against the
votes cast. Without a majority of locked shares, a proposal expires.

## Turning it on

1. **Shares → Issue shares** (company admin): set the name, the symbol, the
   supply, the price, and the shares given to you. The API deploys the keyless
   contract and prepares two proposals:
   - `SetStakingContract`: the DAO counts locked shares as votes (once per DAO);
   - `ChangePolicyAddOrUpdateRole`: the `shareholders` role above.
2. The browser checks that both proposals are exactly these, then the wallet
   signs them. Members vote in **Decisions**.
3. Anyone with a NEAR wallet can then buy, lock, unlock and claim.

When the members change, the new policy keeps the shareholders role.

## Revenue

- **NEAR held by the DAO** (for example sale proceeds): **Shares → Propose to
  share it** creates a `FunctionCall` to `deposit_revenue`, paid from the DAO.
  It goes to the epoch in which the proposal executes.
- **Base ETH bridged by Omni Bridge** arrives on NEAR as
  `base.omnidep.testnet` (`OMNIROLES_SHARES_REVENUE_TOKEN`). Send it to the
  shares account and anyone can call **Split bridged revenue**. A holder
  registers once on the token (`storage_deposit`) to claim it; until then the
  payment fails and stays owed.

## Tests

`contracts/tests/tests/shares.rs`, NEAR sandbox, 60-second epochs:

- only the voter earns, and gets the whole epoch (the non-voter's part included);
- two voters split pro rata (600 / 300 shares: 6 and 3 NEAR, 600 and 300 tokens); shares locked during the epoch do not count;
- with no voter, the revenue moves to the current epoch;
- a token payment to an unregistered holder fails and stays owed.

## Proof on testnet: revenue for voters (2026-10-25)

10-minute epochs, 5-minute proposals. DAO `epochs-1qz7s.factory-v2.mandateos.testnet`,
shares `epochs-1qz7s.mandateos-e2e-mvms3m2m.testnet` (0 access keys,
`FyaBEyahVLh6aK32ch2cxCSekMDRUk3HjtsPziohujHU`).

| Epoch | Step | Result | Transaction |
| --- | --- | --- | --- |
| 0 | Members vote `SetStakingContract` and the shareholders role | Approved | `BqKhxz7i5u7eLqCvo4M7rn7rJUM4n4TY9ss3AsgNesNR`, `BnpCn4duSgrdZ4rNXQukZHwyUC2CFLeLg2nK9313SEa4` |
| 0 | Alice 300, Bob 200, Carol 100 buy and lock | 600 locked | `DkgojDdWtUUpNi91RXwCyRAhajptYZKzANALAsbr63ra` (Alice's lock) |
| 1 | Proposal #2: Alice and Bob vote, Carol does not | Approved | `HHDsbhQVwqo3WiGG2chXjHMCsYNVPRzdMFVGCxJmEhNr`, `2eqiYahyU74BDSsmiubcDxE8icEkS9UgwAkpnEe7N28k` |
| 1 | 0.1 NEAR of revenue; 0.0004 bridged ETH counted | epoch 1 holds both | `4K81dDnV8Qx8xkv5VqkYDxWr8vEGBijLZLcbACtsGbH8`, `7YrQVSkCXGNvNjXY27pNMqNhA9SJAdJjkYbq5yUZTeQD` |
| 2 | Alice and Bob prove their vote; Carol tries | 500 shares proved; Carol refused | `FARYxNNVVDff9VoyiJfjUvv2njeaMJ3VetdB3y5Nr56y`, `GSGfhsi7rWj6w6N4tjKXvg29iYntQPufu7DB7kaeWErn`, `5MKWRWqg9wDZAePj6V13fk8maGcyPUWmhqVmZvXF4Yha` |
| 3 | Split | Alice 0.06 NEAR + 0.00024 ETH, Bob 0.04 + 0.00016, Carol 0 | |
| 3 | Alice claims | paid both, her ETH balance +0.00024 | `DnHzYkokrL3UM7mzwhLkAo68WBDjBAZLQwZvmQdt57nD` |

Carol held 100 of the 600 locked shares but did not vote: her part went to
Alice and Bob (split over 500 shares, not 600).

## First version on testnet (2026-10-25)

This run used the first version of the contract, where every share earned
revenue. Script: a DAO with three members, then the shares contract, then holders.

| Step | Result | Transaction |
| --- | --- | --- |
| Deploy `shares-xszgs.mandateos-e2e-mvms3m2m.testnet` | 0 access keys | `6dnzAoCa5C2nkmFHD8USmfvLxzMurNDVEpSGaT6Sioqz` |
| Members vote `SetStakingContract` | Approved | `GStngqLad6cJzGpZcPDZq2e8uTu3o3AZGBnF6jq9N9v7` |
| Members vote the shareholders role | Approved | `2eVeoHukumK5SKMKEuyayEqnQ9WYz4ZDEQGs3e1v5Dcy` |
| Alice buys 300, Bob 200 (0.001 NEAR each) | 500 sold | `6KR7gsNvdtL3GtggLDdFADfFDU6mxJwCFuwCJ58auDg9`, `CVaPAv9m6JpcjAYoQ31i9wzuR4J9XDtCJLaHYXBgS3pd` |
| Both lock their shares | 500 locked in the DAO | `3X7txfzwruJ473zJmC9ckUT3EdsnMHxftNgbhE6wbbbJ` |
| Shareholders vote to share 0.1 NEAR (Alice's 300 of 500; no member voted) | Approved and paid | `C5drmU5P9rnmhR4hn95FKWZFA56dLrSe6sxXni8Asbd5` |
| 0.0005 bridged ETH sent to the shares account, then split | Alice 0.0003, Bob 0.0002 | `EJ1iMdyA7VZgT2Rj5yKVfvP6TZXW6WkeYhwhaVacQQjM` |
| Alice claims | 0.06 NEAR + 0.0003 ETH | `FbD6Q4JXDyQTtC5SnJA8GkyzDL5h9f7jhqCgrhHwkBLu` |
| Bob unlocks, then tries to move his shares | votes 0, `ERR_NOT_ENOUGH_FREE_SHARES` | `3qeXkJ1B9DKCJyYpGgrh3CWV8kft9tdEW71XYfcMBVqR` |

The ETH came from an account that had received it through Omni Bridge from
Base Sepolia. The run sent it on with a plain `ft_transfer`; the bridge
delivering straight to the shares account was not part of it.

## Limits

- Unaudited, testnet.
- Proceeds reach the EVM wallet only when the Omni Bridge relayer signs and
  finalizes the transfer.
- One revenue token per contract, set when the contract is deployed.
- No `ft_transfer_call` from the shares token itself: plain transfers only.
- Anyone who buys a majority of the shares outvotes the others on calls and
  transfers. The members' veto on vault changes is the safeguard.
