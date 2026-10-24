import type { PrismaClient } from "@mandateos/db";
import { bytesToHex, createPublicClient, encodeFunctionData, getAddress, http, type Address, type Hex } from "viem";
import { z } from "zod";

import { decodeGovernanceEffect, safeOwnerAbi } from "./governance-calldata.js";
import type { NearClient } from "./near.js";
import type { GovernanceOperation } from "./types.js";
import { baseSepolia } from "viem/chains";

const SAFE_SENTINEL = getAddress("0x0000000000000000000000000000000000000001");

const daoProposalSchema = z.object({
  status: z.unknown(),
  kind: z.object({
    FunctionCall: z.object({
      receiver_id: z.string(),
      actions: z.array(z.object({
        method_name: z.string(),
        args: z.string(),
      })),
    }),
  }),
});
const relayProposeArgsSchema = z.object({
  target: z.string(),
  value: z.string().regex(/^\d+$/),
  data: z.string(),
  operation: z.union([z.literal(0), z.literal(1)]),
});

export interface GovernanceProposalGas {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface GovernanceServiceOptions {
  baseRpcUrl: string;
  proposalGas: GovernanceProposalGas;
  safeOwnersReader?: (safe: Address) => Promise<Address[]>;
}

interface RelayProposalCall {
  target: Hex;
  value: string;
  data: Hex;
  operation: 0 | 1;
}

function governanceProposalCall(proposalValue: unknown, relayAccountId: string): RelayProposalCall {
  const proposal = daoProposalSchema.parse(proposalValue);
  const call = proposal.kind.FunctionCall;
  if (call.receiver_id !== relayAccountId || call.actions.length !== 1 || call.actions[0]?.method_name !== "propose") {
    throw new GovernanceError(422, "proposal_not_governance", "DAO proposal does not contain one relay propose call");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(call.actions[0].args, "base64").toString("utf8"));
  } catch {
    throw new GovernanceError(422, "proposal_not_governance", "relay proposal arguments are not valid JSON");
  }
  const args = relayProposeArgsSchema.parse(parsed);
  const targetBytes = Buffer.from(args.target, "base64");
  if (targetBytes.length !== 20) {
    throw new GovernanceError(422, "proposal_not_governance", "relay proposal target must contain 20 bytes");
  }
  const dataBytes = Buffer.from(args.data, "base64");
  if (dataBytes.length < 4) {
    throw new GovernanceError(422, "proposal_not_governance", "relay proposal calldata is missing a selector");
  }
  return {
    target: bytesToHex(targetBytes),
    value: args.value,
    data: bytesToHex(dataBytes),
    operation: args.operation,
  };
}


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
  unblockProposal(organizationId: string, opId: string): Promise<{
    receiverId: string;
    methodName: string;
    description: string;
    args: Record<string, unknown>;
    deposit: string;
  }>;
  swapOwnerProposal(
    organizationId: string,
    input: { oldOwner: string; newOwner: string },
  ): Promise<{
    receiverId: string;
    methodName: string;
    description: string;
    args: Record<string, unknown>;
    deposit: string;
  }>;
  addOwnerProposal(organizationId: string, input: { newOwner: string }): Promise<{
    receiverId: string;
    methodName: string;
    description: string;
    args: Record<string, unknown>;
    deposit: string;
  }>;
}

export class GovernanceService implements GovernanceGateway {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly near: NearClient,
    private readonly options: GovernanceServiceOptions,
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
    const proposalValue = await this.near.viewFunction<unknown>(
      treasury.daoAccountId,
      "get_proposal",
      { id: input.proposalId },
    );
    let proposal;
    try {
      proposal = daoProposalSchema.parse(proposalValue);
    } catch {
      throw new GovernanceError(422, "proposal_not_governance", "DAO proposal has an invalid on-chain shape");
    }
    if (proposal.status !== "Approved") {
      throw new GovernanceError(409, "proposal_not_executed", "DAO proposal is not executed");
    }
    const activeOperation = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
    if (!activeOperation) throw new GovernanceError(409, "relay_operation_missing", "relay has no active operation");
    const operation = await this.near.viewFunction<GovernanceOperation | null>(treasury.relayAccountId, "get_operation", {
      op_id: activeOperation,
    });
    if (!operation) throw new GovernanceError(409, "relay_operation_missing", "relay operation is unavailable");
    let proposalCall: RelayProposalCall;
    try {
      proposalCall = governanceProposalCall(proposal, treasury.relayAccountId);
    } catch (error) {
      if (error instanceof GovernanceError) throw error;
      throw new GovernanceError(422, "proposal_not_governance", "DAO relay proposal calldata is invalid");
    }
    const operationCall = {
      target: bytesToHex(Uint8Array.from(operation.target)),
      value: operation.value,
      data: bytesToHex(Uint8Array.from(operation.data)),
      operation: operation.operation,
    };
    if (
      proposalCall.target.toLowerCase() !== operationCall.target.toLowerCase() ||
      proposalCall.value !== operationCall.value ||
      proposalCall.data.toLowerCase() !== operationCall.data.toLowerCase() ||
      proposalCall.operation !== operationCall.operation
    ) {
      throw new GovernanceError(422, "proposal_operation_mismatch", "DAO proposal does not match the active relay operation");
    }
    try {
      decodeGovernanceEffect({
        chainId: treasury.baseChainId,
        safeAddress: treasury.safeAddress,
        rolesAddress: treasury.rolesAddress,
        ...operationCall,
      });
    } catch {
      throw new GovernanceError(422, "proposal_not_governance", "relay calldata is not a supported MandateOS governance action");
    }
    const clientId = await this.near.viewFunction<string>(treasury.relayAccountId, "client_id");
    const opId = bytesToHex(Uint8Array.from(operation.op_id));
    const data = {
      treasuryId: treasury.id,
      relayAccountId: treasury.relayAccountId,
      clientId,
      proposalId: input.proposalId,
      nearExecutionTxHash: input.nearTransactionHash,
      nearExecutionSignerId: input.signerAccountId,
      target: operationCall.target,
      value: operationCall.value,
      data: operationCall.data,
      operation: operationCall.operation,
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

  async unblockProposal(organizationId: string, opId: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opId)) {
      throw new GovernanceError(400, "invalid_operation_id", "operation id must contain 32 bytes");
    }
    const operation = await this.prisma.governanceOperation.findUnique({
      where: { organizationId_opId: { organizationId, opId } },
      include: { treasury: true },
    });
    if (!operation) throw new GovernanceError(404, "governance_operation_missing", "governance operation not found");
    if (!["Vetoed", "Expired", "Failed", "Executed"].includes(operation.state)) {
      throw new GovernanceError(409, "operation_not_terminal", "governance operation is not terminal");
    }
    if (!operation.txHash) throw new GovernanceError(409, "queue_hash_missing", "queue transaction hash missing");
    const active = await this.near.viewFunction<number[] | null>(
      operation.relayAccountId,
      "active_operation",
    );
    if (!active || Buffer.from(active).toString("hex") !== opId.slice(2).toLowerCase()) {
      throw new GovernanceError(409, "relay_not_blocked", "relay is not blocked by this operation");
    }
    const opIdBytes = Array.from(Buffer.from(opId.slice(2), "hex"));
    const proposal = {
      description: `Release terminal relay operation ${opId}`,
      kind: {
        FunctionCall: {
          receiver_id: operation.relayAccountId,
          actions: [{
            method_name: "confirm_original",
            args: Buffer.from(JSON.stringify({
              op_id: opIdBytes,
              tx_hash: Array.from(Buffer.from(operation.txHash.slice(2), "hex")),
              mpc_signature: null,
            })).toString("base64"),
            deposit: "0",
            gas: "50000000000000",
          }],
        },
      },
    };
    return {
      receiverId: operation.treasury.daoAccountId,
      methodName: "add_proposal",
      description: proposal.description,
      args: { proposal },
      deposit: "100000000000000000000000",
    };
  }

  async swapOwnerProposal(
    organizationId: string,
    input: { oldOwner: string; newOwner: string },
  ) {
    const treasury = await this.prisma.treasury.findFirst({
      where: { organizationId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!treasury) throw new GovernanceError(409, "treasury_missing", "active treasury not found");
    const active = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
    if (active) throw new GovernanceError(409, "relay_busy", "relay still has an active operation");

    const oldOwner = getAddress(input.oldOwner);
    const newOwner = getAddress(input.newOwner);
    if (oldOwner === newOwner) throw new GovernanceError(400, "same_owner", "replacement owner must differ");
    const owners = this.options.safeOwnersReader
      ? await this.options.safeOwnersReader(getAddress(treasury.safeAddress))
      : await createPublicClient({ chain: baseSepolia, transport: http(this.options.baseRpcUrl) }).readContract({
          address: getAddress(treasury.safeAddress),
          abi: safeOwnerAbi,
          functionName: "getOwners",
        });
    const normalized = owners.map((owner) => getAddress(owner));
    const oldIndex = normalized.indexOf(oldOwner);
    if (oldIndex === -1) throw new GovernanceError(422, "old_owner_missing", "old owner is not in the Safe");
    if (normalized.includes(newOwner)) throw new GovernanceError(422, "new_owner_exists", "new owner already owns the Safe");
    const previousOwner = oldIndex === 0 ? SAFE_SENTINEL : normalized[oldIndex - 1]!;
    const calldata = encodeFunctionData({
      abi: safeOwnerAbi,
      functionName: "swapOwner",
      args: [previousOwner, oldOwner, newOwner],
    });
    const proposal = {
      description: `Recover Safe owner ${oldOwner} -> ${newOwner}`,
      kind: {
        FunctionCall: {
          receiver_id: treasury.relayAccountId,
          actions: [{
            method_name: "propose",
            args: Buffer.from(JSON.stringify({
              target: Buffer.from(treasury.safeAddress.slice(2), "hex").toString("base64"),
              value: "0",
              data: Buffer.from(calldata.slice(2), "hex").toString("base64"),
              operation: 0,
              gas_limit: this.options.proposalGas.gasLimit,
              max_fee_per_gas: this.options.proposalGas.maxFeePerGas,
              max_priority_fee_per_gas: this.options.proposalGas.maxPriorityFeePerGas,
            })).toString("base64"),
            deposit: "0",
            gas: "60000000000000",
          }],
        },
      },
    };
    return {
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: proposal.description,
      args: { proposal },
      deposit: "100000000000000000000000",
    };
  }

  async addOwnerProposal(organizationId: string, input: { newOwner: string }) {
    const treasury = await this.prisma.treasury.findFirst({
      where: { organizationId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!treasury) throw new GovernanceError(409, "treasury_missing", "active treasury not found");
    const active = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
    if (active) throw new GovernanceError(409, "relay_busy", "relay still has an active operation");

    const newOwner = getAddress(input.newOwner);
    const owners = this.options.safeOwnersReader
      ? await this.options.safeOwnersReader(getAddress(treasury.safeAddress))
      : await createPublicClient({ chain: baseSepolia, transport: http(this.options.baseRpcUrl) }).readContract({
          address: getAddress(treasury.safeAddress),
          abi: safeOwnerAbi,
          functionName: "getOwners",
        });
    const normalized = owners.map((owner) => getAddress(owner));
    if (normalized.length !== 2) {
      throw new GovernanceError(409, "safe_not_two_owner", "recovery expects a two-owner Safe");
    }
    if (normalized.includes(newOwner)) {
      throw new GovernanceError(422, "new_owner_exists", "new owner already owns the Safe");
    }
    const calldata = encodeFunctionData({
      abi: safeOwnerAbi,
      functionName: "addOwnerWithThreshold",
      args: [newOwner, 2n],
    });
    const proposal = {
      description: `Add Safe owner ${newOwner} and set threshold 2/3`,
      kind: {
        FunctionCall: {
          receiver_id: treasury.relayAccountId,
          actions: [{
            method_name: "propose",
            args: Buffer.from(JSON.stringify({
              target: Buffer.from(treasury.safeAddress.slice(2), "hex").toString("base64"),
              value: "0",
              data: Buffer.from(calldata.slice(2), "hex").toString("base64"),
              operation: 0,
              gas_limit: this.options.proposalGas.gasLimit,
              max_fee_per_gas: this.options.proposalGas.maxFeePerGas,
              max_priority_fee_per_gas: this.options.proposalGas.maxPriorityFeePerGas,
            })).toString("base64"),
            deposit: "0",
            gas: "60000000000000",
          }],
        },
      },
    };
    return {
      receiverId: treasury.daoAccountId,
      methodName: "add_proposal",
      description: proposal.description,
      args: { proposal },
      deposit: "100000000000000000000000",
    };
  }
}
