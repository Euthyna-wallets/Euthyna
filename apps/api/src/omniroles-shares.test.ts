import type { PrismaClient } from "@euthyna/db";
import { shareholdersRole, sharesProposalKinds } from "@euthyna/sdk/roles";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet" };
const SHARES = "acme-shares.mandateos.testnet";

function service(dao: { staking: string; roles: unknown[] }, sharesExist = true) {
  const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (accountId: string, method: string) => {
      if (method === "get_staking_contract") return dao.staking;
      if (method === "get_policy") return { roles: dao.roles };
      if (method === "info" && accountId === SHARES) return { dao_id: treasury.daoAccountId };
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
    getAccount: vi.fn(async (accountId: string) => {
      if (accountId === SHARES && sharesExist) return {};
      throw new Error("does not exist");
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "600000000000" } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

const council = { name: "council", kind: { Group: ["a.testnet", "b.testnet", "c.testnet"] }, permissions: [], vote_policy: {} };

describe("shares proposals", () => {
  it("proposes both votes on a fresh DAO, next to the vault", async () => {
    const { proposals } = await service({ staking: "", roles: [council] }).sharesProposals("org-1");
    expect(proposals.map((proposal) => proposal.args.proposal.kind)).toEqual(sharesProposalKinds(SHARES).map((vote) => vote.kind));
    expect(proposals.every((proposal) => proposal.receiverId === treasury.daoAccountId)).toBe(true);
  });

  it("proposes nothing once both votes passed", async () => {
    const { proposals } = await service({ staking: SHARES, roles: [council, shareholdersRole()] }).sharesProposals("org-1");
    expect(proposals).toEqual([]);
  });

  it("refuses when the DAO already counts votes from another contract", async () => {
    await expect(service({ staking: "other-staking.testnet", roles: [council] }).sharesProposals("org-1")).rejects.toMatchObject({ code: "staking_taken" });
  });

  it("checks the revenue amount", async () => {
    const omniroles = service({ staking: SHARES, roles: [council, shareholdersRole()] });
    await expect(omniroles.revenueProposal("org-1", "0")).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(omniroles.revenueProposal("org-1", "1,5")).rejects.toMatchObject({ code: "invalid_amount" });
    const draft = await omniroles.revenueProposal("org-1", "1.5");
    expect(draft.title).toBe("Share 1.5 NEAR with shareholders");
    expect(draft.args.proposal.kind).toMatchObject({ FunctionCall: { receiver_id: SHARES } });
  });

  it("does not deploy over an existing shares account", async () => {
    const draft = { name: "Acme", symbol: "ACME", totalSupply: 1000, priceNear: "0.01", allocations: [] };
    await expect(service({ staking: "", roles: [council] }).createShares("org-1", draft)).rejects.toMatchObject({ code: "shares_exist" });
  });
});
