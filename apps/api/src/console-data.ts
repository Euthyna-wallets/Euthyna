import type { PrismaClient } from "@mandateos/db";
import { bytesToHex, createPublicClient, getAddress, http, erc20Abi } from "viem";
import { base, baseSepolia } from "viem/chains";

import { onChainAgentEvmAddress } from "./agent-chain.js";
import type { NearClient } from "./near.js";

const delayAbi = [
  { type: "function", name: "txNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "queueNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txExpiration", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txCreatedAt", stateMutability: "view", inputs: [{ name: "nonce", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
const safeAbi = [{
  type: "function",
  name: "getThreshold",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "uint256" }],
}] as const;


function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T;
}

export class ConsoleDataService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly baseRpcUrl: string,
    private readonly agentGasLowYocto = "50000000000000000000000",
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
    let agent = await this.prisma.agent.findFirst({ where: { id: agentId, organizationId } });
    if (!agent) return null;
    const [treasury, audits, provisioning] = await Promise.all([
      this.prisma.treasury.findFirst({ where: { organizationId } }),
      this.prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.agentProvisioning.findUnique({ where: { agentId } }),
    ]);
    let onChain: unknown = null;
    let mandate: unknown = null;
    let ethBalance: string | null = null;
    let nearGasBalanceYocto: string | null = null;
    try {
      nearGasBalanceYocto = (await this.near.getAccount(agent.nearAccountId)).amount;
    } catch {
      nearGasBalanceYocto = null;
    }
    const nearGasLow =
      nearGasBalanceYocto !== null &&
      BigInt(nearGasBalanceYocto) < BigInt(this.agentGasLowYocto);
    if (treasury) {
      try {
        onChain = await this.near.viewFunction(treasury.vaultAccountId, "get_agent", { agent: agent.nearAccountId });
        const derivedAddress = onChainAgentEvmAddress(onChain);
        if (derivedAddress && derivedAddress !== agent.evmAddress) {
          agent = await this.prisma.agent.update({
            where: { id: agent.id },
            data: { evmAddress: derivedAddress },
          });
        }
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
    return plain({
      agent,
      treasury,
      provisioning,
      onChain,
      mandate,
      budget,
      nonce,
      ethBalance,
      nearGasBalanceYocto,
      nearGasLow,
      nearGasLowThresholdYocto: this.agentGasLowYocto,
      audit: audits,
    });
  }

  async governance(organizationId: string) {
    const treasury = await this.prisma.treasury.findFirst({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
    if (!treasury) return { proposals: [], operations: [], delay: null, daoAccountId: null };
    const operations = await this.prisma.governanceOperation.findMany({
      where: { organizationId, treasuryId: treasury.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    try {
      const client = createPublicClient({
        chain: treasury.baseChainId === 8453 ? base : baseSepolia,
        transport: http(this.baseRpcUrl),
      });
      const [proposals, activeRelayOperation, txNonce, queueNonce, cooldown, expiration, safeThreshold, block] = await Promise.all([
        this.near.viewFunction<unknown[]>(treasury.daoAccountId, "get_proposals", {
          from_index: 0,
          limit: 50,
        }),
        this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation"),
        client.readContract({ address: getAddress(treasury.delayAddress), abi: delayAbi, functionName: "txNonce" }),
        client.readContract({ address: getAddress(treasury.delayAddress), abi: delayAbi, functionName: "queueNonce" }),
        client.readContract({ address: getAddress(treasury.delayAddress), abi: delayAbi, functionName: "txCooldown" }),
        client.readContract({ address: getAddress(treasury.delayAddress), abi: delayAbi, functionName: "txExpiration" }),
        client.readContract({ address: getAddress(treasury.safeAddress), abi: safeAbi, functionName: "getThreshold" }),
        client.getBlock({ blockTag: "latest" }),
      ]);
      const timeline = await Promise.all(operations.map(async (operation) => {
        const createdAt = operation.queueNonce === null
          ? null
          : await client.readContract({
              address: getAddress(treasury.delayAddress),
              abi: delayAbi,
              functionName: "txCreatedAt",
              args: [operation.queueNonce],
            });
        const cooldownEndsAt = createdAt === null ? null : createdAt + cooldown;
        const expiresAt = createdAt === null || expiration === 0n ? null : createdAt + cooldown + expiration;
        return {
          ...operation,
          cooldownEndsAt,
          expiresAt,
          countdownSeconds: cooldownEndsAt === null || cooldownEndsAt <= block.timestamp
            ? "0"
            : (cooldownEndsAt - block.timestamp).toString(),
        };
      }));
      return plain({
        daoAccountId: treasury.daoAccountId,
        treasury,
        proposals: proposals.reverse(),
        operations: timeline,
        relayActiveOperation: activeRelayOperation === null
          ? null
          : bytesToHex(Uint8Array.from(activeRelayOperation)),
        delay: {
          address: treasury.delayAddress,
          txNonce,
          queueNonce,
          cooldownSeconds: cooldown,
          expirationSeconds: expiration,
          safeThreshold,
          currentTimestamp: block.timestamp,
        },
      });
    } catch (error) {
      return {
        daoAccountId: treasury.daoAccountId,
        treasury: plain(treasury),
        proposals: [],
        operations: plain(operations),
        relayActiveOperation: null,
        delay: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
