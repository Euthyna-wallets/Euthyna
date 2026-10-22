import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";

import type { MandateAuth } from "./auth.js";
import { BetterAuthGateway } from "./auth-gateway.js";

function fixture(passkey: boolean) {
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: "user-1", email: "member@example.test", emailVerified: false },
        session: { activeOrganizationId: "org-1" },
      }),
    },
  } as unknown as MandateAuth;
  const prisma = {
    passkey: { findFirst: async () => passkey ? ({ id: "passkey-1" }) : null },
    member: { findFirst: async () => ({ userId: "user-1", organizationId: "org-1", role: "owner" }) },
  } as unknown as PrismaClient;
  return new BetterAuthGateway(auth, prisma);
}

describe("console email and passkey boundary", () => {
  it("refuses a session until a passkey is enrolled", async () => {
    await expect(fixture(false).identifyConsole(new Headers())).resolves.toBeNull();
  });

  it("accepts a passkey session while preserving the unverified email state", async () => {
    await expect(fixture(true).identifyConsole(new Headers())).resolves.toEqual({
      userId: "user-1",
      organizationId: "org-1",
      role: "owner",
      email: "member@example.test",
      emailVerified: false,
    });
  });
});
