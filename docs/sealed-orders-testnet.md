# Sealed orders on testnet, 6 November 2026

The first sealed order, end to end, on the `judge-e2e-1903` company (DAO `judge-e2e-1903.sputnikv2.testnet`,
vault `judge-e2e-1903.nomos.euthyna.testnet`, Base Sepolia wallet `0xC63Ac0Bc10dc950B97893818CE553528C1c55ce4`).
What it shows: the order is one hash on chain; a zero-knowledge proof of its hidden terms is verified on NEAR;
the vault, through the same role checks as any agent, has NEAR MPC sign a Uniswap swap that is mined on Base
and settled back on the vault from an MPC attestation of the Base receipt.

## The contract

`euthyna-sealed-orders.testnet`: `contracts/sealed-orders`, wasm built by the contracts CI in the pinned image
(sha256 `2204248bae5c2fd83c23da15e422ac4357a972bd0051c864aa8db4b3af650f08`, on-chain code hash
`3HnXV7bbRP5DRNC64kwAYddoYg2dvq1L8ciU4eSsAfWw`). Deployed, initialised and its only key deleted in one
transaction: `view_access_key_list` returns no key, and the contract has no owner method.

## Turning it on: three votes

| Step | NEAR transaction |
| --- | --- |
| Proposal #5, the `sealed-orders` role: swap USDC for WETH on Uniswap v3, 10 USDC a day, approval up to 20, member `euthyna-sealed-orders.testnet` | [`AsMJDgvP…`](https://testnet.nearblocks.io/txns/AsMJDgvPsAogLgxPN3xgqFNsT9D1o44x3Fmzg7X6BG5n), approved [`8gWx2SD8…`](https://testnet.nearblocks.io/txns/8gWx2SD8pcUExfB6FzU8i4QwTvAXbMLXzhYprsHoaWZq) |
| The three rule changes, after the veto window | [`3r3yWdT3…`](https://testnet.nearblocks.io/txns/3r3yWdT3FVRBaZoub8PMQiAPbnhHJyw5CMgSo86f2APj), [`4XfNs5bn…`](https://testnet.nearblocks.io/txns/4XfNs5bndQ4EKYmwT2rD3YmGdushtEGZNYTeyww3r7Jw), [`3JFoES5C…`](https://testnet.nearblocks.io/txns/3JFoES5Ck2xg6qwfGxXasgVYrGipm9qYUBnFWNRtaNea) |
| Proposal #6, `configure`: this vault, this role, 0.5% slippage (the contract checks the vault's owner and reads its wallet) | [`27dhsTDm…`](https://testnet.nearblocks.io/txns/27dhsTDmii2XjcbqyhGRmB8HgG2cPAKHF3gjMTvxfLuv), approved [`AhR5itmB…`](https://testnet.nearblocks.io/txns/AhR5itmBXS9nzGNsZ3t6Rp6yL1TTAvPXZSZ8eeF14GHt) |
| Proposal #7, the wallet approves the router for 20 USDC (a DAO transaction) | [`HxxXUX7c…`](https://testnet.nearblocks.io/txns/HxxXUX7cy3ZVGEHXtJX72srEUDaLXPVewAHsq5sA59Lw), approved [`CQ3ymvKC…`](https://testnet.nearblocks.io/txns/CQ3ymvKCQybmVzM6PSCyyztH2VUecGTvD5FgsW3T34de); on Base [`0x9e7d9075…`](https://sepolia.basescan.org/tx/0x9e7d9075beead50999d3180cf10dde32b41ec238024c6a84cf0a90cd7203896b), settled on the vault (state `Confirmed`) |

## The order

| Step | Transaction |
| --- | --- |
| Proposal #8 seals `0x193d6691…a721`: buy WETH with USDC at 2 000 USDC per WETH or better, 5 USDC in all, 2 days. Only the hash is on chain | [`DmcdSsf7…`](https://testnet.nearblocks.io/txns/DmcdSsf7HMCkbjtLRoLZMdmUnxCx6ypfzkqRjMnTh8uN), approved [`3p1tDLch…`](https://testnet.nearblocks.io/txns/3p1tDLchuG8kVkrbGsnb4WMZp1pUMfSJLfos1k3QY9oj) |
| The watcher (`pnpm --filter @euthyna/api sealed watch`, on the member's machine) quoted 1 771 USDC per WETH, proved the fill (2 USDC, rate `564568447386072000000000000`) and sent it. The contract verified the proof and the vault prepared and had MPC sign the swap: 101.7 Tgas in all | [`DDxMCteiUFCtykQj8xRdozt7CSMZWePCBTmWWsXzHqM9`](https://testnet.nearblocks.io/txns/DDxMCteiUFCtykQj8xRdozt7CSMZWePCBTmWWsXzHqM9) (operation `0x7d40bbab…3cbb`) |
| The swap on Base Sepolia: 2 USDC in, 0.001129 WETH out to the company wallet, above the minimum the proven rate sets | [`0xea08a63f…`](https://sepolia.basescan.org/tx/0xea08a63fc2db152bc676e8932dca48eea8e04f19ba5683573467d2f520c4f995), settled on the vault once the Base block was final (state `Confirmed`) |

After the fill, `order(dao, 0)` reads `filled: 2000000, fills: 1`; the limit, the 5 USDC total and the deadline
appear nowhere on chain.

## What is public

Each fill's amount, the pair, the rate it demanded (here 1 771 USDC per WETH, so the hidden limit is at or
above it) and the company wallet: the swap is a Base transaction. The order's running total. Who holds the order
file (the members who sealed it, and whoever runs the watcher).

## Seen on the way

The vault settles a Base operation only on a finalized block, about 20 minutes on Base Sepolia: the watcher now
waits up to 40 minutes (`--settle-minutes`) and says so when it stops earlier.
