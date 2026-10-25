import type { PrismaClient } from "@mandateos/db";
import { AGENT_FUNCTION_CALL_METHODS, proposedAgentAccountId } from "@mandateos/sdk";

import type { NearClient } from "./near.js";

export interface AgentAccessKeyExpectation {
  accountId: string;
  publicKey: string;
  vaultAccountId: string;
  methodNames: string[];
  allowanceYocto: null;
}

export interface AgentAccessKeyAttestation {
  valid: boolean;
  keyCount: number;
  publicKey: string | null;
  permission: "FunctionCall" | "FullAccess" | "unknown";
  receiverId: string | null;
  methodNames: string[];
  allowanceYocto: string | null;
  expected: AgentAccessKeyExpectation;
}

export class AgentProvisioningError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function attestAgentAccessKeys(
  keys: unknown[],
  expected: AgentAccessKeyExpectation,
): AgentAccessKeyAttestation {
  const entry = keys.length === 1 && keys[0] && typeof keys[0] === "object"
    ? keys[0] as { public_key?: unknown; access_key?: { permission?: unknown } }
    : null;
  const permission = entry?.access_key?.permission;
  const functionCall = permission && typeof permission === "object" && "FunctionCall" in permission
    ? (permission as { FunctionCall?: { allowance?: unknown; receiver_id?: unknown; method_names?: unknown } }).FunctionCall
    : null;
  const methodNames = Array.isArray(functionCall?.method_names)
    ? functionCall.method_names.filter((value): value is string => typeof value === "string").sort()
    : [];
  const expectedMethods = [...expected.methodNames].sort();
  const publicKey = typeof entry?.public_key === "string" ? entry.public_key : null;
  const receiverId = typeof functionCall?.receiver_id === "string" ? functionCall.receiver_id : null;
  const allowanceYocto = typeof functionCall?.allowance === "string" ? functionCall.allowance : null;
  return {
    valid:
      keys.length === 1 &&
      publicKey === expected.publicKey &&
      receiverId === expected.vaultAccountId &&
      allowanceYocto === expected.allowanceYocto &&
      JSON.stringify(methodNames) === JSON.stringify(expectedMethods),
    keyCount: keys.length,
    publicKey,
    permission: permission === "FullAccess" ? "FullAccess" : functionCall ? "FunctionCall" : "unknown",
    receiverId,
    methodNames,
    allowanceYocto,
    expected,
  };
}

export class AgentProvisioningService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly parentAccountId: string,
    private readonly dailyLimit: number,
    private readonly reserveYocto: string,
    private readonly attestationRetryMs = 1_500,
  ) {}

  async provision(organizationId: string, agentId: string): Promise<{
    status: string;
    transactionHash: string | null;
    attestation: AgentAccessKeyAttestation;
  }> {
    const agent = await this.agent(organizationId, agentId);
    const expectation = this.expectation(agent);
    const reservation = await this.reserve(agent);
    if (reservation === "daily_limit") {
      throw new AgentProvisioningError(429, "daily_sponsorship_limit", "daily NEAR sponsorship limit reached");
    }
    if (reservation === "in_progress" || reservation === "already_provisioned") {
      const attestation = await this.attestation(expectation).catch(() => null);
      if (!attestation?.valid) {
        throw new AgentProvisioningError(409, "provisioning_in_progress", "agent provisioning is already in progress");
      }
      const existing = await this.prisma.agentProvisioning.findUniqueOrThrow({ where: { agentId: agent.id } });
      return { status: existing.status, transactionHash: existing.transactionHash, attestation };
    }

    let transactionHash: string | null = null;
    try {
      transactionHash = await this.near.provisionFunctionCallAccount({
        accountId: expectation.accountId,
        publicKey: expectation.publicKey,
        receiverId: expectation.vaultAccountId,
        methodNames: expectation.methodNames,
        reserveYocto: this.reserveYocto,
        allowanceYocto: null,
      });
    } catch (error) {
      const attestation = await this.attestation(expectation).catch(() => null);
      if (!attestation?.valid) {
        await this.complete(agent.id, false, null);
        throw error;
      }
    }
    // The new key is read with finality "final": wait a few blocks before failing.
    let attestation = await this.attestation(expectation);
    for (let attempt = 0; !attestation.valid && attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.attestationRetryMs));
      attestation = await this.attestation(expectation);
    }
    if (!attestation.valid) {
      await this.complete(agent.id, false, transactionHash);
      throw new AgentProvisioningError(422, "agent_key_attestation_failed", "provisioned account key does not match the restricted policy");
    }
    await this.complete(agent.id, true, transactionHash);
    return { status: "provisioned", transactionHash, attestation };
  }

  async status(organizationId: string, agentId: string): Promise<{
    status: string;
    transactionHash: string | null;
    confirmedAt: Date | null;
    attestation: AgentAccessKeyAttestation | null;
  }> {
    const agent = await this.agent(organizationId, agentId);
    const provisioning = await this.prisma.agentProvisioning.findUnique({ where: { agentId } });
    const attestation = await this.attestation(this.expectation(agent)).catch(() => null);
    return {
      status: provisioning?.status ?? "not_started",
      transactionHash: provisioning?.transactionHash ?? null,
      confirmedAt: provisioning?.confirmedAt ?? null,
      attestation,
    };
  }

  async confirm(organizationId: string, agentId: string) {
    const agent = await this.agent(organizationId, agentId);
    const existing = await this.prisma.agentProvisioning.findUnique({ where: { agentId } });
    if (!existing || (existing.status !== "provisioned" && existing.status !== "confirmed")) {
      throw new AgentProvisioningError(409, "agent_not_provisioned", "provision the agent before confirming its key");
    }
    const attestation = await this.attestation(this.expectation(agent));
    if (!attestation.valid) {
      throw new AgentProvisioningError(422, "agent_key_attestation_failed", "agent access key does not match the restricted policy");
    }
    const provisioning = await this.prisma.agentProvisioning.update({
      where: { agentId },
      data: { status: "confirmed", confirmedAt: new Date() },
    });
    return {
      status: provisioning.status,
      transactionHash: provisioning.transactionHash,
      confirmedAt: provisioning.confirmedAt,
      attestation,
    };
  }

  private async agent(organizationId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, organizationId, active: true } });
    if (!agent) throw new AgentProvisioningError(404, "agent_not_found", "agent not found");
    // Agents created before organization-scoped names keep their legacy account.
    const expectedAccountId = proposedAgentAccountId(agent.name, this.parentAccountId, organizationId);
    if (agent.nearAccountId !== expectedAccountId && agent.nearAccountId !== proposedAgentAccountId(agent.name, this.parentAccountId)) {
      throw new AgentProvisioningError(
        422,
        "agent_account_mismatch",
        `agent account must be ${expectedAccountId}`,
      );
    }
    return agent;
  }

  private expectation(agent: {
    nearAccountId: string;
    nearPublicKey: string;
    vaultAccountId: string;
  }): AgentAccessKeyExpectation {
    return {
      accountId: agent.nearAccountId,
      publicKey: agent.nearPublicKey,
      vaultAccountId: agent.vaultAccountId,
      methodNames: [...AGENT_FUNCTION_CALL_METHODS],
      allowanceYocto: null,
    };
  }

  private async attestation(expectation: AgentAccessKeyExpectation): Promise<AgentAccessKeyAttestation> {
    const accessKeys = await this.near.getAccessKeys(expectation.accountId);
    return attestAgentAccessKeys(accessKeys.keys, expectation);
  }

  private async reserve(agent: {
    id: string;
    organizationId: string;
    nearAccountId: string;
    nearPublicKey: string;
    vaultAccountId: string;
  }): Promise<"reserved" | "in_progress" | "already_provisioned" | "daily_limit"> {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const existing = await transaction.agentProvisioning.findUnique({ where: { agentId: agent.id } });
          if (existing?.status === "reserved") return "in_progress";
          if (existing?.status === "provisioned" || existing?.status === "confirmed") return "already_provisioned";
          const [wallets, agents] = await Promise.all([
            transaction.nearWalletSponsorship.count({
              where: { createdAt: { gte: dayStart, lt: dayEnd }, status: { in: ["reserved", "sponsored"] } },
            }),
            transaction.agentProvisioning.count({
              where: { createdAt: { gte: dayStart, lt: dayEnd }, status: { in: ["reserved", "provisioned", "confirmed"] } },
            }),
          ]);
          if (wallets + agents >= this.dailyLimit) return "daily_limit";
          const data = {
            organizationId: agent.organizationId,
            nearAccountId: agent.nearAccountId,
            publicKey: agent.nearPublicKey,
            vaultAccountId: agent.vaultAccountId,
            methodNames: [...AGENT_FUNCTION_CALL_METHODS],
            reserveYocto: this.reserveYocto,
            allowanceYocto: null,
            status: "reserved",
            transactionHash: null,
            confirmedAt: null,
            createdAt: now,
          };
          await transaction.agentProvisioning.upsert({
            where: { agentId: agent.id },
            create: { agentId: agent.id, ...data },
            update: data,
          });
          return "reserved";
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (
          attempt < 2 &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "P2002" || error.code === "P2034")
        ) continue;
        throw error;
      }
    }
    throw new Error("unable to reserve agent provisioning");
  }

  private async complete(agentId: string, succeeded: boolean, transactionHash: string | null): Promise<void> {
    await this.prisma.agentProvisioning.update({
      where: { agentId },
      data: {
        status: succeeded ? "provisioned" : "failed",
        ...(transactionHash ? { transactionHash } : {}),
      },
    });
  }
}
