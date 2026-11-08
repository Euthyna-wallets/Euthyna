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

### Invoices

The company issues an invoice (Treasury → Invoices): a number (`INV-2026-0001`), a creditor reference
(ISO 11649, `RF…`, unique across companies) and a SEPA QR code (EPC069-12, the "GiroCode") that any
European banking app scans to fill the IBAN, the amount and the reference. Print it as PDF from the
console. The customer pays by SEPA; the bank partner reports the reference with the deposit (its
`FiatDeposit` webhook, signed with ECDSA P-384 and verified with the partner's key: anything unsigned
or forged is refused, and a reference only counts on the invoice's own company account). The
invoice turns **paid** once the euros are in the company wallet as EURC, with the Base hash: the
partner's transfer to the wallet carries the deposit as its orchestration (`RuleExecutionID`). A
partial payment leaves it open. CSV export for the accountant. Invoices live in our database
(`invoice`), not on chain.

Set up once: in the Noah dashboard (API → Webhooks → Create), URL `https://euthyna.io/v1/webhooks/noah`,
event `FiatDeposit`. In the sandbox, "Simulate payment" pays an invoice with its reference.

| Step (Noah sandbox, sealedprod1106, 2026-11-07) | Result | Proof |
| --- | --- | --- |
| Issue `INV-2026-0002`, 18 EUR | reference `RF21INV2026000246EF79`, SEPA QR `BCD/002/1/SCT/CFTEMTM1XXX/…/MT04CFTE19870000000090010358482/EUR18.00//RF21INV2026000246EF79/` | `scripts/invoice-sandbox-e2e.ts` |
| The customer pays it by SEPA with the reference | paid in about 15 s: **17.66 EURC** in the company wallet (`0x8b22…9de6`), the invoice shows the hash | Base Sepolia `0x5ac9127b430b3f6988a615c5d5d8070128937487d04be5e342b721daace0c280` |

### Payroll and remittances

**Any rail.** A beneficiary can be on any payout rail of the partner, still sealed: SEPA (EUR),
Pix (Brazil, BRL), ACH (US, USD), Faster Payments (UK, GBP). The console fills the partner's payout
form for that rail (`RAILS` in `bank-private.ts`); the envelope carries the partner's channel and
that form, and the commitment covers both (v2: sha256 over the vault, the channel, the form as
canonical JSON and the salt). The enclave sends the form as is and redacts every value from its
errors. The company pays in EURC; the partner converts to the payee's currency.

**Standing orders.** The members vote once: "beneficiary #2, 2 400 EUR, every 30 days, from the 28th,
12 times" (`AddStandingOrder`). On each date anyone may call `run_standing_order` (the API's keeper
does, with the voted transactions); the vault pays exactly that beneficiary and amount, with no agent
and no role budget: the vote is the authorisation. A failed run goes back to its date; removing the
beneficiary cancels its orders; `RemoveStandingOrder` stops one. Console: Treasury → Payroll.

What stays public: the amounts (EURC transfers on Base), the dates, the payee's number and label.
Not public: who is paid, their account, their name.

| Step (sealedprod1106, 2026-11-07) | Result | Proof |
| --- | --- | --- |
| Members vote the multi-rail signer and three sealed payees: #2 SEPA (Supplier A), #3 Pix (Contractor BR), #4 UK (Employee UK) (proposal #28) | the vote holds no account, name or Pix key (searched) | NEAR `AtRL56Fr…`, `AxyE2d7L…`, `E9H21SVh…` |
| **Remittance**: the agent pays beneficiary #3 8 EUR | the enclave opens the Pix payee; the partner pays **74.92 BRL by Pix** | NEAR `55asfnwkUuYhSpVHUAz6vfNfAi1VwcNxxm8knFQUX5wz`, Base Sepolia `0x52c92ea608e46dbf81a20b6ffac8015fe60941c14cb252e31a79e23900e4fd38` |
| A payroll order to #4 (UK) runs | the partner refuses: its UK channel is not open for this sandbox customer (`channel policy denied`); nothing leaves, the order goes back to its date | NEAR `AhEAMQ8w8QujufmzgUCvR3wnr8syeXmKia2aiwcSqgXf` |
| **Payroll**: the members vote "beneficiary #2, 3 EUR every 10 minutes, twice" (proposal #30); on its date anyone runs it | the vault pays without an agent or a new vote; the partner pays **2.87 EUR by SEPA**; the order moves to its next date | NEAR `DoqJPecfqL17M79cTynbo8CfKZ2b9fdZ25Q6Lf3GyVgR`, Base Sepolia `0xac6cee06e326fcf1dde882e259c7b9c83703a3999265d5c61c08263c532c282c` |
| Ten minutes later, its second and last run | paid again (2.87 EUR by SEPA); the order is done and leaves the list | NEAR `7LVAzz4b1cuzMPuwqbnYkQDXJQXiQSuRc8eyMXBptDd9`, Base Sepolia `0x5d129ca66caa25066fad9650e3361aab80995a2e7474ec689465cd0399a28005` |

### What the vault guarantees, and what it does not

- Guaranteed on chain: no IBAN outside the voted list, no amount above the ceiling or the budget,
  no reference twice, no payout while the role is disabled or the vault paused. These are the
  vault's checks, before the signer is even called.
- Guaranteed by the enclave: the partner's API key answers only to a vault's call with the exact
  WASM the members voted (`signer_hash`); nobody, including us, can use it from a laptop. Changing
  the signer code means a new hash, which a vault takes only by a vote or, if it follows the
  enclave project, after its veto window (below).
- Not guaranteed: the partner's execution (Noah pays the IBAN off chain; the vault sees its own
  EURC leave and the partner's rule id), and the partner's own honesty. The audit trail is the vault
  payout record, the OutLayer execution and the partner's transaction.

### Enclave updates: one vote, or none with a veto window

The enclave runs from an OutLayer **project** (`euthyna-ops.testnet/bank-signer`). The project's
secrets row is shared by its versions and locked to the builds it names, so a fixed enclave keeps
its generated seed: the same partner key, the same box key, no beneficiary to seal again. The vault
still runs exactly one hash: OutLayer is called with `Project { project_id, version_key: signer_hash }`.

- `SetBankSignerSource { project, follow }` (voted once). With `follow`, anyone may call
  `follow_bank_signer()`: the vault reads the project's active version and queues it as an
  ordinary `SetBankConfig` rule, so it applies after the vault's rule delay unless a council member
  vetoes it. A version is queued once: a vetoed one does not come back. The keeper calls it.
- Without `follow`, each version is a vote, as before.
- Release: build, upload, `outlayer deploy bank-signer <url>`, then
  `node bank-signer/scripts/sandbox-twice.mjs` (each rail paid **twice** to the same payee against
  the partner's sandbox: the check that would have caught the Pix bug), admit the new hash next to
  the old one (`update_access`), and drop the old one once the vaults run the new one.

Proof on sealedprod1106 (2026-11-08): vault `f8b6bebb…` (proposal #38); enclave 0.2.0 `e11f11df…`
from the project, payees resealed, `follow` on (proposal #39); Pix paid twice to the same payee
(`DAhG79sZ…`, `DuhwL86p…`, 46.93 BRL each) and SEPA once (`548ZoeUn…`, 4.78 EUR). Then 0.2.1
`6b0d3046…` activated in the project: `follow_bank_signer` queued it with no vote (`GStmvBGe…`),
applied after the 5-minute window (`Fn2TA9Yb…`), and Pix paid a third time with the same partner
key and the same sealed payee (`HuQaXsrj…`, 48.25 BRL).

The Pix bug it fixed: the partner saves a payee on its first payout, then refuses its form
("selected payment method does not belong to declared self", then 500). The enclave now lists the
customer's saved methods (signed GET with `queryParams`) and names a saved Pix payee by its
`PaymentMethodID`; a bank payee keeps its form (it carries the payout's reference) and falls back
to its saved method.

### Deployment (testnet)

| | |
| --- | --- |
| Signer WASM | 0.2.1, sha256 `6b0d3046c32a15404f2512d660c3fd613f76909109c950866d309436c4442130`, on FastFS `https://test.fastfs.io/euthyna-ops.testnet/outlayer.testnet/6b0d3046…2130.wasm`, active version of project `euthyna-ops.testnet/bank-signer` (`cargo build --release --target wasm32-wasip2` in `bank-signer/`) |
| Box key | `c5c6d26b84243488ef3b2f0efef3c05d4d99e45aa530e13e35f09bf06877bc66` (X25519), from the enclave's `pubkey` output (sealedprod1106 proposal #26) |
| Secrets | profile `noah` of project `euthyna-ops.testnet/bank-signer`, locked to the build: access `And[Predecessor{Or[AccountPattern vaults, Whitelist[sealedprod1106 DAO]]}, WasmHash 6b0d3046…]` (both hashes during the 0.2.0 → 0.2.1 switch, then only the new one); `PROTECTED_NOAH_SEED` generated in the enclave, never exported, kept across versions. The DAO is admitted only to read the public key: the code pays out for a vault only |
| Signer public key | read through sealedprod1106's DAO (proposal #37): `MFkw…nod5Q==` (P-256), attached to a Noah sandbox API key; box key `41ae950e…`. Both stay the same for the project's next versions |
| Earlier builds | `528edf86…` let a vault vote any partner customer id; `05ca8512…` took the IBAN in clear; `e263a0e2…` paid SEPA only; `40db3075…` paid a Pix payee only once. Their secrets rows are deleted and their Noah keys to revoke, so a vault cannot vote those hashes back |
| Vault version | `F4BZbfghE6CY6qQDU5pQZyBUspN3vKSAZYob3DLjnGML` (`contracts/res/vault.wasm`, sha256 `d0d44d4ab01edd864b1264dca97e67a13eab1017a1767ea1bc78c62297319c3f`), published on `euthyna-nomos.testnet` (NEAR `CxhAFbNeKvuu4BM48MD76qFHfDJsdHj625QeDwdTZL1R`); `sealedprod1106` moved its code source to that Nomos by vote (`SetCodeSource`, proposal #15) and upgraded by vote (proposals #16, #18, #19, #24, #27) |
| Console env | `BANK_SIGNER_URL`, `BANK_SIGNER_HASH`, `BANK_SIGNER_BOX_KEY`, `BANK_SIGNER_SECRETS_OWNER`, `BANK_SIGNER_SECRETS_PROFILE`, `BANK_SIGNER_PROJECT` (`env.example`) |

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
