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

  it("stage chaque écriture, refuse l'auto-approbation et ne versionne qu'à l'accord", async () => {
    const supplierChange = await service.requestSupplier(organizationId, "author", {
      name: "Data Provider",
      chainId: 84532,
      address: "0x1111111111111111111111111111111111111111",
    });
    await expect(
      service.decideChange(organizationId, "author", supplierChange.id, "approve"),
    ).rejects.toMatchObject({ code: "four_eyes_self_approval" });
    expect(await service.version(organizationId)).toBe(0);
    await service.decideChange(organizationId, "reviewer", supplierChange.id, "approve");
    expect(await service.version(organizationId)).toBe(1);
    const supplier = await prisma.supplier.findFirstOrThrow({ where: { organizationId } });

    const walletChange = await service.requestWallet(organizationId, "author", {
      supplierId: supplier.id,
      chainId: 84532,
      address: "0x2222222222222222222222222222222222222222",
    });
    await expect(
      service.decideChange(organizationId, "author", walletChange.id, "approve"),
    ).rejects.toMatchObject({ code: "four_eyes_self_approval" });
    await service.decideChange(organizationId, "reviewer", walletChange.id, "approve");
    expect(await service.version(organizationId)).toBe(2);

    const wallets = await service.activeSupplierWallets(organizationId, 84532);
    expect(wallets).toHaveLength(2);

    const other = await service.list(otherOrganizationId);
    expect(other.suppliers).toEqual([]);
    expect(other.version).toBe(0);
  });
});
