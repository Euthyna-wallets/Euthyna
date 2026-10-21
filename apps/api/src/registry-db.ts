import type { Prisma, PrismaClient } from "@mandateos/db";
import { getAddress } from "viem";

import type { Registry } from "./types.js";

export interface SupplierInput {
  name: string;
  contact?: string | undefined;
  chainId: number;
  address: string;
}

export interface ContractInput {
  reference: string;
  role: string;
  supplierId: string;
  maxAmount: string;
  periodicity: string;
  token: string;
}

export class RegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function bumpVersion(tx: Prisma.TransactionClient, organizationId: string) {
  const state = await tx.registryVersion.upsert({
    where: { organizationId },
    update: { version: { increment: 1 } },
    create: { organizationId, version: 1 },
  });
  return state.version;
}

export class RegistryService {
  constructor(private readonly prisma: PrismaClient) {}

  async version(organizationId: string): Promise<number> {
    const state = await this.prisma.registryVersion.findUnique({ where: { organizationId } });
    return state?.version ?? 0;
  }

  async loadRegistry(organizationId: string, role: string, clientId: string): Promise<Registry> {
    const contracts = await this.prisma.contract.findMany({
      where: { organizationId, role, active: true },
      include: { supplier: { include: { wallets: true } } },
    });
    const version = await this.version(organizationId);
    const token = contracts.find((contract) => contract.token)?.token;
    if (!token || contracts.length === 0) {
      throw new RegistryError(422, "registry_empty", `no active contract for role ${role}`);
    }
    const vendors = contracts
      .filter((contract) => contract.supplier.active)
      .map((contract) => ({
        id: contract.supplier.id,
        name: contract.supplier.name,
        addresses: contract.supplier.wallets
          .filter((wallet) => wallet.active && wallet.chainId === 84532)
          .map((wallet) => ({
            address: getAddress(wallet.address),
            maximumPayment: contract.maxAmount.toString(),
          })),
      }))
      .filter((vendor) => vendor.addresses.length > 0);
    const maximumPayment = contracts.reduce(
      (max, contract) => {
        const amount = BigInt(contract.maxAmount.toString());
        return amount > max ? amount : max;
      },
      0n,
    );
    return {
      clientId,
      registryVersion: version,
      network: "base-sepolia",
      chainId: 84532,
      token: { symbol: "USDC", address: getAddress(token), decimals: 6 },
      roles: {
        [role]: {
          maximumPayment: maximumPayment.toString(),
          vendors,
        },
      },
    };
  }

  async list(organizationId: string) {
    const [suppliers, contracts, changes, version] = await Promise.all([
      this.prisma.supplier.findMany({ where: { organizationId }, include: { wallets: true }, orderBy: { name: "asc" } }),
      this.prisma.contract.findMany({ where: { organizationId }, orderBy: { reference: "asc" } }),
      this.prisma.supplierAddressChange.findMany({
        where: { organizationId, status: "pending" },
        orderBy: { createdAt: "asc" },
      }),
      this.version(organizationId),
    ]);
    return { version, suppliers, contracts, pendingAddressChanges: changes };
  }

  async createSupplier(organizationId: string, input: SupplierInput) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          organizationId,
          name: input.name,
          contact: input.contact ?? null,
          wallets: {
            create: { organizationId, chainId: input.chainId, address: getAddress(input.address) },
          },
        },
        include: { wallets: true },
      });
      const version = await bumpVersion(tx, organizationId);
      return { supplier, version };
    });
  }

  async requestAddressChange(organizationId: string, authorId: string, supplierId: string, input: { chainId: number; address: string }) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, organizationId } });
    if (!supplier) throw new RegistryError(404, "supplier_not_found", "supplier not found");
    return this.prisma.supplierAddressChange.create({
      data: {
        organizationId,
        supplierId,
        authorId,
        chainId: input.chainId,
        address: getAddress(input.address),
      },
    });
  }

  async decideAddressChange(
    organizationId: string,
    reviewerId: string,
    changeId: string,
    decision: "approve" | "reject",
  ) {
    return this.prisma.$transaction(async (tx) => {
      const change = await tx.supplierAddressChange.findFirst({
        where: { id: changeId, organizationId, status: "pending" },
      });
      if (!change) throw new RegistryError(404, "change_not_found", "pending change not found");
      if (change.authorId === reviewerId) {
        throw new RegistryError(409, "four_eyes_self_approval", "the author cannot approve their own change");
      }
      if (decision === "reject") {
        const rejected = await tx.supplierAddressChange.update({
          where: { id: change.id },
          data: { status: "rejected", reviewerId, decidedAt: new Date() },
        });
        return { change: rejected, version: await this.version(organizationId) };
      }
      await tx.supplierWallet.updateMany({
        where: { organizationId, supplierId: change.supplierId, chainId: change.chainId },
        data: { active: false },
      });
      await tx.supplierWallet.create({
        data: {
          organizationId,
          supplierId: change.supplierId,
          chainId: change.chainId,
          address: change.address,
        },
      });
      const version = await bumpVersion(tx, organizationId);
      const updated = await tx.supplierAddressChange.update({
        where: { id: change.id },
        data: { status: "approved", reviewerId, decidedAt: new Date() },
      });
      return { change: updated, version };
    });
  }

  async createContract(organizationId: string, input: ContractInput) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplierId, organizationId } });
    if (!supplier) throw new RegistryError(404, "supplier_not_found", "supplier not found");
    return this.prisma.$transaction(async (tx) => {
      const contract = await tx.contract.create({
        data: {
          organizationId,
          reference: input.reference,
          role: input.role,
          supplierId: input.supplierId,
          maxAmount: input.maxAmount,
          periodicity: input.periodicity,
          token: getAddress(input.token),
        },
      });
      const version = await bumpVersion(tx, organizationId);
      return { contract, version };
    });
  }

  async isConsumed(organizationId: string, reference: string): Promise<boolean> {
    const consumed = await this.prisma.consumedReference.findUnique({
      where: { organizationId_reference: { organizationId, reference } },
    });
    return consumed !== null;
  }

  async consumeReference(organizationId: string, reference: string, opId: string): Promise<boolean> {
    try {
      await this.prisma.consumedReference.create({ data: { organizationId, reference, opId } });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return false;
      throw error;
    }
  }
}
