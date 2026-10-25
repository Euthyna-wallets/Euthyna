import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.dao.testnet", vaultAccountId: "acme-vault.testnet" };

function service(input: { vault: { allowed: boolean; reason: string | null } }) {
  const audit: Array<Record<string, unknown>> = [];
  const prisma = {
    treasury: { findUnique: async () => treasury },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: `audit-${audit.length}`, ...data };
      },
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (_account: string, method: string) => {
      if (method === "check_operation") return { ...input.vault, requires_delay: false, requires_cosign: false };
      throw new Error(`unexpected view ${method}`);
    }),
  } as unknown as NearClient;
  const signer = {} as KmsSigner;
  return { omniroles: new OmniRolesService(prisma, near, signer, signer, {} as OmniRolesConfig), audit };
}

const agent = { agentId: "agent-1", nearAccountId: "bot.testnet", role: "suppliers" };
const request = { chain_id: 84532, target: Array(20).fill(1), calldata: [0xa9, 0x05, 0x9c, 0xbb], reference: "INV-1" };

describe("agent dry run", () => {
  it("reports the Guard's refusal when the role allows the call", async () => {
    const { omniroles, audit } = service({ vault: { allowed: true, reason: null } });
    const result = await omniroles.checkOperation("org-1", agent, request, async () => ({
      code: "guard_refused",
      reasons: ["0xAttacker is not a registered supplier"],
    }));
    expect(result).toMatchObject({ allowed: false, refusedBy: "guard", reason: "GUARD:guard_refused:0xAttacker is not a registered supplier" });
    expect(result.explanation).toBe("Guard: 0xAttacker is not a registered supplier");
    expect(audit[0]).toMatchObject({ action: "operation.refused" });
  });

  it("keeps the vault's refusal and does not ask the Guard", async () => {
    const { omniroles } = service({ vault: { allowed: false, reason: "ERR_ROLE_DISABLED" } });
    const guard = vi.fn(async () => null);
    const result = await omniroles.checkOperation("org-1", agent, request, guard);
    expect(result).toMatchObject({ allowed: false, refusedBy: "vault", reason: "ERR_ROLE_DISABLED" });
    expect(guard).not.toHaveBeenCalled();
  });

  it("allows when both the vault and the Guard allow", async () => {
    const { omniroles, audit } = service({ vault: { allowed: true, reason: null } });
    const result = await omniroles.checkOperation("org-1", agent, request, async () => null);
    expect(result).toMatchObject({ allowed: true, refusedBy: null, explanation: null });
    expect(audit[0]).toMatchObject({ action: "operation.allowed" });
  });
});

describe("agent asking the members", () => {
  it("records the exact call and the agent's reason, and executes nothing", async () => {
    const { omniroles, audit } = service({ vault: { allowed: true, reason: null } });
    const result = await omniroles.requestFromAgent("org-1", agent, {
      chainId: 11155111,
      to: "0x6ae43d3271ff6888e7fc43fd7321a503ff738951",
      value: "0",
      data: "0x617ba037",
      reason: "Idle USDC should earn yield on Aave",
    });
    expect(result).toMatchObject({ requestId: "audit-1", status: "waiting_for_members" });
    expect(audit[0]).toMatchObject({
      action: "operation.requested",
      metadata: {
        chainId: 11155111,
        target: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
        calldata: "0x617ba037",
        agentReason: "Idle USDC should earn yield on Aave",
      },
    });
  });
});
