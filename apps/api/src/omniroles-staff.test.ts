import type { PrismaClient } from "@mandateos/db";
import { BASE_SEPOLIA, compileRole, decodeVaultCalls, type RuleChange } from "@mandateos/sdk/roles";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet", baseChainId: 84532 };
const NAOMI = "naomi-agent.mandateos.testnet";
const changes: RuleChange[] = compileRole({
  name: "payments",
  blocks: [{ kind: "payments", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", recipients: [{ address: "0x64f4F6D91B66e01A65e992B89719A6a1E6F501e8", label: "Freelance 1" }], budget: { amount: "1", periodDays: 1 } }],
  members: [{ accountId: NAOMI, kind: "Agent" }],
}, BASE_SEPOLIA);
const key = (changes.find((change) => "SetAllowance" in change) as Extract<RuleChange, { SetAllowance: unknown }>).SetAllowance.key;

function service() {
  const prisma = {
    treasury: { findUnique: async () => treasury },
    supplierWallet: { findMany: async () => [] },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (_account: string, method: string) => {
      // Newest first, as the vault lists them.
      if (method === "list_rule_changes") return changes.slice().reverse().map((change) => ({ change, state: "Executed" }));
      if (method === "get_role") return { config: { enabled: true } };
      if (method === "get_allowance") return { balance: "1000000", reserved: "0", max_refill: "1000000", period_ns: 86_400_000_000_000 };
      if (method === "get_wallet") return { address: null };
      throw new Error(`unexpected view ${method}`);
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "1", proposalPeriodNs: "1" } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

const callsOf = (draft: { args: { proposal: { kind: unknown } } }) =>
  decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId);

describe("staff decisions", () => {
  it("fires an agent from every job it holds, in one vote", async () => {
    const draft = await service().fireProposal("org-1", NAOMI);
    expect(callsOf(draft)).toEqual([{ method: "queue_rule_change", change: { RevokeMembership: { role: "payments", member: NAOMI } } }]);
    await expect(service().fireProposal("org-1", "nobody.testnet")).rejects.toMatchObject({ code: "not_hired" });
  });

  it("changes a budget in the token's units, keeping the period", async () => {
    const draft = await service().budgetProposal("org-1", { key: `0x${Buffer.from(key).toString("hex")}`, amount: "2.5" });
    expect(callsOf(draft)).toEqual([{ method: "queue_rule_change", change: { SetAllowance: { key, balance: "2500000", refill: "2500000", max_refill: "2500000", period_ns: 86_400_000_000_000 } } }]);
    expect(draft.title).toBe("Set the payments budget to 2.5 USDC every 1 day");
    await expect(service().budgetProposal("org-1", { key: `0x${"00".repeat(32)}`, amount: "1" })).rejects.toMatchObject({ code: "budget_not_found" });
  });
});
