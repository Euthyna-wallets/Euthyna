/**
 * ZK Email verification for seat recovery. The browser proves, with the Noir circuit in
 * circuits/email-recovery, that a DKIM key signed an email from some mailbox with a given
 * subject. Here we check:
 *   1. the proof, against the circuit's verification key;
 *   2. that the DKIM key in the proof is one the sender's domain publishes (DNS, else
 *      DNS over HTTPS, else ZK Email's archive of past keys);
 *   3. that the subject is exactly "Euthyna <action> near:<account>".
 * We keep only sha256("euthyna-email:" + the circuit's hash of the address).
 */
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";

import { BarretenbergVerifier } from "@aztec/bb.js";
import { accountInSubject, EMAIL_RECOVERY_VK_BASE64, limbs, modulusFromDkimRecord, readPublicInputs, redc, type EmailEvidence, type RecoveryAction } from "@mandateos/sdk/email-proof";

export class IdentityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface IdentityVerifier {
  /** The identity hash behind this evidence, bound to `account` for `action`; throws when it does not prove it. */
  verify(evidence: unknown, account: string, action: RecoveryAction): Promise<{ identityHash: string; method: string }>;
}

/** DKIM TXT records for selector._domainkey.domain, newest first; empty when none is found. */
export type DkimKeySource = (domain: string, selector: string) => Promise<string[]>;

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function dkimKeys(options: { testKeys?: Record<string, string> | undefined; fetcher?: typeof fetch } = {}): DkimKeySource {
  const fetcher = options.fetcher ?? fetch;
  return async (domain, selector) => {
    if (!NAME.test(domain) || !/^[a-z0-9._-]{1,63}$/i.test(selector)) return [];
    const test = options.testKeys?.[`${selector}._domainkey.${domain}`];
    if (test) return [test];
    const name = `${selector}._domainkey.${domain}`;
    const records: string[] = [];
    try {
      records.push(...(await dns.resolveTxt(name)).map((parts) => parts.join("")));
    } catch {
      try {
        const answer = await (await fetcher(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`, { signal: AbortSignal.timeout(8_000) })).json() as { Answer?: Array<{ data: string }> };
        records.push(...(answer.Answer ?? []).map((item) => item.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "")));
      } catch { /* next source */ }
    }
    try {
      // Keys rotate: an email signed last month may use a key no longer in DNS.
      const archived = await (await fetcher(`https://archive.zk.email/api/key?domain=${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(8_000) })).json() as Array<{ selector: string; value: string }>;
      records.push(...archived.filter((item) => item.selector === selector).map((item) => item.value));
    } catch { /* DNS is enough when it answered */ }
    return records.filter((record) => /p=/.test(record));
  };
}

export function emailIdentityHash(addressHash: string): string {
  return createHash("sha256").update(`euthyna-email:${addressHash}`).digest("hex");
}

export function parseEvidence(evidence: unknown): EmailEvidence {
  const value = evidence as Partial<EmailEvidence> | null;
  if (!value || typeof value.proof !== "string" || value.proof.length > 40_000 || !Array.isArray(value.publicInputs) || typeof value.selector !== "string" || value.selector.length > 63) {
    throw new IdentityError("email_proof_invalid", "the email proof is malformed");
  }
  if (!value.publicInputs.every((field) => typeof field === "string" && /^0x[0-9a-f]{1,64}$/i.test(field))) throw new IdentityError("email_proof_invalid", "the email proof is malformed");
  return { proof: value.proof, publicInputs: value.publicInputs, selector: value.selector };
}

export class EmailVerifier implements IdentityVerifier {
  private verifier: Promise<BarretenbergVerifier> | null = null;
  private readonly vk = Uint8Array.from(Buffer.from(EMAIL_RECOVERY_VK_BASE64, "base64"));

  constructor(private readonly keys: DkimKeySource) {}

  async verify(evidence: unknown, account: string, action: RecoveryAction) {
    const { proof, publicInputs, selector } = parseEvidence(evidence);
    let stated: ReturnType<typeof readPublicInputs>;
    try {
      stated = readPublicInputs(publicInputs);
    } catch {
      throw new IdentityError("email_proof_invalid", "the email proof is malformed");
    }
    // Cheap checks first: the subject must name this account for this action.
    const bound = accountInSubject(stated.subject, action);
    if (bound !== account) {
      throw new IdentityError("email_not_bound", `the email's subject must be exactly "Euthyna ${action} near:${account}"`);
    }
    const expectedRedc = limbs(redc(stated.modulus)).map((limb) => BigInt(limb));
    if (stated.redcLimbs.some((limb, index) => limb !== expectedRedc[index])) throw new IdentityError("email_proof_invalid", "the DKIM key in the proof is inconsistent");
    const records = await this.keys(stated.domain, selector);
    const known = records.some((record) => {
      try {
        return modulusFromDkimRecord(record) === stated.modulus;
      } catch {
        return false;
      }
    });
    if (!known) throw new IdentityError("dkim_key_unknown", `${stated.domain} does not publish the DKIM key that signed this email (selector ${selector})`);
    this.verifier ??= (async () => new BarretenbergVerifier({ threads: 1 }))();
    let valid = false;
    try {
      valid = await (await this.verifier).verifyUltraHonkProof({ proof: Uint8Array.from(Buffer.from(proof, "base64")), publicInputs }, this.vk);
    } catch (error) {
      console.warn(`email proof verification failed: ${String(error).slice(0, 300)}`);
    }
    if (!valid) throw new IdentityError("email_proof_invalid", "the email proof is not valid");
    return { identityHash: emailIdentityHash(stated.addressHash), method: `email:${stated.domain}` };
  }
}
