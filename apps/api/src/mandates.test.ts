import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { MandateService, type MandateInput } from "./mandates.js";
import type { NearClient } from "./near.js";

const token = getAddress("0x418A2b47911dE05e21688F7490195F5324B49474");
const recipients = [getAddress("0x1111111111111111111111111111111111111111")];

const input: MandateInput = {
  role: "researcher",
  operations: ["pay"],
  maxPerTx: "5000000",
  budget: "6000000",
  periodDays: 30,
  recipients,
  token,
  gas: {
    gasLimit: "200000",
    maxFeePerGas: "20000000000",
    maxPriorityFeePerGas: "1000000000",
    maxTotalFee: "30000000000000000",
  },
};

function service(status = "active", currentRole: unknown = null) {
  const prisma = {
    treasury: {
      findUnique: async () => ({
        organizationId: "org-1",
        status,
        daoAccountId: "acme.sputnikv2.testnet",
        vaultAccountId: "acme-vault.alice.testnet",
        relayAccountId: "acme-relay.alice.testnet",
        rolesAddress: getAddress("0x7777777777777777777777777777777777777777"),
      }),
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async () => currentRole,
  } as unknown as NearClient;
  return new MandateService(prisma, near);
}

describe("MandateService.preview", () => {
  it("builds the three artifacts, a diff and unsigned proposals", async () => {
    const preview = await service().preview("org-1", input);
    expect(preview.roleKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(preview.vault.config).toMatchObject({
      enabled: true,
      max_per_tx: "5000000",
      allowed_recipients: [Array.from(Buffer.from(recipients[0]!.slice(2), "hex"))],
    });
    expect(preview.diff).toContainEqual(expect.objectContaining({ field: "max_per_tx", current: null }));
    expect(preview.zodiac.calls).toHaveLength(3);
    expect(preview.proposals.vaultSetRole.methodName).toBe("add_proposal");
    expect(preview.proposals.zodiacRelay).toHaveLength(3);
    expect(preview.agentStatus).toBe("no_agent");
  });

  it("keeps Zodiac assignRoles pending until the agent EVM address exists", async () => {
    const preview = await service().preview("org-1", {
      ...input,
      agent: { nearAccountId: "agent.testnet", mpcPath: "agents/researcher/base" },
    });
    expect(preview.agentStatus).toBe("needs_agent_address");
    expect(preview.zodiac.calls).toHaveLength(3);
    expect(preview.warnings[0]).toContain("derived only");
  });

  it("adds assignRoles when the agent EVM address is known", async () => {
    const preview = await service().preview("org-1", {
      ...input,
      agent: {
        nearAccountId: "agent.testnet",
        mpcPath: "agents/researcher/base",
        evmAddress: getAddress("0x2222222222222222222222222222222222222222"),
      },
    });
    expect(preview.agentStatus).toBe("ready");
    expect(preview.zodiac.calls).toHaveLength(4);
    expect(preview.proposals.vaultRegisterAgent).not.toBeNull();
  });

  it("refuses a pending treasury", async () => {
    await expect(service("pending_dao_hardening").preview("org-1", input)).rejects.toMatchObject({
      code: "treasury_not_active",
    });
  });

  it("refuses swap/bridge before phase 2", async () => {
    await expect(
      service().preview("org-1", { ...input, operations: ["pay", "swap"] }),
    ).rejects.toMatchObject({ code: "operation_not_supported" });
  });

  it("refuses a per-transaction cap above the budget", async () => {
    await expect(
      service().preview("org-1", { ...input, maxPerTx: "7000000" }),
    ).rejects.toMatchObject({ code: "cap_above_budget" });
  });
});
