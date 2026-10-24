import type { PrismaClient } from "@mandateos/db";
import { bytesToHex, createPublicClient, encodeFunctionData, getAddress, http, type Address } from "viem";

import type { NearClient } from "./near.js";
import type { GovernanceOperation } from "./types.js";
import { baseSepolia } from "viem/chains";

const safeOwnerAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function",
    name: "swapOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "oldOwner", type: "address" },
      { name: "newOwner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "addOwnerWithThreshold",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "_threshold", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
const SAFE_SENTINEL = getAddress("0x0000000000000000000000000000000000000001");


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
    private readonly baseRpcUrl = "https://sepolia.base.org",
    private readonly safeOwnersReader?: (safe: Address) => Promise<Address[]>,
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
    const proposal = await this.near.viewFunction<{ status?: unknown; description?: unknown }>(
      treasury.daoAccountId,
      "get_proposal",
      { id: input.proposalId },
    );
    if (proposal.status !== "Approved") {
      throw new GovernanceError(409, "proposal_not_executed", "DAO proposal is not executed");
    }
    const supportedDescription =
      typeof proposal.description === "string" &&
      (
        proposal.description.includes(":zodiac]") ||
        proposal.description.startsWith("Recover Safe owner ") ||
        proposal.description.startsWith("Add Safe owner ")
      );
    if (!supportedDescription) {
      throw new GovernanceError(422, "proposal_not_governance", "DAO proposal is not a MandateOS governance action");
    }
    const activeOperation = await this.near.viewFunction<number[] | null>(treasury.relayAccountId, "active_operation");
    if (!activeOperation) throw new GovernanceError(409, "relay_operation_missing", "relay has no active operation");
    const operation = await this.near.viewFunction<GovernanceOperation | null>(treasury.relayAccountId, "get_operation", {
      op_id: activeOperation,
    });
    if (!operation) throw new GovernanceError(409, "relay_operation_missing", "relay operation is unavailable");
    const clientId = await this.near.viewFunction<string>(treasury.relayAccountId, "client_id");
    const opId = bytesToHex(Uint8Array.from(operation.op_id));
    const data = {
      treasuryId: treasury.id,
      relayAccountId: treasury.relayAccountId,
      clientId,
      proposalId: input.proposalId,
      nearExecutionTxHash: input.nearTransactionHash,
      nearExecutionSignerId: input.signerAccountId,
      target: bytesToHex(Uint8Array.from(operation.target)),
      value: operation.value,
      data: bytesToHex(Uint8Array.from(operation.data)),
      operation: operation.operation,
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
    const owners = this.safeOwnersReader
      ? await this.safeOwnersReader(getAddress(treasury.safeAddress))
      : await createPublicClient({ chain: baseSepolia, transport: http(this.baseRpcUrl) }).readContract({
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
              gas_limit: "200000",
              max_fee_per_gas: "20000000000",
              max_priority_fee_per_gas: "1000000000",
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
    const owners = this.safeOwnersReader
      ? await this.safeOwnersReader(getAddress(treasury.safeAddress))
      : await createPublicClient({ chain: baseSepolia, transport: http(this.baseRpcUrl) }).readContract({
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
              gas_limit: "200000",
              max_fee_per_gas: "20000000000",
              max_priority_fee_per_gas: "1000000000",
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
