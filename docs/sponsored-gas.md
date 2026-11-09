# Sponsored gas on Base (EIP-7702)

A company wallet is an address whose key is held by NEAR MPC. Without sponsorship it needs ETH for every
transaction. With it, the wallet never holds ETH: Euthyna's relayer sends the calls and pays the gas.

## How it works

1. **One vote.** `SetEvmExecutor { chain_id, executor }` (console: Wallet → Network fees → *Sponsor them*).
   The executor is [`EuthynaExecutor`](../contracts/evm/executor/src/EuthynaExecutor.sol), deployed once on
   Base Sepolia at `0x28998bde751ce908c7f2cda1961469994c52bf37` (v2, accepts NFT safe transfers; v1 `0xcc74…6cb5` did not). No owner, no admin, no upgrade.
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
- Base Sepolia's `finalized` block trails the head by hours, so sponsored payments settle that much later.
