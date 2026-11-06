/**
 * Proofs for the recovery contract's sandbox tests (contracts/tests/tests/email_recovery.rs):
 * emails from a test mail domain, signed with its own DKIM key (mailauth), proved as the
 * browser does. Run again after the circuit changes:
 *   pnpm --filter @euthyna/api exec tsx scripts/email-recovery-fixtures.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { dkimKeyHash, modulusFromDkimRecord, newSalt, publicInputBytes } from "@euthyna/sdk/email-proof";

import { dkimKeys } from "../src/recovery/email.js";

import { proveEmail, signedEmail, testMailDomain } from "../src/recovery/test-mail.js";

const out = resolve(import.meta.dirname, "../../../contracts/tests/tests/fixtures/email-recovery");
mkdirSync(out, { recursive: true });
const mail = testMailDomain("mail.euthyna-test.dev", "fixture");
const salt = newSalt();
const otherSalt = newSalt();
const founder = "Alice.Founder@mail.euthyna-test.dev";
const cases: Array<[string, string, string, string]> = [
  ["enroll_alice", founder, "Euthyna enroll near:alice.test.near", salt],
  ["recovery_bob", founder, "Euthyna recovery near:bob.test.near", salt],
  ["recovery_bob_other_mailbox", "mallory@mail.euthyna-test.dev", "Euthyna recovery near:bob.test.near", salt],
  ["recovery_bob_other_salt", founder, "Euthyna recovery near:bob.test.near", otherSalt],
];
const modulus = modulusFromDkimRecord(mail.record);
const files: Record<string, unknown> = { domain: mail.domain, modulus_hex: modulus.toString(16), key_hash: await dkimKeyHash(modulus) };
for (const [name, from, subject, caseSalt] of cases) {
  const started = Date.now();
  const proof = await proveEmail(await signedEmail(mail, from, subject), mail.record, caseSalt);
  files[name] = { proof: proof.proof, public_inputs: Buffer.from(publicInputBytes(proof.publicInputs)).toString("base64") };
  console.log(`${name}: proved in ${Date.now() - started} ms`);
}
// A real email (iCloud, from zk-email's test data) signed with iCloud's real DKIM key.
const icloudEml = readFileSync(resolve(import.meta.dirname, "../src/recovery/fixtures/icloud-hello.eml"), "latin1");
const [icloudRecord] = await dkimKeys()("icloud.com", "1a1hai");
if (!icloudRecord) throw new Error("iCloud's DKIM key (selector 1a1hai) was not found");
const icloud = await proveEmail(icloudEml, icloudRecord, newSalt());
writeFileSync(resolve(import.meta.dirname, "../src/recovery/fixtures/icloud-hello.proof.json"), `${JSON.stringify(icloud, null, 2)}\n`);
files.icloud_hello = { proof: icloud.proof, public_inputs: Buffer.from(publicInputBytes(icloud.publicInputs)).toString("base64") };
writeFileSync(resolve(out, "proofs.json"), `${JSON.stringify(files, null, 2)}\n`);
console.log(`wrote ${resolve(out, "proofs.json")}`);
process.exit(0);
