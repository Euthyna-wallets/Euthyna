import { createHash } from "node:crypto";

import type { PrismaClient } from "@mandateos/db";
import {
  canonicalMultiSendCallOnlyAddress,
  compilePaymentPermission,
  encodeMultiSendTransactions,
  rolesAbi,
  type FlatCondition,
} from "@mandateos/deployer";
import { createPublicClient, encodeFunctionData, getAddress, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

import {
  BaseGasEstimationError,
  gasQuoteView,
  type BaseGasQuote,
  type BaseGasCaps,
  type BaseGasQuoteView,
  type BaseGasQuoter,
} from "./base-gas.js";
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
  gasQuote?: BaseGasQuoteView;
  warnings?: string[];
}
export interface BudgetTokenAction {
  receiverId: string;
  methodName: "storage_deposit" | "mint";
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
  description: string;
}

export interface BudgetTokenStatus {
  environment: string;
  tokenAccountId: string;
  symbol: string;
  decimals: number;
  daoAccountId: string;
  vaultAccountId: string;
  daoStorageRegistered: boolean;
  vaultStorageRegistered: boolean;
  daoBalance: string;
  storageDepositYocto: string;
}

export interface BudgetTokenPlan {
  status: BudgetTokenStatus;
  actions: BudgetTokenAction[];
}
interface AllowanceState {
  refill: bigint;
  maxRefill: bigint;
  period: bigint;
  balance: bigint;
  timestamp: bigint;
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
    relayDerive: MandateProposal;
    zodiacRelay: MandateProposal | null;
  };
  warnings: string[];
}

export interface MandateGateway {
  preview(organizationId: string, input: MandateInput): Promise<MandatePreview>;
  zodiacProposal(organizationId: string, input: MandateInput): Promise<MandateProposal>;
  budgetTokenStatus(organizationId: string): Promise<BudgetTokenStatus>;
  budgetTokenPlan(organizationId: string, amount: string): Promise<BudgetTokenPlan>;
}

function roleConfig(input: MandateInput, rolesModifier: Address, token: Address, gasCaps: BaseGasCaps) {
  return {
    enabled: true,
    token: Array.from(Buffer.from(token.slice(2), "hex")),
    roles_modifier: Array.from(Buffer.from(rolesModifier.slice(2), "hex")),
    role_key: null as number[] | null,
    allowed_recipients: input.recipients.map((recipient) => Array.from(Buffer.from(recipient.slice(2), "hex"))),
    max_per_tx: input.maxPerTx,
    gas_limit: gasCaps.gasLimit.toString(),
    max_fee_per_gas: gasCaps.maxFeePerGas.toString(),
    max_priority_fee_per_gas: gasCaps.maxPriorityFeePerGas.toString(),
    max_total_fee: (gasCaps.gasLimit * gasCaps.maxFeePerGas).toString(),
  };
}

function functionCallArgs(args: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(args)).toString("base64");
}

function b64(bytes: Hex): string {
  return Buffer.from(bytes.slice(2), "hex").toString("base64");
}

const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}] as const;
const delayModuleAbi = [{
  type: "function",
  name: "execTransactionFromModule",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ],
  outputs: [{ type: "bool" }],
}] as const;


export class MandateService implements MandateGateway {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly budgetTokenAccountId: string,
    private readonly baseRpcUrl: string,
    private readonly gasEstimator: BaseGasQuoter,
    private readonly agentGasCaps: BaseGasCaps,
    private readonly nowSeconds: () => bigint = () => BigInt(Math.floor(Date.now() / 1_000)),
    private readonly allowanceReader?: (chainId: number, roles: Address, key: Hex) => Promise<AllowanceState>,
  ) {}

  preview(organizationId: string, input: MandateInput): Promise<MandatePreview> {
    return this.buildPreview(organizationId, input, 0n);
  }

  async zodiacProposal(organizationId: string, input: MandateInput): Promise<MandateProposal> {
    const preview = await this.buildPreview(organizationId, input, this.nowSeconds());
    if (!preview.proposals.zodiacRelay) {
      throw new TreasuryError(409, "agent_address_missing", "derive the agent EVM address before Zodiac configuration");
    }
    return preview.proposals.zodiacRelay;
  }

  private async buildPreview(
    organizationId: string,
    input: MandateInput,
    allowanceTimestamp: bigint,
  ): Promise<MandatePreview> {
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

    await this.assertBudgetTokenDecimals();
    const rolesModifier = getAddress(treasury.rolesAddress);
    const token = getAddress(input.token);
    const compiled = compilePaymentPermission({
      role: input.role,
      token,
      recipients: input.recipients.map((recipient) => getAddress(recipient)),
    });
    const config = {
      ...roleConfig(input, rolesModifier, token, this.agentGasCaps),
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
    const currentAllowance = await this.readAllowance(treasury.baseChainId, rolesModifier, compiled.allowanceKey);
    const budget = BigInt(input.budget);
    const allowanceExists = Object.values(currentAllowance).some((value) => value !== 0n);
    const allowanceBalance = allowanceExists && currentAllowance.balance < budget
      ? currentAllowance.balance
      : budget;

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
          args: [
            compiled.allowanceKey,
            allowanceBalance,
            BigInt(input.budget),
            BigInt(input.budget),
            BigInt(input.periodDays) * 86_400n,
            allowanceTimestamp,
          ],
        }),
        description: `Set periodic allowance ${input.budget} every ${input.periodDays} days for ${input.role} without replenishing current balance`,
      },
    );
    const stepDigest = (value: unknown) => createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")
      .slice(0, 12);
    const setRoleDigest = stepDigest({ role: input.role, config });
    const registerAgentDigest = stepDigest({ role: input.role, agent: input.agent ?? null });
    const fundingDigest = stepDigest({
      role: input.role,
      amount: input.budget,
      tokenId: this.budgetTokenAccountId,
    });
    const relayDeriveDigest = stepDigest({
      relayAccountId: treasury.relayAccountId,
      method: "request_derived_public_key",
    });


    const vaultSetRole: MandateProposal = {
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: `DAO proposal: Vault.set_role(${input.role}) [mandate:${setRoleDigest}:set-role]`,
      args: {
        proposal: {
          description: `Set mandate ${input.role} [mandate:${setRoleDigest}:set-role]`,
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
          description: `DAO proposal: Vault.register_agent(${input.agent.nearAccountId}) [mandate:${registerAgentDigest}:register-agent]`,
          args: {
            proposal: {
              description: `Register agent ${input.agent.nearAccountId} as ${input.role} [mandate:${registerAgentDigest}:register-agent]`,
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

    const agentStatus = !input.agent || !storedAgent
      ? "no_agent"
      : resolvedAgentAddress
        ? "ready"
        : "needs_agent_address";
    const multiSendAddress = canonicalMultiSendCallOnlyAddress(treasury.baseChainId);
    const multiSendTransactions = encodeMultiSendTransactions(zodiacCalls.map((call) => ({
      operation: 0,
      to: call.to,
      value: 0n,
      data: call.data,
    })));
    const multiSendData = encodeFunctionData({
      abi: multiSendAbi,
      functionName: "multiSend",
      args: [multiSendTransactions],
    });
    let zodiacGas: BaseGasQuote | null = null;
    if (resolvedAgentAddress) {
      const delayData = encodeFunctionData({
        abi: delayModuleAbi,
        functionName: "execTransactionFromModule",
        args: [multiSendAddress, 0n, multiSendData, 1],
      });
      try {
        zodiacGas = await this.gasEstimator.quote({
          from: treasury.govAddress,
          to: treasury.delayAddress,
          data: delayData,
        });
      } catch (error) {
        const message = error instanceof BaseGasEstimationError ? error.message : String(error);
        throw new TreasuryError(422, "gas_estimation_failed", message);
      }
    }
    const zodiacDigest = stepDigest({
      role: input.role,
      agent: input.agent?.nearAccountId ?? null,
      agentAddress: resolvedAgentAddress,
      rolesModifier,
      multiSendAddress,
      token,
      recipients: input.recipients,
      budget: input.budget,
      periodDays: input.periodDays,
      gas: zodiacGas
        ? {
            gasLimit: zodiacGas.gasLimit.toString(),
            maxFeePerGas: zodiacGas.maxFeePerGas.toString(),
            maxPriorityFeePerGas: zodiacGas.maxPriorityFeePerGas.toString(),
          }
        : null,
    });
    const relayDerive: MandateProposal = {
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: `DAO proposal: derive relay 0xGOV [mandate:${relayDeriveDigest}:derive-relay]`,
      args: {
        proposal: {
          description: `Derive relay 0xGOV [mandate:${relayDeriveDigest}:derive-relay]`,
          kind: {
            FunctionCall: {
              receiver_id: treasury.relayAccountId,
              actions: [{
                method_name: "request_derived_public_key",
                args: functionCallArgs({}),
                gas: "60000000000000",
                deposit: "0",
              }],
            },
          },
        },
      },
      deposit: "100000000000000000000000",
    };

    const zodiacRelay: MandateProposal | null = resolvedAgentAddress
      ? {
          receiverId: treasury.daoAccountId,
          methodName: "add_proposal",
          description: `DAO proposal: batch Zodiac configuration [mandate:${zodiacDigest}:zodiac]`,
          args: {
            proposal: {
              description: `Batch Zodiac configuration [mandate:${zodiacDigest}:zodiac]`,
              kind: {
                FunctionCall: {
                  receiver_id: treasury.relayAccountId,
                  actions: [{
                    method_name: "propose",
                    args: functionCallArgs({
                      target: b64(multiSendAddress),
                      value: "0",
                      data: b64(multiSendData),
                      operation: 1,
                      gas_limit: zodiacGas!.gasLimit.toString(),
                      max_fee_per_gas: zodiacGas!.maxFeePerGas.toString(),
                      max_priority_fee_per_gas: zodiacGas!.maxPriorityFeePerGas.toString(),
                    }),
                    gas: "60000000000000",
                    deposit: "0",
                  }],
                },
              },
            },
          },
          deposit: "100000000000000000000000",
          gasQuote: gasQuoteView(zodiacGas!),
          warnings: zodiacGas!.sufficientBalance
            ? []
            : [`0xGOV needs ${zodiacGas!.requiredBalance} wei but holds ${zodiacGas!.senderBalance} wei`],
        }
      : null;

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
        relayDerive,
        funding:
          input.agent === undefined
            ? null
            : {
                receiverId: treasury.daoAccountId,
                methodName: "add_proposal",
                description: `DAO proposal: fund ${input.role} budget [mandate:${fundingDigest}:funding]`,
                args: {
                  proposal: {
                    description: `Fund ${input.role} budget [mandate:${fundingDigest}:funding]`,
                    kind: {
                      Transfer: {
                        token_id: this.budgetTokenAccountId,
                        receiver_id: treasury.vaultAccountId,
                        amount: input.budget,
                        msg: JSON.stringify({ role: input.role }),
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
        ...(zodiacGas && !zodiacGas.sufficientBalance
          ? [`0xGOV needs ${zodiacGas.requiredBalance} wei but holds ${zodiacGas.senderBalance} wei`]
          : []),
        "The server prepares proposals only. It never signs a DAO, Vault or Safe transaction.",
      ],
    };
  }
  private async readAllowance(chainId: number, roles: Address, key: Hex): Promise<AllowanceState> {
    if (this.allowanceReader) return this.allowanceReader(chainId, roles, key);
    const client = createPublicClient({
      chain: chainId === 8453 ? base : baseSepolia,
      transport: http(this.baseRpcUrl),
    });
    const allowance = await client.readContract({
      address: roles,
      abi: rolesAbi,
      functionName: "allowances",
      args: [key],
    });
    return {
      refill: allowance[0],
      maxRefill: allowance[1],
      period: allowance[2],
      balance: allowance[3],
      timestamp: allowance[4],
    };
  }

  async budgetTokenStatus(organizationId: string): Promise<BudgetTokenStatus> {
    const treasury = await this.prisma.treasury.findUnique({
      where: { organizationId_environment: { organizationId, environment: "uat" } },
    });
    if (!treasury) throw new TreasuryError(409, "treasury_missing", "register a treasury first");
    if (treasury.environment !== "uat") {
      throw new TreasuryError(400, "budget_mint_uat_only", "test budget token preparation is UAT-only");
    }
    const metadata = await this.assertBudgetTokenDecimals();
    const [bounds, daoStorage, vaultStorage, daoBalance] = await Promise.all([
      this.near.viewFunction<{ min: string }>(this.budgetTokenAccountId, "storage_balance_bounds"),
      this.near.viewFunction<unknown>(this.budgetTokenAccountId, "storage_balance_of", {
        account_id: treasury.daoAccountId,
      }),
      this.near.viewFunction<unknown>(this.budgetTokenAccountId, "storage_balance_of", {
        account_id: treasury.vaultAccountId,
      }),
      this.near.viewFunction<string>(this.budgetTokenAccountId, "ft_balance_of", {
        account_id: treasury.daoAccountId,
      }),
    ]);
    return {
      environment: treasury.environment,
      tokenAccountId: this.budgetTokenAccountId,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      daoAccountId: treasury.daoAccountId,
      vaultAccountId: treasury.vaultAccountId,
      daoStorageRegistered: daoStorage !== null,
      vaultStorageRegistered: vaultStorage !== null,
      daoBalance,
      storageDepositYocto: bounds.min,
    };
  }

  async budgetTokenPlan(organizationId: string, amount: string): Promise<BudgetTokenPlan> {
    if (!/^[1-9]\d*$/.test(amount)) {
      throw new TreasuryError(400, "invalid_budget_mint_amount", "mint amount must be a positive integer");
    }
    const status = await this.budgetTokenStatus(organizationId);
    const actions: BudgetTokenAction[] = [];
    if (!status.daoStorageRegistered) {
      actions.push({
        receiverId: status.tokenAccountId,
        methodName: "storage_deposit",
        args: { account_id: status.daoAccountId, registration_only: true },
        gas: "30000000000000",
        deposit: status.storageDepositYocto,
        description: `Register DAO ${status.daoAccountId} on ${status.symbol}`,
      });
    }
    if (!status.vaultStorageRegistered) {
      actions.push({
        receiverId: status.tokenAccountId,
        methodName: "storage_deposit",
        args: { account_id: status.vaultAccountId, registration_only: true },
        gas: "30000000000000",
        deposit: status.storageDepositYocto,
        description: `Register Vault ${status.vaultAccountId} on ${status.symbol}`,
      });
    }
    actions.push({
      receiverId: status.tokenAccountId,
      methodName: "mint",
      args: { account_id: status.daoAccountId, amount },
      gas: "30000000000000",
      deposit: "0",
      description: `Mint ${amount} ${status.symbol} to DAO (UAT test token)`,
    });
    return { status, actions };
  }

  private async assertBudgetTokenDecimals(): Promise<{ symbol: string; decimals: number }> {
    const metadata = await this.near.viewFunction<{ symbol?: unknown; decimals?: unknown }>(
      this.budgetTokenAccountId,
      "ft_metadata",
    );
    if (metadata.decimals !== 6) {
      throw new TreasuryError(
        422,
        "budget_token_decimals_mismatch",
        `budget token ${this.budgetTokenAccountId} must use 6 decimals`,
      );
    }
    return {
      symbol: typeof metadata.symbol === "string" ? metadata.symbol : this.budgetTokenAccountId,
      decimals: metadata.decimals,
    };
  }

}
