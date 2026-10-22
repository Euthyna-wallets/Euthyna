import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { AGENT_FUNCTION_CALL_METHODS, proposedAgentAccountId } from "@mandateos/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentProvisioningService } from "./agent-provisioning.js";
import type { NearClient } from "./near.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("AgentProvisioningService against PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates one restricted-key account transaction and persists confirmation", async () => {
    const organizationId = randomUUID();
    const authUserId = randomUUID();
    const agentId = randomUUID();
    const accountId = proposedAgentAccountId("Compta Bot", "mandateos.testnet");
    const publicKey = "ed25519:11111111111111111111111111111111";
    const calls: unknown[] = [];
    const accessKey = {
      public_key: publicKey,
      access_key: { permission: { FunctionCall: {
        allowance: "100000000000000000000000",
        receiver_id: "vault.testnet",
        method_names: [...AGENT_FUNCTION_CALL_METHODS],
      } } },
    };
    const near = {
      provisionFunctionCallAccount: async (input: unknown) => {
        calls.push(input);
        return "near-provision-hash";
      },
      getAccessKeys: async () => ({ keys: [accessKey] }),
    } as unknown as NearClient;

    await prisma.organization.create({
      data: { id: organizationId, name: "Provision Org", slug: `provision-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.create({
      data: { id: authUserId, name: "Agent", email: `${authUserId}@agents.mandateos.invalid`, emailVerified: true },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        organizationId,
        authUserId,
        name: "Compta Bot",
        role: "researcher",
        nearAccountId: accountId,
        nearPublicKey: publicKey,
        vaultAccountId: "vault.testnet",
        mpcPath: "agents/researcher/base",
      },
    });
    const service = new AgentProvisioningService(
      prisma,
      near,
      "mandateos.testnet",
      5,
      "300000000000000000000000",
      "100000000000000000000000",
    );
    await expect(service.provision(organizationId, agentId)).resolves.toMatchObject({
      status: "provisioned",
      transactionHash: "near-provision-hash",
      attestation: { valid: true },
    });
    expect(calls).toEqual([{
      accountId,
      publicKey,
      receiverId: "vault.testnet",
      methodNames: [...AGENT_FUNCTION_CALL_METHODS],
      reserveYocto: "300000000000000000000000",
      allowanceYocto: "100000000000000000000000",
    }]);
    await expect(service.confirm(organizationId, agentId)).resolves.toMatchObject({
      status: "confirmed",
      attestation: { valid: true },
    });
    await expect(prisma.agentProvisioning.findUnique({ where: { agentId } })).resolves.toMatchObject({
      status: "confirmed",
      transactionHash: "near-provision-hash",
      confirmedAt: expect.any(Date),
    });

    const secondUserId = randomUUID();
    const secondAgentId = randomUUID();
    await prisma.user.create({
      data: { id: secondUserId, name: "Second Agent", email: `${secondUserId}@agents.mandateos.invalid`, emailVerified: true },
    });
    await prisma.agent.create({
      data: {
        id: secondAgentId,
        organizationId,
        authUserId: secondUserId,
        name: "Second Bot",
        role: "researcher",
        nearAccountId: proposedAgentAccountId("Second Bot", "mandateos.testnet"),
        nearPublicKey: "ed25519:22222222222222222222222222222222",
        vaultAccountId: "vault.testnet",
        mpcPath: "agents/researcher/base",
      },
    });
    const capped = new AgentProvisioningService(
      prisma,
      near,
      "mandateos.testnet",
      1,
      "300000000000000000000000",
      "100000000000000000000000",
    );
    await expect(capped.provision(organizationId, secondAgentId))
      .rejects.toMatchObject({ code: "daily_sponsorship_limit" });
    expect(calls).toHaveLength(1);

    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: authUserId } });
    await prisma.user.delete({ where: { id: secondUserId } });
  });
});
