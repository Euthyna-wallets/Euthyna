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
| An agent of sealedprod1106 (`treasury-desk`, ceiling 50 EUR, 100 EUR a day, all voted) pays an IBAN that was not voted | refused by the vault: `BeneficiaryNotAllowed`; 70 EUR to the voted IBAN: `ERR_MAX_PER_PAYOUT` | `check_bank_payout` |
| The members vote the borrowed customer id of another account (`SetBankConfig`, proposal #21) and the agent pays | refused **in the enclave**: `the customer is not this vault's`; budget and reference given back | NEAR `FiG8TyWU8Aaswhf7SHKPLY9URLCMABjxphYkMugJF2QL` |
| With the vault's own customer (proposal #22), the agent pays 5 EUR to Atelier Dupont SAS (`FR76 3000 6000 0112 3456 7890 189`) | the enclave signs the partner's single-use rule `ba917604-…`; the vault queues 5 EURC; NEAR MPC signs it; the partner pays **4.78 EUR to the IBAN** | NEAR `fwwpChrpcwKewsBGLz7sF93o7UukUQc3qEC9FtSwBQC`, Base Sepolia `0x0eef2dd1f229f0f0d7731a383df2176426d6b8b7113a591046a186817010c8e6` |
| Sealed beneficiaries (proposal #25: new signer, box key, beneficiary #1 "Supplier A", sealed in the SDK as a browser does): the agent pays beneficiary #1 6 EUR; #2, never voted, is refused (`BeneficiaryNotAllowed`) | the enclave opens the envelope, checks the commitment and pays **5.73 EUR to the IBAN**; the vault's `bank:*` state, proposal #25, the agent's transaction with its OutLayer input and output hold no IBAN and no name (searched) | NEAR `DeZp8uT96RTWWFfHmiikZtEHEtXreUrSVf5nTAtqYgoF`, Base Sepolia `0xb5d30de698c77c53fe3d91acd30a190ed687d657ca1b319e451466d3c0e948a5` |

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
| Whose account | the partner customer is derived from the vault: `eut-` + 38 hex of sha256(vault account). The enclave refuses any other id, so a vault cannot pay out under another company's KYB by voting its customer id; the API opens accounts under the same id (`customerIdOf`) |
| What the signer does | `POST /transactions/sell/prepare` (the IBAN, the name, the reference, EURC → EUR) and `POST /workflows/onchain-deposit-to-payment-method` with a **single-use trigger**: this source address, exactly this amount, before this expiry (24 h), nonce = the payout id. It answers the deposit address and the rule id; it cannot widen anything the vault decided |
| The transfer | `on_bank_signer` builds `transfer(deposit, amount)` on the EURC token and queues it as a `Scheduled` operation of the agent's role (the role's delay applies above its threshold, the council can veto); the same worker that broadcasts voted transactions signs it through NEAR MPC and settles it. A refusal or a signer failure gives the budget, the membership use and the reference back |
| Agents | MCP `bank_payout` / `bank_status`; `mandate` shows the role's `bank` block (voted IBANs, ceiling, budget) |
| Members | Settings → suppliers (add or remove an IBAN by vote), Treasury → Euro payouts (enable, who may pay, history); Activity shows each payout as one row with its Base transaction |

### The IBAN is not public

Nothing on chain names the IBAN or its holder: not the vault's state, the DAO proposal, the agent's
transaction, the OutLayer input or output, nor the payout records. A member's browser seals the
beneficiary (`packages/sdk/src/bank-private.ts`) and our server never receives the IBAN either:

| On chain | What it is |
| --- | --- |
| `#1`, `Supplier A` | the beneficiary's number, and a public label the members choose (never a name) |
| `commitment` | sha256("euthyna-bank-beneficiary-v1" 0 vault 0 IBAN 0 holder 0 type 0 salt); the 32-byte random salt keeps an IBAN from being found by trying candidates |
| `sealed_for_signer` | X25519 to the enclave's box key, AES-256-GCM, the vault's account as associated data: only that enclave opens it, and only for this vault |
| `sealed_for_members` | the same beneficiary for the members' reading keys (derived from a signature of their own wallet, the sealed orders' scheme); the console checks it against the commitment |

The agent pays `bank_payout(beneficiary: 1, …)`. The vault forwards the envelope and the commitment;
the enclave opens the envelope, recomputes the commitment and pays only that IBAN, otherwise it
refuses (`the beneficiary is not the one the members voted`). Its output and its errors name neither
the IBAN nor the holder. The vault refuses an IBAN in clear (`ERR_BANK_CLEARTEXT_IBAN`), and voting
the box key or a sealed beneficiary erases the first version's clear records from its state.

Still public: the amount (an EURC transfer on Base), the reference (an invoice number, never
personal data) and that beneficiary #1 was paid. Past states stay on archival nodes: the IBAN used
on testnet before this change (`FR76 3000 6000 0112 3456 7890 189`, the standard example IBAN) is in
that history.

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
| Signer WASM | sha256 `e263a0e2eae2903d02f5f60e1a67c4ae5d9566b288f6158fe5d8f2f65c1475db`, on FastFS `https://test.fastfs.io/euthyna-ops.testnet/outlayer.testnet/e263a0e2…75db.wasm` (uploaded by `euthyna-ops.testnet`; `cargo build --release --target wasm32-wasip2` in `bank-signer/`) |
| Box key | `f0a6cacc113fe6c2f6f362e27f2399100a1320e34b88319f1892309c1b80b621` (X25519), from the enclave's `pubkey` output (sealedprod1106 proposal #23, OutLayer request 12660) |
| Secrets | profile `noah` of `euthyna-ops.testnet`, bound to that hash; access `And[Predecessor{Or[AccountPattern vaults, Whitelist[sealedprod1106 DAO]]}, WasmHash]` (NEAR `7egpNTpg…`; stored with access restricted to the owner, then narrowed); `PROTECTED_NOAH_SEED` generated in the enclave, never exported. The DAO is admitted only to read the public key: the code pays out for a vault only |
| Signer public key | read through sealedprod1106's DAO (proposal #23): `MFkw…m6FfBw==` (P-256), attached to a Noah sandbox API key that only this build can use |
| Earlier builds | `528edf86…` let a vault vote any partner customer id; `05ca8512…` took the IBAN in clear. Their secrets rows are deleted and their Noah keys are to be revoked, so a vault cannot vote those hashes back |
| Vault version | `7bFN1t7CoweQgV9mwQsxs3PvdNJSRbFok4U76G9AGUx` (`contracts/res/vault.wasm`, sha256 `01b03571e3c2d09bfaa8effac1593be6c30034e521f8d6714da36c9bf55fa6f9`), published on `euthyna-nomos.testnet` (NEAR `2rZcaGKCV4YPiUMGJin1CuBuN5qno7v5x311gykbXXbk`); `sealedprod1106` moved its code source to that Nomos by vote (`SetCodeSource`, proposal #15) and upgraded by vote (proposals #16, #18, #19, #24) |
| Console env | `BANK_SIGNER_URL`, `BANK_SIGNER_HASH`, `BANK_SIGNER_BOX_KEY`, `BANK_SIGNER_SECRETS_OWNER`, `BANK_SIGNER_SECRETS_PROFILE` (`env.example`) |

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
