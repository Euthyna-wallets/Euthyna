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
        PASSKEY_RP_ID: "localhost",
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

  it("starts the sessionless Better Auth passkey ceremony without a password", async () => {
    const email = `passkey-${randomUUID()}@example.test`;
    const response = await gateway.startPasskeyRegistration({
      email,
      name: "Passkey User",
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { context?: string };
    expect(body.context?.split(".")).toHaveLength(3);
    await expect(prisma.user.findUnique({ where: { email } })).resolves.toBeNull();

    const options = await auth.handler(new Request(
      `http://localhost:3000/api/auth/passkey/generate-register-options?${new URLSearchParams({
        context: body.context!,
        name: "MandateOS console",
      })}`,
      { headers: { origin: "http://localhost:5173" } },
    ));
    expect(options.status).toBe(200);
    await expect(prisma.user.findUnique({ where: { email } })).resolves.toMatchObject({
      name: "Passkey User",
      emailVerified: false,
    });
    await expect(
      prisma.account.count({ where: { providerId: "credential" } }),
    ).resolves.toBe(0);
  });

  it("allows an interrupted registration retry but refuses an enrolled email", async () => {
    const email = `existing-${randomUUID()}@example.test`;
    const userId = randomUUID();
    await prisma.user.create({
      data: { id: userId, name: "Existing", email, emailVerified: false },
    });
    const retry = await gateway.startPasskeyRegistration({ email, name: "Existing" });
    expect(retry.status).toBe(200);
    await prisma.passkey.create({
      data: {
        id: randomUUID(),
        name: "Test passkey",
        publicKey: "AQ==",
        userId,
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      },
    });
    const enrolled = await gateway.startPasskeyRegistration({ email, name: "Existing" });
    expect(enrolled.status).toBe(409);
  });
  it("requires a different admin to approve a member's proven wallets", async () => {
    const organizationId = randomUUID();
    const adminUserId = randomUUID();
    const memberUserId = randomUUID();
    const verifiedAt = new Date();
    const memberId = randomUUID();
    await prisma.organization.create({
      data: { id: organizationId, name: "Four Eyes", slug: `four-eyes-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.createMany({
      data: [
        { id: adminUserId, name: "Admin", email: `admin-${adminUserId}@acme.test`, emailVerified: true },
        { id: memberUserId, name: "Ben", email: `ben-${memberUserId}@acme.test`, emailVerified: true },
      ],
    });
    await prisma.member.createMany({
      data: [
        { id: randomUUID(), organizationId, userId: adminUserId, role: "admin", createdAt: new Date() },
        {
          id: memberId,
          organizationId,
          userId: memberUserId,
          role: "member",
          nearAccountId: "ben.testnet",
          evmAddress: "0x0000000000000000000000000000000000000001",
          walletProofVerifiedAt: verifiedAt,
          createdAt: new Date(),
        },
      ],
    });
    await expect(
      gateway.decideMemberWalletProof(organizationId, memberId, memberUserId, {
        decision: "approve",
        nearAccountId: "ben.testnet",
        evmAddress: "0x0000000000000000000000000000000000000001",
        walletProofVerifiedAt: verifiedAt.toISOString(),
      }),
    ).rejects.toThrow("own wallet proof");
    await expect(
      gateway.decideMemberWalletProof(organizationId, memberId, adminUserId, {
        decision: "approve",
        nearAccountId: "ben.testnet",
        evmAddress: "0x0000000000000000000000000000000000000002",
        walletProofVerifiedAt: verifiedAt.toISOString(),
      }),
    ).rejects.toThrow("proof changed");
    await expect(
      gateway.decideMemberWalletProof(organizationId, memberId, adminUserId, {
        decision: "approve",
        nearAccountId: "ben.testnet",
        evmAddress: "0x0000000000000000000000000000000000000001",
        walletProofVerifiedAt: verifiedAt.toISOString(),
      }),
    ).resolves.toMatchObject({
      walletProofApprovedAt: expect.any(Date),
      walletProofApprovedBy: adminUserId,
    });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminUserId, memberUserId] } } });
  });

});
