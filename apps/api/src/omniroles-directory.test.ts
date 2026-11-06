import type { PrismaClient } from "@euthyna/db";
import { registryProposalKind } from "@euthyna/sdk/roles";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet" };
const SHARES = "acme-shares.mandateos.testnet";

function service(registryId: string | undefined, sharesDao = treasury.daoAccountId) {
  const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (accountId: string, method: string) => {
      if (accountId === SHARES && method === "info") return { dao_id: sharesDao };
      if (method === "get_company") return null;
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "600000000000", registryId } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

describe("public directory", () => {
  it("proposes a listing with the company's own vault and shares", async () => {
    const draft = await service("registry.testnet").registryProposal("org-1", { name: "Acme AI", description: "Pentest on demand" });
    expect(draft.receiverId).toBe(treasury.daoAccountId);
    expect(draft.args.proposal.kind).toEqual(registryProposalKind("registry.testnet", { vaultAccountId: treasury.vaultAccountId, sharesAccountId: SHARES, name: "Acme AI", description: "Pentest on demand" }));
  });

  it("leaves out a shares contract that belongs to another DAO", async () => {
    const directory = await service("registry.testnet", "other.factory.testnet").directory("org-1");
    expect(directory.sharesAccountId).toBeNull();
  });

  it("refuses when no directory is configured", async () => {
    await expect(service(undefined).registryProposal("org-1", { name: "Acme", description: "" })).rejects.toMatchObject({ code: "registry_disabled" });
  });
});
