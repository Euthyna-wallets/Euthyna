import { randomUUID } from "node:crypto";

import { PrismaClient } from "@mandateos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RegistryService } from "./registry-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("RegistryService against PostgreSQL", () => {
  let prisma: PrismaClient;
  let service: RegistryService;
  let organizationId: string;
  let otherOrganizationId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL required");
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    service = new RegistryService(prisma);
    organizationId = randomUUID();
    otherOrganizationId = randomUUID();
    await prisma.organization.createMany({
      data: [
        { id: organizationId, name: "ACME", slug: `acme-${organizationId}`, createdAt: new Date() },
        { id: otherOrganizationId, name: "Other", slug: `other-${otherOrganizationId}`, createdAt: new Date() },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("versionne, applique le quatre-yeux et isole les organisations", async () => {
    const supplier = await service.createSupplier(organizationId, {
      name: "Data Provider",
      chainId: 84532,
      address: "0x1111111111111111111111111111111111111111",
    });
    expect(supplier.version).toBe(1);

    const contract = await service.createContract(organizationId, {
      reference: "SUB-001",
      role: "researcher",
      supplierId: supplier.supplier.id,
      maxAmount: "5000000",
      periodicity: "monthly",
      token: "0x418A2b47911dE05e21688F7490195F5324B49474",
    });
    expect(contract.version).toBe(2);

    const registry = await service.loadRegistry(organizationId, "researcher", "acme");
    expect(registry.registryVersion).toBe(2);
    expect(registry.roles.researcher?.vendors[0]?.addresses[0]?.address).toBe(
      "0x1111111111111111111111111111111111111111",
    );

    const change = await service.requestAddressChange(
      organizationId,
      "author-user",
      supplier.supplier.id,
      { chainId: 84532, address: "0x2222222222222222222222222222222222222222" },
    );
    await expect(
      service.decideAddressChange(organizationId, "author-user", change.id, "approve"),
    ).rejects.toMatchObject({ code: "four_eyes_self_approval" });
    expect(await service.version(organizationId)).toBe(2);

    const approved = await service.decideAddressChange(organizationId, "reviewer-user", change.id, "approve");
    expect(approved.version).toBe(3);
    const wallets = await prisma.supplierWallet.findMany({ where: { supplierId: supplier.supplier.id } });
    expect(wallets.filter((wallet) => wallet.active)).toHaveLength(1);
    expect(wallets.find((wallet) => wallet.active)?.address).toBe("0x2222222222222222222222222222222222222222");

    const other = await service.list(otherOrganizationId);
    expect(other.suppliers).toEqual([]);
    expect(other.version).toBe(0);
  });
});
