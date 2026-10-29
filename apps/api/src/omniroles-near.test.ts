import type { PrismaClient } from "@mandateos/db";
import { BASE_SEPOLIA, compileRole, decodeVaultCalls, NEAR_TESTNET_TOKENS, type RoleDraft } from "@mandateos/sdk/roles";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { cardOwner, nearTransferSummary, OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const treasury = { organizationId: "org-1", daoAccountId: "acme.factory.testnet", vaultAccountId: "acme-vault.mandateos.testnet", baseChainId: 84532 };
const LARRY = "larry-09d0b2-agent.mandateos.testnet";
const CARD = "larry-09d0b2-card.mandateos.testnet";
const USDC = NEAR_TESTNET_TOKENS[0]!;

function service(options: { legacy?: boolean; existing?: unknown[]; balances?: Record<string, string>; executed?: unknown[] } = {}) {
  const prisma = {
    treasury: { findUnique: async () => treasury },
    supplierWallet: { findMany: async () => [] },
    agent: { findMany: async () => [{ name: "Larry", nearAccountId: LARRY, active: true }] },
  } as unknown as PrismaClient;
  const near = {
    viewFunction: vi.fn(async (account: string, method: string, args: Record<string, string>) => {
      if (method === "get_near_permissions") {
        if (options.legacy) throw new Error("MethodNotFound");
        return options.existing ?? [];
      }
      if (method === "list_rule_changes") return (options.executed ?? []).slice().reverse().map((change) => ({ change, state: "Executed" }));
      if (method === "get_role") return { config: { enabled: true } };
      if (method === "get_allowance") return { balance: "10000000", reserved: "0", max_refill: "10000000", period_ns: 86_400_000_000_000 };
      if (method === "ft_balance_of") return options.balances?.[`${account}:${args.account_id}`] ?? "0";
      throw new Error(`unexpected view ${method}`);
    }),
  } as unknown as NearClient;
  const config = { proposalBondYocto: "1", proposalPeriodNs: "1" } as OmniRolesConfig;
  return new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config);
}

const refill: RoleDraft = {
  name: "card-refill",
  blocks: [{ kind: "near-transfer", token: "USDC", receivers: [{ accountId: CARD, label: "Larry's card" }], budget: { amount: "10", periodDays: 1 }, maxPerTransfer: "5" }],
  members: [{ accountId: LARRY, kind: "Agent" }],
};
const evmOnly: RoleDraft = { name: "card-refill", blocks: [{ kind: "wrap", budget: { amount: "0.1", periodDays: 1 } }], members: [] };
const kinds = (draft: { args: { proposal: { kind: unknown } } }) =>
  decodeVaultCalls(draft.args.proposal.kind as Parameters<typeof decodeVaultCalls>[0], treasury.vaultAccountId)!
    .map((call) => (call.method === "queue_rule_change" ? Object.keys(call.change)[0] : call.method));

describe("NEAR transfer roles", () => {
  it("drafts the registration and the permissions", async () => {
    const draft = await service().roleProposal("org-1", refill);
    expect(kinds(draft)).toEqual(["SetAllowance", "SetRole", "GrantMembership", "NearStorageDeposit", "SetNearPermissions"]);
  });

  it("refuses a NEAR block on a vault that cannot send NEAR tokens", async () => {
    await expect(service({ legacy: true }).roleProposal("org-1", refill)).rejects.toMatchObject({ code: "invalid_role", message: expect.stringMatching(/upgrade/) });
  });

  it("clears NEAR permissions the role had when the edit drops them, and only then", async () => {
    expect(kinds(await service({ existing: [{ token: USDC.accountId }] }).roleProposal("org-1", evmOnly))).toContain("SetNearPermissions");
    expect(kinds(await service().roleProposal("org-1", evmOnly))).not.toContain("SetNearPermissions");
    // Older vaults never get the change they do not know.
    expect(kinds(await service({ legacy: true }).roleProposal("org-1", evmOnly))).not.toContain("SetNearPermissions");
  });

  it("ignores a clear flag sent by the client", async () => {
    const draft = await service().roleProposal("org-1", { ...evmOnly, clearNearPermissions: true });
    expect(kinds(draft)).not.toContain("SetNearPermissions");
  });
});

describe("NEAR holdings and activity", () => {
  it("reads the vault's and the cards' token balances", async () => {
    const holdings = await service({ balances: { [`${USDC.accountId}:${treasury.vaultAccountId}`]: "25000000", [`${USDC.accountId}:${CARD}`]: "3500000" } }).holdings("org-1").catch((error: unknown) => error);
    // holdings() also reads EVM and Solana; the NEAR part is what matters here.
    const near = (holdings as { chains?: Array<{ chain: string; assets: unknown[] }> }).chains?.find((chain) => chain.chain === "NEAR testnet");
    expect(near?.assets).toEqual([
      { symbol: "USDC", amount: "25", where: "vault", usd: 25 },
      { symbol: "USDC", amount: "3.5", where: "Larry's card", usd: 3.5 },
    ]);
  });

  it("names card refills and plain transfers", () => {
    const agents = [{ name: "Larry", nearAccountId: LARRY }];
    expect(nearTransferSummary({ amount: "5000000", receiver_id: CARD }, USDC, cardOwner(CARD, agents))).toBe("Refilled Larry's card with 5 USDC");
    expect(nearTransferSummary({ amount: "1250000", receiver_id: "bob.testnet" }, USDC, cardOwner("bob.testnet", agents))).toBe("Sent 1.25 USDC to bob.testnet");
  });
});

describe("NEAR rights in the roles view", () => {
  it("lists what the role may send on NEAR and its budget", async () => {
    const executed = compileRole(refill, BASE_SEPOLIA);
    const { roles } = await service({ executed }).roles("org-1");
    const [role] = roles;
    expect(role!.description!.details).toContain(`Send USDC on NEAR to ${CARD}, from 0.1 USDC to 5 USDC per transfer, within budget "card-refill NEAR transfers"`);
    expect(role!.budgets).toEqual([expect.objectContaining({ token: "USDC", available: "10", max: "10", periodDays: 1 })]);
  });

  it("forgets NEAR rights once the role was deleted, even if it is created again", async () => {
    const executed = [...compileRole(refill, BASE_SEPOLIA), { RemoveRole: { role: "card-refill" } }, ...compileRole(evmOnly, BASE_SEPOLIA)];
    const { roles } = await service({ executed }).roles("org-1");
    expect(roles[0]!.description!.details.some((detail) => detail.includes("on NEAR"))).toBe(false);
  });
});
