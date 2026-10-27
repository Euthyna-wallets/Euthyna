# MandateOS API

The API never holds a key that moves company funds. Funds sit at one EVM
address derived by NEAR MPC from the company's OmniRoles vault (path
`omniroles/evm`, the same address on every EVM chain). The vault signs only:

- an **agent operation** that fits the agent's role (prepare → authorize (optional Guard visa) →
  MPC signature), or
- a **transaction voted by the DAO** (Sputnik proposal → veto window →
  `start_dao_transaction` → MPC signature).

The API prepares proposals; members sign them with their own NEAR wallet. The
worker only broadcasts what the vault already signed.

## Direct on-chain agent flow

The MCP server uses NEAR RPC and an EVM RPC directly; no API key or server is required for an unguarded role. Set `EVM_RPC_URL` for a custom endpoint; Base Sepolia defaults to `https://sepolia.base.org`. The signer socket or local NEAR signer still supplies the agent's function-call signatures.

Call `prepare`, then `authorize` with `approval: null`. Read `get_operation` to obtain the exact signed transaction, broadcast it, and resume through the MCP `status` tool. It waits for finalized foreign-chain state before calling `settle`. Queued operations can be resumed after their delay; any configured human co-signature is still required. `cancel` requests the same-nonce self transaction after the on-chain timeout; `status` broadcasts and settles it. After the unconfirmed deadline, `release_unconfirmed` frees the wallet with budget spent.

Vault settlement methods accept `{ op_id: number[32], block_hash: number[32] }`. The untrusted block-hash hint lets the vault calculate the exact MPC V1 expected payload hash; MPC must verify finalized success for that transaction and chain. Failed transactions do not produce refund proofs. `settle_cancellation` uses the stored cancellation transaction. `get_settlement_config` exposes the configured delays. There is no in-flight lock: concurrent proof requests never block cancellation, another proof or timeout release. The first valid callback wins; callbacks after a terminal state do nothing, including a cancellation proof received after Unconfirmed.

`get_address_list({ list: "suppliers" })` returns `{address: number[20], label: string}[]`. Supplier changes use DAO proposals and `queue_rule_change`, not the database approval mechanism. `GET /v1/console/omniroles/suppliers` reads this list; `POST /v1/console/omniroles/proposals/suppliers` accepts `{ entries: [{address: "0x…", label}], migrate?: boolean }` and returns the unsigned DAO proposal. Migration loads active database suppliers and is refused when the on-chain list is already populated. The browser independently checks the proposal before signing.

Role drafts support `guardRequired` (default false) and `suppliersOnly` (default false). The latter compiles payment recipient checks to `InAddressList("suppliers")`; the vault remains the authorization authority when the API is down.

The routes below are optional API conveniences and the legacy Guard-required flow. They are not prerequisites for the direct MCP path. Backend status reports can confirm only; they cannot refund a failed operation. See `Architecture.md` for redeployment and key permissions.

## Identities

| Who | How | Used for |
| --- | --- | --- |
| Member | NEP-413 sign-in with a NEAR wallet (`/api/auth/near/challenge`, then `/api/auth/sign-in/near`). The signing key must be a full-access key of the account on chain. | `/v1/console/*`, `/v1/emergency/*` |
| Agent | API key (`x-api-key`) issued when the agent is created, plus its own NEAR function-call key on the vault. | `/v1/operations/*` |

Console requests must come from the console origin (`CONSOLE_ORIGIN`). Email
sign-up/sign-in and Better Auth member edits are disabled: members are the
DAO's council, changed only by a vote.

## Agent routes

### `GET /v1/agent/mandate`

What the agent may do. The response has its role, the role's rules in plain
sentences, what each budget has left this period, the recipients the Guard
accepts (registered suppliers and the company wallet), and the company wallet
address. The data is read from the vault.

### `GET /v1/agent/share-revenue?amountWei=`

The Omni Bridge call that sends `amountWei` of ETH from the company wallet to
the company's shares contract on NEAR: `to`, `data`, `value` (amount plus the
bridge fee from the Omni Bridge API), `allowanceAmount` and the network fees.
The agent prepares it like any other operation. The vault signs it only if the
agent's role has a revenue-sharing budget for exactly this recipient.

### `POST /v1/operations/check`

A dry run with nothing reserved. Body: `{ request }`, the vault
`OperationRequest`. The vault's `check_operation` answers first. When the role
allows the call, the Guard answers next (registered suppliers, references
already paid). The response has `allowed`, `refusedBy` (`vault` or `guard`),
`reason` and a readable `explanation`. Network fees are not checked. Both
outcomes appear in Activity.


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

## MCP server

`packages/mcp` exposes the agent API to any MCP client: Claude, Cursor, Codex.
Its instructions tell the agent to read `mandate` first, `check` before `pay`,
and, when a call is refused, to stop and report it: an agent never asks the
members itself. Only a member can turn a refused operation into a proposal ("Ask the
members" in Activity).

| Tool | Does |
| --- | --- |
| `mandate` | role, budgets left, accepted recipients, company wallet |
| `check` | dry run of a transfer (`token`, `recipient`, `amount`) or of any call (`to`, `data`, `value`, `allowanceAmount`) |
| `pay` | prepare → authorize without visa → broadcast → MPC settlement |
| `execute_call` | execute exact calldata allowed by the role, with explicit gas fields |
| `share_revenue` | optional API builder for an ETH revenue call; use `execute_call` with prebuilt bridge calldata without that API |
| `status`, `cancel` | operation state; same-nonce cancellation |

With euthyna-signer, the config is one line and holds no secret: the socket is
found by itself, and the vault, role and network are read from the signer.

```bash
claude mcp add euthyna --env EUTHYNA_AGENT=<agent>.testnet -- npx -y @euthyna/mcp
```

`@euthyna/mcp` is this server bundled in one file (`pnpm --filter @mandateos/mcp
bundle`, published from `packages/mcp/npm`). From the repository, with a local
key instead:

```bash
pnpm --filter @mandateos/sdk build
pnpm --filter @mandateos/mcp build

MANDATEOS_API_URL=… MANDATEOS_AGENT_API_KEY=… AGENT_NEAR_ACCOUNT_ID=… \
VAULT_ACCOUNT_ID=… AGENT_ROLE=… node packages/mcp/dist/server.js
```

Do not put `pnpm … start` in an MCP stdio client command: package-manager
banners are not JSON-RPC. The server also routes NEAR transaction logs to
stderr; stdout is reserved exclusively for the MCP protocol.

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

### Shares

See [shares.md](./shares.md).

- `GET /v1/console/omniroles/shares`: the shares contract next to the vault
  (supply, price, revenue shared), whether its account is keyless, whether the
  DAO counts locked shares and has the `shareholders` role, and the signed-in
  member's position.
- `POST /v1/console/omniroles/shares` (admin): `{ name, symbol, totalSupply,
  priceNear, allocations: [{ accountId, shares }] }`. It deploys the contract
  on an account with no access key, then returns the proposals that turn it on.
- `POST /v1/console/omniroles/proposals/shares`: the proposals still missing
  (`SetStakingContract`, the shareholders role).
- `GET /v1/console/omniroles/directory`: the registry, the company's DAO,
  vault and shares accounts, and its listing as read on chain.
- `POST /v1/console/omniroles/proposals/registry`: `{ name, description }`. A
  vote that lists the company in the public directory (`docs/registry.md`).
- `POST /v1/console/omniroles/proposals/revenue`: `{ amountNear }`. It returns
  a `FunctionCall` to `deposit_revenue`, paid from the DAO.
- `POST /v1/console/omniroles/proposals/proceeds`: `{ chainId, amountNear }`
  (84532 Base Sepolia, 11155111 Ethereum Sepolia). It returns two proposals that
  send NEAR held by the DAO to the company wallet as wNEAR through Omni Bridge:
  the bridge storage (members who may cast the last vote, and the transfer
  message account), then `near_deposit` + `ft_transfer_call` on `wrap.testnet`.
  The bridge fee comes from the Omni Bridge API. Errors: `wallet_missing`,
  `unsupported_chain`, `dao_balance_low`, `bridge_fee_unavailable`.

Buying, locking, unlocking and claiming are wallet calls to the contract. The
API is not involved.

### Governance and activity

- `GET /v1/console/omniroles/governance`: proposals (decoded), the veto window
  (rules and `Scheduled` transactions), and the voted transactions with their
  state.
- `POST /v1/console/omniroles/rules/activate`: executes ready rules and starts
  ready transactions. The API also does this on its own loop.
- `GET /v1/console/omniroles/roles`: roles, budgets, and who holds each role.
- `GET /v1/console/omniroles/activity`: what the chains record.
  - `operations`: each operation read from the vault (`get_operation`: who,
    which role, what, state, nonce), then from the EVM chain (receipt of the
    signed transaction: executed or reverted). The database only says which
    operations to look up, and gives names.
  - `integrity`: per chain, the wallet's nonce on the EVM chain against the
    vault's `next_nonce`. Only the vault hands out nonces, so the chain can
    never count more transactions than the vault signed. If it does, a
    transaction left the wallet outside MandateOS (`alert`).
  - `requests`: refusals and dry runs, MandateOS's own record. They never
    reach a chain.
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
- Any council member may hire; only the member who hired an agent, or an admin,
  provisions or revokes it. A member may hold 5 agents without a voted role,
  open pairing codes included.

### Pairing with euthyna-signer

- `POST /v1/console/agents/pairings` `{ name, role, vaultAccountId }` → a
  one-time `code` (128 bits, valid 10 minutes, shown once; only its hash is
  stored) and the account the agent will get.
- `GET /v1/console/agents/pairings/:id` → `waiting | paired | expired`, with
  the signer's public key and hostname once paired. The console then
  provisions the agent as above.
- `POST /v1/agents/pair` `{ code, publicKey, hostname }` (called by
  `euthyna-signer pair`, no session): hires the agent with that public key and
  returns `{ agentId, accountId, vaultAccountId, networkId, role, apiKey }`
  to the signer only. A code works once.

### Emergency

`POST /v1/emergency/cancel` (`{ vaultAccountId, opId }`) replaces a signed but unconfirmed operation with a
0-value transaction at the same nonce. This works only in state
`PossiblySigned`.

## Worker

The worker leases operations from the database and:

- picks the RPC of the operation's chain (`BASE_SEPOLIA_RPC_URL`,
  `ETHEREUM_SEPOLIA_RPC_URL`);
- recovers the MPC signature from the NEAR transaction if the vault did not
  store it;
- broadcasts, then waits `WORKER_CONFIRMATIONS` blocks;
- requests MPC settlement with `settle`, or `settle_cancellation` for a finalized cancellation;
- leaves reverted original budgets spent and uses the conservative unconfirmed timeout.

The API keeps each vault's NEAR storage funded: when it has less than 0.5 NEAR
free, the API sends it 1 NEAR from the relayer. This NEAR pays for storage
only; company funds never move.



### Cancellation fees and finality

The vault method `cancel_nonce` accepts only `{ op_id }`; the MCP `cancel` tool accepts only `{ opId }`. The vault sets gas to 21,000 and computes twice the original fee cap and priority fee, bounded by the role's per-gas and total-fee caps. Both fields must increase by at least 12.5%, rounded up with a minimum increment of one. Insufficient policy headroom rejects the call before recording a cancellation. No caller can poison the cancellation with a zero priority fee. If MPC signing fails or has not returned a signature, anyone can retry `cancel_nonce(op_id)`: the vault reuses the stored transaction and digest, increments its request count, and keeps the reservation. Once a signed cancellation is stored, the method rejects further requests with `ERR_CANCELLATION_ALREADY_SIGNED`. Duplicate signing callbacks cannot overwrite the first stored signature or raw transaction.

Both the direct SDK and worker wait until the receipt block is at or below `eth_getBlockByNumber("finalized")` before requesting MPC verification. When a cancellation exists, SDK `status` checks both original and cancellation receipts and proves whichever finalized successfully.

Build/validation versions: Rust 1.99.1, cargo-near 0.22.0, near-sdk / near-contract-standards 5.29.1 (SDK minimum protocol 84), near-workspaces 0.23.0, nearcore sandbox 2.14.0. Build checked-in WASM through `contracts/build.sh`; see `Architecture.md` and the contract CI workflow for the verified image digest, sandbox archive checksum and `NEAR_SANDBOX_BIN_PATH` setup.

Contract CI pins Actions by full commit SHA, retains all six built WASM files, and requires byte-for-byte equality between its pinned-image build and checked-in `contracts/res/` artifacts before the full sandbox suite. Deploy only the artifacts covered by that successful comparison.
