import type { PrismaClient } from "@mandateos/db";
import { bytesToHex } from "viem";

import type { NearClient } from "./near.js";
import type { GovernanceOperation } from "./types.js";

export class GovernanceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface GovernanceGateway {
  recordRelayExecution(
    organizationId: string,
    input: { proposalId: number; nearTransactionHash: string; signerAccountId: string },
  ): Promise<{ opId: string; state: string }>;
}

export class GovernanceService implements GovernanceGateway {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
  ) {}

  async recordRelayExecution(
    organizationId: string,
    input: { proposalId: number; nearTransactionHash: string; signerAccountId: string },
  ): Promise<{ opId: string; state: string }> {
    const [treasury, member] = await Promise.all([
      this.prisma.treasury.findFirst({ where: { organizationId, status: "active" }, orderBy: { createdAt: "desc" } }),
      this.prisma.member.findFirst({
        where: {
          organizationId,
          nearAccountId: input.signerAccountId,
          walletProofVerifiedAt: { not: null },
        },
        select: { id: true },
      }),
    ]);
    if (!treasury) throw new GovernanceError(409, "treasury_missing", "active treasury not found");
    if (!member) throw new GovernanceError(403, "council_wallet_required", "signer must be a proven organization member");
    const proposal = await this.near.viewFunction<{ status?: unknown; description?: unknown }>(
      treasury.daoAccountId,
      "get_proposal",
      { id: input.proposalId },
    );
    if (proposal.status !== "Approved") {
      throw new GovernanceError(409, "proposal_not_executed", "DAO proposal is not executed");
    }
    if (typeof proposal.description !== "string" || !proposal.description.includes(":zodiac]")) {
      throw new GovernanceError(422, "proposal_not_zodiac", "DAO proposal is not a MandateOS Zodiac batch");
    }
    const activeOperation = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
    if (!activeOperation) throw new GovernanceError(409, "relay_operation_missing", "relay has no active operation");
    const operation = await this.near.viewFunction<GovernanceOperation | null>(treasury.relayAccountId, "get_operation", {
      op_id: activeOperation,
    });
    if (!operation) throw new GovernanceError(409, "relay_operation_missing", "relay operation is unavailable");
    const clientId = await this.near.viewFunction<string>(treasury.relayAccountId, "client_id");
    const opId = bytesToHex(Uint8Array.from(operation.op_id));
    const data = {
      treasuryId: treasury.id,
      relayAccountId: treasury.relayAccountId,
      clientId,
      proposalId: input.proposalId,
      nearExecutionTxHash: input.nearTransactionHash,
      nearExecutionSignerId: input.signerAccountId,
      target: bytesToHex(Uint8Array.from(operation.target)),
      value: operation.value,
      data: bytesToHex(Uint8Array.from(operation.data)),
      operation: operation.operation,
      lastError: null,
    };
    const stored = await this.prisma.governanceOperation.upsert({
      where: { organizationId_opId: { organizationId, opId } },
      create: {
        organizationId,
        opId,
        state: operation.state,
        nextAttemptAt: new Date(),
        ...data,
      },
      update: {
        ...data,
        nextAttemptAt: new Date(),
      },
    });
    return { opId: stored.opId, state: stored.state };
  }
}
