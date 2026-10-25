import type { PrismaClient } from "@mandateos/db";
import { proceedsToEvmKinds } from "@mandateos/sdk/roles";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet", baseChainId: 84532 };
const WALLET = "0x834e5A4d6685E2B14189136Aca6fDe051266ef30";
const PER_ACCOUNT = "1250000000000000000000";
const PER_TRANSFER = "2000000000000000000000";
const FEE = "2183406114039459266024";

function service(daoBalance = "5000000000000000000000000", wallet: string | null = WALLET) {
  const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (accountId: string, method: string, args: { account_id?: string }) => {
      if (method === "get_wallet") return wallet ? { address: [...Buffer.from(wallet.slice(2), "hex")] } : null;
      if (method === "get_policy") return { roles: [{ kind: { Group: ["a.testnet", "b.testnet"] } }] };
      if (method === "required_balance_for_account") return PER_ACCOUNT;
      if (method === "required_balance_for_init_transfer") return PER_TRANSFER;
      if (method === "storage_balance_of") return args.account_id === "a.testnet" ? { total: "1", available: "0" } : null;
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
    getAccount: vi.fn(async () => ({ amount: daoBalance })),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "600000000000" } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

afterEach(() => vi.unstubAllGlobals());

describe("sale proceeds to the company wallet", () => {
  it("proposes the bridge storage, then the transfer to the company wallet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ transferred_token_fee: FEE, native_token_fee: "0" }))));
    const result = await service().proceedsProposals("org-1", { chainId: 84532, amountNear: "0.1" });
    const expected = proceedsToEvmKinds({
      daoAccountId: treasury.daoAccountId, chainId: 84532, wallet: WALLET, amountYocto: "100000000000000000000000",
      feeYocto: FEE, membersToRegister: ["b.testnet"], perAccountYocto: PER_ACCOUNT, perTransferYocto: PER_TRANSFER,
    });
    expect(result.proposals.map((proposal) => proposal.args.proposal.kind)).toEqual([expected.storage, expected.transfer]);
    expect(result.messageAccount).toBe(expected.messageAccount);
    expect(result.proposals[1]!.title).toBe("Send 0.1 NEAR to the company wallet on Base Sepolia");
  });

  it("refuses without a company wallet, an unknown chain, or a short DAO", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ transferred_token_fee: FEE }))));
    await expect(service(undefined, null).proceedsProposals("org-1", { chainId: 84532, amountNear: "0.1" })).rejects.toMatchObject({ code: "wallet_missing" });
    await expect(service().proceedsProposals("org-1", { chainId: 1, amountNear: "0.1" })).rejects.toMatchObject({ code: "unsupported_chain" });
    await expect(service("150000000000000000000000").proceedsProposals("org-1", { chainId: 84532, amountNear: "0.1" })).rejects.toMatchObject({ code: "dao_balance_low" });
    await expect(service().proceedsProposals("org-1", { chainId: 84532, amountNear: "0" })).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("stops when the bridge fee API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(service().proceedsProposals("org-1", { chainId: 84532, amountNear: "0.1" })).rejects.toMatchObject({ code: "bridge_fee_unavailable" });
  });
});
