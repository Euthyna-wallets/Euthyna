import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { digestVaultTransaction, hexToByteArray } from "./evm.js";
import { Guard } from "./guard.js";
import { EnvKmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { PaymentService } from "./payments.js";
import { RegistryService } from "./registry-db.js";
import type { VaultOperation } from "./types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const token = getAddress("0x418A2b47911dE05e21688F7490195F5324B49474");
const recipient = getAddress("0x1111111111111111111111111111111111111111");

function operation(opIdHex: `0x${string}`, reference: string): VaultOperation {
  const opId = hexToByteArray(opIdHex);
  const operation: VaultOperation = {
    op_id: opId,
    client_id: "acme",
    agent: "agent.testnet",
    role: "researcher",
    intent: {
      token: Array.from(Buffer.from(token.slice(2), "hex")),
      recipient: Array.from(Buffer.from(recipient.slice(2), "hex")),
      amount: "1000000",
      reference,
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    policy_version: 1,
    registry_version: 1,
    evm_nonce: 0,
    transaction: {
      chain_id: 84532,
      nonce: 0,
      to: Array(20).fill(0x44),
      value: "0",
      input: [1, 2, 3, 4],
      gas_limit: "200000",
      max_fee_per_gas: "20000000000",
      max_priority_fee_per_gas: "1000000000",
    },
    tx_digest: Array(32).fill(0),
    expires_at_block: 10_000,
    state: "Prepared",
    signed_transaction: null,
  };
  operation.tx_digest = hexToByteArray(digestVaultTransaction(operation));
  return operation;
}

describe.skipIf(!databaseUrl)("PaymentService concurrency", () => {
  let prisma: PrismaClient;
  let service: PaymentService;
  let organizationId: string;
  let agentId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    organizationId = randomUUID();
    agentId = randomUUID();
    const userId = randomUUID();
    await prisma.organization.create({
      data: { id: organizationId, name: "ACME", slug: `acme-${organizationId}`, createdAt: new Date() },
    });
    await prisma.user.create({
      data: { id: userId, name: "Agent", email: `agent-${userId}@example.test`, emailVerified: true },
    });
    await prisma.agent.create({
      data: {
        id: agentId,
        organizationId,
        authUserId: userId,
        name: "Agent",
        role: "researcher",
        nearAccountId: "agent.testnet",
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: "vault.testnet",
        mpcPath: "agents/researcher/base",
      },
    });
    await prisma.treasury.create({
      data: {
        organizationId,
        environment: "uat",
        nearNetwork: "testnet",
        baseChainId: 84532,
        daoAccountId: "dao.testnet",
        vaultAccountId: "vault.testnet",
        relayAccountId: "relay.testnet",
        safeAddress: "0x4444444444444444444444444444444444444444",
        rolesAddress: "0x5555555555555555555555555555555555555555",
        delayAddress: "0x6666666666666666666666666666666666666666",
        govAddress: "0x7777777777777777777777777777777777777777",
        vaultWasmSha256: "v",
        relayWasmSha256: "r",
      },
    });
    const supplier = await prisma.supplier.create({
      data: {
        organizationId,
        name: "Provider",
        wallets: { create: { organizationId, chainId: 84532, address: recipient } },
      },
    });
    await prisma.contract.create({
      data: {
        organizationId,
        reference: "SUB-001",
        role: "researcher",
        supplierId: supplier.id,
        maxAmount: "5000000",
        periodicity: "monthly",
        token,
      },
    });
    await prisma.registryVersion.create({ data: { organizationId, version: 1 } });
    const registry = new RegistryService(prisma);
    const guard = new Guard(new EnvKmsSigner(new Uint8Array(32).fill(7)));
    const current = { operation: operation(`0x${"11".repeat(32)}`, "INV-CONCURRENT") };
    const near = {
      getOperation: async () => current.operation,
    } as unknown as NearClient;
    service = new PaymentService(prisma, near, guard, registry);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates exactly one visa and one consumed reference under concurrency", async () => {
    const opId = Array.from(Buffer.from("11".repeat(32), "hex"));
    const agent = { agentId, nearAccountId: "agent.testnet", vaultAccountId: "vault.testnet", role: "researcher" };
    const [first, second] = await Promise.all([
      service.pay(organizationId, agent, opId),
      service.pay(organizationId, agent, opId),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await prisma.paymentVisa.count({ where: { organizationId } })).toBe(1);
    expect(await prisma.consumedReference.count({ where: { organizationId } })).toBe(1);
  });
});
