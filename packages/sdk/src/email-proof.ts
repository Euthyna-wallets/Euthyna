/**
 * ZK Email for Euthyna seat recovery: everything around the Noir circuit
 * (circuits/email-recovery) that both the browser (prover) and the API (verifier)
 * need. Pure TypeScript: no Node or DOM APIs.
 *
 * The person sends themself an email whose subject names the action and their NEAR
 * account, downloads it (.eml) and proves in the browser that the mailbox's provider
 * signed it (DKIM). The proof is zero-knowledge: it reveals a salted hash of the sender
 * address, the sender domain and the subject; never the address or the rest of the email.
 * The recovery contract on NEAR verifies it (contracts/email-recovery).
 */

export const MAX_EMAIL_HEADER_LENGTH = 1024;
export const MAX_DOMAIN_LENGTH = 64;
export const MAX_SUBJECT_LENGTH = 96;
export const KEY_LIMBS = 18;
/** modulus (18) + redc (18) + salt + address hash + domain (64 + len) + subject (96 + len). */
export const PUBLIC_INPUT_COUNT = KEY_LIMBS * 2 + 1 + 1 + MAX_DOMAIN_LENGTH + 1 + MAX_SUBJECT_LENGTH + 1;
/** Proofs are zero-knowledge with a Keccak transcript (bb's "evm" target): what the contract verifies. */
export const PROOF_TARGET = "evm" as const;

export type RecoveryAction = "enroll" | "recovery";
export type EmailEvidence = { proof: string; publicInputs: string[]; selector: string };
export type Sequence = { index: string; length: string };
export type DkimSignature = { domain: string; selector: string; signature: bigint; headers: string[]; algorithm: string; canonicalization: string };

/** The subject the email must have: one action, one NEAR account. */
export function recoverySubject(action: RecoveryAction, account: string): string {
  return `Euthyna ${action} near:${account}`;
}

/** The NEAR account a subject binds to, for this action; null if it is not exactly ours. */
export function accountInSubject(subject: string, action: RecoveryAction): string | null {
  const match = subject.trim().match(new RegExp(`^euthyna ${action} near:([a-z0-9._-]{2,64})$`, "i"));
  return match ? match[1]!.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Parsing the .eml (RFC 5322 header, RFC 6376 relaxed canonicalization)
// ---------------------------------------------------------------------------

type RawHeader = { name: string; raw: string };

function splitHeaders(eml: string): RawHeader[] {
  const end = eml.search(/\r?\n\r?\n/);
  const block = (end === -1 ? eml : eml.slice(0, end)).replace(/\r?\n/g, "\r\n");
  const headers: RawHeader[] = [];
  for (const line of block.split("\r\n")) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1]!.raw += `\r\n${line}`;
    else if (line.includes(":")) headers.push({ name: line.slice(0, line.indexOf(":")).trim().toLowerCase(), raw: line });
  }
  return headers;
}

/** RFC 6376 §3.4.2: lowercase name, unfold, collapse whitespace, trim around the colon. */
export function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(":");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw.slice(colon + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim();
  return `${name}:${value}`;
}

function tags(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).replace(/\s+/g, "");
  }
  return out;
}

/** The address in the From header, lowercased. */
export function fromAddress(eml: string): string {
  const from = splitHeaders(eml).filter((header) => header.name === "from");
  if (from.length !== 1) throw new Error("The email must have exactly one From header");
  const value = relaxedHeader(from[0]!.raw).slice(5);
  const angled = value.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1]! : value).trim().toLowerCase();
}

/** The DKIM-Signature of the sender's own domain (d= equal to the From domain). */
export function senderDkim(eml: string): DkimSignature & { raw: string } {
  const domain = fromAddress(eml).split("@")[1] ?? "";
  for (const header of splitHeaders(eml).filter((item) => item.name === "dkim-signature")) {
    const t = tags(relaxedHeader(header.raw).slice("dkim-signature:".length));
    if ((t.d ?? "").toLowerCase() !== domain) continue;
    if (t.a !== "rsa-sha256") throw new Error(`DKIM algorithm ${t.a} is not supported (rsa-sha256 only)`);
    if (!(t.c ?? "simple/simple").startsWith("relaxed")) throw new Error("Only relaxed header canonicalization is supported");
    return {
      raw: header.raw, domain, selector: t.s ?? "", algorithm: t.a, canonicalization: t.c ?? "",
      signature: BigInt(`0x${base64ToHex(t.b ?? "")}`), headers: (t.h ?? "").toLowerCase().split(":").filter(Boolean),
    };
  }
  throw new Error(`No DKIM signature from ${domain}: the provider did not sign this email for its own domain`);
}

/** The exact bytes the DKIM signature covers: the signed headers, then the DKIM-Signature with an empty b=. */
export function signedHeaderBytes(eml: string): { header: string; dkim: DkimSignature } {
  const dkim = senderDkim(eml);
  const all = splitHeaders(eml);
  const used = new Set<number>();
  const lines: string[] = [];
  for (const name of dkim.headers) {
    // Each h= name takes the next instance from the bottom.
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]!.name === name && !used.has(index)) {
        used.add(index);
        lines.push(relaxedHeader(all[index]!.raw));
        break;
      }
    }
  }
  const signature = relaxedHeader(dkim.raw).replace(/(^|;)(\s*)b=[^;]*/i, "$1$2b=");
  return { header: `${lines.map((line) => `${line}\r\n`).join("")}${signature}`, dkim };
}

// ---------------------------------------------------------------------------
// Circuit inputs
// ---------------------------------------------------------------------------

function base64ToHex(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = "";
  for (const char of value.replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid base64");
    bits += index.toString(2).padStart(6, "0");
  }
  let hex = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, "0");
  return hex;
}

export function limbs(value: bigint, count = KEY_LIMBS): string[] {
  const out: string[] = [];
  const mask = (1n << 120n) - 1n;
  for (let i = 0; i < count; i += 1) {
    out.push(`0x${(value & mask).toString(16)}`);
    value >>= 120n;
  }
  return out;
}

/** noir-bignum's Barrett parameter for a 2048-bit modulus. */
export function redc(modulus: bigint): bigint {
  // noir-bignum v0.11: 2^(2 * MOD_BITS + BARRET_REDUCTION_OVERFLOW_BITS) / modulus, overflow bits = 6.
  return (1n << (2n * 2048n + 6n)) / modulus;
}

/** A fresh enrollment salt: 31 random bytes (always below the BN254 field modulus), as a field. */
export function newSalt(): string {
  const bytes = new Uint8Array(31);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The DKIM key as the recovery contract knows it: sha256 of its 36 public inputs (modulus
 * and redc, 18 limbs each, 32 bytes big-endian). Same as the contract's `add_dkim_key`.
 */
export async function dkimKeyHash(modulus: bigint): Promise<string> {
  const fields = [...limbs(modulus), ...limbs(redc(modulus))];
  const digest = await globalThis.crypto.subtle.digest("SHA-256", publicInputBytes(fields));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The public inputs as the contract takes them: 32 bytes each, big-endian, concatenated. */
export function publicInputBytes(publicInputs: string[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(publicInputs.length * 32);
  publicInputs.forEach((field, index) => {
    const hex = BigInt(field).toString(16).padStart(64, "0");
    for (let i = 0; i < 32; i += 1) out[index * 32 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  });
  return out;
}

/** SHA-256 padding up to the circuit's maximum (as zk-email's sha256Pad). */
function sha256Pad(message: Uint8Array, max: number): Uint8Array {
  const bitLength = BigInt(message.length * 8);
  const padded: number[] = [...message, 0x80];
  while ((padded.length + 8) % 64 !== 0) padded.push(0);
  for (let i = 7; i >= 0; i -= 1) padded.push(Number((bitLength >> BigInt(i * 8)) & 0xffn));
  if (padded.length > max) throw new Error(`The signed headers are ${message.length} bytes; the circuit takes at most ${max - 72}`);
  while (padded.length < max) padded.push(0);
  return Uint8Array.from(padded);
}

function sequence(header: string, pattern: RegExp, field: string): { field: Sequence; start: number; end: number } {
  const match = header.match(pattern);
  if (!match || match.index === undefined) throw new Error(`The signed headers have no ${field} field`);
  const index = match.index + match[1]!.length;
  return { field: { index: String(index), length: String(match[2]!.length) }, start: index, end: index + match[2]!.length };
}

/** An .eml read byte for byte (latin1), so the signed bytes are exactly the ones received. */
export function emlFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** The circuit's inputs for this email (read with emlFromBytes) and this DKIM public key modulus. */
export function circuitInputs(eml: string, modulus: bigint, salt: string) {
  const { header, dkim } = signedHeaderBytes(eml);
  const bytes = Uint8Array.from(header, (char) => char.charCodeAt(0) & 0xff);
  const from = sequence(header, /(^|\r\n)(from:[^\r\n]*)/, "From");
  const fromValue = header.slice(from.start, from.end);
  const angle = fromValue.lastIndexOf("<");
  const addressStart = from.start + (angle >= 0 ? angle + 1 : 5 + (fromValue.slice(5).length - fromValue.slice(5).trimStart().length));
  const addressEnd = angle >= 0 ? from.start + fromValue.indexOf(">", angle) : from.end;
  const subject = sequence(header, /(^|\r\n)(subject:[^\r\n]*)/, "Subject");
  return {
    selector: dkim.selector,
    domain: dkim.domain,
    inputs: {
      header: { storage: Array.from(sha256Pad(bytes, MAX_EMAIL_HEADER_LENGTH), String), len: String(bytes.length) },
      pubkey: { modulus: limbs(modulus), redc: limbs(redc(modulus)) },
      signature: limbs(dkim.signature),
      from_header_sequence: from.field,
      from_address_sequence: { index: String(addressStart), length: String(addressEnd - addressStart) },
      subject_sequence: subject.field,
      salt,
    },
  };
}

// ---------------------------------------------------------------------------
// Public inputs
// ---------------------------------------------------------------------------

function text(fields: string[], count: number, lengthField: string): string {
  const length = Number(BigInt(lengthField));
  if (length > count) throw new Error("Invalid public input length");
  return String.fromCharCode(...fields.slice(0, length).map((field) => Number(BigInt(field))));
}

/** What a proof states, read from its public inputs. */
export function readPublicInputs(publicInputs: string[]) {
  if (publicInputs.length !== PUBLIC_INPUT_COUNT) throw new Error(`Expected ${PUBLIC_INPUT_COUNT} public inputs, got ${publicInputs.length}`);
  let at = 0;
  const take = (count: number) => publicInputs.slice(at, (at += count));
  const modulusLimbs = take(KEY_LIMBS).map((field) => BigInt(field));
  const redcLimbs = take(KEY_LIMBS).map((field) => BigInt(field));
  const salt = `0x${BigInt(take(1)[0]!).toString(16).padStart(64, "0")}`;
  const addressHash = BigInt(take(1)[0]!).toString(16).padStart(64, "0");
  const domain = text(take(MAX_DOMAIN_LENGTH), MAX_DOMAIN_LENGTH, take(1)[0]!);
  const subject = text(take(MAX_SUBJECT_LENGTH), MAX_SUBJECT_LENGTH, take(1)[0]!);
  const modulus = modulusLimbs.reduceRight((acc, limb) => (acc << 120n) | limb, 0n);
  return { modulus, redcLimbs, salt, addressHash, domain, subject };
}

/** The RSA modulus in a DKIM TXT record ("v=DKIM1; k=rsa; p=…"), via a DER reader for SPKI or PKCS#1. */
export function modulusFromDkimRecord(record: string): bigint {
  const p = tags(record).p;
  if (!p) throw new Error("The DKIM record has no public key (revoked)");
  const der = Uint8Array.from((base64ToHex(p).match(/../g) ?? []).map((byte) => parseInt(byte, 16)));
  // Walk the DER: the first INTEGER large enough to be a 2048-bit modulus.
  for (let i = 0; i < der.length - 4; i += 1) {
    if (der[i] !== 0x02) continue;
    let length = der[i + 1]!;
    let offset = i + 2;
    if (length & 0x80) {
      const bytes = length & 0x7f;
      length = 0;
      for (let j = 0; j < bytes; j += 1) length = (length << 8) | der[offset + j]!;
      offset += bytes;
    }
    if (length >= 256 && length <= 257) {
      let hex = "";
      for (let j = offset; j < offset + length; j += 1) hex += der[j]!.toString(16).padStart(2, "0");
      const modulus = BigInt(`0x${hex}`);
      if (modulus.toString(2).length !== 2048) throw new Error("Only 2048-bit DKIM keys are supported");
      return modulus;
    }
  }
  throw new Error("Only 2048-bit RSA DKIM keys are supported");
}
export { EMAIL_RECOVERY_BYTECODE_SHA256, EMAIL_RECOVERY_VK_BASE64 } from "./email-recovery-vk.js";
