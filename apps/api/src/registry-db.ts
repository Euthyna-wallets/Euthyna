import type { Prisma, PrismaClient } from "@euthyna/db";
import { getAddress } from "viem";


export type RegistryChangeKind = "supplier_create" | "wallet_add";

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

  /** Active supplier wallets on a chain: what the Guard accepts as a transfer recipient. */
  async activeSupplierWallets(organizationId: string, chainId: number) {
    const wallets = await this.prisma.supplierWallet.findMany({
      where: { organizationId, chainId, active: true, supplier: { active: true } },
      include: { supplier: true },
    });
    return wallets.map((wallet) => ({ id: wallet.supplier.id, name: wallet.supplier.name, address: getAddress(wallet.address) }));
  }

  async list(organizationId: string) {
    const [suppliers, changes, version] = await Promise.all([
      this.prisma.supplier.findMany({ where: { organizationId }, include: { wallets: true }, orderBy: { name: "asc" } }),
      this.prisma.registryChange.findMany({
        where: { organizationId, status: "pending" },
        orderBy: { createdAt: "asc" },
      }),
      this.version(organizationId),
    ]);
    return { version, suppliers, pendingChanges: changes };
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
