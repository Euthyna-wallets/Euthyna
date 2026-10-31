/**
 * Test-only helpers for ZK Email: a test mail domain with its own DKIM key, signed emails
 * (mailauth, an independent DKIM implementation), and proving as the browser does.
 * Never imported by the server.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { UltraHonkBackend } from "@aztec/bb.js";
import { circuitInputs, modulusFromDkimRecord } from "@mandateos/sdk/email-proof";
import { Noir } from "@noir-lang/noir_js";

const circuit = () => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../console/public/circuits/email_recovery.json"), "utf8")) as { bytecode: string };

/** A DKIM key for a test mail domain, and its DNS record. */
export function testMailDomain(domain = "mail.euthyna-test.dev", selector = "e2e") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  return { domain, selector, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string, record: `v=DKIM1; k=rsa; p=${p}`, name: `${selector}._domainkey.${domain}` };
}

/** An email as a mail provider sends it, DKIM-signed relaxed/relaxed. */
export async function signedEmail(mail: ReturnType<typeof testMailDomain>, from: string, subject: string): Promise<string> {
  const { dkimSign } = await import("mailauth/lib/dkim/sign.js") as unknown as { dkimSign: (input: string, options: unknown) => Promise<{ signatures: string; errors: unknown[] }> };
  const message = [
    `From: Founder <${from}>`, "To: me@example.org", `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}@${mail.domain}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", "Recovery email for Euthyna.", "",
  ].join("\r\n");
  const signed = await dkimSign(message, { canonicalization: "relaxed/relaxed", signatureData: [{ signingDomain: mail.domain, selector: mail.selector, privateKey: mail.privateKey, algorithm: "rsa-sha256", canonicalization: "relaxed/relaxed" }] });
  if (signed.errors?.length) throw new Error(JSON.stringify(signed.errors));
  return signed.signatures + message;
}

/** What the browser does: build the inputs with the domain's key, prove. */
export async function proveEmail(eml: string, record: string) {
  const compiled = circuit();
  const { inputs, selector } = circuitInputs(eml, modulusFromDkimRecord(record));
  const { witness } = await new Noir(compiled as never).execute(inputs as never);
  const proof = await new UltraHonkBackend(compiled.bytecode, { threads: 2 }).generateProof(witness);
  return { proof: Buffer.from(proof.proof).toString("base64"), publicInputs: proof.publicInputs, selector };
}

