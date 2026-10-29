# Euthyna Market

Tracked in [#87](https://github.com/Euthyna-wallets/MandateOS/issues/87). This page grows with each
step; only what is built is described here.

## Vault: NEP-141 transfers

A vault can send NEAR fungible tokens (NEP-141) it holds on its own account, for example to refill
an agent's card account. Source: [`contracts/vault/src/near_tokens.rs`](../contracts/vault/src/near_tokens.rs).

### What the DAO votes

Both are rule changes: queued by the DAO, executed after the vault's rule delay, vetoable by the
council like every other rule.

| Rule change | Effect |
| --- | --- |
| `NearStorageDeposit { token }` | The vault calls `storage_deposit` on `token` for itself (0.00125 NEAR, excess refunded), so it can receive that token, e.g. sales. |
| `SetNearPermissions { role, permissions }` | Replaces what `role` may send in NEAR tokens. `RemoveRole` clears it. |

A permission is `{ token, receivers, allowance, min_per_transfer, max_per_transfer }`: one NEP-141 contract, up to 32
receivers, the budget (an existing `SetAllowance` key, in the token's base units), a floor and a
cap per transfer (`0 < min ≤ max`). The floor matters: every transfer stores a record paid by the
vault's NEAR balance, so it bounds how many records a compromised agent can make the vault pay for
(at most budget ÷ floor per period). At most 16 permissions per role.

### What the agent calls

`execute_near(role, { token, receiver_id, amount, memo, reference })`, with at least 50 Tgas.

The vault refuses unless all of these hold:

| Check | Error |
| --- | --- |
| vault not paused | `ERR_PAUSED` |
| enough gas for `ft_transfer` and its callback | `ERR_NEAR_CALLBACK_GAS` |
| role exists, enabled, not Guard-gated | `ERR_ROLE_NOT_FOUND`, `ERR_ROLE_DISABLED`, `ERR_VISA_REQUIRED` |
| caller is a member, started, not ended, uses left | `ERR_MEMBERSHIP_NOT_FOUND`, `ERR_MEMBERSHIP_UNAVAILABLE` |
| token listed for the role | `TokenNotAllowed` |
| receiver listed for that token | `FunctionNotAllowed` |
| `amount ≥ min_per_transfer` | `ERR_MIN_PER_TRANSFER` |
| `amount ≤ max_per_transfer` | `ERR_MAX_PER_TRANSFER` |
| `amount ≤ budget left` (after refill) | `ERR_ALLOWANCE_EXCEEDED` |
| reference never used by this role | `ERR_REFERENCE_ALREADY_USED` |
| memo ≤ 120 characters, amount > 0, receiver ≠ vault | `ERR_MEMO_TOO_LONG`, `ERR_ZERO_AMOUNT`, `ERR_SELF_TRANSFER` |

Refusals other than pause, gas, budget and reference come as `ERR_PERMISSION_DENIED:<reason>`.

Then the vault reserves the amount on the budget, stores the operation as `Pending`, logs
`OMNIROLES_NEAR_OPERATION:<op_id hex>` and calls `ft_transfer(receiver_id, amount, memo)` on the
token with 1 yoctoNEAR and 30 Tgas. The private callback `on_near_transfer` then:

- on success: spends the budget, counts one membership use, sets `Confirmed`, logs `OMNIROLES_NEAR_CONFIRMED`;
- on failure (for example the receiver never registered on the token): releases the reservation,
  sets `Failed`, logs `OMNIROLES_NEAR_FAILED`. The reference stays used.

If the callback never runs (for example it ran out of gas), the operation would stay `Pending`
and hold its reservation. After the vault's unconfirmed timeout (`settlement_config.unconfirmed_after_ns`,
6 hours by default), anyone can call `release_near_unconfirmed(op_id)`: the operation becomes
`Unconfirmed`, the role and membership reservations are freed, and the budget and membership use
**stay spent**, because the tokens may have left. Same rule as `release_unconfirmed` on EVM and
`release_solana_unconfirmed` on Solana. Logs `OMNIROLES_NEAR_UNCONFIRMED`.

The vault never calls anything other than `ft_transfer` on a listed token, and `storage_deposit`
on a token the DAO voted.

Views: `get_near_permissions(role)`, `get_near_operation(op_id)`,
`get_near_operation_by_reference(role, reference)`, and the dry run
`check_near(role, member, request)`.

### Upgrading an existing vault

State is stored under raw keys (`near:p:<role>`, `near:o:<op_id>`), so the vault layout is
unchanged and a vault on the published version moves to this one by a DAO `Upgrade` vote
([`contracts/tests/tests/near_transfers.rs`](../contracts/tests/tests/near_transfers.rs)).

The new code is about 60 KB larger, which is about 0.6 NEAR more locked for storage. Nomos funds
new vaults tightly, so the vault needs a top-up before the upgrade vote, or the deploy fails for lack
of storage balance. The console's upgrade flow does it: `upgradeProposal()` in the API tops the vault
up from the relayer before drafting the vote. By hand, a plain NEAR transfer to the vault works too.

### Tests

- `contracts/vault/src/near_tokens.rs` unit tests: floor refused (check and execute), floor validation
  (`0 < min ≤ max`), a stuck `Pending` operation released only after the timeout, with the budget kept
  spent and reservations freed, and never twice.
- [`near_transfers.rs`](../contracts/tests/tests/near_transfers.rs): refill within budget; failed
  `ft_transfer` releases the budget; published vault upgraded by vote, state kept, then transfers.
- [`attacks.rs`](../contracts/tests/tests/attacks.rs) `injected_agent_cannot_move_near_tokens_outside_its_role`:
  each refusal above, listed by `pnpm attack:all`.

## SDK, MCP and console

- **Role block** `near-transfer` (`packages/sdk/src/roles.ts`):
  `{ kind: "near-transfer", token: "USDC" | "TestUSDC", receivers: [{ accountId, label }], budget, maxPerTransfer, minPerTransfer? }`.
  It compiles to `SetAllowance`, `SetRole`, the memberships, then `NearStorageDeposit` (once per token, so the
  vault can hold it) and `SetNearPermissions`. Amounts are in token units. The floor defaults to budget ÷ 100:
  each transfer stores a record the vault pays for, so by default a role makes at most 100 per period.
  The compiler refuses: no receiver, more than 32, an invalid account id, a floor of zero, a floor above the
  cap, a cap above the budget, an unknown token.
- **Tokens** (NEAR testnet): Circle's USDC `3e2210e1…b8af` (faucet.circle.com) and the test token
  `test-ft-v4.mandateos-root-20261021.testnet`, both 6 decimals.
- **Editing a role.** `SetRole` does not touch NEAR permissions. When a role that has NEAR permissions on the
  vault is saved without a NEAR block, the API adds `SetNearPermissions` with an empty list on every vault that
  has NEAR transfers (even if none are executed yet: an earlier vote may still be in the veto queue), so old
  rights never survive the edit. Only « method not found » counts as an older vault; any other RPC error stops
  the draft. The console accepts the proposal only if it matches the role it compiled
  itself, or that plus this one clearing change (it only removes rights). A NEAR block on a vault older than
  this version is refused with « vote the vault upgrade first ».
- **Agent** (`OnchainAgentClient.nearTransfer`, MCP `near_transfer` and `near_status`): dry run with
  `check_near`, then `execute_near` with 100 Tgas; the result is read back by reference. `near_status` calls
  `release_near_unconfirmed` once the timeout has passed. `execute_near` and `release_near_unconfirmed` are in
  `AGENT_FUNCTION_CALL_METHODS`. **Agents paired before this version** keep a valid key (attested as `outdated`);
  `near_transfer` answers « this agent's NEAR key predates NEAR transfers: pair the agent again ».
- **API**: Holdings show the vault's and the cards' token balances (stablecoin = $1). Activity reads
  `OMNIROLES_NEAR_OPERATION` logs from the vault and shows « Refilled Larry's card with 5 USDC » or
  « Sent 5 USDC to bob.testnet ». The roles view lists the NEAR (and Solana) rights and their budgets.
- **Console**: Rules → « + Pay in NEAR tokens », with one-click « + <agent>'s card » receivers.

## Spending cards

An agent's card is a plain NEAR account next to its agent account: `<slug>-card.<parent>` for
`<slug>-agent.<parent>` (`cardAccountIdOf` in the SDK). The vault refills it by role; the agent pays from it
on its own (for example a market purchase), and the blast radius is the card's balance.

### Can the card use a function-call key? No.

Market payments are NEP-366 delegate actions wrapping `ft_transfer`, which requires exactly 1 yoctoNEAR.
Probe on a local sandbox (nearcore 2.14.0), `scripts/fc-key-delegate-probe.mjs`, with the card holding the test
token and a separate relayer:

| Case | Result |
| --- | --- |
| A. full-access key, `ft_transfer` with 1 yocto | relayed, tokens moved |
| B. function-call key limited to `ft_transfer` on the token, 1 yocto | refused by the protocol: `DelegateActionAccessKeyError: DepositWithFunctionCall` |
| C. same function-call key, 0 yocto | key accepted, then the token panics: `Requires attached deposit of exactly 1 yoctoNEAR` |

So a function-call key cannot pay a NEP-141 token, directly or through a delegate. The card keeps a
**full-access key**, generated and held by euthyna-signer, which only signs `ft_transfer` delegates on the
configured token (`sign_delegate`, step 6). The card account and its key are created in that step, with the
signer; until then a card is any account the members list.
