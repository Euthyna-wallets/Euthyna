# MandateOS API

The API never holds a key that moves company funds. Funds sit at one EVM
address derived by NEAR MPC from the company's OmniRoles vault (path
`omniroles/evm`, the same address on every EVM chain). The vault signs only:

- an **agent operation** that fits the agent's role (prepare → Guard visa →
  authorize → MPC signature), or
- a **transaction voted by the DAO** (Sputnik proposal → veto window →
  `start_dao_transaction` → MPC signature).

The API prepares proposals; members sign them with their own NEAR wallet. The
worker only broadcasts what the vault already signed.

## Identities

| Who | How | Used for |
| --- | --- | --- |
| Member | NEP-413 sign-in with a NEAR wallet (`/api/auth/near/challenge`, then `/api/auth/sign-in/near`). The signing key must be a full-access key of the account on chain. | `/v1/console/*`, `/v1/emergency/*` |
| Agent | API key (`x-api-key`) issued when the agent is created, plus its own NEAR function-call key on the vault. | `/v1/operations/*` |

Console requests must come from the console origin (`CONSOLE_ORIGIN`). Email
sign-up/sign-in and Better Auth member edits are disabled: members are the
DAO's council, changed only by a vote.

## Agent routes

### `POST /v1/operations/check`

Dry run of an operation request against the agent's role, with nothing
reserved. Body: `{ request }` (the vault `OperationRequest`). It returns whether
the role allows it and why.

### `POST /v1/operations/gas-quote`

The network fees for the agent's next operation on Base Sepolia.

### `POST /v1/operations/pay`

The agent has already called `prepare` on the vault. Body:
`{ opId: number[32], invoice? }`. The Guard reads the prepared operation from
the vault and checks:

- the recipient is a registered supplier wallet or the company wallet;
- the invoice, when given: prompt injection, recipient mismatch, a reused
  reference.

Responses:

- `200 { visa, signature }`: the agent then calls `authorize` on the vault.
- `422 { error, message, reasons }`: refused. There is no escalation: the
  refusal is logged (`operation.refused`, reason `GUARD:<code>:<reasons>`) and
  the SDK calls `cancel_prepared`. A member can then submit the same action as
  a transaction for the members to vote on (see *Voted transactions*).
- Sending the same `opId` again returns the stored visa, never a second one.

### `POST /v1/operations/:opId/authorization`

Body: `{ nearTransactionHash }`, the hash of the agent's `authorize` call. The
worker uses it to recover the MPC signature if the vault could not store it.

### `POST /v1/operations/:opId/cancellation` and `GET /v1/operations/:opId`

These routes cancel an operation the agent owns, or read its state (vault
state, EVM hash, confirmations).

## Console routes

### Company and members

- `GET /v1/console/omniroles/status`: DAO, vault, company wallet, balances per
  chain, and whether the vault is paused.
- `POST /v1/console/omniroles/plan` and `POST /v1/console/omniroles/create`
  (admin): `{ daoName }`. Both deploy the Sputnik DAO (factory
  `factory-v2.mandateos.testnet`) and its vault.
- `GET /v1/console/omniroles/members`, `POST /v1/console/omniroles/members`
  (`{ nearAccountId, name? }`) and `DELETE /v1/console/omniroles/members/:id`.
  These edit the list of members *before* the DAO exists. Afterwards, members
  change only through `proposals/members`.

### Proposals (signed by the member's wallet)

Each route returns `{ receiverId, args, deposit, title, summary }`. The console
decodes `args` again in the browser and shows exactly what will be voted. The
member then signs `add_proposal` with their wallet. Sputnik's `act_proposal`
must repeat the exact proposal kind, so a vote cannot apply to something other
than what was shown.

| Route | Body | Vote on |
| --- | --- | --- |
| `proposals/role` | `{ draft }` | create or change a role (transfer, swap; budgets, period, max approval) |
| `proposals/membership` | `{ role, member, kind, action, maxUses? }` | give or remove a role |
| `proposals/members` | `{ members: string[] }` (3–20) | change the council (`ChangePolicy`, threshold `ceil(2n/3)`) |
| `proposals/pause` | `{ pause }` | pause or resume the vault |
| `proposals/wallet` | `{ chainId? }` | create the company wallet on a chain |
| `proposals/transaction` | `{ title?, transactions: [{ chainId, to, value?, data?, gas? }] }` (≤ 10) | transactions outside any role |

Rule changes go through a veto window (`queue_rule_change`, then
`execute_rule_change`). During the window any council member can veto.

### Voted transactions (multisig)

`proposals/transaction` covers anything a role does not allow, such as a
deposit on Aave, a bridge, or a payment to a new recipient. The API adds the
network fees and nothing else:

- gas: the calls of one chain are estimated in order. The first uses
  `eth_estimateGas` × 1.3. The next ones run in one `eth_simulateV1` after the
  earlier calls (gas used × 1.5 + 30k), so an approve-then-supply is estimated
  on the right state. Several RPCs are tried per chain. A call that would
  revert refuses the proposal with its reason (`422 would_revert`); no RPC
  answering refuses it too (`503 gas_estimate_unavailable`). No limit is
  guessed;
- max fee: `max(3 × gasPrice + priority, floor per chain)`;
- the vault caps each transaction at 5M gas, 500 gwei and 0.5 ETH of fees.

Once approved, the transactions get `Scheduled` and wait out the veto window.
Then the API calls `start_dao_transaction(chain_id)`, which is permissionless:
the oldest transaction of that chain starts, once the wallet is free on that
chain. The worker broadcasts it on its own chain.

The console's **Wallet** page also acts as a WalletConnect wallet. A dApp
connects to the company address, and every `eth_sendTransaction` becomes a
proposal. Off-chain signatures (`personal_sign`, `eth_signTypedData_v4`) are
refused.

### Governance and activity

- `GET /v1/console/omniroles/governance`: proposals (decoded), the veto window
  (rules and `Scheduled` transactions), and the voted transactions with their
  state.
- `POST /v1/console/omniroles/rules/activate`: executes ready rules and starts
  ready transactions. The API also does this on its own loop.
- `GET /v1/console/omniroles/roles`: roles, budgets, and who holds each role.
- `GET /v1/console/omniroles/activity`: agent operations, refusals with their
  reason, and voted transactions.
- `POST /v1/console/omniroles/refresh`: clears the API's cached reads.

### Suppliers

- `GET /v1/console/registry`
- `POST /v1/console/suppliers` (`{ name, contact?, chainId, address }`)
- `POST /v1/console/suppliers/:id/wallets` (`{ chainId, address }`)
- `POST /v1/console/registry-changes/:id/decision` (`approve|reject`)

Every change needs a second member: the author cannot approve their own
request.

### Agents

- `GET|POST /v1/console/agents`, `GET /v1/console/agents/:id`
- `GET|POST /v1/console/agents/:id/provision`, `POST …/provision-confirm`:
  creates the agent's NEAR account with a function-call key restricted to the
  vault's agent methods.
- `POST /v1/console/agents/:id/revoke`

### Emergency

`POST /v1/emergency/cancel` (`{ vaultAccountId, opId, gasLimit, maxFeePerGas,
maxPriorityFeePerGas }`) replaces a signed but unconfirmed operation with a
0-value transaction at the same nonce. This works only in state
`PossiblySigned`.

## Worker

The worker leases operations from the database and:

- picks the RPC of the operation's chain (`BASE_SEPOLIA_RPC_URL`,
  `ETHEREUM_SEPOLIA_RPC_URL`);
- recovers the MPC signature from the NEAR transaction if the vault did not
  store it;
- broadcasts, then waits `WORKER_CONFIRMATIONS` blocks;
- reports the status to the vault (`report_status`), which releases the
  wallet.

The API keeps each vault's NEAR storage funded: when it has less than 0.5 NEAR
free, the API sends it 1 NEAR from the relayer. This NEAR pays for storage
only; company funds never move.
