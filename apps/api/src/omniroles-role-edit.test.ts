import type { PrismaClient } from "@euthyna/db";
import { allowanceKey, BASE_SEPOLIA, decodeVaultCalls, hexOf, type RoleDraft } from "@euthyna/sdk/roles";
import { describe, expect, it, vi } from "vitest";

import { roleDraftSchema } from "./app.js";
import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet", baseChainId: 84532 };
const SEALED = "euthyna-sealed-orders-v2.testnet";
const USDC = BASE_SEPOLIA.tokens.find((token) => token.symbol === "USDC")!.address;

function service(sealedIsMember: boolean) {
  const prisma = { treasury: { findUnique: async () => treasury }, supplierWallet: { findMany: async () => [] } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (_account: string, method: string) => {
      if (method === "get_near_permissions") return [];
      if (method === "get_membership") return sealedIsMember ? { active: true } : null;
      throw new Error(`unexpected view ${method}`);
    }),
  } as unknown as NearClient;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, { proposalBondYocto: "1", proposalPeriodNs: "1", sealedOrdersId: SEALED } as OmniRolesConfig);
}

const desk: RoleDraft = {
  name: "desk",
  blocks: [{ kind: "swap", tokenIn: USDC, tokensOut: [BASE_SEPOLIA.weth!], protocols: ["uniswap-v3"], budget: { amount: "15", periodDays: 1 }, maxApproval: "20", sealedOrders: true }],
  members: [{ accountId: "new-agent.testnet", kind: "Agent" }],
};
const calls = (draft: { args: { proposal: { kind: unknown } } }) =>
  decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId)!.map((call) => (call.method === "queue_rule_change" ? call.change : call));

describe("editing a role", () => {
  it("keeps the edit fields through the route's validation", () => {
    const key = hexOf(allowanceKey("desk", "swap-1"));
    const parsed = roleDraftSchema.parse({ draft: { ...desk, keepBudgets: [key], revokeMembers: ["old.testnet"], clearSolanaPermissions: true } });
    expect(parsed.draft).toMatchObject({ keepBudgets: [key], revokeMembers: ["old.testnet"], clearSolanaPermissions: true });
  });

  it("does not re-grant the sealed-orders contract when it is already a member, and keeps unchanged budgets", async () => {
    const key = hexOf(allowanceKey("desk", "swap-1"));
    const edited = calls(await service(true).roleProposal("org-1", { ...desk, keepBudgets: [key], revokeMembers: ["old.testnet"] }));
    expect(edited.some((change) => "SetAllowance" in change)).toBe(false);
    expect(edited).toContainEqual({ RevokeMembership: { role: "desk", member: "old.testnet" } });
    expect(edited.filter((change) => "GrantMembership" in change).map((change) => (change as { GrantMembership: { member: string } }).GrantMembership.member)).toEqual(["new-agent.testnet"]);
    const created = calls(await service(false).roleProposal("org-1", desk));
    expect(created.filter((change) => "GrantMembership" in change).map((change) => (change as { GrantMembership: { member: string } }).GrantMembership.member)).toEqual(["new-agent.testnet", SEALED]);
  });
});
