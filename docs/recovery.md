# Founder seat recovery (ZK Email, verified on NEAR)

A founder who loses their NEAR account gets their DAO seat back through the other founders' vote. The new
account proves, with a zero-knowledge proof of an email, that it controls the mailbox the founder enrolled.
The proof is verified **on chain**, by the recovery contract; no Euthyna server is in the path. Nothing changes
a seat by itself: the DAO's vote does.

| | |
| --- | --- |
| Contract | [`contracts/email-recovery`](../contracts/email-recovery), deployed at `euthyna-recovery-v4.testnet` with **no access key** (keeper `mandateos.testnet`, 600 s); the first deployment, `euthyna-recovery.testnet` (no cooldown after a cancel), is no longer used |
| Circuit | [`circuits/email-recovery`](../circuits/email-recovery) (Noir 1.0.0-beta.26, bb.js 5.3.0, zero-knowledge proofs) |
| Verifier | zkVerify's UltraHonk verifier v0.4.0 ([`contracts/vendor/ultrahonk-no-std`](../contracts/vendor)), on NEAR's BN254 host functions |
| Cost | about **85 Tgas** per enrollment or request (proof verified in the call), a few seconds to prove in Node, about 40 s in a browser on one thread |

## Flow

1. **Enroll** (Settings → Seat recovery, signed in with the founder's wallet).
   - The founder sends themself an email with the subject `Euthyna enroll near:<founder account>` and drops its
     source (or `.eml`) in the page.
   - The browser picks a random **salt**, and proves with the circuit that the mail provider signed the email (DKIM).
     The proof reveals the DKIM key, a **salted** hash of the sender address, the sender domain and the subject.
   - The founder signs `enroll(dao_id, proof, public_inputs)` on the contract. The contract checks that the subject
     names the caller, that the DKIM key is in its registry for that domain, and **verifies the proof**. It stores
     the salt, the hash and the domain. The email never leaves the browser.
2. **Ask** (`/recover`, signed in with the new account). The browser reads the enrollment's salt from the contract,
   and proves a second email from the same mailbox, subject `Euthyna recovery near:<new account>`, with that salt.
   The new account signs `request(dao_id, lost_account_id, proof, public_inputs)`. The contract verifies the proof
   and that the hash and salt are the enrolled ones, and opens a recovery.
3. **Wait.** Until the waiting period ends, the lost account can call `cancel(dao_id)`. This is the answer to a mailbox
   takeover: the real founder still has their key. The contract enforces the delay, not a server.
4. **Vote.** Once the contract says the recovery is `ready`, any member submits the two usual votes: the DAO policy
   (members) and the vault council (`SetCouncil`, with its veto window). The console drafts them through the API,
   which refuses before the contract says `ready`; the founders approve them in their DAO as any other proposal.
   (The testnet run below votes on a plain Sputnik DAO, without a vault, with `AddMemberToRole` and `RemoveMemberFromRole`.)

## What is public

Every transaction is public, so the proof's public inputs are too:

| Public | Why it is acceptable, or not |
| --- | --- |
| The DKIM key and the sender domain (`gmail.com`) | The contract needs them to check the key. A custom domain reveals it: use a common provider. |
| The salted hash of the address | The salt is chosen at enrollment and public, so precomputed tables of addresses do not work; someone who already guesses the exact address can still check that guess against the hash. |
| The subject (`Euthyna recovery near:<new account>`) | The new account is public anyway. |
| The proof itself | **Zero-knowledge** (bb 5's ZK UltraHonk): it reveals nothing about the email beyond the public inputs. |

Earlier versions used bb.js 0.84, whose proofs are not zero-knowledge ("plain" UltraHonk, no witness privacy), and
kept them in the API's database. Those tables are no longer written; the old proofs never went on chain.

## What the circuit proves

`circuits/email-recovery/src/main.nr` is built on [zkemail.nr](https://github.com/zkemail/zkemail.nr) v2.0.0 (audited),
patched for Noir 1.0.0-beta.26 in [`circuits/vendor`](../circuits/vendor) (the diff is there, the DKIM logic is unchanged).
It checks the 2048-bit RSA DKIM signature over the signed headers (the key is a public input), that `From` and
`Subject` are real header fields, and that the address is well formed. It outputs the Pedersen hash of the lowercased
address with its length and the salt, the domain after the last `@`, and the subject.

## DKIM keys

The contract accepts a key only if its registry has it for the email's domain (`dkim_keys(domain)`). The keeper
adds and removes keys (`add_dkim_key(domain, modulus_hex)`); it can do nothing else: no enrollment, no recovery,
no upgrade (the contract has no upgrade method and no access key).

- **On testnet the keeper is `euthyna-dkim-keeper.testnet`, a plain account held by the Euthyna team.** On mainnet it
  is meant to be a DAO. A key the keeper adds wrongly would let someone who guesses a founder's address forge a
  request for that domain: the 48 h window and the founders' vote are still in the way, and every key is public
  and can be checked against DNS.
- Registered on 2026-11-04 (current keys from DNS over HTTPS, else ZK Email's archive): Gmail and Googlemail
  (`20251104`, `20260707`), Outlook (`selector1`, `selector2`), Hotmail and Live (`selector1`), iCloud and me.com
  (`1a1hai`), Yahoo (`s2048`), Proton (`protonmail`, `protonmail2`, `protonmail3`), and the test domain
  `mail.euthyna-test.dev` used by the end-to-end run.
- **Testnet only: `yopmail.com` (selector `dkim`, key hash `ad8e8df3…5a1d`, tx `EcNyQ8ZmSu2NstziSSbD3AwTYSerDgeUoz8crhA2vfe8`)**,
  so judges can try the flow with a throwaway inbox. A YOPmail inbox has no password: anyone who knows the address can
  open it and send from it, so it proves nothing about who holds it. **It must never be registered on mainnet**, nor
  any other public or disposable inbox (Mailinator, temp-mail…). The console warns when a founder enrolls with one.

### Before mainnet

- Deploy a new contract with a 48 hour delay and a DAO as keeper.
- Register only providers where a mailbox needs a password; no `yopmail.com`, no test domain.
- Providers rotate keys: when an email is signed with a key the contract does not know, the console says so before
  proving.

## On testnet

The table below is the first deployment, `euthyna-recovery.testnet`. The API and the console now use
`euthyna-recovery-v4.testnet` (code hash `23BJWfFWycL71niKjgvhcMbrXGeH3QPGxroao3FTuZVm`, the current
`contracts/res/email_recovery.wasm`), unless `RECOVERY_CONTRACT_ID` says otherwise. Enrollments do not carry
over: a founder enrolled on the first contract enrolls again.

| Step | Result | Transaction |
| --- | --- | --- |
| Create `euthyna-recovery.testnet` (temporary key, testnet faucet), then deploy + `new(keeper, 600 s)` + delete the key in one transaction | 0 access keys; code hash `Eg1Ht4oYrNVjDVaqgsGrwPgsev1ZsbfzMr4HPd5uRhPa` = base58(sha256 of `contracts/res/email_recovery.wasm`, the pinned-image build) | `9TQFJBzjXRJ1iEsqGmNJzBcw2UeqCcH6E1h1dmLN7x3g` |
| The keeper registers the providers' DKIM keys | 16 keys, then `yopmail.com` (testnet only), 2.7 Tgas each | e.g. Gmail `20251104`, test domain `6Dofwp7ib57XkodvMAwe9ieSt5AS5rMYGYqmo2y8J8go` |
| A DAO with three founders | `eut-rec-11526.sputnikv2.testnet`: alice, carol, dave | `4bVFtqLTzG43EvtoHVs7VdgM35nRE5S89bcBqeZa6WJz` |
| Alice enrolls (proof verified in the call) | 85.3 Tgas | `6Cgo1kQcuqfSShZz5ohYHGhfpzLvu98WajdinoxEoFBP` |
| Bob asks with another mailbox | refused, `ERR_DIFFERENT_MAILBOX` | |
| Bob asks with Alice's mailbox | waiting, 85.4 Tgas | `3AGASXfh7gZjagzppF5xEqG9YZgvtw24ED7A2mjZVoFd` |
| Alice cancels | cancelled | `AzTYMheLPMcmLA5nCVUS2XqQfSDRrSiJh1ZS5NupFNri` |
| Bob asks again; nobody cancels for 10 minutes | waiting, then `ready` (a vote drafted before that is refused: `too_early`) | `4T4dcaZkUBpRifivsuYRGRMGah7h6ACrsTTjGm7Ugp4b` |
| The contract says `ready`; the founders vote: proposal #0 adds Bob to the council (carol, dave approve), proposal #1 removes Alice (carol, dave, then Bob) | council: dave, carol, bob | #0 approved by dave `HTiBKYnUpeFc9akZUwdzsjJaS4zUHSy4DL4AP4cYYpPi`; #1 `94yEsKwZYNQYZ2djCLXbfnLFMzVdudd5Wv1uT7DaysNW`, approvals `EKumk9CZsmca2Byanmc7kXYemFaCKDx8ZuDkWuoHPiY`, `Avvrp1hnGb7hSMEp6br8h1CiBKjXhKPzPHNFyTciZuWz`, `Ge8XWpzTGL6gTru9MiEyyxfFHA6KJDiC8GSJSXvTnfmr` |
| A proof made in Chromium by the console's own code (`proveEmailFile`) | `verify_proof` → `true` on `euthyna-recovery.testnet` | view call |

The testnet contract waits **10 minutes** so the whole flow can be tried in one sitting; the mainnet contract is meant to wait 48 hours.
Re-run: `KEYS=<dir> DAO=<dao> pnpm --filter @euthyna/api exec tsx scripts/recovery-testnet-e2e.ts enroll|request|cancel|status|vote`.

## Tested

| What | How |
| --- | --- |
| The contract with real proofs: only the keeper manages keys, the SDK and the contract hash keys the same way, an unknown key, a proof used by another account, a flipped public input, another mailbox, another salt, a second open request, cancel by someone else, cancel by the founder, ready after the delay | `contracts/tests/tests/email_recovery.rs` (NEAR sandbox; proofs from `apps/api/scripts/email-recovery-fixtures.ts`) |
| A real iCloud email, signed with iCloud's real DKIM key, proved and verified on chain | same file, `a_real_icloud_email_proof_verifies_on_chain` |
| The circuit and the SDK in Node: zero-knowledge proof verifies, a forged input does not, same mailbox and salt give the same hash, another salt or mailbox does not | `apps/api/src/recovery/email.prove.integration.test.ts` (`ZK_EMAIL_PROVE=1`) |
| What the API reads from the contract and when it drafts the vote | `apps/api/src/recovery/service.test.ts` |

## Limits

- **Mailbox takeover is the main risk.** The cancel window and the founders' vote are the defence; a second
  factor should come later.
- **The provider must sign with its own domain** (`d=` equal to the `From` domain). Gmail, Outlook and iCloud do
  this; relays that rewrite headers break the signature. Only 2048-bit RSA keys.
- **The keeper is a single testnet account** (see DKIM keys), and the testnet registry accepts `yopmail.com`, a public inbox: testnet only.
- The vendored zkemail.nr patch and the NEAR pairing patch are not audited.
