import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@mandateos/db";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import {
  assertDelayPolicy,
  TreasuryError,
  TreasuryService,
  type BaseTreasuryVerifier,
  type TreasuryConfig,
} from "./treasury.js";

const artifactsDir = fileURLToPath(new URL("../../../contracts/res", import.meta.url));
const govAddress = getAddress("0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025");
const govPublicKey = "secp256k1:jCrfJ5wjMBroDh6Mefb1bohaBtzE9me5MaKEhmfmFqK5CudvdSWviXXxfowdtttqh9KWN3zNK9QQu5kq8FfXBK8";

const config: TreasuryConfig = {
  nearNetwork: "testnet",
  daoFactoryId: "sputnikv2.testnet",
  mpcContractId: "v1.signer-prod.testnet",
  mpcPath: "governance/base-sepolia",
  budgetTokenAccountId: "test-ft.testnet",
  artifactsDir,
  accountParent: "mandateos.testnet",
  environments: {
    uat: {
      baseChainId: 84532,
      baseRpcUrl: "http://127.0.0.1:8545",
      delayCooldownSeconds: 300n,
      delayExpirationSeconds: 604_800n,
    },
    production: {
      baseChainId: 8453,
      baseRpcUrl: "http://127.0.0.1:8546",
      delayCooldownSeconds: 86_400n,
      delayExpirationSeconds: 604_800n,
    },
  },
  vaultTtlBlocks: 50,
  vaultDepositYocto: "10000000000000000000000000",
  relayDepositYocto: "10000000000000000000000000",
  daoCreateDepositYocto: "10000000000000000000000000",
};

type TestMember = {
  id: string;
  nearAccountId: string | null;
  evmAddress: string | null;
  walletProofVerifiedAt: Date | null;
};

const provedAt = new Date("2026-01-01T00:00:00.000Z");
const members: TestMember[] = [
  { id: "m1", nearAccountId: "alice.testnet", evmAddress: "0x1111111111111111111111111111111111111111", walletProofVerifiedAt: provedAt },
  { id: "m2", nearAccountId: "bob.testnet", evmAddress: "0x2222222222222222222222222222222222222222", walletProofVerifiedAt: provedAt },
  { id: "m3", nearAccountId: "carol.testnet", evmAddress: "0x3333333333333333333333333333333333333333", walletProofVerifiedAt: provedAt },
];

function fakePrisma(options?: {
  members?: TestMember[];
  existingTreasury?: Record<string, unknown>;
  confirmedMemberIds?: string[];
}) {
  const created: unknown[] = [];
  const audits: unknown[] = [];
  const prisma = {
    member: {
      findMany: async (args?: { where?: { walletProofVerifiedAt?: { not: null } } }) => {
        const configured = options?.members ?? members;
        return args?.where?.walletProofVerifiedAt ? configured.filter((member) => member.walletProofVerifiedAt) : configured;
      },
      findFirst: async () => ({ id: "m1" }),
      update: async () => ({ id: "m1" }),
    },
    treasury: {
      findUnique: async () => options?.existingTreasury ?? null,
      update: async ({ data }: { data: unknown }) => ({
        ...(options?.existingTreasury ?? {}),
        ...(data as Record<string, unknown>),
        id: "treasury-1",
      }),
      create: async ({ data }: { data: unknown }) => {
        created.push(data);
        return {
          ...(data as Record<string, unknown>),
          id: "treasury-1",
        };
      },
    },
    auditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
      },
    },
    treasuryDeploymentConfirmation: {
      findMany: async () => (options?.confirmedMemberIds ?? (options?.members ?? members)
        .filter((member) => member.walletProofVerifiedAt)
        .map((member) => member.id))
        .map((memberId) => ({ memberId })),
      upsert: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
  return { prisma, created, audits };
}

type NearOverrides = {
  vaultOwner?: string;
  codeHashes?: Record<string, string>;
  globalDaoHash?: string;
  policy?: unknown;
  autoUpdate?: boolean;
  vault?: { mpc?: string; chain?: number; guard?: string; token?: string; ttl?: number };
  relay?: { client?: string; mpc?: string; path?: string; chain?: number; delay?: string; multisend?: string; guard?: string };
};

const daoAccountId = "acme.sputnikv2.testnet";
const vaultAccountId = "acme-vault.alice.testnet";
const relayAccountId = "acme-relay.alice.testnet";
const guardKeyBase64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const multiSendAddress = getAddress("0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526");
const multiSendCallOnlyAddress = getAddress("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");

function councilPolicy() {
  return {
    roles: [
      {
        name: "council",
        kind: { Group: members.map((member) => member.nearAccountId) },
        permissions: ["*:AddProposal", "*:VoteApprove"],
      },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" },
  };
}

function fakeNear(overrides?: NearOverrides): NearClient {
  return {
    derivedPublicKey: async () => govPublicKey,
    getAccount: async (accountId: string) => ({
      code_hash: overrides?.codeHashes?.[accountId] ?? "factory-hash",
      amount: "0",
      ...(accountId === daoAccountId && overrides?.globalDaoHash
        ? { global_contract_hash: overrides.globalDaoHash }
        : {}),
    }),
    getAccessKeys: async () => ({ keys: [] }),
    viewFunction: async (accountId: string, method: string) => {
      const isVault = accountId === vaultAccountId;
      if (method === "get_default_code_hash") return "factory-hash";
      if (method === "get_policy") return overrides?.policy ?? councilPolicy();
      if (method === "get_factory_info") return { factory_id: "sputnikv2.testnet", auto_update: overrides?.autoUpdate ?? false };
      if (method === "owner_id") return overrides?.vaultOwner ?? daoAccountId;
      if (method === "delay_address") return overrides?.relay?.delay ?? Buffer.from(basePlan.delayAddress.slice(2), "hex").toString("base64");
      if (method === "client_id") return overrides?.relay?.client ?? "acme";
      if (method === "multisend_address") return overrides?.relay?.multisend ?? Buffer.from(multiSendCallOnlyAddress.slice(2), "hex").toString("base64");
      if (method === "mpc_contract_id") {
        return isVault ? (overrides?.vault?.mpc ?? config.mpcContractId) : (overrides?.relay?.mpc ?? config.mpcContractId);
      }
      if (method === "mpc_path") return overrides?.relay?.path ?? config.mpcPath;
      if (method === "evm_chain_id") return isVault ? (overrides?.vault?.chain ?? 84532) : (overrides?.relay?.chain ?? 84532);
      if (method === "guard_public_key") {
        return isVault ? (overrides?.vault?.guard ?? guardKeyBase64) : (overrides?.relay?.guard ?? guardKeyBase64);
      }
      if (method === "token_id") return overrides?.vault?.token ?? config.budgetTokenAccountId;
      if (method === "reservation_ttl_blocks") return overrides?.vault?.ttl ?? config.vaultTtlBlocks;
      throw new Error(`unexpected view ${accountId}.${method}`);
    },
  } as unknown as NearClient;
}

const signer: KmsSigner = {
  sign: async () => new Uint8Array(64),
  publicKey: async () => new Uint8Array(32).fill(7),
};

const basePlan = {
  chainId: 84532,
  safeAddress: getAddress("0x4444444444444444444444444444444444444444"),
  rolesAddress: getAddress("0x5555555555555555555555555555555555555555"),
  delayAddress: getAddress("0x6666666666666666666666666666666666666666"),
  multiSendAddress,
  multiSendCallOnlyAddress,
  safeDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "safe" },
  rolesDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "roles" },
  delayDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "delay" },
  safeModuleCalls: [],
  saltNonces: { safe: "1", roles: "2", delay: "3" },
};

const verifier: BaseTreasuryVerifier = { verify: async () => undefined };

function service(prisma: PrismaClient, near: NearClient = fakeNear(), baseVerifier = verifier) {
  return new TreasuryService(prisma, near, signer, config, async () => basePlan, () => baseVerifier);
}

describe("TreasuryService.plan", () => {
  it("derives 0xGOV from the relay path and builds the three-lock plan", async () => {
    const { prisma } = fakePrisma();
    const plan = await service(prisma).plan("org-1", {
      environment: "uat",
      daoName: "Acme Treasury",
      founderNearAccountId: "alice.testnet",
    });

    expect(plan.daoAccountId).toBe("acme-treasury.sputnikv2.testnet");
    expect(plan.threshold).toBe(2);
    expect(plan.govAddress).toBe(govAddress);
    expect(plan.vault.accountId).toBe("acme-tre-v.mandateos.testnet");
    expect(plan.vault.initArgs.owner_id).toBe(plan.daoAccountId);
    expect(plan.relay.initArgs.owner_id).toBe(plan.daoAccountId);
    expect(plan.relay.initArgs.delay_address).toBe(Buffer.from(basePlan.delayAddress.slice(2), "hex").toString("base64"));
    expect(plan.relay.initArgs.multisend_address).toBe(Buffer.from(multiSendCallOnlyAddress.slice(2), "hex").toString("base64"));
    expect(plan.relay.initArgs.guard_public_key).toBe(guardKeyBase64);
    expect(plan.base.safeAddress).toBe(basePlan.safeAddress);
    expect(plan.vault.actions.map((action) => action.type)).toEqual([
      "CreateAccount",
      "Transfer",
      "DeployContract",
      "FunctionCall",
    ]);
    expect(plan.vault.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not create a redundant separator when the eight-character prefix ends in a dash", async () => {
    const { prisma } = fakePrisma();
    const plan = await service(prisma).plan("org-1", {
      environment: "uat",
      daoName: "Factory UI Org",
      founderNearAccountId: "alice.testnet",
    });
    expect(plan.vault.accountId).toBe("factory-v.mandateos.testnet");
    expect(plan.relay.accountId).toBe("factory-r.mandateos.testnet");
  });

  it("refuses a proven council member missing a wallet", async () => {
    const { prisma } = fakePrisma({
      members: [{ ...members[0]!, evmAddress: null }],
    });
    await expect(
      service(prisma).plan("org-1", {
        environment: "uat",
        daoName: "acme",
        founderNearAccountId: "alice.testnet",
      }),
    ).rejects.toMatchObject({ code: "proven_wallets_missing" });
  });

  it("excludes an admin-declared member without wallet signatures from the council", async () => {
    const pending = {
      id: "m4",
      nearAccountId: "mallory.testnet",
      evmAddress: "0x4444444444444444444444444444444444444444",
      walletProofVerifiedAt: null,
    };
    const { prisma } = fakePrisma({ members: [...members, pending] });
    const plan = await service(prisma).plan("org-1", {
      environment: "uat",
      daoName: "acme",
      founderNearAccountId: "alice.testnet",
    });
    expect(plan.council.map((member) => member.memberId)).toEqual(["m1", "m2", "m3"]);
    expect(plan.threshold).toBe(2);
  });
});

async function artifactHashes() {
  const hash = async (name: string) =>
    bs58.encode(createHash("sha256").update(await readFile(resolve(artifactsDir, name))).digest());
  return {
    [vaultAccountId]: await hash("vault.wasm"),
    [relayAccountId]: await hash("governance_relay.wasm"),
  };
}

const registerInput = {
  environment: "uat",
  daoAccountId,
  vaultAccountId,
  relayAccountId,
  safeAddress: basePlan.safeAddress,
  rolesAddress: basePlan.rolesAddress,
  delayAddress: basePlan.delayAddress,
  govAddress,
};

describe("TreasuryService.register", () => {
  it("verifies the NEAR accounts and persists the treasury", async () => {
    const { prisma, created, audits } = fakePrisma();
    const near = fakeNear({ codeHashes: await artifactHashes() });
    const treasury = await service(prisma, near).register("org-1", "user-1", registerInput);
    expect(treasury.daoAccountId).toBe(registerInput.daoAccountId);
    expect(created).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({ action: "treasury.registered", actorId: "user-1" }),
    ]);
  });

  it("requires the Vault owner to be the DAO", async () => {
    const { prisma } = fakePrisma();
    const near = fakeNear({ vaultOwner: "someone-else.testnet", codeHashes: await artifactHashes() });
    await expect(service(prisma, near).register("org-1", "user-1", registerInput)).rejects.toMatchObject({
      code: "vault_owner_mismatch",
    });
  });

  it("refuses a Vault code hash that does not match the artifact", async () => {
    const { prisma } = fakePrisma();
    const near = fakeNear({ codeHashes: { [vaultAccountId]: "wrong", [relayAccountId]: "wrong" } });
    await expect(service(prisma, near).register("org-1", "user-1", registerInput)).rejects.toMatchObject({
      code: "wasm_hash_mismatch",
    });
  });

  it("refuses registration until every proven member confirms the deployment digest", async () => {
    const { prisma } = fakePrisma({ confirmedMemberIds: ["m1", "m2"] });
    await expect(
      service(prisma, fakeNear({ codeHashes: await artifactHashes() }))
        .register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "deployment_confirmations_missing" });
  });
});


async function validNear(overrides?: NearOverrides) {
  return fakeNear({ codeHashes: await artifactHashes(), ...overrides });
}

describe("TreasuryService.refresh", () => {
  const existing = {
    id: "treasury-1",
    organizationId: "org-1",
    environment: "uat",
    nearNetwork: "testnet",
    baseChainId: 84532,
    daoAccountId,
    vaultAccountId,
    relayAccountId,
    safeAddress: basePlan.safeAddress,
    rolesAddress: basePlan.rolesAddress,
    delayAddress: basePlan.delayAddress,
    govAddress,
    vaultWasmSha256: "old",
    relayWasmSha256: "old",
    status: "pending_dao_hardening",
  };

  it("re-runs verification and flips pending_dao_hardening to active", async () => {
    const { prisma, audits } = fakePrisma({ existingTreasury: existing });
    const treasury = await service(prisma, await validNear()).refresh("org-1", "user-1", "uat");
    expect(treasury.status).toBe("active");
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "treasury.refreshed", metadata: expect.objectContaining({ from: "pending_dao_hardening", to: "active" }) }),
    );
  });

  it("keeps the treasury active and records a warning while auto-update is enabled", async () => {
    const { prisma, audits } = fakePrisma({ existingTreasury: existing });
    const treasury = await service(prisma, await validNear({ autoUpdate: true })).refresh("org-1", "user-1", "uat");
    expect(treasury.status).toBe("active");
    expect(audits).toContainEqual(expect.objectContaining({
      action: "treasury.refreshed",
      metadata: expect.objectContaining({ warnings: ["dao_auto_update_enabled"] }),
    }));
  });

  it("returns 404 when no treasury exists", async () => {
    const { prisma } = fakePrisma();
    await expect(service(prisma).refresh("org-1", "user-1", "uat")).rejects.toMatchObject({
      status: 404,
      code: "treasury_missing",
    });
  });
});

describe("TreasuryService.register hardening", () => {
  it("registers an immutable global DAO as active and records auto-update as a warning", async () => {
    const { prisma, created, audits } = fakePrisma();
    const treasury = await service(prisma, await validNear({ autoUpdate: true })).register(
      "org-1",
      "user-1",
      registerInput,
    );
    expect(treasury.status).toBe("active");
    expect(created).toEqual([expect.objectContaining({ status: "active" })]);
    expect(audits).toContainEqual(expect.objectContaining({
      action: "treasury.registered",
      metadata: expect.objectContaining({ warnings: ["dao_auto_update_enabled"] }),
    }));
  });

  it("rejects a DAO whose code hash is not the factory default", async () => {
    const { prisma } = fakePrisma();
    const near = await validNear({ codeHashes: { ...(await artifactHashes()), [daoAccountId]: "other-hash" } });
    await expect(service(prisma, near).register("org-1", "user-1", registerInput)).rejects.toMatchObject({
      code: "dao_code_hash_mismatch",
    });
  });

  it("accepts an immutable global DAO hash matching the factory default", async () => {
    const { prisma } = fakePrisma();
    const near = await validNear({
      codeHashes: { ...(await artifactHashes()), [daoAccountId]: "11111111111111111111111111111111" },
      globalDaoHash: "factory-hash",
    });
    await expect(service(prisma, near).register("org-1", "user-1", registerInput)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("rejects more than one council role", async () => {
    const { prisma } = fakePrisma();
    const base = councilPolicy();
    const policy = {
      ...base,
      roles: [...base.roles, { ...base.roles[0], name: "council" }],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_council_role_count" });
  });

  it("rejects a council that does not match the organization members", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      roles: [{ ...councilPolicy().roles[0], kind: { Group: ["alice.testnet", "bob.testnet"] } }],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_council_mismatch" });
  });

  it("rejects a non-absolute or wrong threshold", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "3" },
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_threshold_mismatch" });
  });

  it("rejects an extra mono-member role that carries a voting permission", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      roles: [
        ...councilPolicy().roles,
        {
          name: "solo",
          kind: { Group: ["alice.testnet"] },
          permissions: ["*:AddProposal", "*:VoteApprove"],
          vote_policy: {},
        },
      ],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_extra_voting_role" });
  });

  it("rejects a council VotePolicy that lowers the Transfer threshold", async () => {
    const { prisma } = fakePrisma();
    const base = councilPolicy();
    const policy = {
      ...base,
      roles: [
        {
          ...base.roles[0],
          vote_policy: {
            Transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "1" },
          },
        },
      ],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_vote_policy_threshold" });
  });

  it("accepts a council VotePolicy that keeps the expected threshold", async () => {
    const { prisma } = fakePrisma();
    const base = councilPolicy();
    const policy = {
      ...base,
      roles: [
        {
          ...base.roles[0],
          vote_policy: {
            Transfer: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" },
          },
        },
      ],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("rejects a non-RoleWeight default vote policy", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      default_vote_policy: { weight_kind: "Ratio", quorum: "0", threshold: "2" },
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_weight_kind" });
  });

  it("rejects a non-zero quorum", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "1", threshold: "2" },
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_weight_kind" });
  });

  it("rejects a policy that grants AddProposal to Everyone", async () => {
    const { prisma } = fakePrisma();
    const policy = {
      ...councilPolicy(),
      roles: [
        ...councilPolicy().roles,
        { name: "open", kind: "Everyone", permissions: ["*:AddProposal"] },
      ],
    };
    await expect(
      service(prisma, await validNear({ policy })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "dao_everyone_add_proposal" });
  });

  it.each([
    ["mpc_contract_id", { mpc: "wrong.testnet" }, "vault_mpc_mismatch"],
    ["evm_chain_id", { chain: 8453 }, "vault_chain_mismatch"],
    ["guard_public_key", { guard: "AAAA" }, "vault_guard_key_mismatch"],
    ["token_id", { token: "wrong-ft.testnet" }, "vault_token_mismatch"],
    ["reservation_ttl_blocks", { ttl: 99 }, "vault_ttl_mismatch"],
  ])("rejects a Vault with the wrong %s", async (_name, vaultOverride, code) => {
    const { prisma } = fakePrisma();
    await expect(
      service(prisma, await validNear({ vault: vaultOverride })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code });
  });

  it("rejects a relay whose delay_address is not 0xGOV", async () => {
    const { prisma } = fakePrisma();
    await expect(
      service(prisma, await validNear({ relay: { delay: Buffer.alloc(20).toString("base64") } })).register(
        "org-1",
        "user-1",
        registerInput,
      ),
    ).rejects.toMatchObject({ code: "relay_delay_mismatch" });
  });

  it("rejects a relay with the wrong chain id", async () => {
    const { prisma } = fakePrisma();
    await expect(
      service(prisma, await validNear({ relay: { chain: 8453 } })).register("org-1", "user-1", registerInput),
    ).rejects.toMatchObject({ code: "relay_chain_mismatch" });
  });

  it("passes the environment cooldown to the Delay verifier", async () => {
    const { prisma } = fakePrisma();
    const calls: Array<{ cooldown: bigint; expiration: bigint }> = [];
    const spy: BaseTreasuryVerifier = {
      verify: async (input) => {
        calls.push({ cooldown: input.delayCooldownSeconds, expiration: input.delayExpirationSeconds });
      },
    };
    await service(prisma, await validNear({ vault: { chain: 8453 }, relay: { chain: 8453 } }), spy).register(
      "org-1",
      "user-1",
      { ...registerInput, environment: "production" },
    );
    expect(calls).toEqual([{ cooldown: 86_400n, expiration: 604_800n }]);
  });

  it("rejects a 300 s Delay in production", () => {
    expect(() => assertDelayPolicy(300n, 604_800n, 86_400n, 604_800n)).toThrow(
      expect.objectContaining({ code: "delay_policy_mismatch" }),
    );
  });
});
