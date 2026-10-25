import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@mandateos/db";

import { createAuth, type MandateAuth } from "./auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Runs only when TEST_DATABASE_URL points at a PostgreSQL database with
 * `packages/db/prisma/schema.prisma` applied:
 *
 *   DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @mandateos/db exec prisma db push
 *   TEST_DATABASE_URL=... pnpm --filter @mandateos/api test
 */
describe.skipIf(!databaseUrl)("BetterAuthGateway against PostgreSQL", () => {
  let prisma: PrismaClient;
  let gateway: BetterAuthGateway;
  let auth: MandateAuth;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    auth = createAuth(
      {
        BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
        BETTER_AUTH_URL: "http://localhost:3000",
        CONSOLE_ORIGIN: "http://localhost:5173",
      },
      prisma,
    );
    gateway = new BetterAuthGateway(auth, prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("issues a per-agent key, revokes it, scopes listings and records audit", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await prisma.organization.createMany({
      data: [
        { id: orgId, name: "ACME", slug: `acme-${orgId}`, createdAt: new Date() },
        { id: otherOrgId, name: "Other", slug: `other-${otherOrgId}`, createdAt: new Date() },
      ],
    });
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        name: "Admin",
        email: `admin-${userId}@example.invalid`,
        emailVerified: true,
      },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: orgId,
        userId,
        role: "admin",
        createdAt: new Date(),
      },
    });

    const created = await gateway.createAgent({
      organizationId: orgId,
      name: "Research agent",
      role: "researcher",
      nearAccountId: `agent-${orgId}.testnet`,
      nearPublicKey: "ed25519:11111111111111111111111111111111",
      vaultAccountId: "vault.testnet",
      mpcPath: "agents/researcher/base",
    });
    expect(created.apiKey.length).toBeGreaterThan(20);

    const identity = await gateway.identifyAgent(created.apiKey);
    expect(identity).toMatchObject({
      agentId: created.agent.id,
      organizationId: orgId,
      nearAccountId: created.agent.nearAccountId,
      vaultAccountId: "vault.testnet",
    });
    await expect(gateway.listAgents(otherOrgId)).resolves.toEqual([]);

    await expect(gateway.revokeAgent(orgId, created.agent.id)).resolves.toBe(true);
    await expect(gateway.identifyAgent(created.apiKey)).resolves.toBeNull();
    await expect(gateway.revokeAgent(otherOrgId, created.agent.id)).resolves.toBe(false);

    await gateway.recordAudit({
      organizationId: orgId,
      actorType: "console",
      actorId: userId,
      action: "agent.revoked",
      targetType: "agent",
      targetId: created.agent.id,
    });
    await expect(
      prisma.auditLog.count({ where: { organizationId: orgId, action: "agent.revoked" } }),
    ).resolves.toBe(1);
  });
});
