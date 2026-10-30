# Abstract

Euthyna gives people, companies and their AI agents wallets on every chain that no single key can drain or lose. Funds sit in wallets derived by NEAR's MPC network from a keyless vault contract. The vault signs a transaction only if it fits a role its owners voted on: which contracts, which functions, which recipients, which budget.

Agents act directly on chain through an MCP server and a local signer. Euthyna's own servers are never in the execution path, and never hold a key that can move funds. Humans govern through a DAO; agents operate inside the rules. Atlantis, built on Euthyna, lets anyone launch an AI company with shares, revenue and votes on top of the same infrastructure.

Today the stack runs on NEAR testnet, Base Sepolia, Ethereum Sepolia and Solana devnet.

# The problem

Whoever holds money on chain, a person, a company or an AI agent, faces the same two failures: the key leaks and the funds are drained, or the key is lost and the funds are gone. Private key compromises caused 43.8% of the $2.2 billion stolen from crypto platforms in 2024 ([Chainalysis, via Benzinga](https://benzinga.com/content/42596818/chainalysis-estimates-2-2b-stolen-from-crypto-platforms-in-2024)). Chainalysis also estimates that 17% to 23% of all bitcoin, about 2.78 to 3.79 million BTC, is lost or out of circulation ([PaymentsNext](https://paymentsnext.com/chainalysis-research-shows-up-to-23-of-bitcoin-are-mia/)).

User forums tell the same story at small scale. On r/ethdev, a user found the ETH and tokens of a MetaMask wallet drained, with transactions sent from the wallet's own address; replies point to a keylogger, malware or physical access, and warn about the "recovery" scams that follow ([thread](https://www.reddit.com/r/ethdev/comments/1itzmx3/wallet_drained_but_how/)).

| Setup | For humans | For AI agents |
| --- | --- | --- |
| Private key or seed phrase | One leak (malware, phishing, a photo of the seed) drains everything; one loss locks everything forever. | The key sits in the agent's environment: a prompt injection or a leaked file drains the wallet. |
| Custodial service (exchange, wallet-as-a-service) | The provider can freeze or lose funds; limits live in its database. | Same, and the agent's API key becomes the new single secret. |
| Multisig | Safer, but every payment waits for several people, and signers often approve data they cannot read. In February 2025, Bybit's Safe multisig lost over $1.4 billion when signers approved a transaction a tampered web interface showed as a routine transfer ([NCC Group](https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/)). | With the agent as one signer, every action waits for humans, so the agent is no longer autonomous. |

What both need is the same: no single key that can drain or lose the funds, rules a machine checks before anything is signed, and a way to recover access. Euthyna gives people and companies a wallet with those properties, and lets them hand an AI agent a role inside it.

# Design principles

1. **Non-custodial.** No key that can move company funds exists anywhere. The vault has no access key; wallets are derived by MPC from the vault's account.
2. **Policy lives on chain.** Roles, budgets and recipients are vault state, changed only by a DAO vote after a veto window.
3. **Fail closed.** Anything the vault cannot decode, locate or prove is refused.
4. **The vault builds or checks every byte.** Amounts are measured in the calldata, never declared by the agent; on Solana the vault writes the transaction itself.
5. **Humans govern, agents operate.** Members vote on rules; agents act alone inside them and can always ask members to vote on anything outside.
6. **No backend in the execution path.** If Euthyna's servers go down, agents keep transacting through public RPCs and NEAR's MPC network.
7. **Verifiable.** Vault code is built reproducibly, published by hash and upgraded only by vote; every operation leaves a record on NEAR and on the destination chain.

# Architecture

Each company gets two contracts on NEAR: a DAO that holds the votes and a keyless vault that holds the rules and signs. Everything else is a client.

Members vote in the DAO, which owns the vault. Agents can only ask the vault; only the vault can ask MPC to sign for the company's wallets.

| Component | Where | Role |
| --- | --- | --- |
| `euthyna.near` | NEAR | Root account of the project. |
| Nomos (`nomos.euthyna.near`) | NEAR | Factory. Stores vault code versions by SHA-256 hash and creates keyless vaults as sub-accounts. Has no power over vaults once created. |
| Company DAO | NEAR, official Sputnik factory | Members and votes. Owner of the vault. |
| Company vault (`<name>.nomos.euthyna.near`) | NEAR | Roles, budgets, recipients, operation queue. The only account that can ask MPC to sign for the company's wallets. |
| Chain signatures | NEAR MPC network | Derives the company's wallets on other chains from the vault account; signs only what the vault requests; attests foreign transaction results. |
| Company wallets | EVM chains (Base, Ethereum), Solana; Bitcoin planned | Hold the funds. Addresses are derived, not imported. |
| euthyna-signer | Agent's machine | Keeps the agent's NEAR key out of the AI's reach and only signs vault calls. |
| MCP server | Agent's machine | Tools the AI calls: pay, swap, lend, Solana transfer, status. Talks to the vault directly. |
| API and console | euthyna.io | Onboarding, proposals to vote, activity, balances. Optional for execution. |

An agent's NEAR account can only call the vault's agent methods. The vault checks the call against the agent's role, asks MPC for a signature, and the agent broadcasts the signed transaction itself.

# Roles and policy engine

A role is a list of permissions plus budgets, voted by the DAO and enforced by the vault on the exact transaction bytes.

**Permissions (EVM).** Each permission pins a chain, a target contract and a 4-byte function selector. A condition tree then checks the decoded arguments: equal to, in a list, less or greater than, the company's own wallet, every or some array element. The ABI decoder is bounds-checked and fails closed. Sending native ETH is off unless the permission allows it.

**Budgets.** `WithinAllowance` nodes charge the amount read from the calldata to a budget that refills over a period (a day, a week, a month). Budgets are reserved when the operation is prepared, so parallel operations cannot overspend.

**Role blocks.** The console and SDK write permissions from plain blocks:

| Block | What the agent may do |
| --- | --- |
| `payments` | Send one token to listed recipients, within a budget. |
| `swap` | Swap a token on Uniswap V2/V3 into listed tokens; proceeds must go to the company wallet. |
| `lending` | Supply to and withdraw from Aave, always on behalf of the company wallet. |
| `wrap` | Wrap ETH into WETH and back. |
| `solana-transfer` | Send SOL or an SPL token to listed Solana wallets. |
| `share-revenue` | Bridge revenue to the company's shareholders contract. |

**Other controls.** Membership with start, end and maximum uses; unique references per operation; delays and co-signature above thresholds; velocity limits; gas caps per role; a pause held by a security council.

**Refusals are not dead ends.** A refused request is recorded with its reason. Any member can turn it into a DAO proposal carrying exactly that transaction.

# Operation lifecycle

Every operation goes through four steps. On testnet, four pipelined agent operations on Base settled in 217 seconds, and a Solana transfer in 18 seconds.

1. **Prepare.** The agent calls the vault with the transaction it wants (target, calldata, value, gas, reference). The vault finds a matching permission, evaluates the conditions, reserves the budget and assigns the wallet nonce.
2. **Sign.** The vault asks the MPC network for a signature on the transaction hash, under the derivation path of the company wallet. The vault never sees a private key.
3. **Broadcast.** The agent, or anyone, sends the signed transaction to the chain.
4. **Settle.** The vault asks MPC to attest the transaction's finality on the foreign chain (`verify_foreign_transaction`), then finishes the accounting. An operation that never lands can be released after its time-to-live.

**Pipelined nonces.** Up to 8 EVM operations per wallet can be in flight at once, so an agent can approve, swap and supply without waiting for each to settle.

**Integrity check.** The vault counts the transactions it signed for each wallet. If the chain's nonce for that wallet is ever higher, something left the wallet outside the vault, and the console raises an alert.

# Chains

One vault governs wallets on several chains; each chain gets the checking model that fits it.

| Chain | Status | How the vault controls it |
| --- | --- | --- |
| Base | Ready, testnet | EVM: checks the calldata of each EIP-1559 transaction against the role, MPC signs (secp256k1), settlement attested by MPC. |
| Ethereum | Ready, testnet | EVM, same model as Base. |
| Solana | Ready, testnet | The vault builds the transaction itself (System, Token and Associated Token programs only), MPC signs (ed25519), finality attested by MPC. The agent supplies only recipient, mint, amount and a recent blockhash. |
| Arbitrum | Planned | EVM, same model as Base. |
| BSC | Planned | EVM, same model as Base. |
| Plasma | Planned | EVM, same model as Base. |
| Tron | Planned | Its own transaction format and address encoding, built and checked by the vault. |
| Bitcoin | Planned | A Bitcoin wallet derived by MPC; the vault builds and signs its transactions. |

**Planned features across chains.** NEAR Intents: the vault registers an MPC key on `intents.near` and signs only `TokenDiff` swaps it built itself. 1Click cross-chain swaps: the vault verifies the signature 1Click puts on each quote and checks that recipient and refund address are company wallets. EIP-7702 batching: approve, swap and revoke in one atomic EVM transaction, each inner call checked by the vault.

# Upgrades and governance

Only a company's own members can change its vault's code, and only to a version anyone can rebuild and check.

- **Reproducible builds.** Vault WASM is built in a pinned Docker image (cargo-near 0.22.0, Rust 1.99.1), so its SHA-256 can be reproduced from the source.
- **Versions on Nomos.** The project publishes each version to Nomos, keyed by its hash, with release notes. Three versions are live on testnet: the original, then Solana support, then an upgrade gas guard.
- **Upgrade by vote.** Members propose `Upgrade { code_hash }`; after the vote and the veto window, the vault fetches the code from Nomos, checks the hash, deploys it and migrates its state. Existing state is kept, as shown when a testnet company moved from version 1 to version 2.
- **Every rule change follows the same path:** proposal, DAO vote, a delay during which the security council can veto, then execution.
- **Pause.** The security council can pause all agent operations at once; resuming takes a members' vote.

# Security model

A fully compromised agent can spend at most its remaining budget, on actions its role allows, toward recipients the DAO listed.

| Attacker | What they can do | What stops the rest |
| --- | --- | --- |
| Compromised agent (prompt injection, stolen key) | Allowed actions up to its budget | Role checks on exact bytes; budgets; members revoke the agent by vote; council pause |
| Euthyna's servers | Show wrong data in the console | No key, no role in signing; proposals are re-checked in the member's browser before signing |
| One DAO member | Propose changes | Votes, veto window, council veto |
| Swap counterparty or MEV | Give a poor price | Budget caps the exposure; minimum-rate rules planned |

**Trust assumptions.** The NEAR MPC network signs only what the vault asks and attests foreign results honestly. Target protocols (Uniswap, Aave) and their governance behave as published. For planned features: 1Click's signing key, and `intents.near`'s operators, who can freeze an account.

# Recovery and identity

Company wallets cannot be lost: they have no private key and are re-derived from the vault account. What can be lost is a person's key, and with it the ability to vote. Recovery is designed for people, not for vaults.

**Member recovery (planned).** A member's NEAR account runs a small recovery contract. A recovery proof must name the new key, then a delay starts (48 to 72 hours for a person) during which any current key or the DAO can cancel. After the delay the account adds the new key to itself.

| Factor | How it is checked | Notes |
| --- | --- | --- |
| Passkey | `p256_verify` on NEAR | Primary key; synced passkeys already cover most losses. |
| ZK Email | Groth16 proof of a DKIM-signed email, verified on NEAR with `alt_bn128` | Needs a DKIM key registry; email takeover is the main risk. |
| ZKPassport | Proof from a passport or ID card chip, verified by the ZKPassport contract on EVM and attested to NEAR by MPC | Same document as at enrollment, via a stable per-app identifier. |
| Trusted contact | Another NEAR account's signature | Social recovery. |

Recovery requires two of the factors enrolled. Euthyna can be one factor, never enough on its own.

**Companies.** If members lose keys but quorum remains, the others vote a replacement in the DAO. If quorum is lost, a last-resort path voted at creation lets a director prove their identity with ZKPassport, followed by a 14 to 30-day public delay that any active member or the council can cancel.

**KYB.** ZKPassport covers the KYC half of KYB: directors' and owners' nationality, age, sanctions checks and uniqueness, without revealing documents. Proving that a company exists and who controls it needs other sources, such as a vLEI or a registry proof.

# Atlantis

Atlantis lets anyone launch an AI company in a few steps: a DAO, a vault, wallets, roles for its agents, and shares that carry votes and revenue. It is built entirely on Euthyna, named after the legendary city that was far ahead of its time.

**Launch.** The founder names the company and its members. Atlantis creates the Sputnik DAO and asks Nomos for a keyless vault owned by it; members then vote the company wallets and the first roles.

**Shares.** Each company can deploy one shares contract next to its vault. The contract has no access key, so no one can change it, Atlantis included.

| Part | How it works |
| --- | --- |
| Token | NEP-141 with 0 decimals: 1 unit = 1 share, fixed supply. |
| Sale | `buy()` at a fixed price in NEAR; proceeds go to the DAO. |
| Votes | The contract is the DAO's staking contract: locked shares are votes. |
| Revenue | Split by epoch (7 days in production) among holders who voted on at least one proposal that epoch, pro rata of their locked shares. |

**Revenue from agents.** An agent with a `share-revenue` role sends revenue from the company's Base wallet to the shares contract through the Omni Bridge, with a fixed recipient and a capped bridge fee. On testnet, 0.002 ETH went from an agent to shareholders this way, after a refused attempt toward a different recipient.

**Public pages.** Each company has a public page read straight from NEAR: members, vault, wallets, treasury and revenue paid to voters. A registry lists the companies.

Shares are held by people, not by agents: agents work for the company, owners vote on what they may do.

# Use cases

Each use case is one role: what the agent may do, with which budget, and where the money may go.

| Use case | Example role | Status |
| --- | --- | --- |
| Supplier payouts | Pay listed suppliers in USDC on Base or Solana, up to 500 per week | Live on testnet |
| Treasury yield | Wrap ETH, swap USDC for WETH on Uniswap, supply to Aave on behalf of the company wallet | Live on testnet |
| Rebalancing across chains | Swap up to 100 USDC per quote from Base into SOL delivered to the company's Solana wallet, via 1Click | Planned |
| Revenue sharing | Send company revenue to shareholders who voted, through the Omni Bridge | Live on testnet |
| Freelance agent | Get paid by clients and pay for its own tools and APIs, within a monthly budget | Possible with payment roles |
| AI company on Atlantis | Agents run operations, owners hold shares, vote and receive revenue | Live on testnet |
| Retail wallet | A personal wallet on every chain, a passkey to sign, ZK-based recovery | Planned |

When an agent needs something outside its role, such as a new recipient or a bigger amount, members vote on that exact transaction, and the role does not change.

# Status and roadmap

Everything below "Today" runs on NEAR testnet, Base Sepolia, Ethereum Sepolia and Solana devnet, and is open to the NEAR Hackathon judges at [euthyna.io](https://euthyna.io/).

**Today**

- Company creation: Sputnik DAO plus a keyless vault from Nomos, resumable if a step fails.
- Roles for payments, Uniswap swaps, Aave lending, WETH wrapping, Solana transfers and revenue sharing.
- Pipelined EVM operations, MPC-attested settlement on Base and Solana, wallet integrity check.
- Vault versions published on Nomos and upgraded by vote, with state kept.
- MCP server and euthyna-signer for agents; console with balances in USD, activity in plain sentences and proofs on demand.
- Atlantis: shares, revenue to voters, public company pages.

**Next**

1. More chains: Arbitrum, BSC, Plasma, Tron and Bitcoin.
2. Mainnet: `euthyna.near` and `nomos.euthyna.near`, NEAR Intents and 1Click cross-chain swaps.
3. EIP-7702 batching on EVM wallets.
4. Member recovery with passkeys, ZK Email and ZKPassport; KYC of directors at onboarding.
5. A retail Euthyna wallet on the same infrastructure.

# Sources

- [NEAR Intents Verifier source](https://github.com/near/intents)
- [1Click quote signature verification](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature)
- [ZKPassport SDK](https://www.npmjs.com/package/@zkpassport/sdk)
- [ZK Email FAQ](https://docs.zk.email/frequently-asked-questions)
- [OP Stack Isthmus upgrade (EIP-7702)](https://docs.optimism.io/op-stack/protocol/hardforks/isthmus.md)
- [near-sdk `p256_verify`](https://docs.rs/near-sdk/5.29.1/near_sdk/env/fn.p256_verify.html)
