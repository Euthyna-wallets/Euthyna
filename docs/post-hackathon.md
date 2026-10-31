# After the hackathon

Decided, not built. Each item says why it waits and where to start.

## Single-owner wallets: recovery with guardians

A wallet with one owner (retail) has no co-founders to vote a lost seat back, so the founders' vote of
[docs/recovery.md](./recovery.md) is replaced by guardians, as in
[Candide's Social Recovery Module](https://docs.candide.dev/wallet/plugins/recovery-with-guardians/) for Safe.

| Candide (Safe) | Euthyna (NEAR) |
| --- | --- |
| Safe owner key | The owner's NEAR account: only member of the DAO and of the vault council |
| Guardians (Ethereum addresses), threshold | NEAR accounts of people the owner trusts, threshold such as 2 of 3 |
| Email guardian: Candide signs after an OTP | Euthyna signs after a ZK Email proof of the enrolled mailbox (no OTP, only a hash of the address kept) |
| Grace period, `cancelRecovery` by the owner | Delay (7 days, for example), the lost account can cancel |
| Finalize: owners replaced | The member replaced in the DAO policy and in the vault council |

To build:

- **A delay enforced on chain.** Sputnik executes an approved proposal at once, so guardians could skip an
  API-side delay. Either route the change through the vault's rule queue with an owner veto, or add a small
  recovery contract that collects guardian approvals and executes after the delay unless cancelled.
- **Euthyna is never enough alone.** With a threshold of 2, at least one guardian besides Euthyna must
  approve.
- **Alerts on more than one channel** during the delay: the mailbox may be the attacker's.
- **A single-owner wallet type.** The API requires three founders today (`council_too_small`).
- **Reuse what exists.** ZK Email verification (`apps/api/src/recovery`), the cancel window and the console
  flow.

Known limit, as with Candide: guardians who reach the threshold together can take the wallet. The delay and the
owner's cancel are the defence.

Estimate: two to three days.
