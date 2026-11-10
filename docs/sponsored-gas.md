# Sponsored gas on Base (EIP-7702)

A company wallet is an address whose key is held by NEAR MPC. Without sponsorship it needs ETH for every
transaction. With it, the wallet never holds ETH: Euthyna's relayer sends the calls and pays the gas.

## How it works

1. **One vote.** `SetEvmExecutor { chain_id, executor }` (console: Wallet → Network fees → *Sponsor them*).
   The executor is [`EuthynaExecutor`](../contracts/evm/executor/src/EuthynaExecutor.sol), deployed once on
   Base Sepolia at `0x76bb5c47b0759af0300afeea954fa837a96675ed` (v3: `executeBatch` and NFT safe transfers; v2 `0x2899…bf37` had no batch, v1 `0xcc74…6cb5` refused NFTs). No owner, no admin, no upgrade.
2. **Delegation.** The worker's keeper (`apps/api/src/delegation-keeper.ts`) calls `delegate_wallet`: the vault
   has NEAR MPC sign the EIP-7702 authorization `keccak(0x05 ‖ rlp([chain_id, executor, nonce]))`. The gas
   tank submits it in a type-4 transaction. The wallet's code becomes `0xef0100 ‖ executor`.
3. **Payments.** For a sponsored operation the vault no longer signs a raw transaction. It signs the EIP-712
   `Execute(to, value, data, opId, deadline)` with the wallet's domain (`verifyingContract` = the wallet).
   The wallet nonce is not consumed. The relayer calls `wallet.execute(…, v, r, s)`.
4. **Checks in the executor.** The signer must be the wallet itself (`ecrecover == address(this)`), low-s only,
   each `opId` runs once, and not after `deadline`. A failed call reverts the whole transaction.
5. **Settlement.** On success the wallet emits `Executed(opId)`. Once the block is final, `settle_sponsored`
   has NEAR MPC attest that log (foreign-chain `Log` extractor), and the operation becomes `Confirmed`.
   With no log, the budget comes back after the deadline (`release_unconfirmed`).

What the relayer can do: send a signed call, or not. It cannot change the call, replay it, or move funds.

## Swaps: approve + swap + revoke in one transaction

`prepare_with_approval(role, request, approval { token, amount })` (MCP `execute_call` with
`approveToken` + `approveAmount`). The vault signs one EIP-712 `Batch` of three calls, which the
wallet runs with `executeBatch`, all or nothing:

1. `token.approve(request.target, amount)`: the spender is always the call's own target;
2. the call (the swap);
3. `token.approve(request.target, 0)`: added by the vault, not by the agent.

The approve must be allowed by the same role (its budget is checked, not charged: the swap is charged).
If the swap fails, the approval is undone with it. The relayer cannot drop, reorder or change a call:
the signature covers the whole list. Only on a chain with sponsored execution
(`ERR_APPROVAL_NEEDS_SPONSORED` otherwise). Agents created before this need a new key: the method
`prepare_with_approval` is not on their function-call key.

## Proof on testnet (9 November 2026)

| Step | Where | Reference |
| --- | --- | --- |
| Vault with this code (`vault.wasm` sha256 `7cd1b6d8…`) | NEAR testnet | `eut-sp-sp1109b.testnet` |
| Wallet, 0 ETH throughout | Base Sepolia | `0x1db9bad1d7f4effed814dfc7a0dc5d5aef0f2303` |
| Wallet code after delegation | Base Sepolia | `0xef0100cc74e64316a2aa8deaad0f893d216a879af86cb5` |
| `execute` relayed and paid by the tank, `Executed` log | Base Sepolia | `0xbf474940b665afb3986e159b85d639a39306c983ed793909a8f065b8ab616a90` |
| `settle_sponsored` on the MPC-attested log → `Confirmed` | NEAR testnet | `Gafqdih1rYqkXLfWWnPUyaYeyB6rwTLX4Yju7WinhmdR` |
| Executor v2 voted, wallet re-delegated by the keeper | Base Sepolia | code `0xef010028998bde751ce908c7f2cda1961469994c52bf37` |
| ERC-721 `safeMint` to the delegated wallet | Base Sepolia | `0x85aab66234ab7fd99c0ad1fb096ee6b876b90adb6dc8237e9c2b826111d5d93c` |
| Executor v3 voted, wallet re-delegated | Base Sepolia | code `0xef010076bb5c47b0759af0300afeea954fa837a96675ed` |
| approve + swap + revoke, one `executeBatch` paid by the tank (4 in, 8 out, allowance back to 0, wallet 0 ETH) | Base Sepolia | `0xbc98d6eafc398384f05097ba55f4a023a336aca6e02e218ab0ddd0a3b97a4f68` |
| its `settle_sponsored` → `Confirmed` | NEAR testnet | `5hvSeWvAqnXMF9M3MzK3CaQwzWfVM5yyQVUCrw7bPxjk` |
| A company's euros swapped on Uniswap V3: 0.3 EURC (Noah's sandbox euro) → 0.000155 WETH, approve + swap + revoke by the agent over MCP, relayed | Base Sepolia | `0x63c57a2405715267087c886dc905f44c60dbe6781fd5ee849076bb107430fa8e` (wallet `0x411a…3013`, Judge Timed 2054) |

The first swap ran on a test router and test tokens the tank deployed (`apps/api/scripts/sponsored-batch-e2e.mts`).
The EURC one runs on Uniswap's SwapRouter02, in a WETH/EURC_TEST 0.3 % pool we opened on Uniswap's factory at the
market rate, since Uniswap had none for Noah's sandbox token (`0xc68a7653ac3b5eB444BC90CfA43deeC0bB4C3722`,
`apps/api/scripts/eurc-pool-setup.mts`; its liquidity is a small WETH-only position from the tank).

Rerun: `apps/api/scripts/sponsored-testnet-e2e.mts` (then `sponsored-settle.mts` if Base Sepolia
finality outlasts the run: it lags a few hours behind the head).

Executor tests (Foundry, `vm.signAndAttachDelegation`):
`cd contracts/evm/executor && forge install foundry-rs/forge-std --no-git && forge test`.

## Limits

- Testnet only. The vault version with `SetEvmExecutor` must be published on Nomos and voted per company first;
  older vaults show "needs the latest vault version" in the console.
- A settle sent right when our RPC sees the block final can time out on the MPC side (its nodes see
  finality a little later): the first attempt here did (`26xMNfTC…`), the retry two minutes later passed.
  The worker retries on its next poll.
- "Stop sponsoring" does not yet send an authorization to `0x0`: the wallet stays delegated (it still runs only
  what the vault signs).
- Testnet settles on Base's `safe` head (the L2 block is posted on L1), about 5 minutes after the call; mainnet
  keeps `Finalized` (`foreign::evm_finality`). Base Sepolia's `finalized` head can trail by an hour or more.
- Sponsored transfers voted by the DAO start without waiting for each other (they use no wallet nonce): two voted
  transfers ran and settled within 5 minutes on 9 November (`apps/api/scripts/sponsored-parallel-e2e.mts`, NEAR
  `EokVMGtV…`, `AZ6fGm3w…`). Plain transactions still go one at a time.

## Why not eth-infinitism's Simple7702Account

Tested live on Base Sepolia (`apps/api/scripts/simple7702-compare.mts`): a throwaway key delegated to the
deployed Simple7702Account v0.8 (`0x4Cd241E8…66c9`), EntryPoint v0.8 (`0x4337084D…f108`), a paymaster
for that wallet only, the tank as bundler.

| | Result | Tx |
| --- | --- | --- |
| approve + swap + revoke via `executeBatch`, paymaster pays, wallet 0 ETH | works | `0x84a7a890…cb81` |
| a UserOp signed, sent 3 minutes later | still runs: no deadline | `0xb2df3929…765a` |
| a failing swap | bundle succeeds, `UserOperationEvent.success = false`, nonce used, gas paid | `0xbf3c58e3…c5` |
| cancel: an empty UserOp with the same nonce first | the signed one can no longer run | `0x4f8b5eeb…527a` |

It works, and it is audited, but a signed UserOp never expires (`_validateSignature` returns success with
no time range). The vault gives budgets back when an operation expires without proof, so with this account
it would have to cancel by burning the nonce first (as `cancel_nonce` does on the plain path) and settle on
`UserOperationEvent` with `success` decoded. EuthynaExecutor checks the deadline itself. Ambire's
`AmbireAccount7702` (ambire-common) has the same shape: `validateUserOp` returns success with no time range.
