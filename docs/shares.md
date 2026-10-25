# Shares

A MandateOS company can sell shares. Holders vote with them in the company's
Sputnik DAO and receive a cut of the revenue the company shares.

## What it is

`contracts/shares` is one contract per company, deployed next to the vault
(`<company>-shares.<parent>`). Its account has no access key, so nobody can
change it, MandateOS included. It does four things:

| | |
| --- | --- |
| Token | NEP-141 with 0 decimals: 1 unit = 1 share. Fixed supply. |
| Sale | `buy()` at a fixed price in NEAR. The proceeds go to the DAO account. Unsold shares earn nothing and do not vote. |
| Votes | The contract is the DAO's staking contract. `lock(n)` delegates n shares as votes; `unlock(n)` takes them back. |
| Revenue | `deposit_revenue()` shares NEAR. One NEP-141 token is shared too: through `ft_transfer_call`, or through `sync_revenue()` after a plain transfer (a bridge). Every share held earns the same, locked or not. `claim()` pays both. |

After `unlock`, shares stay frozen for twice the proposal period. They can
neither move nor vote again before the proposal they voted on is over.

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
- **Base ETH bridged by Omni Bridge** arrives on NEAR as
  `base.omnidep.testnet` (`OMNIROLES_SHARES_REVENUE_TOKEN`). Send it to the
  shares account and anyone can call **Split bridged revenue**. A holder
  registers once on the token (`storage_deposit`) to claim it; until then the
  payment fails and stays owed.

## Proof on testnet (2026-10-25)

Script: a DAO with three members, then the shares contract, then holders.

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
- One revenue token per contract, set when the contract is deployed.
- No `ft_transfer_call` from the shares token itself: plain transfers only.
- Anyone who buys a majority of the shares outvotes the others on calls and
  transfers. The members' veto on vault changes is the safeguard.
