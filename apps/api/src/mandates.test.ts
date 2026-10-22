import type { PrismaClient } from "@mandateos/db";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { z } from "zod";

import { MandateService, type MandateInput } from "./mandates.js";
import type { NearClient } from "./near.js";

const token = getAddress("0x418A2b47911dE05e21688F7490195F5324B49474");
const recipients = [getAddress("0x1111111111111111111111111111111111111111")];

// Sputnik DAO 2.3.1 ProposalKind::Transfer at immutable upstream commit 317ea4fb1:
// https://github.com/near-daos/sputnik-dao-contract/blob/317ea4fb1/sputnikdao2/src/proposals.rs
const sputnikTransferSchema = z.object({
  token_id: z.string().min(1),
  receiver_id: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  msg: z.string().nullable(),
}).strict();

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

function service(
  status = "active",
  currentRole: unknown = null,
  agentEvmAddress: string | null = null,
  budgetTokenDecimals = 6,
) {
  const updates: unknown[] = [];
  const prisma = {
    treasury: {
      findUnique: async () => ({
        organizationId: "org-1",
        status,
        environment: "uat",
        daoAccountId: "acme.sputnikv2.testnet",
        vaultAccountId: "acme-vault.alice.testnet",
        relayAccountId: "acme-relay.alice.testnet",
        rolesAddress: getAddress("0x7777777777777777777777777777777777777777"),
      }),
    },
    agent: {
      findFirst: async () => ({ id: "agent-1", evmAddress: null }),
      update: async ({ data }: { data: unknown }) => {
        updates.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: async (_accountId: string, method: string, args?: Record<string, unknown>) => {
      if (method === "ft_metadata") return { symbol: "TestUSDC", decimals: budgetTokenDecimals };
      if (method === "storage_balance_bounds") return { min: "1250000000000000000000" };
      if (method === "storage_balance_of") {
        return args?.account_id === "acme.sputnikv2.testnet" ? null : { total: "1250000000000000000000" };
      }
      if (method === "ft_balance_of") return "6000000";
      if (method === "get_agent") {
        return {
          active: true,
          role: "researcher",
          mpc_path: "agents/researcher/base",
          evm_address: agentEvmAddress
            ? Array.from(Buffer.from(agentEvmAddress.slice(2), "hex"))
            : null,
        };
      }
      return currentRole;
    },
  } as unknown as NearClient;
  return { service: new MandateService(prisma, near), updates };
}

describe("MandateService.preview", () => {
  it("builds the three artifacts, a diff and unsigned proposals", async () => {
    const preview = await service().service.preview("org-1", input);
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
    expect(preview.proposals.zodiacRelay[0]).toMatchObject({
      args: {
        proposal: {
          kind: {
            FunctionCall: {
              actions: [{ gas: "60000000000000" }],
            },
          },
        },
      },
    });
    expect(preview.agentStatus).toBe("no_agent");
  });

  it("keeps Zodiac assignRoles pending until the agent EVM address exists", async () => {
    const preview = await service().service.preview("org-1", {
      ...input,
      agent: { nearAccountId: "agent.testnet", mpcPath: "agents/researcher/base" },
    });
    expect(preview.agentStatus).toBe("needs_agent_address");
    expect(preview.zodiac.calls).toHaveLength(3);
    expect(preview.warnings[0]).toContain("derived only");
  });

  it("adds assignRoles when the agent EVM address is known", async () => {
    const fixture = service("active", null, "0x2222222222222222222222222222222222222222");
    const preview = await fixture.service.preview("org-1", {
      ...input,
      agent: {
        nearAccountId: "agent.testnet",
        mpcPath: "agents/researcher/base",
      },
    });
    expect(preview.agentStatus).toBe("ready");
    expect(preview.zodiac.calls).toHaveLength(4);
    expect(preview.proposals.vaultRegisterAgent).not.toBeNull();
    expect(fixture.updates).toEqual([{ evmAddress: "0x2222222222222222222222222222222222222222" }]);
  });

  it("emits a Sputnik 2.3.1 FT Transfer with the configured token_id", async () => {
    const preview = await service("active", null, "0x2222222222222222222222222222222222222222")
      .service.preview("org-1", {
        ...input,
        agent: { nearAccountId: "agent.testnet", mpcPath: "agents/researcher/base" },
      });
    const transfer = (
      preview.proposals.funding?.args.proposal as { kind: { Transfer: unknown } }
    ).kind.Transfer;
    expect(sputnikTransferSchema.parse(transfer)).toEqual({
      token_id: "test-ft.testnet",
      receiver_id: "acme-vault.alice.testnet",
      amount: "6000000",
      msg: JSON.stringify({ role: "researcher" }),
    });
  });

  it("plans missing UAT storage registrations before mint and reports the DAO balance", async () => {
    const fixture = service();
    await expect(fixture.service.budgetTokenPlan("org-1", "6000000")).resolves.toMatchObject({
      status: {
        decimals: 6,
        daoBalance: "6000000",
        daoStorageRegistered: false,
        vaultStorageRegistered: true,
      },
      actions: [
        { methodName: "storage_deposit", args: { account_id: "acme.sputnikv2.testnet" } },
        { methodName: "mint", args: { account_id: "acme.sputnikv2.testnet", amount: "6000000" } },
      ],
    });
  });

  it("refuses a budget token whose decimals differ from USDC", async () => {
    await expect(service("active", null, null, 18).service.preview("org-1", input))
      .rejects.toMatchObject({ code: "budget_token_decimals_mismatch" });
  });

  it("refuses a pending treasury", async () => {
    await expect(service("pending_dao_hardening").service.preview("org-1", input)).rejects.toMatchObject({
      code: "treasury_not_active",
    });
  });

  it("refuses swap/bridge before phase 2", async () => {
    await expect(
      service().service.preview("org-1", { ...input, operations: ["pay", "swap"] }),
    ).rejects.toMatchObject({ code: "operation_not_supported" });
  });

  it("refuses a per-transaction cap above the budget", async () => {
    await expect(
      service().service.preview("org-1", { ...input, maxPerTx: "7000000" }),
    ).rejects.toMatchObject({ code: "cap_above_budget" });
  });
});
