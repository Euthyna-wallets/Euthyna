import type { PrismaClient } from "@euthyna/db";
import { describe, expect, it } from "vitest";

import type { MandateAuth } from "./auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";

function fixture(input: { passkey?: boolean; near?: string; seatNear?: string | null }) {
  const updates: unknown[] = [];
  const seat = { id: "member-1", userId: "user-1", organizationId: "org-1", role: "owner", nearAccountId: input.seatNear ?? null };
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", email: "member@example.test", emailVerified: false },
        session: { activeOrganizationId: "org-1" },
      }),
    },
  } as unknown as MandateAuth;
  const prisma = {
    passkey: { findFirst: async () => input.passkey ? ({ id: "passkey-1" }) : null },
    account: { findFirst: async () => input.near ? ({ accountId: input.near }) : null },
    member: {
      findFirst: async () => seat,
      update: async (args: { data: { nearAccountId: string } }) => {
        updates.push(args.data);
        return { ...seat, ...args.data };
      },
    },
  } as unknown as PrismaClient;
  return { gateway: new BetterAuthGateway(auth, prisma), updates };
}

describe("console session boundary", () => {
  it("refuses a session without a NEAR wallet", async () => {
    await expect(fixture({}).gateway.identifyConsole(new Headers())).resolves.toBeNull();
  });

  it("refuses a session from a passkey alone", async () => {
    await expect(fixture({ passkey: true }).gateway.identifyConsole(new Headers())).resolves.toBeNull();
  });

  it("accepts a NEAR wallet session and records the creator's NEAR account on their seat", async () => {
    const { gateway, updates } = fixture({ near: "alice.testnet" });
    await expect(gateway.identifyConsole(new Headers())).resolves.toMatchObject({ memberId: "member-1", nearAccountId: "alice.testnet" });
    expect(updates).toEqual([{ nearAccountId: "alice.testnet" }]);
  });

  it("keeps the seat's NEAR account when it is already set", async () => {
    const { gateway, updates } = fixture({ near: "alice.testnet", seatNear: "alice.testnet" });
    await gateway.identifyConsole(new Headers());
    expect(updates).toEqual([]);
  });
});
