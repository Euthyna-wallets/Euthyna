import type { PrismaClient } from "@mandateos/db";
import { compilePaymentPermission, rolesAbi, type FlatCondition } from "@mandateos/deployer";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { onChainAgentEvmAddress } from "./agent-chain.js";
import type { NearClient } from "./near.js";
import { TreasuryError } from "./treasury.js";

export interface MandateInput {
  role: string;
  operations: string[];
  maxPerTx: string;
  budget: string;
  periodDays: number;
  recipients: Address[];
  token: Address;
  gas: {
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    maxTotalFee: string;
  };
  agent?: {
    nearAccountId: string;
    mpcPath: string;
    evmAddress?: Address | undefined;
  } | undefined;
}

export interface MandateProposal {
  receiverId: string;
  methodName: string;
  description: string;
  args: Record<string, unknown>;
  deposit: string;
}

export interface MandatePreview {
  roleKey: Hex;
  allowanceKey: Hex;
  vault: { config: Record<string, unknown>; current: unknown };
  zodiac: {
    target: Address;
    selector: Hex;
    conditions: FlatCondition[];
    calls: Array<{ to: Address; data: Hex; description: string }>;
  };
  guard: Record<string, unknown>;
  diff: Array<{ field: string; current: unknown; next: unknown }>;
  agentStatus: "ready" | "needs_agent_address" | "no_agent";
  proposals: {
    vaultSetRole: MandateProposal;
    vaultRegisterAgent: MandateProposal | null;
    funding: MandateProposal | null;
    zodiacRelay: MandateProposal[];
  };
  warnings: string[];
}

export interface MandateGateway {
  preview(organizationId: string, input: MandateInput): Promise<MandatePreview>;
}

function roleConfig(input: MandateInput, rolesModifier: Address, token: Address) {
  return {
    enabled: true,
    token: Array.from(Buffer.from(token.slice(2), "hex")),
    roles_modifier: Array.from(Buffer.from(rolesModifier.slice(2), "hex")),
    role_key: null as number[] | null,
    allowed_recipients: input.recipients.map((recipient) => Array.from(Buffer.from(recipient.slice(2), "hex"))),
    max_per_tx: input.maxPerTx,
    gas_limit: input.gas.gasLimit,
    max_fee_per_gas: input.gas.maxFeePerGas,
    max_priority_fee_per_gas: input.gas.maxPriorityFeePerGas,
    max_total_fee: input.gas.maxTotalFee,
  };
}

function functionCallArgs(args: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(args)).toString("base64");
}

function b64(bytes: Hex): string {
  return Buffer.from(bytes.slice(2), "hex").toString("base64");
}

export class MandateService implements MandateGateway {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
  ) {}

  async preview(organizationId: string, input: MandateInput): Promise<MandatePreview> {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(input.role)) {
      throw new TreasuryError(400, "invalid_role", "role must be a lowercase slug");
    }
    const unsupported = input.operations.filter((operation) => operation !== "pay");
    if (unsupported.length > 0) {
      throw new TreasuryError(400, "operation_not_supported", `unsupported operations: ${unsupported.join(", ")}`);
    }
    if (input.recipients.length === 0) throw new TreasuryError(400, "no_recipients", "at least one recipient is required");
    if (BigInt(input.maxPerTx) > BigInt(input.budget)) {
      throw new TreasuryError(400, "cap_above_budget", "maxPerTx cannot exceed the role budget");
    }
    if (input.periodDays < 1 || input.periodDays > 365) {
      throw new TreasuryError(400, "invalid_period", "periodDays must be between 1 and 365");
    }

    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: "uat" } },
    });
    if (!treasury) throw new TreasuryError(409, "treasury_missing", "register a treasury first");
    if (treasury.status !== "active") {
      throw new TreasuryError(409, "treasury_not_active", "treasury is pending DAO hardening");
    }

    const rolesModifier = getAddress(treasury.rolesAddress);
    const token = getAddress(input.token);
    const compiled = compilePaymentPermission({
      role: input.role,
      token,
      recipients: input.recipients.map((recipient) => getAddress(recipient)),
    });
    const config = {
      ...roleConfig(input, rolesModifier, token),
      role_key: Array.from(Buffer.from(compiled.roleKey.slice(2), "hex")),
    };
    let resolvedAgentAddress: Address | null = null;
    let storedAgent: { id: string; evmAddress: string | null } | null = null;
    if (input.agent) {
      storedAgent = await this.prisma.agent.findFirst({
        where: { organizationId, nearAccountId: input.agent.nearAccountId, active: true },
        select: { id: true, evmAddress: true },
      });
      if (storedAgent) {
        const onChainAgent = await this.near.viewFunction<unknown>(
          treasury.vaultAccountId,
          "get_agent",
          { agent: input.agent.nearAccountId },
        );
        const derivedAddress = onChainAgentEvmAddress(onChainAgent);
        if (derivedAddress) {
          resolvedAgentAddress = derivedAddress;
          if (derivedAddress !== storedAgent.evmAddress) {
            await this.prisma.agent.update({
              where: { id: storedAgent.id },
              data: { evmAddress: derivedAddress },
            });
          }
        } else if (storedAgent.evmAddress) {
          resolvedAgentAddress = getAddress(storedAgent.evmAddress);
        }
      }
    }
    const current = await this.near.viewFunction<unknown>(treasury.vaultAccountId, "get_role", { role: input.role });
    const currentConfig =
      current && typeof current === "object" && "config" in current
        ? (current as { config: Record<string, unknown> }).config
        : null;
    const diff = [
      ["enabled", currentConfig?.enabled, config.enabled],
      ["token", currentConfig?.token, config.token],
      ["role_key", currentConfig?.role_key, config.role_key],
      ["allowed_recipients", currentConfig?.allowed_recipients, config.allowed_recipients],
      ["max_per_tx", currentConfig?.max_per_tx, config.max_per_tx],
      ["gas_limit", currentConfig?.gas_limit, config.gas_limit],
      ["max_total_fee", currentConfig?.max_total_fee, config.max_total_fee],
    ]
      .filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after))
      .map(([field, before, after]) => ({ field: String(field), current: before ?? null, next: after }));

    const zodiacCalls: Array<{ to: Address; data: Hex; description: string }> = [];
    if (resolvedAgentAddress) {
      zodiacCalls.push({
        to: rolesModifier,
        data: encodeFunctionData({
          abi: rolesAbi,
          functionName: "assignRoles",
          args: [resolvedAgentAddress, [compiled.roleKey], [true]],
        }),
        description: `Assign role ${input.role} to ${resolvedAgentAddress}`,
      });
    }
    zodiacCalls.push(
      {
        to: rolesModifier,
        data: encodeFunctionData({ abi: rolesAbi, functionName: "scopeTarget", args: [compiled.roleKey, token] }),
        description: `Scope target ${token}`,
      },
      {
        to: rolesModifier,
        data: encodeFunctionData({
          abi: rolesAbi,
          functionName: "scopeFunction",
          args: [compiled.roleKey, token, compiled.selector, compiled.conditions, 0],
        }),
        description: "Allow transfer(recipient, amount) only to registered recipients",
      },
      {
        to: rolesModifier,
        data: encodeFunctionData({
          abi: rolesAbi,
          functionName: "setAllowance",
          args: [compiled.allowanceKey, BigInt(input.budget), 0n, 0n, 0n, 0n],
        }),
        description: `Set allowance ${input.budget} for ${input.role}`,
      },
    );

    const vaultSetRole: MandateProposal = {
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: `DAO proposal: Vault.set_role(${input.role})`,
      args: {
        proposal: {
          description: `Set mandate ${input.role}`,
          kind: {
            FunctionCall: {
              receiver_id: treasury.vaultAccountId,
              actions: [
                {
                  method_name: "set_role",
                  args: functionCallArgs({ role: input.role, config }),
                  gas: "50000000000000",
                  deposit: "0",
                },
              ],
            },
          },
        },
      },
      deposit: "100000000000000000000000",
    };

    const vaultRegisterAgent = input.agent
      ? {
          receiverId: treasury.daoAccountId,
          methodName: "add_proposal",
          description: `DAO proposal: Vault.register_agent(${input.agent.nearAccountId})`,
          args: {
            proposal: {
              description: `Register agent ${input.agent.nearAccountId} as ${input.role}`,
              kind: {
                FunctionCall: {
                  receiver_id: treasury.vaultAccountId,
                  actions: [
                    {
                      method_name: "register_agent",
                      args: functionCallArgs({
                        agent: input.agent.nearAccountId,
                        role: input.role,
                        mpc_path: input.agent.mpcPath,
                      }),
                      gas: "50000000000000",
                      deposit: "0",
                    },
                  ],
                },
              },
            },
          },
          deposit: "100000000000000000000000",
        }
      : null;

    const zodiacRelay: MandateProposal[] = zodiacCalls.map((call) => ({
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: `DAO proposal: relay ${call.description}`,
      args: {
        proposal: {
          description: call.description,
          kind: {
            FunctionCall: {
              receiver_id: treasury.relayAccountId,
              actions: [
                {
                  method_name: "propose",
                  args: functionCallArgs({
                    target: b64(call.to),
                    value: "0",
                    data: b64(call.data),
                    gas_limit: input.gas.gasLimit,
                    max_fee_per_gas: input.gas.maxFeePerGas,
                    max_priority_fee_per_gas: input.gas.maxPriorityFeePerGas,
                  }),
                  gas: "300000000000000",
                  deposit: "0",
                },
              ],
            },
          },
        },
      },
      deposit: "100000000000000000000000",
    }));

    const agentStatus = !input.agent || !storedAgent
      ? "no_agent"
      : resolvedAgentAddress
        ? "ready"
        : "needs_agent_address";

    return {
      roleKey: compiled.roleKey,
      allowanceKey: compiled.allowanceKey,
      vault: { config, current },
      zodiac: {
        target: compiled.target,
        selector: compiled.selector,
        conditions: compiled.conditions,
        calls: zodiacCalls,
      },
      guard: {
        role: input.role,
        operations: input.operations,
        maxPerTx: input.maxPerTx,
        budget: input.budget,
        periodDays: input.periodDays,
        recipients: input.recipients,
        token,
      },
      diff,
      agentStatus,
      proposals: {
        vaultSetRole,
        vaultRegisterAgent,
        funding:
          input.agent === undefined
            ? null
            : {
                receiverId: treasury.daoAccountId,
                methodName: "add_proposal",
                description: `DAO proposal: fund ${input.role} budget`,
                args: {
                  proposal: {
                    description: `Fund ${input.role} budget`,
                    kind: {
                      Transfer: {
                        receiver_id: treasury.vaultAccountId,
                        amount: input.budget,
                        msg: JSON.stringify({ role: input.role, config }),
                      },
                    },
                  },
                },
                deposit: "100000000000000000000000",
              },
        zodiacRelay,
      },
      warnings: [
        ...(agentStatus === "needs_agent_address"
          ? ["The agent EVM address is derived only after the Vault add-key/derive step; Zodiac assignRoles stays pending."]
          : []),
        "The server prepares proposals only. It never signs a DAO, Vault or Safe transaction.",
      ],
    };
  }
}
