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
  baseRpcUrl: "http://127.0.0.1:8545",
  budgetTokenAccountId: "test-ft.testnet",
  artifactsDir,
  baseChainId: 84532,
  vaultTtlBlocks: 50,
  vaultDepositYocto: "10000000000000000000000000",
  relayDepositYocto: "10000000000000000000000000",
  daoCreateDepositYocto: "10000000000000000000000000",
};

type TestMember = { id: string; nearAccountId: string | null; evmAddress: string | null };

const members: TestMember[] = [
  { id: "m1", nearAccountId: "alice.testnet", evmAddress: "0x1111111111111111111111111111111111111111" },
  { id: "m2", nearAccountId: "bob.testnet", evmAddress: "0x2222222222222222222222222222222222222222" },
  { id: "m3", nearAccountId: "carol.testnet", evmAddress: "0x3333333333333333333333333333333333333333" },
];

function fakePrisma(options?: { members?: TestMember[] }) {
  const created: unknown[] = [];
  const audits: unknown[] = [];
  const prisma = {
    member: {
      findMany: async () => options?.members ?? members,
      findFirst: async () => ({ id: "m1" }),
      update: async () => ({ id: "m1" }),
    },
    treasury: {
      findUnique: async () => null,
      create: async ({ data }: { data: unknown }) => {
        created.push(data);
        return {
          ...(data as Record<string, unknown>),
          id: "treasury-1",
          status: "active",
        };
      },
    },
    auditLog: {
      create: async ({ data }: { data: unknown }) => {
        audits.push(data);
      },
    },
  } as unknown as PrismaClient;
  return { prisma, created, audits };
}

function fakeNear(overrides?: { vaultOwner?: string; codeHashes?: Record<string, string> }): NearClient {
  return {
    derivedPublicKey: async () => govPublicKey,
    getAccount: async (accountId: string) => ({ code_hash: overrides?.codeHashes?.[accountId] ?? "unused", amount: "0" }),
    getAccessKeys: async () => ({ keys: [] }),
    viewFunction: async (accountId: string, method: string) => {
      if (method === "owner_id") return overrides?.vaultOwner ?? "acme.sputnikv2.testnet";
      if (method === "evm_address") return Buffer.from(govAddress.slice(2), "hex").toString("base64");
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
  safeDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "safe" },
  rolesDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "roles" },
  delayDeployment: { to: getAddress("0x7777777777777777777777777777777777777777"), value: "0", data: "0x" as const, chainId: 84532, description: "delay" },
  safeModuleCalls: [],
  saltNonces: { safe: "1", roles: "2", delay: "3" },
};

const verifier: BaseTreasuryVerifier = { verify: async () => undefined };

function service(prisma: PrismaClient, near: NearClient = fakeNear()) {
  return new TreasuryService(prisma, near, signer, config, async () => basePlan, verifier);
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
    expect(plan.vault.accountId).toBe("acme-treasury-vault.alice.testnet");
    expect(plan.vault.initArgs.owner_id).toBe(plan.daoAccountId);
    expect(plan.relay.initArgs.owner_id).toBe(plan.daoAccountId);
    expect(plan.relay.initArgs.delay_address).toBe(Buffer.from(govAddress.slice(2), "hex").toString("base64"));
    expect(plan.base.safeAddress).toBe(basePlan.safeAddress);
    expect(plan.vault.actions.map((action) => action.type)).toEqual([
      "CreateAccount",
      "Transfer",
      "DeployContract",
      "FunctionCall",
    ]);
    expect(plan.vault.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a council member without both wallets", async () => {
    const { prisma } = fakePrisma({
      members: [{ ...members[0]!, evmAddress: null }],
    });
    await expect(
      service(prisma).plan("org-1", {
        environment: "uat",
        daoName: "acme",
        founderNearAccountId: "alice.testnet",
      }),
    ).rejects.toMatchObject({ code: "member_wallets_missing" });
  });
});

async function artifactHashes() {
  const hash = async (name: string) =>
    bs58.encode(createHash("sha256").update(await readFile(resolve(artifactsDir, name))).digest());
  return {
    "acme-vault.alice.testnet": await hash("vault.wasm"),
    "acme-relay.alice.testnet": await hash("governance_relay.wasm"),
  };
}

const registerInput = {
  environment: "uat",
  daoAccountId: "acme.sputnikv2.testnet",
  vaultAccountId: "acme-vault.alice.testnet",
  relayAccountId: "acme-relay.alice.testnet",
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
    const near = fakeNear({ codeHashes: { "acme-vault.alice.testnet": "wrong", "acme-relay.alice.testnet": "wrong" } });
    await expect(service(prisma, near).register("org-1", "user-1", registerInput)).rejects.toMatchObject({
      code: "wasm_hash_mismatch",
    });
  });
});
