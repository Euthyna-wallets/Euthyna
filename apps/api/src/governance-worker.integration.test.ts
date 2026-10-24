import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaGovernanceStore } from "./governance-worker.js";
import type { GovernanceOperation } from "./types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaGovernanceStore against PostgreSQL", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists the signed execute checkpoint across worker instances and excludes terminal failures", async () => {
    const organizationId = randomUUID();
    const treasuryId = randomUUID();
    await prisma.organization.create({
      data: { id: organizationId, name: "Governance Worker Org", slug: `gov-${organizationId}`, createdAt: new Date() },
    });
    await prisma.treasury.create({
      data: {
        id: treasuryId,
        organizationId,
        environment: "uat",
        nearNetwork: "testnet",
        baseChainId: 84532,
        daoAccountId: `dao-${organizationId}.testnet`,
        vaultAccountId: `vault-${organizationId}.testnet`,
        relayAccountId: `relay-${organizationId}.testnet`,
        safeAddress: "0x1111111111111111111111111111111111111111",
        rolesAddress: "0x2222222222222222222222222222222222222222",
        delayAddress: "0x3333333333333333333333333333333333333333",
        govAddress: "0x4444444444444444444444444444444444444444",
        vaultWasmSha256: "11".repeat(32),
        relayWasmSha256: "22".repeat(32),
      },
    });
    const operation: GovernanceOperation = {
      op_id: Array(32).fill(1) as number[],
      proposer: `dao-${organizationId}.testnet`,
      target: Array(20).fill(5) as number[],
      value: "0",
      data: [1, 2, 3],
      operation: 1,
      evm_nonce: 0,
      transaction: {
        chain_id: 84532,
        nonce: 0,
        to: Array(20).fill(3) as number[],
        value: "0",
        input: [],
        gas_limit: "300000",
        max_fee_per_gas: "20000000000",
        max_priority_fee_per_gas: "1000000000",
      },
      tx_digest: Array(32).fill(6) as number[],
      possibly_signed_at_block: 1,
      state: "PossiblySigned",
      signature: null,
      signed_transaction: [2, 3, 4],
      cancellation: null,
    };
    const treasury = {
      id: treasuryId,
      organizationId,
      relayAccountId: `relay-${organizationId}.testnet`,
      safeAddress: "0x1111111111111111111111111111111111111111",
      delayAddress: "0x3333333333333333333333333333333333333333",
      rolesAddress: "0x2222222222222222222222222222222222222222",
      baseChainId: 84532,
    };
    const first = new PrismaGovernanceStore(prisma);
    await first.upsertDiscovered(treasury, "client", operation);
    const [job] = await first.listReady(new Date());
    expect(job).toMatchObject({ organizationId, state: "PossiblySigned" });
    await first.update(job!, {
      state: "Executing",
      executeRawTransaction: "0x1234",
      executeTxHash: `0x${"33".repeat(32)}`,
      executionScannedThroughBlock: 1234n,
      vetoScannedThroughBlock: 1200n,
      nextAttemptAt: new Date(0),
    });

    const second = new PrismaGovernanceStore(prisma);
    const [recovered] = await second.listReady(new Date());
    expect(recovered).toMatchObject({
      state: "Executing",
      executeRawTransaction: "0x1234",
      executeTxHash: `0x${"33".repeat(32)}`,
      executionScannedThroughBlock: 1234n,
      vetoScannedThroughBlock: 1200n,
    });
    await second.update(recovered!, { state: "Failed", nextAttemptAt: null, lastError: "execute reverted" });
    await expect(second.listReady(new Date())).resolves.toEqual([]);

    await prisma.organization.delete({ where: { id: organizationId } });
  });
});
