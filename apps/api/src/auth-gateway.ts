import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@mandateos/db";
import { getAddress } from "viem";

import { AGENT_API_KEY_CONFIG_ID, type MandateAuth } from "./auth.js";
import { NEAR_PROVIDER_ID } from "./near-auth.js";

export interface AgentIdentity {
  agentId: string;
  organizationId: string;
  nearAccountId: string;
  vaultAccountId: string;
  role: string;
}

export interface SessionIdentity {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export interface ConsoleIdentity extends SessionIdentity {
  memberId: string;
  nearAccountId?: string | null;
  organizationId: string;
  role: string;
  emailVerified: boolean;
}

export interface AgentView {
  id: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  evmAddress: string | null;
  mpcPath: string;
  active: boolean;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface MemberView {
  id: string;
  userId: string;
  role: string;
  nearAccountId: string | null;
  evmAddress: string | null;
  email: string | null;
  name: string | null;
  walletProofClaimable: boolean;
  walletProofVerifiedAt: Date | null;
  walletProofApprovedAt: Date | null;
  walletProofApprovedBy: string | null;
}

export interface CreateAgentInput {
  organizationId: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  mpcPath: string;
  createdByUserId: string;
}

export interface CreatedAgent {
  agent: AgentView;
  apiKey: string;
}

export interface AuditEvent {
  organizationId?: string | null;
  actorType: "console" | "agent" | "system";
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}


export type NearSponsorshipReservation =
  | "reserved"
  | "already_sponsored"
  | "in_progress"
  | "daily_limit"
  | "member_mismatch"
  | "conflict";
/**
 * Boundary used by the HTTP layer. Tests inject a fake gateway; production uses
 * Better Auth sessions / API keys plus Prisma.
 */
export interface AuthGateway {
  handler(request: Request): Promise<Response>;
  identifyAgent(apiKey: string | undefined): Promise<AgentIdentity | null>;
  identifyConsole(headers: Headers): Promise<ConsoleIdentity | null>;
  /** The NEAR account signed in with these cookies, member of a company or not. */
  identifyNearAccount(headers: Headers): Promise<string | null>;
  listAgents(organizationId: string): Promise<AgentView[]>;
  getAgent(organizationId: string, agentId: string): Promise<AgentView | null>;
  setAgentEvmAddress(organizationId: string, agentId: string, evmAddress: string): Promise<AgentView | null>;
  listMembers(organizationId: string): Promise<MemberView[]>;
  reserveNearWalletSponsorship(input: {
    organizationId: string;
    userId: string;
    nearAccountId: string;
    publicKey: string;
    dailyLimit: number;
  }): Promise<NearSponsorshipReservation>;
  completeNearWalletSponsorship(nearAccountId: string, succeeded: boolean): Promise<void>;
  createAgent(input: CreateAgentInput): Promise<CreatedAgent>;
  revokeAgent(organizationId: string, agentId: string): Promise<boolean>;
  recordAudit(event: AuditEvent): Promise<void>;
}

function toAgentView(agent: {
  id: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  evmAddress: string | null;
  mpcPath: string;
  active: boolean;
  createdByUserId: string | null;
  createdAt: Date;
}): AgentView {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    nearAccountId: agent.nearAccountId,
    nearPublicKey: agent.nearPublicKey,
    vaultAccountId: agent.vaultAccountId,
    evmAddress: agent.evmAddress,
    mpcPath: agent.mpcPath,
    active: agent.active,
    createdByUserId: agent.createdByUserId,
    createdAt: agent.createdAt,
  };
}

function toMemberView(member: {
  id: string;
  userId: string;
  role: string;
  nearAccountId: string | null;
  evmAddress: string | null;
  walletProofClaimable: boolean;
  walletProofVerifiedAt: Date | null;
  walletProofApprovedAt: Date | null;
  walletProofApprovedBy: string | null;
  user: { email: string; name: string };
}): MemberView {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    nearAccountId: member.nearAccountId,
    evmAddress: member.evmAddress,
    email: member.user.email,
    name: member.user.name,
    walletProofClaimable: member.walletProofClaimable,
    walletProofVerifiedAt: member.walletProofVerifiedAt,
    walletProofApprovedAt: member.walletProofApprovedAt,
    walletProofApprovedBy: member.walletProofApprovedBy,
  };
}

export class BetterAuthGateway implements AuthGateway {
  constructor(
    private readonly auth: MandateAuth,
    private readonly prisma: PrismaClient,
  ) {}

  handler(request: Request): Promise<Response> {
    return this.auth.handler(request);
  }

  async identifyAgent(apiKey: string | undefined): Promise<AgentIdentity | null> {
    if (!apiKey) return null;
    const result = await this.auth.api.verifyApiKey({
      body: { key: apiKey, configId: AGENT_API_KEY_CONFIG_ID },
    });
    if (!result.valid || !result.key || result.key.enabled === false) return null;

    const agent = await this.prisma.agent.findUnique({
      where: { authUserId: result.key.referenceId },
    });
    if (!agent || !agent.active) return null;
    return {
      agentId: agent.id,
      organizationId: agent.organizationId,
      nearAccountId: agent.nearAccountId,
      vaultAccountId: agent.vaultAccountId,
      role: agent.role,
    };
  }

  /** A console session belongs to a user who signed in with a NEAR wallet. */
  private async nearSession(headers: Headers) {
    const session = await this.auth.api.getSession({ headers });
    if (!session) return null;
    const nearAccount = await this.prisma.account.findFirst({
      where: { userId: session.user.id, providerId: NEAR_PROVIDER_ID },
      select: { accountId: true },
    });
    return nearAccount ? { ...session, nearAccountId: nearAccount.accountId } : null;
  }

  async identifyNearAccount(headers: Headers): Promise<string | null> {
    return (await this.nearSession(headers))?.nearAccountId ?? null;
  }

  async identifyConsole(headers: Headers): Promise<ConsoleIdentity | null> {
    const session = await this.nearSession(headers);
    if (!session) return null;
    const sessionUser = { userId: session.user.id, email: session.user.email };
    const rawSession: unknown = session.session;
    if (
      !rawSession ||
      typeof rawSession !== "object" ||
      !("activeOrganizationId" in rawSession)
    ) {
      return null;
    }
    const activeOrganizationId = rawSession.activeOrganizationId;
    if (typeof activeOrganizationId !== "string" || activeOrganizationId.length === 0) {
      return null;
    }

    let member = await this.prisma.member.findFirst({
      where: { userId: sessionUser.userId, organizationId: activeOrganizationId },
    });
    if (!member) return null;
    if (!member.nearAccountId && session.nearAccountId) {
      // The company creator's seat is created by Better Auth; its NEAR account is the one they signed in with.
      member = await this.prisma.member.update({ where: { id: member.id }, data: { nearAccountId: session.nearAccountId } });
    }
    return {
      ...sessionUser,
      memberId: member.id,
      nearAccountId: member.nearAccountId,
      organizationId: member.organizationId,
      role: member.role,
      emailVerified: session.user.emailVerified,
    };
  }

  async reserveNearWalletSponsorship(input: {
    organizationId: string;
    userId: string;
    nearAccountId: string;
    publicKey: string;
    dailyLimit: number;
  }): Promise<NearSponsorshipReservation> {
    const member = await this.prisma.member.findFirst({
      where: {
        organizationId: input.organizationId,
        nearAccountId: input.nearAccountId,
        walletProofVerifiedAt: { not: null },
        walletProofApprovedAt: { not: null },
      },
    });
    if (!member) return "member_mismatch";

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const existing = await transaction.nearWalletSponsorship.findFirst({
            where: {
              OR: [{ nearAccountId: input.nearAccountId }, { publicKey: input.publicKey }],
            },
          });
          if (existing) {
            if (
              existing.organizationId !== input.organizationId ||
              existing.userId !== member.userId ||
              existing.nearAccountId !== input.nearAccountId ||
              existing.publicKey !== input.publicKey
            ) {
              return "conflict";
            }
            if (existing.status === "sponsored") return "already_sponsored";
            if (existing.status === "reserved") return "in_progress";
          }

          const [sponsoredWalletsToday, provisionedAgentsToday] = await Promise.all([
            transaction.nearWalletSponsorship.count({
              where: {
                createdAt: { gte: dayStart, lt: dayEnd },
                status: { in: ["reserved", "sponsored"] },
              },
            }),
            transaction.agentProvisioning.count({
              where: {
                createdAt: { gte: dayStart, lt: dayEnd },
                status: { in: ["reserved", "provisioned", "confirmed"] },
              },
            }),
          ]);
          if (sponsoredWalletsToday + provisionedAgentsToday >= input.dailyLimit) return "daily_limit";
          if (existing) {
            await transaction.nearWalletSponsorship.update({
              where: { id: existing.id },
              data: { status: "reserved" },
            });
            return "reserved";
          }
          await transaction.nearWalletSponsorship.create({
            data: {
              organizationId: input.organizationId,
              userId: member.userId,
              nearAccountId: input.nearAccountId,
              publicKey: input.publicKey,
            },
          });
          return "reserved";
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (
          attempt < 2 &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "P2034" || error.code === "P2002")
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("unable to reserve NEAR sponsorship");
  }

  async completeNearWalletSponsorship(nearAccountId: string, succeeded: boolean): Promise<void> {
    await this.prisma.nearWalletSponsorship.update({
      where: { nearAccountId },
      data: { status: succeeded ? "sponsored" : "failed" },
    });
  }

  async getAgent(organizationId: string, agentId: string): Promise<AgentView | null> {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, organizationId } });
    return agent ? toAgentView(agent) : null;
  }

  async setAgentEvmAddress(
    organizationId: string,
    agentId: string,
    evmAddress: string,
  ): Promise<AgentView | null> {
    const updated = await this.prisma.agent.updateMany({
      where: { id: agentId, organizationId },
      data: { evmAddress: getAddress(evmAddress) },
    });
    if (updated.count === 0) return null;
    return toAgentView(await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } }));
  }

  async listMembers(organizationId: string): Promise<MemberView[]> {
    const members = await this.prisma.member.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return members.map(toMemberView);
  }

  async listAgents(organizationId: string): Promise<AgentView[]> {
    const agents = await this.prisma.agent.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return agents.map(toAgentView);
  }

  async createAgent(input: CreateAgentInput): Promise<CreatedAgent> {
    const agentId = randomUUID();
    const authUserId = randomUUID();

    await this.prisma.$transaction([
      this.prisma.user.create({
        data: {
          id: authUserId,
          name: `agent:${input.name}`,
          email: `agent-${agentId}@agents.mandateos.invalid`,
          emailVerified: true,
        },
      }),
      this.prisma.agent.create({
        data: {
          id: agentId,
          organizationId: input.organizationId,
          authUserId,
          name: input.name,
          role: input.role,
          nearAccountId: input.nearAccountId,
          nearPublicKey: input.nearPublicKey,
          vaultAccountId: input.vaultAccountId,
          mpcPath: input.mpcPath,
          createdByUserId: input.createdByUserId,
        },
      }),
    ]);

    try {
      const createdKey = await this.auth.api.createApiKey({
        body: {
          configId: AGENT_API_KEY_CONFIG_ID,
          userId: authUserId,
          name: `agent:${input.name}`,
        },
      });
      const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      return { agent: toAgentView(agent), apiKey: createdKey.key };
    } catch (error) {
      await this.prisma.agent.deleteMany({ where: { id: agentId } });
      await this.prisma.user.deleteMany({ where: { id: authUserId } });
      throw error;
    }
  }

  async revokeAgent(organizationId: string, agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, organizationId },
    });
    if (!agent) return false;

    await this.prisma.$transaction([
      this.prisma.agent.update({ where: { id: agent.id }, data: { active: false } }),
      this.prisma.apikey.updateMany({
        where: { referenceId: agent.authUserId },
        data: { enabled: false },
      }),
    ]);
    return true;
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: event.organizationId ?? null,
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        ...(event.metadata === undefined
          ? {}
          : { metadata: event.metadata as Prisma.InputJsonValue }),
      },
    });
  }
}
