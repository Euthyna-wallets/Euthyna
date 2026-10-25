import type { Prisma, PrismaClient } from "@mandateos/db";
import { getAddress } from "viem";

import type { Registry } from "./types.js";

export type RegistryChangeKind = "supplier_create" | "wallet_add" | "contract_create" | "contract_update";

export interface SupplierInput {
  name: string;
  contact?: string | undefined;
  chainId: number;
  address: string;
}

export interface WalletInput {
  supplierId: string;
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

export interface ContractUpdateInput {
  contractId: string;
  maxAmount?: string | undefined;
  periodicity?: string | undefined;
  token?: string | undefined;
  role?: string | undefined;
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

async function bumpVersion(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
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
    const token = contracts[0]?.token;
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
    const maximumPayment = contracts.reduce((max, contract) => {
      const amount = BigInt(contract.maxAmount.toString());
      return amount > max ? amount : max;
    }, 0n);
    return {
      clientId,
      registryVersion: version,
      network: "base-sepolia",
      chainId: 84532,
      token: { symbol: "USDC", address: getAddress(token), decimals: 6 },
      roles: {
        [role]: { maximumPayment: maximumPayment.toString(), vendors },
      },
    };
  }

  async list(organizationId: string) {
    const [suppliers, contracts, changes, version] = await Promise.all([
      this.prisma.supplier.findMany({ where: { organizationId }, include: { wallets: true }, orderBy: { name: "asc" } }),
      this.prisma.contract.findMany({ where: { organizationId }, orderBy: { reference: "asc" } }),
      this.prisma.registryChange.findMany({
        where: { organizationId, status: "pending" },
        orderBy: { createdAt: "asc" },
      }),
      this.version(organizationId),
    ]);
    return { version, suppliers, contracts, pendingChanges: changes };
  }

  private async pending(
    organizationId: string,
    authorId: string,
    kind: RegistryChangeKind,
    payload: Record<string, unknown>,
  ) {
    return this.prisma.registryChange.create({
      data: { organizationId, authorId, kind, payload: payload as Prisma.InputJsonValue },
    });
  }

  async requestSupplier(organizationId: string, authorId: string, input: SupplierInput) {
    const address = getAddress(input.address);
    // The same address asked twice (e.g. a role edited again) reuses the request waiting for review.
    const waiting = await this.prisma.registryChange.findMany({ where: { organizationId, status: "pending", kind: "supplier_create" } });
    const same = waiting.find((change) => {
      const payload = change.payload as Record<string, unknown>;
      return payload.address === address && payload.chainId === input.chainId;
    });
    if (same) return same;
    return this.pending(organizationId, authorId, "supplier_create", {
      name: input.name,
      contact: input.contact ?? null,
      chainId: input.chainId,
      address,
    });
  }

  async requestWallet(organizationId: string, authorId: string, input: WalletInput) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplierId, organizationId } });
    if (!supplier) throw new RegistryError(404, "supplier_not_found", "supplier not found");
    return this.pending(organizationId, authorId, "wallet_add", {
      supplierId: input.supplierId,
      chainId: input.chainId,
      address: getAddress(input.address),
    });
  }

  async requestContract(organizationId: string, authorId: string, input: ContractInput) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: input.supplierId, organizationId } });
    if (!supplier) throw new RegistryError(404, "supplier_not_found", "supplier not found");
    return this.pending(organizationId, authorId, "contract_create", {
      reference: input.reference,
      role: input.role,
      supplierId: input.supplierId,
      maxAmount: input.maxAmount,
      periodicity: input.periodicity,
      token: getAddress(input.token),
    });
  }

  async requestContractUpdate(organizationId: string, authorId: string, input: ContractUpdateInput) {
    const contract = await this.prisma.contract.findFirst({
      where: { id: input.contractId, organizationId },
    });
    if (!contract) throw new RegistryError(404, "contract_not_found", "contract not found");
    return this.pending(organizationId, authorId, "contract_update", {
      contractId: contract.id,
      ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
      ...(input.periodicity !== undefined ? { periodicity: input.periodicity } : {}),
      ...(input.token !== undefined ? { token: getAddress(input.token) } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
    });
  }

  async decideChange(
    organizationId: string,
    reviewerId: string,
    changeId: string,
    decision: "approve" | "reject",
  ) {
    return this.prisma.$transaction(async (tx) => {
      const change = await tx.registryChange.findFirst({
        where: { id: changeId, organizationId, status: "pending" },
      });
      if (!change) throw new RegistryError(404, "change_not_found", "pending change not found");
      if (change.authorId === reviewerId) {
        throw new RegistryError(409, "four_eyes_self_approval", "the author cannot approve their own change");
      }
      if (decision === "reject") {
        const rejected = await tx.registryChange.update({
          where: { id: change.id },
          data: { status: "rejected", reviewerId, decidedAt: new Date() },
        });
        return { change: rejected, version: await this.version(organizationId) };
      }

      const payload = change.payload as Record<string, unknown>;
      await this.applyChange(tx, organizationId, change.kind, payload);
      const version = await bumpVersion(tx, organizationId);
      const approved = await tx.registryChange.update({
        where: { id: change.id },
        data: { status: "approved", reviewerId, decidedAt: new Date() },
      });
      return { change: approved, version };
    });
  }

  private async applyChange(
    tx: Prisma.TransactionClient,
    organizationId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    if (kind === "supplier_create") {
      await tx.supplier.create({
        data: {
          organizationId,
          name: String(payload.name),
          contact: payload.contact ? String(payload.contact) : null,
          wallets: {
            create: {
              organizationId,
              chainId: Number(payload.chainId),
              address: getAddress(String(payload.address)),
            },
          },
        },
      });
      return;
    }
    if (kind === "wallet_add") {
      const supplier = await tx.supplier.findFirst({
        where: { id: String(payload.supplierId), organizationId },
      });
      if (!supplier) throw new RegistryError(404, "supplier_not_found", "supplier not found");
      await tx.supplierWallet.create({
        data: {
          organizationId,
          supplierId: supplier.id,
          chainId: Number(payload.chainId),
          address: getAddress(String(payload.address)),
        },
      });
      return;
    }
    if (kind === "contract_create") {
      await tx.contract.create({
        data: {
          organizationId,
          reference: String(payload.reference),
          role: String(payload.role),
          supplierId: String(payload.supplierId),
          maxAmount: String(payload.maxAmount),
          periodicity: String(payload.periodicity),
          token: getAddress(String(payload.token)),
        },
      });
      return;
    }
    if (kind === "contract_update") {
      const contract = await tx.contract.findFirst({
        where: { id: String(payload.contractId), organizationId },
      });
      if (!contract) throw new RegistryError(404, "contract_not_found", "contract not found");
      await tx.contract.update({
        where: { id: contract.id },
        data: {
          ...(payload.maxAmount !== undefined ? { maxAmount: String(payload.maxAmount) } : {}),
          ...(payload.periodicity !== undefined ? { periodicity: String(payload.periodicity) } : {}),
          ...(payload.token !== undefined ? { token: getAddress(String(payload.token)) } : {}),
          ...(payload.role !== undefined ? { role: String(payload.role) } : {}),
        },
      });
      return;
    }
    throw new RegistryError(422, "unknown_change_kind", `unknown registry change ${kind}`);
  }

  async isConsumed(organizationId: string, reference: string): Promise<boolean> {
    const consumed = await this.prisma.consumedReference.findUnique({
      where: { organizationId_reference: { organizationId, reference } },
    });
    return consumed !== null;
  }

  async releaseReference(organizationId: string, reference: string): Promise<void> {
    await this.prisma.consumedReference.deleteMany({ where: { organizationId, reference } });
  }
}
