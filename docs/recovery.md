# Founder seat recovery (ZK Email)

A founder who loses their NEAR account gets their DAO seat back through the other founders' vote. The new
account proves, with a zero-knowledge proof of an email, that it controls the same mailbox the founder enrolled.
Nothing changes a seat by itself.

## Flow

1. **Enroll** (Settings → Seat recovery).
   - The founder sends themself an email with the subject `Euthyna enroll near:<founder account>`, downloads
     it (`.eml`) and drops it in the page.
   - The browser proves, with the Noir circuit `circuits/email-recovery`, that the mail provider signed it
     (DKIM). The proof reveals only a hash of the sender address, the sender's domain and the subject.
   - The API verifies the proof, checks that the DKIM key is the one the domain publishes, and keeps
     `sha256("euthyna-email:" + address hash)` with the proof.
   - The email never leaves the browser.
2. **Ask** (`/recover`, signed in with the new account). The person proves a second email from the same
   mailbox, with the subject `Euthyna recovery near:<new account>`. The subject binds the proof to that
   account, so nobody else can reuse it.
3. **Wait.** During `RECOVERY_DELAY_SECONDS` (48 h by default), the holder of the "lost" account can cancel.
   This is the answer to a mailbox takeover: the real founder still has their key.
4. **Vote.** Any member submits the two usual votes: the DAO policy (members) and the vault council
   (`SetCouncil`, with its veto window). Before voting, **Check the proofs in my browser** verifies both proofs
   with the circuit's verification key. It also shows whether the two proofs come from the same mailbox
   (same address hash).

## What the circuit proves

`circuits/email-recovery/src/main.nr` is built on [zkemail.nr](https://github.com/zkemail/zkemail.nr) v2.0.0,
which is audited. It checks:

- the 2048-bit RSA DKIM signature over the signed headers; the key is a public input;
- that the `From` and `Subject` fields are real header fields;
- that the address is well formed.

It outputs:

- a Pedersen hash of the lowercased address, packed 31 bytes per field;
- the domain after the last `@`;
- the subject.

The API accepts the DKIM key only if the domain publishes it: through DNS, then DNS over HTTPS, then
[ZK Email's archive](https://archive.zk.email) for keys a provider has rotated. So a key from another domain
cannot vouch for a Gmail address.

Size: 275,542 gates (UltraHonk, bb.js 0.84.0, Noir 1.0.0-beta.5). Proving takes about 40 s in Node with 2
threads, and about 60 s in a headless browser with 1 thread. Verifying takes under a second with the key.

To rebuild: `node circuits/email-recovery/build.mjs` (needs `nargo` 1.0.0-beta.5). It writes
`apps/console/public/circuits/email_recovery.json` and `packages/sdk/src/email-recovery-vk.ts`.

## Trust and limits

- **No NEAR contract verifies the proof.** The API verifies it, every member can verify it again in their
  browser, and the vote decides.
- **Mailbox takeover is the main risk.** The 48 h cancel window and the founders' vote are the defence, and a
  second factor should come later.
- **The provider must sign with its own domain** (`d=` equal to the `From` domain). Gmail, Outlook and iCloud
  do this; relays that rewrite headers break the signature.
- **The address hash is not salted.** Someone who guesses an address can check it against a stored hash. It
  is never published on chain.
- **Testnet test domains.** On testnet, `RECOVERY_TEST_DKIM_KEYS` lets tests sign their own emails for test
  domains. It is ignored on mainnet.

## Tested

| What | How |
| --- | --- |
| Enroll, ask, wrong mailbox, proof bound to another account or action, cancel by the founder, too early, the votes drafted, done when the DAO changed | `apps/api/src/recovery/service.integration.test.ts` (PostgreSQL) |
| The real circuit and the verifier. Emails are signed by mailauth, an independent DKIM implementation, and proved as the browser does. Checked: another account, another action, a key the domain does not publish, a tampered public input, the same mailbox in another case, another mailbox | `apps/api/src/recovery/email.prove.integration.test.ts` (`ZK_EMAIL_PROVE=1`) |
| A real iCloud email: our header canonicalization matches its DKIM signature, and it is proved and verified | `apps/api/src/recovery/email.test.ts`, fixture from zk-email's test data |
| In a browser (Chromium, production build) against NEAR testnet: the founder enrolls, another mailbox is refused, the new account asks, a member checks the proofs in their browser and submits the votes, two founders approve, and the DAO's council changes on chain | Run of 2026-10-31 on `e2e-buyer-73429.sputnikv2.testnet`: `eut-newthird` replaced by `eut-fourth` (DAO proposals #3 and #4) |
