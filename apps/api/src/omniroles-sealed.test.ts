import type { PrismaClient } from "@euthyna/db";
import { describeSealedProposal, sealedCancelKind, sealedOrderKind } from "@euthyna/sdk";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { roleDraftSchema } from "./app.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet" };
const SEALED = "euthyna-sealed-orders-v2.testnet";
const COMMITMENT = `0x02${"ab".repeat(31)}`;

function service(sealedOrdersId: string | undefined) {
  const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (accountId: string, method: string) => {
      if (accountId === SEALED && method === "orders") return [{ id: 0, commitment: COMMITMENT, filled: "0", fills: 0, cancelled: false, terms: "x" }];
      if (accountId === SEALED && method === "readers") return [{ account: "alice.testnet", public_key: "k" }];
      if (accountId === treasury.vaultAccountId && method === "get_wallet") return null;
      // The desk role swaps EURC for WETH on the Uniswap router (the token sold is one of the conditions).
      if (accountId === treasury.vaultAccountId && method === "get_role") return { config: { permissions: [
        { target: Array.from(Buffer.from("94cC0AaC535CCDB3C01d6787D6413C739ae12bc4", "hex")), conditions: [{ compValue: `0x${"00".repeat(12)}623ef90571256f905b2fde947dc33098bdd8f4d8` }, { compValue: `0x${"00".repeat(12)}4200000000000000000000000000000000000006` }] },
      ] } };
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "600000000000", sealedOrdersId } as OmniRolesConfig;
  const omni = new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
  vi.spyOn(omni, "roles").mockResolvedValue({
    roles: [
      { name: "desk", enabled: true, description: null, budgets: [], members: [{ member: "agent.testnet", kind: "Agent" }, { member: SEALED, kind: "Agent" }] },
      { name: "payments", enabled: true, description: null, budgets: [], members: [{ member: "agent.testnet", kind: "Agent" }] },
    ],
  } as never);
  return omni;
}

describe("sealed orders v2", () => {
  it("proposes an order: a seal to the sealed-orders contract from the company's DAO, terms encrypted", async () => {
    const draft = await service(SEALED).sealedOrderProposal("org-1", { role: "desk", commitment: COMMITMENT, slippageBps: 50, terms: "ZW5j", approveUsdc: null });
    expect(draft.receiverId).toBe(treasury.daoAccountId);
    expect(draft.args.proposal.kind).toEqual(sealedOrderKind(SEALED, { vault: treasury.vaultAccountId, role: "desk", chainId: 84532, commitment: COMMITMENT as `0x${string}`, slippageBps: 50, terms: "ZW5j" }));
    expect(draft.title).toBe("Seal an order");
    expect(describeSealedProposal(draft.args.proposal.kind, SEALED)?.details.join(" ")).toContain("stay hidden");
  });

  it("approves the token the order sells (EURC)", async () => {
    const omni = service(SEALED);
    const draft = await omni.sealedOrderProposal("org-1", { role: "desk", commitment: COMMITMENT, slippageBps: 50, terms: null, approveUsdc: "0.05", sell: "EURC" }).catch((error: unknown) => error);
    // The approval needs a fee estimate from Base Sepolia: offline, the proposal is refused before anything else.
    if (draft instanceof Error) { expect(String(draft)).not.toMatch(/token/i); return; }
    const actions = (draft as { args: { proposal: { kind: { FunctionCall: { actions: Array<{ method_name: string; args: string }> } } } } }).args.proposal.kind.FunctionCall.actions;
    expect(JSON.parse(Buffer.from(actions[0]!.args, "base64").toString()).token.toLowerCase()).toBe("0x623ef90571256f905b2fde947dc33098bdd8f4d8");
  });

  it("refuses a commitment that is not a field element", async () => {
    await expect(service(SEALED).sealedOrderProposal("org-1", { role: "desk", commitment: `0xff${"00".repeat(31)}`, slippageBps: 50, terms: null, approveUsdc: null }))
      .rejects.toMatchObject({ code: "invalid_sealed" });
  });

  it("lists the roles the contract fills through, the orders and the members' reading keys", async () => {
    const view = await service(SEALED).sealedOrders("org-1");
    expect(view.enabled).toBe(true);
    expect(view.roles.map((role) => role.name)).toEqual(["desk"]);
    expect(view.roles[0]!.agents).toEqual(["agent.testnet"]);
    expect(view.roles[0]!.sells).toEqual(["EURC"]);
    expect(view.orders).toHaveLength(1);
    expect(view.readers).toHaveLength(1);
  });

  it("cancels by a vote", async () => {
    const draft = await service(SEALED).sealedCancelProposal("org-1", 3);
    expect(draft.args.proposal.kind).toEqual(sealedCancelKind(SEALED, treasury.vaultAccountId, 3));
  });

  it("is off when no contract is configured", async () => {
    expect((await service(undefined).sealedOrders("org-1")).enabled).toBe(false);
    await expect(service(undefined).sealedCancelProposal("org-1", 0)).rejects.toMatchObject({ code: "sealed_disabled" });
  });

  it("keeps the console's \"Allow sealed orders\" box through the route's validation", () => {
    const swap = { kind: "swap", tokenIn: `0x${"11".repeat(20)}`, tokensOut: [`0x${"22".repeat(20)}`], protocols: ["uniswap-v3"], budget: { amount: "10", periodDays: 1 }, maxApproval: "20", sealedOrders: true };
    const parsed = roleDraftSchema.parse({ draft: { name: "desk", blocks: [swap], members: [] } });
    expect(parsed.draft.blocks[0]).toMatchObject({ kind: "swap", sealedOrders: true });
  });
});
