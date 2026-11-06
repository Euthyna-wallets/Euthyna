import { randomUUID } from "node:crypto";

import { PrismaClient } from "@euthyna/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaPairingStore, newPairingCode, pairingCodeHash } from "./pairings.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaPairingStore against PostgreSQL", () => {
  let prisma: PrismaClient;
  let store: PrismaPairingStore;
  const organizationId = randomUUID();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    store = new PrismaPairingStore(prisma);
    await prisma.organization.create({ data: { id: organizationId, name: "Pairing test", slug: `pairing-${organizationId}`, createdAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("lets exactly one of two concurrent signers claim a code", async () => {
    const code = newPairingCode();
    const pairing = await store.create({
      organizationId,
      createdByUserId: "user-1",
      name: "Mario",
      role: "yield-manager",
      nearAccountId: `mario-${organizationId.slice(0, 6)}.testnet`,
      vaultAccountId: "vault.testnet",
      mpcPath: "agents/yield-manager/base",
      codeHash: pairingCodeHash(code),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await store.countOpen(organizationId, "user-1", new Date())).toBe(1);
    const found = await store.findOpen(pairingCodeHash(code.toLowerCase().replaceAll("-", " ")), new Date());
    expect(found?.id).toBe(pairing.id);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) => store.claim(pairing.id, `ed25519:key${n}`, `host${n}`, new Date())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.findOpen(pairingCodeHash(code), new Date())).toBeNull();
    expect(await store.countOpen(organizationId, "user-1", new Date())).toBe(0);
  });

  it("ignores an expired code", async () => {
    const code = newPairingCode();
    await store.create({
      organizationId,
      createdByUserId: "user-1",
      name: "Old",
      role: "r",
      nearAccountId: "old.testnet",
      vaultAccountId: "vault.testnet",
      mpcPath: "agents/r/base",
      codeHash: pairingCodeHash(code),
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await store.findOpen(pairingCodeHash(code), new Date())).toBeNull();
  });
});
