# Sealed orders on testnet, 6 November 2026

Two runs: [v2](#v2-an-agent-of-the-swap-role-places-the-order), the current contract (an agent of the swap role
places the order, the members read its terms), then [v1](#v1-the-dao-seals-by-vote), the first one.

## v1: the DAO seals by vote

The first sealed order, end to end, on the `judge-e2e-1903` company (DAO `judge-e2e-1903.sputnikv2.testnet`,
vault `judge-e2e-1903.nomos.euthyna.testnet`, Base Sepolia wallet `0xC63Ac0Bc10dc950B97893818CE553528C1c55ce4`).
What it shows: the order is one hash on chain; a zero-knowledge proof of its hidden terms is verified on NEAR;
the vault, through the same role checks as any agent, has NEAR MPC sign a Uniswap swap that is mined on Base
and settled back on the vault from an MPC attestation of the Base receipt.

### The contract

`euthyna-sealed-orders.testnet`: `contracts/sealed-orders`, wasm built by the contracts CI in the pinned image
(sha256 `2204248bae5c2fd83c23da15e422ac4357a972bd0051c864aa8db4b3af650f08`, on-chain code hash
`3HnXV7bbRP5DRNC64kwAYddoYg2dvq1L8ciU4eSsAfWw`). Deployed, initialised and its only key deleted in one
transaction: `view_access_key_list` returns no key, and the contract has no owner method.

### Turning it on: three votes

| Step | NEAR transaction |
| --- | --- |
| Proposal #5, the `sealed-orders` role: swap USDC for WETH on Uniswap v3, 10 USDC a day, approval up to 20, member `euthyna-sealed-orders.testnet` | [`AsMJDgvP…`](https://testnet.nearblocks.io/txns/AsMJDgvPsAogLgxPN3xgqFNsT9D1o44x3Fmzg7X6BG5n), approved [`8gWx2SD8…`](https://testnet.nearblocks.io/txns/8gWx2SD8pcUExfB6FzU8i4QwTvAXbMLXzhYprsHoaWZq) |
| The three rule changes, after the veto window | [`3r3yWdT3…`](https://testnet.nearblocks.io/txns/3r3yWdT3FVRBaZoub8PMQiAPbnhHJyw5CMgSo86f2APj), [`4XfNs5bn…`](https://testnet.nearblocks.io/txns/4XfNs5bndQ4EKYmwT2rD3YmGdushtEGZNYTeyww3r7Jw), [`3JFoES5C…`](https://testnet.nearblocks.io/txns/3JFoES5Ck2xg6qwfGxXasgVYrGipm9qYUBnFWNRtaNea) |
| Proposal #6, `configure`: this vault, this role, 0.5% slippage (the contract checks the vault's owner and reads its wallet) | [`27dhsTDm…`](https://testnet.nearblocks.io/txns/27dhsTDmii2XjcbqyhGRmB8HgG2cPAKHF3gjMTvxfLuv), approved [`AhR5itmB…`](https://testnet.nearblocks.io/txns/AhR5itmBXS9nzGNsZ3t6Rp6yL1TTAvPXZSZ8eeF14GHt) |
| Proposal #7, the wallet approves the router for 20 USDC (a DAO transaction) | [`HxxXUX7c…`](https://testnet.nearblocks.io/txns/HxxXUX7cy3ZVGEHXtJX72srEUDaLXPVewAHsq5sA59Lw), approved [`CQ3ymvKC…`](https://testnet.nearblocks.io/txns/CQ3ymvKCQybmVzM6PSCyyztH2VUecGTvD5FgsW3T34de); on Base [`0x9e7d9075…`](https://sepolia.basescan.org/tx/0x9e7d9075beead50999d3180cf10dde32b41ec238024c6a84cf0a90cd7203896b), settled on the vault (state `Confirmed`) |

### The order

| Step | Transaction |
| --- | --- |
| Proposal #8 seals `0x193d6691…a721`: buy WETH with USDC at 2 000 USDC per WETH or better, 5 USDC in all, 2 days. Only the hash is on chain | [`DmcdSsf7…`](https://testnet.nearblocks.io/txns/DmcdSsf7HMCkbjtLRoLZMdmUnxCx6ypfzkqRjMnTh8uN), approved [`3p1tDLch…`](https://testnet.nearblocks.io/txns/3p1tDLchuG8kVkrbGsnb4WMZp1pUMfSJLfos1k3QY9oj) |
| The watcher (`pnpm --filter @euthyna/api sealed watch`, on the member's machine) quoted 1 771 USDC per WETH, proved the fill (2 USDC, rate `564568447386072000000000000`) and sent it. The contract verified the proof and the vault prepared and had MPC sign the swap: 101.7 Tgas in all | [`DDxMCteiUFCtykQj8xRdozt7CSMZWePCBTmWWsXzHqM9`](https://testnet.nearblocks.io/txns/DDxMCteiUFCtykQj8xRdozt7CSMZWePCBTmWWsXzHqM9) (operation `0x7d40bbab…3cbb`) |
| The swap on Base Sepolia: 2 USDC in, 0.001129 WETH out to the company wallet, above the minimum the proven rate sets | [`0xea08a63f…`](https://sepolia.basescan.org/tx/0xea08a63fc2db152bc676e8932dca48eea8e04f19ba5683573467d2f520c4f995), settled on the vault once the Base block was final (state `Confirmed`) |

After the fill, `order(dao, 0)` reads `filled: 2000000, fills: 1`; the limit, the 5 USDC total and the deadline
appear nowhere on chain.

### What is public

Each fill's amount, the pair, the rate it demanded (here 1 771 USDC per WETH, so the hidden limit is at or
above it) and the company wallet: the swap is a Base transaction. The order's running total. Who holds the order
file (the members who sealed it, and whoever runs the watcher).

### Seen on the way

The vault settles a Base operation only on a finalized block, about 20 minutes on Base Sepolia: the watcher now
waits up to 40 minutes (`--settle-minutes`) and says so when it stops earlier.

## v2: an agent of the swap role places the order

Same company and wallet. The contract `euthyna-sealed-orders-v2.testnet` is the CI build of
`contracts/sealed-orders` (sha256 `8be6477b36c86b95c96dba8c5e77255eeefa9580a91e7ceb74d69d370c0a273c`, on-chain
code hash `AR7L9TpCk5wtceqhJp28rGNVrsZAaWkBprYAczktRfQX`), deployed, initialised and keyless in one transaction
[`7njJg5XV…`](https://testnet.nearblocks.io/txns/7njJg5XVnWT3KQXsQu4nQEoGMwVXLK9erh8TwV74bKLm): `view_access_key_list` returns no key. No `configure`
any more: the role decides.

| Step | Transaction |
| --- | --- |
| Proposal #9, the `treasury-desk` role: swap USDC for WETH on Uniswap v3, 10 USDC a day, approval up to 20, "Allow sealed orders" on; members the agent `eut-e2e1903-desk-agent.testnet` and the contract | [`FyQgxeGT…`](https://testnet.nearblocks.io/txns/FyQgxeGTH52vRS7pyEbCEx28iJQZiTWFrSLduZQKLdAi), approved [`CMTUPRvP…`](https://testnet.nearblocks.io/txns/CMTUPRvPw2XhGts4NqYRCh4RvAhiCuJvCU62MFnH7cNj) and [`ErccKDAW…`](https://testnet.nearblocks.io/txns/ErccKDAWAnXdJs6gbE5vEkkrCW6xWFXFmRbqEqrxsvzT) |
| The four rule changes after the veto window (allowance, role, then the two members) | [`aM66V9ws…`](https://testnet.nearblocks.io/txns/aM66V9wsemP5pks5YoVePRwpgSc3Ww4eb1phpRr7wA6), [`2qwJWu7x…`](https://testnet.nearblocks.io/txns/2qwJWu7xifr3kJUKjKkaacMZHFM7ZRGXEvtT8GakeeP4), [`6o94zbt5…`](https://testnet.nearblocks.io/txns/6o94zbt5A6XArodXJzAAv4zkr3ycdnoTJnVkuvosKpeF), [`Gb4XErct…`](https://testnet.nearblocks.io/txns/Gb4XErct2j4sfmVqHuDLE5mtrfvZUZZsrZ2X4bzX9d4) |
| Two council members register a reading key (an X25519 key derived from their NEP-413 signature; the contract checks the DAO policy) | [`52kijbax…`](https://testnet.nearblocks.io/txns/52kijbaxwGA7571R2hr5TivmrGgi2NaaQFAfVFjmgPcY), [`5rN8KTnN…`](https://testnet.nearblocks.io/txns/5rN8KTnN6YC6jSoHuLb9M7LBPZeaexAamHSqttaVLieH) |
| The agent (`sealed place --approve 20`) has the vault approve the router for 20 USDC, inside the role: 34.7 Tgas | [`D2NDr2vn…`](https://testnet.nearblocks.io/txns/D2NDr2vnBaUvQvrjz1TUcJLrYBiRRGxbJR1C3KdXqDvS); on Base [`0xbd666317…`](https://sepolia.basescan.org/tx/0xbd666317fb6f180e1f1a68839275ef7134def34bbac5645bfebec4dd0a0a0f33), settled (`Confirmed`) |
| The agent seals order #0, `0x0102b5f3…5bca`: 2 000 USDC per WETH or better, 5 USDC in all, 2 days, with the terms encrypted for the two readers: 16.2 Tgas | [`7dF2DRQS…`](https://testnet.nearblocks.io/txns/7dF2DRQSZ9JJZUABzBxyFk7ADjkcz8S1BydZg2LDN483) |
| The watcher (`sealed watch --chunk 2`) quoted 1 772 USDC per WETH, proved a 2 USDC fill and sent it: 101.8 Tgas | [`CSHcLrYd…`](https://testnet.nearblocks.io/txns/CSHcLrYdh92DoFSG6KHbBeCmT8mvFT6UvnWksXBSEujW) (operation `0xc7f52363…0bd8`, `min_out` 0.001123 WETH) |
| The swap on Base Sepolia: 2 USDC in, 0.0011289 WETH out to the company wallet | [`0x04d7421a…`](https://sepolia.basescan.org/tx/0x04d7421afad2b4a4593d392a8945e516de26182c1c5719d0ccf3612f2cd450fc), settled on the vault once final (`Confirmed`, 23 minutes later) |

Then `order(vault, 0)` reads `filled: 2000000, fills: 1`. The two registered members decrypt the terms from the
chain (cap 5 USDC, the limit, the deadline); `eut-e2e1903-newseat.testnet`, a member who registered no key,
cannot. The router allowance reads 18 USDC (20 approved, 2 swapped).

Seen on the way, fixed in the same branch: `sealed place` printed near-api-js receipt logs into the order file
(stdout now carries only the file); the agent's router approval was signed but not broadcast (`place` now
broadcasts it and keeps it pending in the order file until settled); the watcher no longer sends a fill the router
allowance cannot cover (`needs-approval`).
