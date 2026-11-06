import type { PrismaClient } from "@euthyna/db";
import { describe, expect, it } from "vitest";

import type { MandateAuth } from "./auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";

type RecordRow = {
  id: string;
  organizationId: string;
  userId: string;
  nearAccountId: string;
  publicKey: string;
  status: string;
  createdAt: Date;
};

function gatewayFixture(options?: { member?: boolean; existingToday?: number }) {
  const records: RecordRow[] = [];
  for (let index = 0; index < (options?.existingToday ?? 0); index += 1) {
    records.push({
      id: `existing-${index}`,
      organizationId: "other-org",
      userId: `other-${index}`,
      nearAccountId: `w-existing-${index}.mandateos.testnet`,
      publicKey: `ed25519:existing-${index}`,
      status: "sponsored",
      createdAt: new Date(),
    });
  }
  const prisma = {
    member: {
      findFirst: async () => options?.member === false ? null : ({ id: "member-1" }),
    },
    nearWalletSponsorship: {
      findFirst: async ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        records.find((row) => where.OR.some((condition) =>
          (condition.nearAccountId && condition.nearAccountId === row.nearAccountId) ||
          (condition.publicKey && condition.publicKey === row.publicKey))) ?? null,
      count: async () => records.filter((row) => row.status === "reserved" || row.status === "sponsored").length,
      create: async ({ data }: { data: Omit<RecordRow, "id" | "status" | "createdAt"> }) => {
        const row = { ...data, id: `record-${records.length}`, status: "reserved", createdAt: new Date() };
        records.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id?: string; nearAccountId?: string }; data: { status: string } }) => {
        const row = records.find((candidate) => candidate.id === where.id || candidate.nearAccountId === where.nearAccountId);
        if (!row) throw new Error("missing sponsorship");
        row.status = data.status;
        return row;
      },
    },
    agentProvisioning: {
      count: async () => 0,
    },
    $transaction: async (callback: (transaction: unknown) => unknown) => callback(prisma),
  } as unknown as PrismaClient;
  return { gateway: new BetterAuthGateway({} as MandateAuth, prisma), records };
}

const input = {
  organizationId: "org-1",
  userId: "user-1",
  nearAccountId: "w-founder.mandateos.testnet",
  publicKey: "ed25519:founder",
  dailyLimit: 2,
};

describe("NEAR wallet sponsorship reservations", () => {
  it("reserves once, persists completion, and becomes idempotent", async () => {
    const { gateway, records } = gatewayFixture();
    await expect(gateway.reserveNearWalletSponsorship(input)).resolves.toBe("reserved");
    expect(records).toHaveLength(1);
    await gateway.completeNearWalletSponsorship(input.nearAccountId, true);
    await expect(gateway.reserveNearWalletSponsorship(input)).resolves.toBe("already_sponsored");
  });

  it("enforces the daily cap using reserved and sponsored rows", async () => {
    const { gateway } = gatewayFixture({ existingToday: 2 });
    await expect(gateway.reserveNearWalletSponsorship(input)).resolves.toBe("daily_limit");
  });

  it("refuses sponsorship when no proved member owns the deterministic wallet", async () => {
    const { gateway } = gatewayFixture({ member: false });
    await expect(gateway.reserveNearWalletSponsorship(input)).resolves.toBe("member_mismatch");
  });
});
