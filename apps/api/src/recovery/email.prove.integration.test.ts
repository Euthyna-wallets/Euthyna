/**
 * ZK Email end to end in Node: emails signed with a test DKIM key (mailauth), proved with
 * the real circuit (noir_js + bb.js, as the browser does: zero-knowledge, Keccak transcript),
 * verified with the circuit's key. The recovery contract verifies the same proofs on chain
 * (contracts/tests/tests/email_recovery.rs). About 6 s per email.
 * ZK_EMAIL_PROVE=1 vitest run src/recovery/email.prove
 */
import { Barretenberg, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { EMAIL_RECOVERY_VK_BASE64, newSalt, PROOF_TARGET, readPublicInputs, recoverySubject } from "@euthyna/sdk/email-proof";
import { describe, expect, it } from "vitest";

import { proveEmail, signedEmail, testMailDomain } from "./test-mail.js";

const prove = process.env.ZK_EMAIL_PROVE === "1";

describe.skipIf(!prove)("ZK Email proofs, proved and verified for real", () => {
  it("proves a mailbox: same mailbox and salt give the same hash, and nothing can be swapped", async () => {
    const api = await Barretenberg.new({ threads: 2 });
    const verifier = new UltraHonkVerifierBackend(api);
    const verificationKey = Uint8Array.from(Buffer.from(EMAIL_RECOVERY_VK_BASE64, "base64"));
    const check = (evidence: { proof: string; publicInputs: string[] }) =>
      verifier.verifyProof({ proof: Uint8Array.from(Buffer.from(evidence.proof, "base64")), publicInputs: evidence.publicInputs, verificationKey }, { verifierTarget: PROOF_TARGET });
    try {
      const mail = testMailDomain();
      const salt = newSalt();
      const enrolled = await proveEmail(await signedEmail(mail, "Alice.Founder@mail.euthyna-test.dev", recoverySubject("enroll", "alice.testnet")), mail.record, salt);
      expect(await check(enrolled)).toBe(true);
      const stated = readPublicInputs(enrolled.publicInputs);
      expect(stated).toMatchObject({ domain: "mail.euthyna-test.dev", subject: "Euthyna enroll near:alice.testnet" });
      expect(BigInt(stated.salt)).toBe(BigInt(salt));

      // Changing a public input (another mailbox's hash) breaks the proof.
      const forged = { ...enrolled, publicInputs: enrolled.publicInputs.map((field, index) => (index === 37 ? `0x${"1".padStart(64, "0")}` : field)) };
      expect(await check(forged).catch(() => false)).toBe(false);

      // The same mailbox (any case) with the same salt: same hash. Another salt, or another mailbox: another hash.
      const again = await proveEmail(await signedEmail(mail, "alice.founder@mail.euthyna-test.dev", recoverySubject("recovery", "alice2.testnet")), mail.record, salt);
      expect(readPublicInputs(again.publicInputs).addressHash).toBe(stated.addressHash);
      const resalted = await proveEmail(await signedEmail(mail, "alice.founder@mail.euthyna-test.dev", recoverySubject("recovery", "alice2.testnet")), mail.record, newSalt());
      expect(readPublicInputs(resalted.publicInputs).addressHash).not.toBe(stated.addressHash);
      const bob = await proveEmail(await signedEmail(mail, "bob@mail.euthyna-test.dev", recoverySubject("recovery", "alice2.testnet")), mail.record, salt);
      expect(readPublicInputs(bob.publicInputs).addressHash).not.toBe(stated.addressHash);
    } finally {
      await api.destroy();
    }
  }, 400_000);
});
