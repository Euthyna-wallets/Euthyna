import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaWorkerStore } from "./operation-worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaWorkerStore against PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("leases one worker, resumes after lease expiry, and atomically releases a cancelled reference", async () => {
    const organizationId = randomUUID();
    const authUserId = randomUUID();
    const agentId = randomUUID();
    const leaseName = `worker-${randomUUID()}`;
    const opId = `0x${"01".repeat(32)}`;
    await prisma.organization.create({
      data: { id: organizationId, name: "Worker Org", slug: `worker-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.create({
      data: { id: authUserId, name: "Worker Agent", email: `${authUserId}@agents.mandateos.invalid`, emailVerified: true },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        organizationId,
        authUserId,
        name: "Worker Agent",
        role: "researcher",
        nearAccountId: `agent-${agentId}.testnet`,
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: `vault-${agentId}.testnet`,
        mpcPath: "agents/researcher/base",
      },
    });
    await prisma.operation.create({
      data: {
        organizationId,
        opId,
        agentId,
        reference: "INV-WORKER-1",
        state: "PossiblySigned",
        txDigest: `0x${"02".repeat(32)}`,
        evmNonce: 0,
        amount: "100",
      },
    });
    await prisma.consumedReference.create({
      data: { organizationId, reference: "INV-WORKER-1", opId },
    });

    const first = new PrismaWorkerStore(prisma, "holder-1", leaseName);
    const second = new PrismaWorkerStore(prisma, "holder-2", leaseName);
    const now = new Date("2026-01-01T00:00:00.000Z");
    await expect(first.acquireLease(now, 1_000)).resolves.toBe(true);
    await expect(second.acquireLease(now, 1_000)).resolves.toBe(false);
    await expect(second.acquireLease(new Date(now.getTime() + 1_001), 1_000)).resolves.toBe(true);

    const [queued] = await second.listReady(now);
    expect(queued).toMatchObject({ organizationId, opId, reference: "INV-WORKER-1" });
    await second.releaseReference(queued!, "Cancelled");
    await expect(prisma.consumedReference.findUnique({
      where: { organizationId_reference: { organizationId, reference: "INV-WORKER-1" } },
    })).resolves.toBeNull();
    await expect(prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId } },
    })).resolves.toMatchObject({ state: "Cancelled" });

    await expect(prisma.operation.create({
      data: {
        organizationId,
        opId: `0x${"03".repeat(32)}`,
        agentId,
        reference: "INV-WORKER-1",
        state: "Prepared",
        txDigest: `0x${"04".repeat(32)}`,
        evmNonce: 1,
        amount: "100",
      },
    })).resolves.toMatchObject({ reference: "INV-WORKER-1" });

    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: authUserId } });
    await prisma.workerLease.delete({ where: { name: leaseName } });
  });
});
