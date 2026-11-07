# Euro bank account (IBAN)

A company gets a euro IBAN. A SEPA transfer to it arrives as **EURC in the company wallet**, the
address the vault controls, and from there it moves only as a role allows or the members vote. The
partner is [Noah](https://docs.noah.com) (Business API, virtual IBANs held at OpenPayd).

| | |
| --- | --- |
| Who opens it | an owner of the company, once, with the company's legal details (KYB), in **Treasury → Euro bank account** |
| Where the euros go | the company wallet only: the API reads its address from the vault on NEAR (`get_wallet`) and never takes it from the request; if the partner answers with another address, nothing is saved (`destination_mismatch`) |
| What arrives | EURC on Base (sandbox: `EURC_TEST` on Base Sepolia, `0x623ef90571256F905B2Fde947dC33098BdD8F4d8`) |
| How it leaves | like any company money: a payment role with an EURC budget, or a transaction the members vote |
| Keys | the Noah API key stays on the server (`NOAH_API_KEY`); the company wallet still has no private key |
| Code | `apps/api/src/bank/` (client, service, tests), `apps/console/src/routes/BankAccountCard.tsx` |

## On testnet (Noah sandbox, Base Sepolia), 2026-11-07

Run: `NOAH_API_KEY=… DATABASE_URL=… VAULT=<vault> pnpm --filter @euthyna/api exec tsx scripts/bank-sandbox-e2e.ts`.

| Step | Result | Proof |
| --- | --- | --- |
| Open the account for `testdao4ai.euthyna-nomos.testnet` | IBAN `MT22 CFTE 1987 0000 0000 9001 0358 449`, settles into `0x1be62b8a…8e1d`, read from the vault | `bank-sandbox-e2e.ts` |
| A SEPA transfer of 20 EUR (sandbox simulation) | 19.71 EURC in the company wallet, about 30 s later (1 % fee) | Base Sepolia `0x569f9cead0e810b69bb1b05bf65780bb1f33a9fe50a34691c81574e0c7e5e2da` |
| Same for `sealedprod1106.nomos.euthyna.testnet` | 19.71 EURC in `0x8b22b9fa…9de6` | Base Sepolia `0x794330f7d92b2f8f377591eb9630522a2d2d07e3a88f97147ffda7f45cdce864` |
| The members of sealedprod1106 vote to pay 5 EURC to a supplier from those euros | proposal #13, approved by two of three; scheduled by the vault | NEAR `7eqYU8we8uCAZ7jVbfzMHi3Q8ibdZw6uBo8Jt6STNdrn`, `FMKS3Ty1zjSGSSbUjZco9j4EVa3mGtswGZxfyTuhToDF` |
| After the veto window the API starts it, NEAR MPC signs it for the vault, the worker broadcasts it | 5 EURC received by the supplier (`0x1be62b8a…8e1d`): 19.71 → 24.71 | Base Sepolia `0xc45d7ea2a864c590e9f23eb2abfb173d0189eb4587f9abaddd15aa5b4c768470` (vault operation `f8643bfc…e027`, wallet nonce 8); started by the API `Bjv1TApifuxda22Fkq5gLsAvvhepJxrPhwkCTRgpUKQ2`, settled by the worker from the MPC attestation of the finalized Base block, state `Confirmed` |
| The worker settles it on the vault | budget and nonce closed on NEAR, about 25 min after the transfer (Base finality) | NEAR `Cix2CioqhiKRc3UANU8zxsBctqZbq5bbuNnNxdUXiZME` |

## Euros out: an agent pays a voted IBAN

The question with a bank partner is who can change where the money goes. A payout address at the
partner is tied to an IBAN by whoever holds the partner API key; the vault cannot see that binding.
So the partner's API key must answer to the vault, and to nothing else:

```
agent ──request_bank_payout──▶ vault (NEAR) ──request_execution──▶ OutLayer (Intel TDX)
                                   │  IBAN in the voted list?            │ bank-signer wasm
                                   │  amount ≤ ceiling, ≤ budget?        │ holds Noah's key
                                   │  reference unused?                  │ answers only a vault
                                   ◀──────── deposit address ────────────┘ single-use rule at Noah
                                   │
                                   └─ EURC transfer to that address, signed by NEAR MPC
                                      (queued like a voted transaction) ──▶ Noah pays the IBAN
```

| | |
| --- | --- |
| The rule | `RuleChange::AddBankBeneficiary` (IBAN, holder name, checksum verified), `SetBankPermission` (role, EURC budget, ceiling per payout), `SetBankConfig` (which signer code, which secrets); all voted by the DAO, queued and vetoable like any rule |
| The check | `request_bank_payout(role, iban, amount, reference)` in `contracts/vault/src/bank.rs`: paused, role enabled, membership active, beneficiary listed, amount within ceiling and budget, reference unused, one payout at a time; the budget is reserved before anything leaves |
| The signer | `bank-signer/`: a WASI component run by [OutLayer](https://outlayer.fastnear.com) in an Intel TDX enclave. Its manifest denies direct, HTTPS and meta-transaction callers; its secret row (profile `noah`) is readable only by that exact WASM hash **and** only when the predecessor is a vault (`*.euthyna-nomos.testnet`, `*.nomos.euthyna.testnet`); the code itself refuses unless `OUTLAYER_EXECUTION_TYPE=NEAR` and the caller is the vault named in its input. Noah's request-signing key (P-256) is derived in the enclave from a `PROTECTED_` seed generated there; the API key attached to that public key refuses unsigned requests (HTTP 401) |
| What the signer does | `POST /transactions/sell/prepare` (the IBAN, the name, the reference, EURC → EUR) and `POST /workflows/onchain-deposit-to-payment-method` with a **single-use trigger**: this source address, exactly this amount, before this expiry (24 h), nonce = the payout id. It answers the deposit address and the rule id; it cannot widen anything the vault decided |
| The transfer | `on_bank_signer` builds `transfer(deposit, amount)` on the EURC token and queues it as a `Scheduled` operation of the agent's role (the role's delay applies above its threshold, the council can veto); the same worker that broadcasts voted transactions signs it through NEAR MPC and settles it. A refusal or a signer failure gives the budget, the membership use and the reference back |
| Agents | MCP `bank_payout` / `bank_status`; `mandate` shows the role's `bank` block (voted IBANs, ceiling, budget) |
| Members | Settings → suppliers (add or remove an IBAN by vote), Treasury → Euro payouts (enable, who may pay, history); Activity shows each payout as one row with its Base transaction |

### What the vault guarantees, and what it does not

- Guaranteed on chain: no IBAN outside the voted list, no amount above the ceiling or the budget,
  no reference twice, no payout while the role is disabled or the vault paused. These are the
  vault's checks, before the signer is even called.
- Guaranteed by the enclave: the partner's API key answers only to a vault's call with the exact
  WASM the members voted (`signer_hash`); nobody, including us, can use it from a laptop. Changing
  the signer code or its secrets means a new hash, and a new `SetBankConfig` vote.
- Not guaranteed: the partner's execution (Noah pays the IBAN off chain; the vault sees its own
  EURC leave and the partner's rule id), and the partner's own honesty. The audit trail is the vault
  payout record, the OutLayer execution and the partner's transaction.

### Deployment (testnet)

| | |
| --- | --- |
| Signer WASM | sha256 `528edf86677845ff9baf5bcd2d25f17564f8b047d33ba2bc1c1a15cb71eb01a4`, on FastFS `https://test.fastfs.io/euthyna-ops.testnet/outlayer.testnet/528edf86…01a4.wasm` (uploaded by `euthyna-ops.testnet`) |
| Secrets | profile `noah` of `euthyna-ops.testnet`, bound to that hash; access `And[Predecessor{Or[AccountPattern vaults, …]}, WasmHash]` (NEAR `BffY2J6J…`); `PROTECTED_NOAH_SEED` generated in the enclave, never exported |
| Signer public key | obtained through the vault (DAO proposal #14 of sealedprod1106, OutLayer worker `G94JrfzY…`): `MFkw…cw==` (P-256), attached to the Noah sandbox API key |
| Vault version | `EkNBLjdMetqegPZgmZXL3QBs57tg1cQHicWHLkdYJYpt` (`contracts/res/vault.wasm`, sha256 `cc43d9e7a212700762975d6e594fc283b9f4963a8341f4da5cc1c4c036dca88d`), published on `euthyna-nomos.testnet` (NEAR `84VmD25JECLyWNDcFaCZf46vTVnVfb5rdwMkPdRazFCC`) |
| Console env | `BANK_SIGNER_URL`, `BANK_SIGNER_HASH`, `BANK_SIGNER_SECRETS_OWNER`, `BANK_SIGNER_SECRETS_PROFILE` (`env.example`) |

## Limits

- Sandbox only. In production Noah runs the KYB of each company (or relies on ours under a
  partnership); the code refuses a chain or mode it does not know.
- Only Base settles: NEAR MPC verifies Base transactions for the vault; it does not verify Ethereum
  on testnet (`get_available_foreign_chains` on `v1.signer-prod.testnet`).
- One euro payout at a time per vault (the signer's answer is awaited before the next request).
- Noah's conversion fee (about 1 %) comes off the EURC amount: the IBAN receives the `fiat_amount`
  the signer reports, not the exact euros the agent named.
- OutLayer's TEE is the trust anchor for the partner key: its attestation is theirs to publish; the
  vault checks the WASM hash it voted, not the enclave quote.
