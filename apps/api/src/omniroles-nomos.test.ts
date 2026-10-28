import type { PrismaClient } from "@mandateos/db";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";

const CODE_HASH = bs58.encode(Buffer.alloc(32, 7));
const OLD_HASH = bs58.encode(Buffer.alloc(32, 3));
const NOMOS = "nomos.euthyna.testnet";
const VAULT = `acme.${NOMOS}`;
const DAO = "acme.sputnikv2.testnet";

function setup(options: { daoMembers?: string[] | null; relayerYocto?: string } = {}) {
  const created = new Set<string>();
  let daoMembers = ["a.testnet", "b.testnet", "c.testnet"];
  if (options.daoMembers) {
    created.add(DAO);
    daoMembers = options.daoMembers;
  }
  const calls: Array<{ contract: string; method: string; args: Record<string, unknown>; deposit: string }> = [];
  const treasuries: unknown[] = [];
  const prisma = {
    member: {
      findMany: async () => ["a", "b", "c"].map((name, index) => ({
        id: `m${index}`,
        nearAccountId: `${name}.testnet`,
        user: { name },
      })),
    },
    treasury: {
      findUnique: async () => null,
      create: async ({ data }: { data: unknown }) => {
        treasuries.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  const near = {
    relayerAccountId: () => "relayer.testnet",
    getAccount: vi.fn(async (accountId: string) => {
      if (accountId === "relayer.testnet") return { amount: options.relayerYocto ?? "100000000000000000000000000" };
      if (created.has(accountId)) return { code_hash: CODE_HASH };
      throw new Error("does not exist");
    }),
    viewFunction: vi.fn(async (accountId: string, method: string) => {
      if (accountId === NOMOS && method === "versions") return [{ code_hash: OLD_HASH }, { code_hash: CODE_HASH }];
      if (accountId === NOMOS && method === "vault_deposit") return "7750000000000000000000000";
      if (accountId === DAO && method === "get_policy") return { roles: [{ kind: { Group: daoMembers } }] };
      if (accountId === VAULT && method === "owner_id") return DAO;
      if (accountId === VAULT && method === "code_source") return NOMOS;
      throw new Error(`unexpected view ${accountId}.${method}`);
    }),
    callFunction: vi.fn(async (contract: string, method: string, args: Record<string, unknown>, _gas: string, deposit: string) => {
      calls.push({ contract, method, args, deposit });
      if (method === "create") created.add(DAO);
      if (method === "create_vault") created.add(VAULT);
      return `tx-${method}`;
    }),
    executeActions: vi.fn(async () => {
      throw new Error("the vault must be created by Nomos, not deployed by the API");
    }),
  } as unknown as NearClient;
  const signer = { publicKey: async () => new Uint8Array(32) } as unknown as KmsSigner;
  const config = {
    nearNetwork: "testnet",
    daoFactoryId: "sputnikv2.testnet",
    nomosId: NOMOS,
    mpcContractId: "v1.signer-prod.testnet",
    daoCreateDepositYocto: "6000000000000000000000000",
    accountParent: "mandateos.testnet",
    ruleDelayNs: 300_000_000_000,
    ruleExpirationNs: 900_000_000_000,
    operationTtlNs: 600_000_000_000,
    proposalBondYocto: "100000000000000000000000",
    proposalPeriodNs: "604800000000000",
  } as OmniRolesConfig;
  return { service: new OmniRolesService(prisma, near, signer, signer, config), calls, treasuries, near };
}

describe("company creation through Sputnik and Nomos", () => {
  it("plans the DAO on Sputnik and the vault under Nomos, pinned to the latest version", async () => {
    const { service } = setup();
    const plan = await service.plan("org-1", "Acme");
    expect(plan.daoAccountId).toBe(DAO);
    expect(plan.vaultAccountId).toBe(VAULT);
    expect(plan.vaultWasmSha256).toBe("07".repeat(32));
  });

  it("creates the DAO, then asks Nomos for a keyless vault owned by it", async () => {
    const { service, calls, treasuries, near } = setup();
    await service.create("org-1", "Acme");
    expect(calls.map((call) => `${call.contract}.${call.method}`)).toEqual(["sputnikv2.testnet.create", `${NOMOS}.create_vault`]);
    const vault = calls[1]!;
    expect(vault.args.name).toBe("acme");
    expect(vault.args.code_hash).toBe(CODE_HASH);
    expect(vault.deposit).toBe("7750000000000000000000000");
    const init = JSON.parse(Buffer.from(String(vault.args.args), "base64").toString());
    expect(init.owner_id).toBe(DAO);
    expect(init.council).toEqual(["a.testnet", "b.testnet", "c.testnet"]);
    expect(near.executeActions).not.toHaveBeenCalled();
    expect(treasuries).toEqual([expect.objectContaining({ daoAccountId: DAO, vaultAccountId: VAULT, vaultWasmSha256: "07".repeat(32) })]);
  });

  it("resumes after a failed vault: reuses the company's own DAO", async () => {
    const { service, calls, treasuries } = setup({ daoMembers: ["c.testnet", "a.testnet", "b.testnet"] });
    const result = await service.create("org-1", "Acme");
    expect(result.daoTransaction).toBe("existing");
    expect(calls.map((call) => call.method)).toEqual(["create_vault"]);
    expect(treasuries).toHaveLength(1);
  });

  it("refuses a DAO name governed by other members", async () => {
    const { service, calls } = setup({ daoMembers: ["mallory.testnet"] });
    await expect(service.create("org-1", "Acme")).rejects.toMatchObject({ code: "account_taken" });
    expect(calls).toEqual([]);
  });

  it("stops before spending anything when the relayer cannot pay for both", async () => {
    const { service, calls } = setup({ relayerYocto: "10000000000000000000000000" });
    await expect(service.create("org-1", "Acme")).rejects.toMatchObject({ code: "relayer_low_funds" });
    expect(calls).toEqual([]);
  });
});

describe("vault upgrades", () => {
  function upgradeSetup(freeYocto: bigint) {
    const transfers: string[] = [];
    const treasury = { id: "t1", organizationId: "org-1", daoAccountId: DAO, vaultAccountId: VAULT, baseChainId: 84532, status: "active" };
    const prisma = { treasury: { findUnique: async () => treasury } } as unknown as PrismaClient;
    const storage = 700_000;
    const near = {
      getAccount: vi.fn(async () => ({ code_hash: OLD_HASH, amount: (BigInt(storage) * 10n ** 19n + freeYocto).toString(), storage_usage: storage })),
      viewFunction: vi.fn(async (accountId: string, method: string) => {
        if (accountId === VAULT && method === "code_source") return NOMOS;
        if (accountId === NOMOS && method === "versions") {
          return [
            { code_hash: OLD_HASH, size: 700_000, notes: "", published_at_ns: "1790000000000000000" },
            { code_hash: CODE_HASH, size: 800_000, notes: "Solana", published_at_ns: "1793000000000000000" },
          ];
        }
        throw new Error(`unexpected view ${accountId}.${method}`);
      }),
      executeActions: vi.fn(async (_accountId: string, actions: Array<{ depositYocto: string }>) => {
        transfers.push(actions[0]!.depositYocto);
        return "tx";
      }),
    } as unknown as NearClient;
    const config = { nomosId: NOMOS, proposalBondYocto: "100000000000000000000000", proposalPeriodNs: "604800000000000" } as OmniRolesConfig;
    return { service: new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, config), transfers };
  }

  it("lists the published versions, newest first, and marks the running one", async () => {
    const versions = await upgradeSetup(10n ** 24n).service.versions("org-1");
    expect(versions).toMatchObject({ current: OLD_HASH, latest: CODE_HASH, upgradable: true });
    expect(versions.versions.map((version) => [version.index, version.current])).toEqual([[2, false], [1, true]]);
  });

  it("tops the vault up for the bigger code, then drafts the Upgrade vote", async () => {
    const { service, transfers } = upgradeSetup(10n ** 23n); // 0.1 NEAR free, 1 NEAR more needed
    const draft = await service.upgradeProposal("org-1", CODE_HASH);
    expect(transfers).toHaveLength(1);
    expect(BigInt(transfers[0]!)).toBeGreaterThan(10n ** 24n);
    expect(draft.title).toBe("Upgrade the vault to version 2 (Solana)");
    expect(atob(draft.args.proposal.kind.FunctionCall.actions[0]!.args)).toContain(CODE_HASH);
  });

  it("refuses the running version and unknown hashes", async () => {
    const { service } = upgradeSetup(10n ** 25n);
    await expect(service.upgradeProposal("org-1", OLD_HASH)).rejects.toMatchObject({ code: "already_current" });
    await expect(service.upgradeProposal("org-1", bs58.encode(Buffer.alloc(32, 9)))).rejects.toMatchObject({ code: "unknown_version" });
  });
});
