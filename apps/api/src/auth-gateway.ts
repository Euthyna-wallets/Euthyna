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
  registerPasswordless(
    baseUrl: string,
    consoleOrigin: string,
    input: { email: string; name: string },
  ): Promise<Response>;
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
    };
  }

  async registerPasswordless(
    baseUrl: string,
    consoleOrigin: string,
    input: { email: string; name: string },
  ): Promise<Response> {
    const password = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const response = await this.auth.handler(
      new Request(`${baseUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: consoleOrigin, "content-type": "application/json" },
        body: JSON.stringify({ email: input.email, name: input.name, password }),
      }),
    );
    if (!response.ok) return response;
    const payload = (await response.clone().json()) as { user?: { id?: string } };
    if (payload.user?.id) {
      await this.prisma.account.deleteMany({
        where: { userId: payload.user.id, providerId: "credential" },
      });
    }
    return response;
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
