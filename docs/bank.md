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
| After the veto window the API starts it, NEAR MPC signs it for the vault, the worker broadcasts it | 5 EURC received by the supplier (`0x1be62b8a…8e1d`): 19.71 → 24.71 | Base Sepolia `0xc45d7ea2a864c590e9f23eb2abfb173d0189eb4587f9abaddd15aa5b4c768470` (vault operation `f8643bfc…e027`, wallet nonce 8) |

## Limits

- Sandbox only. In production Noah runs the KYB of each company (or relies on ours under a
  partnership); the code refuses a chain or mode it does not know.
- Only Base settles: NEAR MPC verifies Base transactions for the vault; it does not verify Ethereum
  on testnet (`get_available_foreign_chains` on `v1.signer-prod.testnet`).
- Euros out to a bank (off-ramp) are not built.
