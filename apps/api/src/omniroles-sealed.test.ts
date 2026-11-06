import type { PrismaClient } from "@euthyna/db";
import { describeSealedProposal, sealedSealKind } from "@euthyna/sdk";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet" };
const SEALED = "euthyna-sealed-orders.testnet";
const COMMITMENT = `0x02${"ab".repeat(31)}`;

function service(sealedOrdersId: string | undefined) {
  const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (accountId: string, method: string) => {
      if (accountId === SEALED && method === "config") return { vault: treasury.vaultAccountId, role: "sealed-orders", next_id: 1 };
      if (accountId === SEALED && method === "orders") return [{ id: 0, commitment: COMMITMENT, filled: "0", fills: 0, cancelled: false }];
      if (accountId === treasury.vaultAccountId && (method === "get_role" || method === "get_membership")) return { enabled: true };
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "600000000000", sealedOrdersId } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

describe("sealed orders", () => {
  it("proposes a seal: one hash to the sealed-orders contract, from the company's DAO", async () => {
    const draft = await service(SEALED).sealedSealProposal("org-1", COMMITMENT);
    expect(draft.receiverId).toBe(treasury.daoAccountId);
    expect(draft.args.proposal.kind).toEqual(sealedSealKind(SEALED, COMMITMENT as `0x${string}`));
    expect(draft.title).toBe("Seal an order");
    expect(describeSealedProposal(draft.args.proposal.kind, SEALED)?.details.join(" ")).toContain("stay hidden");
  });

  it("refuses a commitment that is not a field element", async () => {
    await expect(service(SEALED).sealedSealProposal("org-1", `0xff${"00".repeat(31)}`)).rejects.toMatchObject({ code: "invalid_sealed" });
  });

  it("reads what the chain shows: a hash, what was filled, whether the role is ready", async () => {
    const view = await service(SEALED).sealedOrders("org-1");
    expect(view.enabled).toBe(true);
    expect(view.roleReady).toBe(true);
    expect(view.orders).toHaveLength(1);
  });

  it("is off when no contract is configured", async () => {
    expect((await service(undefined).sealedOrders("org-1")).enabled).toBe(false);
    await expect(service(undefined).sealedSealProposal("org-1", COMMITMENT)).rejects.toMatchObject({ code: "sealed_disabled" });
  });
});
