import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@mandateos/db";
import { getAddress } from "viem";

import { AGENT_API_KEY_CONFIG_ID, type MandateAuth } from "./auth.js";

export interface AgentIdentity {
  agentId: string;
  organizationId: string;
  nearAccountId: string;
  vaultAccountId: string;
  role: string;
}

export interface ConsoleIdentity {
  userId: string;
  organizationId: string;
  role: string;
  email: string;
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
}

export interface CreateAgentInput {
  organizationId: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  mpcPath: string;
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
  listAgents(organizationId: string): Promise<AgentView[]>;
  getAgent(organizationId: string, agentId: string): Promise<AgentView | null>;
  listMembers(organizationId: string): Promise<MemberView[]>;
  addMember(
    organizationId: string,
    input: { name: string; nearAccountId: string; evmAddress: string },
  ): Promise<MemberView>;
  setMemberWallets(
    organizationId: string,
    memberId: string,
    input: { nearAccountId: string; evmAddress: string },
  ): Promise<MemberView | null>;
  startPasskeyRegistration(
    input: { email: string; name: string; nearPublicKey?: string | undefined },
  ): Promise<Response>;
  reserveNearWalletSponsorship(input: {
    organizationId: string;
    userId: string;
    nearAccountId: string;
    publicKey: string;
    dailyLimit: number;
  }): Promise<NearSponsorshipReservation>;
  completeNearWalletSponsorship(nearAccountId: string, succeeded: boolean): Promise<void>;
  isEmailVerified(headers: Headers): Promise<boolean>;
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
    createdAt: agent.createdAt,
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

  async identifyConsole(headers: Headers): Promise<ConsoleIdentity | null> {
    const session = await this.auth.api.getSession({ headers });
    if (!session) return null;
    const enrolledPasskey = await this.prisma.passkey.findFirst({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!enrolledPasskey) return null;
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

    const member = await this.prisma.member.findFirst({
      where: { userId: session.user.id, organizationId: activeOrganizationId },
    });
    if (!member) return null;
    return {
      userId: session.user.id,
      organizationId: member.organizationId,
      role: member.role,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
    };
  }

  async startPasskeyRegistration(
    input: { email: string; name: string; nearPublicKey?: string | undefined },
  ): Promise<Response> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const enrolled = await this.prisma.passkey.findFirst({
        where: { userId: existing.id },
        select: { id: true },
      });
      if (enrolled) {
        return new Response(JSON.stringify({ error: "account_exists" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
    }
    const context = await this.auth.createRegistrationContext({
      email,
      name: input.name,
      userId: existing?.id ?? randomUUID(),
    });
    return new Response(JSON.stringify({ context }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async isEmailVerified(headers: Headers): Promise<boolean> {
    const session = await this.auth.api.getSession({ headers });
    return session?.user.emailVerified === true;
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
        userId: input.userId,
        nearAccountId: input.nearAccountId,
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
              existing.userId !== input.userId ||
              existing.nearAccountId !== input.nearAccountId ||
              existing.publicKey !== input.publicKey
            ) {
              return "conflict";
            }
            if (existing.status === "sponsored") return "already_sponsored";
            if (existing.status === "reserved") return "in_progress";
          }

          const sponsoredToday = await transaction.nearWalletSponsorship.count({
            where: {
              createdAt: { gte: dayStart, lt: dayEnd },
              status: { in: ["reserved", "sponsored"] },
            },
          });
          if (sponsoredToday >= input.dailyLimit) return "daily_limit";
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
              userId: input.userId,
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

  async addMember(
    organizationId: string,
    input: { name: string; nearAccountId: string; evmAddress: string },
  ): Promise<MemberView> {
    const userId = randomUUID();
    const memberId = randomUUID();
    await this.prisma.$transaction([
      this.prisma.user.create({
        data: {
          id: userId,
          name: input.name,
          email: `member-${userId}@members.mandateos.invalid`,
          emailVerified: true,
        },
      }),
      this.prisma.member.create({
        data: {
          id: memberId,
          organizationId,
          userId,
          role: "member",
          nearAccountId: input.nearAccountId,
          evmAddress: getAddress(input.evmAddress),
          createdAt: new Date(),
        },
      }),
    ]);
    const member = await this.prisma.member.findUniqueOrThrow({
      where: { id: memberId },
      include: { user: true },
    });
    return {
      id: member.id,
      userId: member.userId,
      role: member.role,
      nearAccountId: member.nearAccountId,
      evmAddress: member.evmAddress,
      email: member.user.email,
      name: member.user.name,
    };
  }

  async setMemberWallets(
    organizationId: string,
    memberId: string,
    input: { nearAccountId: string; evmAddress: string },
  ): Promise<MemberView | null> {
    const updated = await this.prisma.member.updateMany({
      where: { id: memberId, organizationId },
      data: {
        nearAccountId: input.nearAccountId,
        evmAddress: getAddress(input.evmAddress),
      },
    });
    if (updated.count === 0) return null;
    const member = await this.prisma.member.findUniqueOrThrow({
      where: { id: memberId },
      include: { user: true },
    });
    return {
      id: member.id,
      userId: member.userId,
      role: member.role,
      nearAccountId: member.nearAccountId,
      evmAddress: member.evmAddress,
      email: member.user.email,
      name: member.user.name,
    };
  }

  async listMembers(organizationId: string): Promise<MemberView[]> {
    const members = await this.prisma.member.findMany({
      where: { organizationId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: member.role,
      nearAccountId: member.nearAccountId,
      evmAddress: member.evmAddress,
      email: member.user.email,
      name: member.user.name,
    }));
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
