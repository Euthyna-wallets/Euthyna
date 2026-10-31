/**
 * ZK Email end to end in Node: emails signed with a test DKIM key (mailauth), proved with
 * the real circuit (noir_js + bb.js, as the browser does), verified by EmailVerifier.
 * Proving takes about 40 s per email. ZK_EMAIL_PROVE=1 vitest run src/recovery/email.prove
 */
import { recoverySubject, type RecoveryAction } from "@mandateos/sdk/email-proof";
import { describe, expect, it } from "vitest";

import { EmailVerifier, emailIdentityHash, dkimKeys } from "./email.js";
import { proveEmail, signedEmail, testMailDomain } from "./test-mail.js";

const prove = process.env.ZK_EMAIL_PROVE === "1";

describe.skipIf(!prove)("ZK Email proofs, proved and verified for real", () => {
  it("accepts the mailbox's email for its account and action, and nothing else", async () => {
    const mail = testMailDomain();
    const verifier = new EmailVerifier(dkimKeys({ testKeys: { [mail.name]: mail.record } }));
    const action: RecoveryAction = "enroll";
    const eml = await signedEmail(mail, "Alice.Founder@mail.euthyna-test.dev", recoverySubject(action, "alice.testnet"));
    const evidence = await proveEmail(eml, mail.record);

    const verified = await verifier.verify(evidence, "alice.testnet", "enroll");
    expect(verified.method).toBe("email:mail.euthyna-test.dev");
    expect(verified.identityHash).toMatch(/^[0-9a-f]{64}$/);
    // Bound to one account and one action.
    await expect(verifier.verify(evidence, "mallory.testnet", "enroll")).rejects.toMatchObject({ code: "email_not_bound" });
    await expect(verifier.verify(evidence, "alice.testnet", "recovery")).rejects.toMatchObject({ code: "email_not_bound" });
    // A key the domain does not publish.
    const other = testMailDomain();
    await expect(new EmailVerifier(dkimKeys({ testKeys: { [other.name]: other.record } })).verify(evidence, "alice.testnet", "enroll")).rejects.toMatchObject({ code: "dkim_key_unknown" });
    // Changing a public input (another mailbox's hash) breaks the proof.
    const forged = { ...evidence, publicInputs: evidence.publicInputs.map((field, index) => (index === 36 ? `0x${"1".padStart(64, "0")}` : field)) };
    await expect(verifier.verify(forged, "alice.testnet", "enroll")).rejects.toMatchObject({ code: "email_proof_invalid" });

    // The same mailbox (any case), another email: same identity. Another mailbox: another identity.
    const again = await proveEmail(await signedEmail(mail, "alice.founder@mail.euthyna-test.dev", recoverySubject("recovery", "alice2.testnet")), mail.record);
    expect((await verifier.verify(again, "alice2.testnet", "recovery")).identityHash).toBe(verified.identityHash);
    const bob = await proveEmail(await signedEmail(mail, "bob@mail.euthyna-test.dev", recoverySubject("recovery", "alice2.testnet")), mail.record);
    expect((await verifier.verify(bob, "alice2.testnet", "recovery")).identityHash).not.toBe(verified.identityHash);
    expect(emailIdentityHash("00")).not.toBe(verified.identityHash);
  }, 400_000);
});
