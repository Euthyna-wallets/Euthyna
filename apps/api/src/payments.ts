import type { PrismaClient } from "@mandateos/db";
import { bytesToHex } from "viem";

import type { Guard, GuardResult } from "./guard.js";
import type { NearClient } from "./near.js";
import { RegistryError, type RegistryService } from "./registry-db.js";
import type { Registry, VaultOperation } from "./types.js";

export type OperationStatus =
  | "Prepared"
  | "PossiblySigned"
  | "Broadcast"
  | "Confirmed"
  | "CancellationRequested"
  | "CancellationBroadcast"
  | "CancellationMined"
  | "Cancelled"
  | "Escalated"
  | "Rejected"
  | "Reverted";

export interface PayResult {
  status: 200 | 202 | 422;
  body: Record<string, unknown>;
}

export class PaymentError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function opHex(opId: number[]): string {
  return bytesToHex(Uint8Array.from(opId));
}

function hardRuleFailure(operation: VaultOperation, registry: Registry): string | null {
  const role = registry.roles[operation.role];
  if (!role) return "role_not_in_registry";
  const token = registry.token.address;
  if (!token || bytesToHex(Uint8Array.from(operation.intent.token)) !== token.toLowerCase()) return "token_mismatch";
  if (BigInt(operation.intent.amount) > BigInt(role.maximumPayment)) return "amount_above_cap";
  const recipient = bytesToHex(Uint8Array.from(operation.intent.recipient)).toLowerCase();
  const allowed = role.vendors.some((vendor) =>
    vendor.addresses.some((address) => address.address.toLowerCase() === recipient),
  );
  if (!allowed) return "recipient_not_allowed";
  return null;
}

export class PaymentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly guard: Guard,
    private readonly registry: RegistryService,
  ) {}

  async pay(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; vaultAccountId: string; role: string },
    opId: number[],
  ): Promise<PayResult> {
    const operation = await this.near.getOperation(agent.vaultAccountId, opId);
    if (operation.agent !== agent.nearAccountId) {
      throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    }
    if (operation.state !== "Prepared") {
      throw new PaymentError(422, "not_prepared", `operation state is ${operation.state}`);
    }
    const existingVisa = await this.prisma.paymentVisa.findUnique({
      where: { organizationId_opId: { organizationId, opId: opHex(opId) } },
    });
    if (existingVisa) return { status: 200, body: { visa: existingVisa.visa, signature: existingVisa.signature } };
    const existingEscalation = await this.prisma.escalation.findUnique({
      where: { organizationId_opId: { organizationId, opId: opHex(opId) } },
    });
    if (existingEscalation) {
      return {
        status: existingEscalation.status === "rejected" ? 422 : 202,
        body: {
          escalationId: existingEscalation.id,
          status: existingEscalation.status,
          reasons: existingEscalation.reasons,
        },
      };
    }

    let registry: Registry;
    try {
      registry = await this.registry.loadRegistry(organizationId, agent.role, operation.client_id);
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new PaymentError(422, error.code, error.message);
      }
      throw error;
    }
    const refusal = hardRuleFailure(operation, registry);
    if (refusal) throw new PaymentError(422, refusal, refusal.replaceAll("_", " "));
    if (await this.registry.isConsumed(organizationId, operation.intent.reference)) {
      throw new PaymentError(422, "reference_consumed", "this reference is already consumed");
    }

    const treasury = await this.prisma.treasury.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    if (!treasury) throw new PaymentError(409, "treasury_missing", "no treasury for this organization");
    const result = await this.guard.approve(operation, registry);
    await this.upsertOperation(organizationId, agent.agentId, operation);
    if (result.decision === "approve") {
      const stored = await this.storeVisa(
        organizationId,
        opHex(opId),
        operation.intent.reference,
        result.approval.visa as unknown as object,
        result.approval.signature,
      );
      return { status: 200, body: { visa: stored.visa, signature: stored.signature } };
    }

    const escalation = await this.prisma.escalation.create({
      data: {
        organizationId,
        opId: opHex(opId),
        agentId: agent.agentId,
        environment: treasury.environment,
        reasons: result.reasons,
        invoice: operation.intent as unknown as object,
        registrySnapshot: registry as unknown as object,
        status: "pending",
      },
    });
    await this.prisma.operation.update({
      where: { organizationId_opId: { organizationId, opId: opHex(opId) } },
      data: { state: "Escalated" },
    });
    return { status: 202, body: { escalationId: escalation.id, reasons: result.reasons } };
  }

  async listEscalations(organizationId: string) {
    return this.prisma.escalation.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getOperation(organizationId: string, agentId: string, opId: number[]): Promise<Record<string, unknown>> {
    const hex = opHex(opId);
    const stored = await this.prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    if (stored && stored.agentId !== agentId) throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    const escalation = await this.prisma.escalation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    const visa = await this.prisma.paymentVisa.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: "uat" } },
    });
    let vaultState: string | null = null;
    if (treasury) {
      try {
        const onChain = await this.near.viewFunction<{ state?: string }>(treasury.vaultAccountId, "get_operation", {
          op_id: opId,
        });
        vaultState = onChain?.state ?? null;
      } catch {
        vaultState = null;
      }
    }
    const status = this.mergeStatus(stored?.state ?? vaultState, escalation?.status ?? null, visa !== null);
    return {
      opId: hex,
      status,
      vaultState,
      escalation: escalation ? { id: escalation.id, status: escalation.status, reasons: escalation.reasons } : null,
      visa: visa ? { visa: visa.visa, signature: visa.signature } : null,
      txHash: stored?.txHash ?? null,
      lastError: stored?.lastError ?? null,
    };
  }

  async recordAuthorization(
    organizationId: string,
    agent: { agentId: string; nearAccountId: string; vaultAccountId: string },
    opId: number[],
    nearTransactionHash: string,
  ): Promise<Record<string, unknown>> {
    const hex = opHex(opId);
    const stored = await this.prisma.operation.findUnique({
      where: { organizationId_opId: { organizationId, opId: hex } },
    });
    if (!stored) throw new PaymentError(404, "operation_not_found", "operation must be registered before authorization");
    if (stored.agentId !== agent.agentId) {
      throw new PaymentError(403, "agent_mismatch", "operation belongs to another agent");
    }
    if (stored.nearAuthorizationTxHash && stored.nearAuthorizationTxHash !== nearTransactionHash) {
      throw new PaymentError(409, "authorization_tx_conflict", "a different authorization transaction is already registered");
    }
    const operation = await this.near.getOperation(agent.vaultAccountId, opId);
    if (operation.agent !== agent.nearAccountId) {
      throw new PaymentError(403, "agent_mismatch", "Vault operation belongs to another agent");
    }
    if (operation.state !== "PossiblySigned" && operation.state !== "Confirmed") {
      throw new PaymentError(422, "authorization_not_final", `operation state is ${operation.state}`);
    }
    const updated = await this.prisma.operation.update({
      where: { organizationId_opId: { organizationId, opId: hex } },
      data: {
        nearAuthorizationTxHash: nearTransactionHash,
        state: operation.state,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    return {
      opId: hex,
      nearTransactionHash: updated.nearAuthorizationTxHash,
      state: updated.state,
    };
  }

  async decideEscalation(
    organizationId: string,
    reviewerId: string,
    escalationId: string,
    decision: "approve" | "reject",
  ): Promise<Record<string, unknown>> {
    const escalation = await this.prisma.escalation.findFirst({
      where: { id: escalationId, organizationId },
    });
    if (!escalation) throw new PaymentError(404, "escalation_not_found", "escalation not found");
    if (escalation.status !== "pending") throw new PaymentError(409, "escalation_decided", "escalation already decided");
    if (decision === "reject") {
      const rejected = await this.prisma.escalation.update({
        where: { id: escalation.id },
        data: { status: "rejected", decidedBy: reviewerId, decidedAt: new Date() },
      });
      await this.prisma.operation.updateMany({
        where: { organizationId, opId: escalation.opId },
        data: { state: "Rejected" },
      });
      return { escalation: rejected };
    }

    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: escalation.environment } },
    });
    if (!treasury) throw new PaymentError(409, "treasury_missing", "no treasury for this escalation environment");
    const opBytes = Array.from(Buffer.from(escalation.opId.slice(2), "hex"));
    const operation = await this.near.getOperation(treasury.vaultAccountId, opBytes);
    if (operation.state !== "Prepared") {
      throw new PaymentError(422, "not_prepared", "operation is no longer Prepared");
    }
    const registry = await this.registry.loadRegistry(organizationId, operation.role, operation.client_id);
    const result = await this.guard.approve(operation, registry);
    if (result.decision !== "approve") {
      throw new PaymentError(422, "still_escalated", "the operation still does not match a rule");
    }
    const stored = await this.prisma.$transaction(async (tx) => {
      const visa = await tx.paymentVisa.create({
        data: {
          organizationId,
          opId: escalation.opId,
          visa: result.approval.visa as unknown as object,
          signature: result.approval.signature,
        },
      });
      await tx.consumedReference.create({
        data: { organizationId, reference: operation.intent.reference, opId: escalation.opId },
      });
      await tx.escalation.update({
        where: { id: escalation.id },
        data: { status: "approved", decidedBy: reviewerId, decidedAt: new Date() },
      });
      await tx.operation.updateMany({
        where: { organizationId, opId: escalation.opId },
        data: { state: "Prepared" },
      });
      return visa;
    });
    return { escalation: { ...escalation, status: "approved" }, visa: stored.visa, signature: stored.signature };
  }

  private async storeVisa(
    organizationId: string,
    opId: string,
    reference: string,
    visa: object,
    signature: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.paymentVisa.findUnique({
          where: { organizationId_opId: { organizationId, opId } },
        });
        if (existing) return existing;
        await tx.consumedReference.create({ data: { organizationId, reference, opId } });
        return tx.paymentVisa.create({ data: { organizationId, opId, visa, signature } });
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const existing = await this.prisma.paymentVisa.findUnique({
          where: { organizationId_opId: { organizationId, opId } },
        });
        if (existing) return existing;
        throw new PaymentError(422, "reference_consumed", "this reference is already consumed");
      }
      throw error;
    }
  }

  private mergeStatus(stored: string | null | undefined, escalationStatus: string | null, hasVisa: boolean): OperationStatus {
    if (escalationStatus === "rejected") return "Rejected";
    if (escalationStatus === "pending") return "Escalated";
    if (stored === "Confirmed") return "Confirmed";
    if (stored === "Cancelled") return "Cancelled";
    if (stored === "Reverted") return "Reverted";
    if (stored === "Broadcast") return "Broadcast";
    if (stored === "PossiblySigned" || hasVisa) return "PossiblySigned";
    return (stored as OperationStatus | undefined) ?? "Prepared";
  }

  private async upsertOperation(organizationId: string, agentId: string, operation: VaultOperation) {
    const data = {
      organizationId,
      opId: opHex(operation.op_id),
      agentId,
      reference: operation.intent.reference,
      state: "Prepared",
      txDigest: bytesToHex(Uint8Array.from(operation.tx_digest)),
      evmNonce: BigInt(operation.evm_nonce),
      amount: operation.intent.amount,
    };
    await this.prisma.operation.upsert({
      where: { organizationId_opId: { organizationId, opId: data.opId } },
      update: { state: data.state },
      create: data,
    });
  }
}
