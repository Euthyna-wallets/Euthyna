import type { PrismaClient } from "@mandateos/db";
import { createPublicClient, getAddress, http, erc20Abi } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { NearClient } from "./near.js";

export class ConsoleDataService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly baseRpcUrl: string,
  ) {}

  async overview(organizationId: string) {
    const [treasury, registry, agents, escalations, operations] = await Promise.all([
      this.prisma.treasury.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" } }),
      this.prisma.registryVersion.findUnique({ where: { organizationId } }),
      this.prisma.agent.findMany({ where: { organizationId } }),
      this.prisma.escalation.findMany({ where: { organizationId, status: "pending" } }),
      this.prisma.operation.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);
    const token = await this.prisma.contract.findFirst({ where: { organizationId, active: true } });
    let safeBalance: string | null = null;
    if (treasury && token) {
      const client = createPublicClient({
        chain: treasury.baseChainId === 8453 ? base : baseSepolia,
        transport: http(this.baseRpcUrl),
      });
      try {
        safeBalance = (
          await client.readContract({
            address: getAddress(token.token),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(treasury.safeAddress)],
          })
        ).toString();
      } catch {
        safeBalance = null;
      }
    }
    return {
      treasury,
      registryVersion: registry?.version ?? 0,
      agents: { total: agents.length, active: agents.filter((agent) => agent.active).length },
      pendingEscalations: escalations.length,
      safeBalance,
      operations,
    };
  }

  async operations(organizationId: string) {
    const [operations, escalations, visas] = await Promise.all([
      this.prisma.operation.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 }),
      this.prisma.escalation.findMany({ where: { organizationId } }),
      this.prisma.paymentVisa.findMany({ where: { organizationId } }),
    ]);
    return operations.map((operation) => ({
      ...operation,
      status:
        escalations.find((escalation) => escalation.opId === operation.opId)?.status === "pending"
          ? "Escalated"
          : operation.state,
      hasVisa: visas.some((visa) => visa.opId === operation.opId),
    }));
  }

  async operation(organizationId: string, opId: string) {
    const [operation, escalation, visa] = await Promise.all([
      this.prisma.operation.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
      this.prisma.escalation.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
      this.prisma.paymentVisa.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
    ]);
    if (!operation) return null;
    const timeline = [
      { step: "Agent request", at: operation.createdAt, txHash: null },
      { step: "Guard visa", at: visa?.createdAt ?? null, txHash: null },
      { step: "Vault / MPC", at: operation.state !== "Prepared" ? operation.updatedAt : null, txHash: null },
      { step: "Base broadcast", at: operation.broadcastAt, txHash: operation.txHash },
      { step: "Base revert", at: operation.revertedAt, txHash: operation.txHash },
    ];
    return { operation, escalation, visa, timeline };
  }

  async agentDetail(organizationId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({ where: { id: agentId, organizationId } });
    if (!agent) return null;
    const [treasury, audits] = await Promise.all([
      this.prisma.treasury.findFirst({ where: { organizationId } }),
      this.prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    let onChain: unknown = null;
    let mandate: unknown = null;
    let ethBalance: string | null = null;
    if (treasury) {
      try {
        onChain = await this.near.viewFunction(treasury.vaultAccountId, "get_agent", { agent: agent.nearAccountId });
        mandate = await this.near.viewFunction(treasury.vaultAccountId, "get_role", { role: agent.role });
      } catch {
        onChain = null;
      }
      if (agent.evmAddress) {
        const client = createPublicClient({
          chain: treasury.baseChainId === 8453 ? base : baseSepolia,
          transport: http(this.baseRpcUrl),
        });
        try {
          ethBalance = (await client.getBalance({ address: getAddress(agent.evmAddress) })).toString();
        } catch {
          ethBalance = null;
        }
      }
    }
    return { agent, treasury, onChain, mandate, ethBalance, audit: audits };
  }

  async governance(organizationId: string) {
    const treasury = await this.prisma.treasury.findFirst({ where: { organizationId } });
    if (!treasury) return { proposals: [], delay: null };
    try {
      const proposals = await this.near.viewFunction<unknown[]>(treasury.daoAccountId, "get_proposals", {
        from_index: 0,
        limit: 20,
      });
      return { proposals: proposals.reverse(), delay: { address: treasury.delayAddress, cooldownSeconds: 300 } };
    } catch (error) {
      return { proposals: [], delay: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
