import { createHash, randomBytes } from "node:crypto";

import type { PrismaClient } from "@mandateos/db";

/** How long a pairing code works. */
export const PAIRING_TTL_MS = 10 * 60_000;

export interface PairingRecord {
  id: string;
  organizationId: string;
  createdByUserId: string;
  name: string;
  role: string;
  nearAccountId: string;
  vaultAccountId: string;
  mpcPath: string;
  expiresAt: Date;
  redeemedAt: Date | null;
  publicKey: string | null;
  hostname: string | null;
  agentId: string | null;
}

export type NewPairing = Omit<PairingRecord, "id" | "redeemedAt" | "publicKey" | "hostname" | "agentId"> & { codeHash: string };

export interface PairingStore {
  create(input: NewPairing): Promise<PairingRecord>;
  get(organizationId: string, id: string): Promise<PairingRecord | null>;
  /** The unused, unexpired pairing with this code hash. */
  findOpen(codeHash: string, now: Date): Promise<PairingRecord | null>;
  /** Marks it used, only if nobody did first. */
  claim(id: string, publicKey: string, hostname: string, now: Date): Promise<boolean>;
  attachAgent(id: string, agentId: string): Promise<void>;
  /** Unused, unexpired codes a member holds: they count toward the hiring cap. */
  countOpen(organizationId: string, userId: string, now: Date): Promise<number>;
}

// Crockford base32: no I, L, O, U, so a code read aloud or retyped stays unambiguous.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 128 random bits, as EUT-XXXX-XXXX-…; the signer sends it back once. */
export function newPairingCode(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `EUT-${out.match(/.{1,4}/g)!.join("-")}`;
}

/** Case, dashes and spaces do not matter; the hash is what is stored. */
export function pairingCodeHash(code: string): string {
  const normalized = code.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^EUT/, "");
  return createHash("sha256").update(`euthyna-pairing:${normalized}`).digest("hex");
}

export class PrismaPairingStore implements PairingStore {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: NewPairing): Promise<PairingRecord> {
    return this.prisma.agentPairing.create({ data: input });
  }

  get(organizationId: string, id: string): Promise<PairingRecord | null> {
    return this.prisma.agentPairing.findFirst({ where: { id, organizationId } });
  }

  findOpen(codeHash: string, now: Date): Promise<PairingRecord | null> {
    return this.prisma.agentPairing.findFirst({ where: { codeHash, redeemedAt: null, expiresAt: { gt: now } } });
  }

  async claim(id: string, publicKey: string, hostname: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.agentPairing.updateMany({
      where: { id, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now, publicKey, hostname },
    });
    return count === 1;
  }

  async attachAgent(id: string, agentId: string): Promise<void> {
    await this.prisma.agentPairing.update({ where: { id }, data: { agentId } });
  }

  countOpen(organizationId: string, userId: string, now: Date): Promise<number> {
    return this.prisma.agentPairing.count({ where: { organizationId, createdByUserId: userId, redeemedAt: null, expiresAt: { gt: now } } });
  }
}

/** For tests and local runs without a database. */
export class MemoryPairingStore implements PairingStore {
  readonly rows: Array<PairingRecord & { codeHash: string }> = [];

  create(input: NewPairing): Promise<PairingRecord> {
    const row = { ...input, id: crypto.randomUUID(), redeemedAt: null, publicKey: null, hostname: null, agentId: null };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  get(organizationId: string, id: string): Promise<PairingRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id && row.organizationId === organizationId) ?? null);
  }

  findOpen(codeHash: string, now: Date): Promise<PairingRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.codeHash === codeHash && !row.redeemedAt && row.expiresAt > now) ?? null);
  }

  claim(id: string, publicKey: string, hostname: string, now: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id && !candidate.redeemedAt && candidate.expiresAt > now);
    if (!row) return Promise.resolve(false);
    Object.assign(row, { redeemedAt: now, publicKey, hostname });
    return Promise.resolve(true);
  }

  attachAgent(id: string, agentId: string): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.agentId = agentId;
    return Promise.resolve();
  }

  countOpen(organizationId: string, userId: string, now: Date): Promise<number> {
    return Promise.resolve(this.rows.filter((row) => row.organizationId === organizationId && row.createdByUserId === userId && !row.redeemedAt && row.expiresAt > now).length);
  }
}
