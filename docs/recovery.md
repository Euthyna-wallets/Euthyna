# Founder seat recovery (ZKPassport)

A founder who loses their NEAR account gets their DAO seat back through the other founders' vote. The new
account proves, with ZKPassport, that it holds the same passport or ID card the founder enrolled. Nothing
changes a seat by itself.

## Flow

1. **Enroll** (Settings → Seat recovery). The founder scans a QR code with the ZKPassport app. The proof is
   bound to `near:<founder account>` and made for the scope `euthyna-recovery`. The API verifies it and keeps
   `sha256("euthyna-recovery:" + uniqueIdentifier)` plus the proofs, which are public and can be re-verified.
   It never keeps a name, a number or a birth date. Re-enrolling replaces the old proof, for example after a
   renewed passport.
2. **Ask** (`/recover`, signed in with the new account). The person gives the DAO and the lost account and
   proves their ID again. This time the proof is bound to `near:<new account>`, so it cannot be reused by
   anyone else. The API checks that it is the enrolled ID.
3. **Wait.** For `RECOVERY_DELAY_SECONDS` (48 h by default), the holder of the "lost" account can cancel. This
   covers a stolen passport: the real founder still has their key.
4. **Vote.** After the wait, any member can submit the two usual votes: the DAO policy (members) and the vault
   council (`SetCouncil`, with its veto window). Before voting, each member can press **Check the proofs on
   Ethereum Sepolia**. Their browser asks ZKPassport's verifier contract directly (`verifyProof`,
   `0xDDeFf76024052D26B78A7Fac66FFbd6fbc5bd9Ad`), so they do not have to trust Euthyna's server.

## Trust and limits

- **Verification on Euthyna's server.** The proofs are verified with the SDK's local verifier, never
  ZKPassport's API, against the certificate and circuit registries on Ethereum Sepolia. No NEAR contract
  verifies ZKPassport proofs, and NEAR MPC's foreign transaction check does not cover Ethereum Sepolia. The
  vote, the waiting period and the members' own on-chain check are what make it safe.
- **Testnet uses dev mode.** Only ZKPassport's mock IDs (issuer ZKR) are accepted there. They all share the
  identifier `1`, so on testnet any mock ID matches any enrolled mock ID; the waiting period and the vote still
  apply. Turn `ZKPASSPORT_DEV_MODE` off on mainnet.
- **Known gaps (from Safe's research).**
  - There is no liveness check: someone holding the founder's stolen passport can prove. This is why the
    waiting period, the cancel and the vote exist.
  - A renewed document gets a new identifier: enroll again.
  - A person with two passports counts twice.

## Tested

| What | How |
| --- | --- |
| Enroll, ask, wrong ID, proof bound to another account, cancel by the founder, too early, the votes drafted, done when the DAO changed | `apps/api/src/recovery/service.integration.test.ts` (PostgreSQL) |
| Proofs must be bound to the account in both the query and the proved result | `apps/api/src/recovery/passport.test.ts` |
| A real proof from the ZKPassport app goes through the real verifier, and is refused for another account and outside dev mode | `apps/api/src/recovery/passport.proof.integration.test.ts` (`ZKPASSPORT_PROOF`, `ZKPASSPORT_ACCOUNT`) |
| Replacing a founder on testnet: DAO policy and vault council, voted 2 of 3 | `e2e-buyer-73429`: `eut-third` replaced by `eut-newthird`, then `council` on `e2e-buyer-73429.nomos.euthyna.testnet` |
