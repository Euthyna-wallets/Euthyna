import { randomBytes } from "node:crypto";
import type { KmsSigner } from "./kms.js";
import type { GuardVisa, StatusReport } from "./types.js";

const textEncoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: number | string | bigint): Uint8Array {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new Error("u64 is out of range");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, parsed, true);
  return bytes;
}

function string(value: string): Uint8Array {
  const encoded = textEncoder.encode(value);
  return concat(u32(encoded.length), encoded);
}

function fixed(value: number[], length: number): Uint8Array {
  if (value.length !== length || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`expected ${length} bytes`);
  }
  return Uint8Array.from(value);
}

export function serializeVisa(visa: GuardVisa): Uint8Array {
  return concat(
    string(visa.client_id),
    fixed(visa.op_id, 32),
    fixed(visa.tx_digest, 32),
    string(visa.agent),
    string(visa.role),
    string(visa.reference),
    u64(visa.policy_version),
    u64(visa.registry_version),
    u64(visa.visa_nonce),
    u64(visa.expires_at_ns),
  );
}

export function serializeStatusReport(report: StatusReport): Uint8Array {
  return concat(
    string(report.client_id),
    fixed(report.op_id, 32),
    Uint8Array.of(report.kind === "Confirmed" ? 0 : 1),
    fixed(report.tx_hash, 32),
    u64(report.report_nonce),
    u64(report.block_number),
  );
}

export async function signDomainPayload(
  domain: "mandateos:visa:v1" | "mandateos:status:v1",
  payload: Uint8Array,
  signer: KmsSigner,
): Promise<string> {
  const message = concat(textEncoder.encode(domain), payload);
  const signature = await signer.sign(message);
  return Buffer.from(signature).toString("base64");
}

export function randomSafeNonce(): number {
  return Number(BigInt(`0x${randomBytes(6).toString("hex")}`));
}
