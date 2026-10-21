import type { PrismaClient } from "@mandateos/db";
import { createPublicClient, getAddress, http, erc20Abi } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { NearClient } from "./near.js";

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T;
}

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
    const [token, contracts] = await Promise.all([
      this.prisma.contract.findFirst({ where: { organizationId, active: true } }),
      this.prisma.contract.findMany({ where: { organizationId, active: true } }),
    ]);
    const roleBudgets: Array<Record<string, unknown>> = [];
    if (treasury) {
      for (const role of [...new Set(contracts.map((contract) => contract.role))]) {
        try {
          const state = await this.near.viewFunction<Record<string, unknown>>(treasury.vaultAccountId, "get_role", { role });
          if (state) roleBudgets.push({ role, ...state });
        } catch {
          // role not deployed yet
        }
      }
    }
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
    return plain({
      treasury,
      registryVersion: registry?.version ?? 0,
      agents: { total: agents.length, active: agents.filter((agent) => agent.active).length },
      pendingEscalations: escalations.length,
      safeBalance,
      roleBudgets,
      operations,
    });
  }

  async operations(organizationId: string) {
    const [operations, escalations, visas] = await Promise.all([
      this.prisma.operation.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 }),
      this.prisma.escalation.findMany({ where: { organizationId } }),
      this.prisma.paymentVisa.findMany({ where: { organizationId } }),
    ]);
    return plain(operations.map((operation) => ({
      ...operation,
      status:
        escalations.find((escalation) => escalation.opId === operation.opId)?.status === "pending"
          ? "Escalated"
          : operation.state,
      hasVisa: visas.some((visa) => visa.opId === operation.opId),
    })));
  }

  async operation(organizationId: string, opId: string) {
    const [operation, escalation, visa] = await Promise.all([
      this.prisma.operation.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
      this.prisma.escalation.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
      this.prisma.paymentVisa.findUnique({ where: { organizationId_opId: { organizationId, opId } } }),
    ]);
    if (!operation) return null;
    const afterVault = operation.state !== "Prepared";
    const timeline = [
      { step: "Agent request", at: operation.createdAt, txHash: null },
      { step: "Guard visa", at: visa?.createdAt ?? null, txHash: null },
      { step: "Vault", at: afterVault ? operation.updatedAt : null, txHash: null },
      { step: "MPC signature", at: afterVault ? operation.updatedAt : null, txHash: null },
      { step: "Base broadcast", at: operation.broadcastAt, txHash: operation.txHash },
      { step: "Zodiac", at: operation.state === "Confirmed" ? operation.updatedAt : null, txHash: operation.txHash },
      { step: "Confirmed", at: operation.state === "Confirmed" ? operation.updatedAt : null, txHash: operation.txHash },
    ];
    if (operation.state === "Reverted") {
      timeline.push({ step: "Reverted", at: operation.revertedAt, txHash: operation.txHash });
    }
    if (operation.state === "Cancelled") {
      timeline.push({ step: "Cancelled", at: operation.updatedAt, txHash: operation.txHash });
    }
    return plain({ operation, escalation, visa, timeline });
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
    let nonce: number | null = null;
    let budget: unknown = null;
    if (treasury) {
      try {
        nonce = await this.near.viewFunction<number>(treasury.vaultAccountId, "next_evm_nonce", {
          agent: agent.nearAccountId,
        });
        budget = mandate;
      } catch {
        nonce = null;
      }
    }
    return plain({ agent, treasury, onChain, mandate, budget, nonce, ethBalance, audit: audits });
  }

  async governance(organizationId: string) {
    const treasury = await this.prisma.treasury.findFirst({ where: { organizationId } });
    if (!treasury) return { proposals: [], delay: null };
    try {
      const proposals = await this.near.viewFunction<unknown[]>(treasury.daoAccountId, "get_proposals", {
        from_index: 0,
        limit: 20,
      });
      return plain({ proposals: proposals.reverse(), delay: { address: treasury.delayAddress, cooldownSeconds: 300 } });
    } catch (error) {
      return { proposals: [], delay: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
