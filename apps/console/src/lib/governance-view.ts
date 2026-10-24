import { decodeMultiSendTransactions, rolesAbi } from "@mandateos/deployer";
import { bytesToHex, decodeFunctionData, getAddress, toFunctionSelector, type Hex } from "viem";

const swapOwnerSelector = toFunctionSelector("swapOwner(address,address,address)");
const addOwnerSelector = toFunctionSelector("addOwnerWithThreshold(address,uint256)");
const multiSendSelector = toFunctionSelector("multiSend(bytes)");
const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}] as const;
const safeOwnerAbi = [
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
      { name: "threshold", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export interface DecisionEffect {
  title: string;
  details: string[];
  warnings: string[];
  recognized: boolean;
}

interface FunctionCallAction {
  methodName: string;
  args: string;
}

function functionCall(kind: unknown): { receiverId: string; actions: FunctionCallAction[] } | null {
  if (!kind || typeof kind !== "object" || !("FunctionCall" in kind)) return null;
  const value = kind.FunctionCall;
  if (!value || typeof value !== "object" || !("receiver_id" in value) || !("actions" in value)) return null;
  if (typeof value.receiver_id !== "string" || !Array.isArray(value.actions)) return null;
  const actions: FunctionCallAction[] = [];
  for (const action of value.actions) {
    if (!action || typeof action !== "object" || !("method_name" in action) || !("args" in action)) return null;
    if (typeof action.method_name !== "string" || typeof action.args !== "string") return null;
    actions.push({ methodName: action.method_name, args: action.args });
  }
  return { receiverId: value.receiver_id, actions };
}

export function relayAction(kind: unknown, relayAccountId: string | undefined): "propose" | "cancel_nonce" | null {
  const call = functionCall(kind);
  if (!call || !relayAccountId || call.receiverId !== relayAccountId || call.actions.length !== 1) return null;
  const methodName = call.actions[0]!.methodName;
  return methodName === "propose" || methodName === "cancel_nonce" ? methodName : null;
}

function relayPayload(argsBase64: string): { selector: string; data: Hex; target: string } | null {
  try {
    const json = JSON.parse(atob(argsBase64)) as unknown;
    if (
      !json ||
      typeof json !== "object" ||
      !("data" in json) ||
      !("target" in json) ||
      typeof json.data !== "string" ||
      typeof json.target !== "string"
    ) return null;
    const dataBytes = Uint8Array.from(atob(json.data), (character) => character.charCodeAt(0));
    const targetBytes = Uint8Array.from(atob(json.target), (character) => character.charCodeAt(0));
    const data = bytesToHex(dataBytes);
    return {
      selector: bytesToHex(dataBytes.slice(0, 4)),
      data,
      target: getAddress(bytesToHex(targetBytes)),
    };
  } catch {
    return null;
  }
}

function jsonArgs(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tokenAmount(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "unknown amount";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

export function proposalDecision(input: {
  kind?: unknown;
  relayAccountId?: string | undefined;
  knownEvmAddresses?: string[] | undefined;
}): DecisionEffect {
  if (input.kind && typeof input.kind === "object" && "Transfer" in input.kind) {
    const transfer = input.kind.Transfer;
    if (transfer && typeof transfer === "object" && "receiver_id" in transfer && "amount" in transfer) {
      const receiver = String(transfer.receiver_id);
      return {
        title: "Fund a spending permission",
        details: [`Recipient: ${receiver}`, `Amount: ${tokenAmount(transfer.amount)}`],
        warnings: receiver.toLowerCase().includes("dead") ? ["Recipient is the burn address"] : [],
        recognized: true,
      };
    }
  }
  const call = functionCall(input.kind);
  const action = call?.actions[0];
  if (!call || !action) {
    return { title: "Unrecognized action — review carefully", details: [], warnings: ["Unknown calldata"], recognized: false };
  }
  if (call.receiverId === input.relayAccountId && action.methodName === "cancel_nonce") {
    return { title: "Cancel an underpriced transaction", details: ["Releases the decision queue after confirmation"], warnings: [], recognized: true };
  }
  if (call.receiverId === input.relayAccountId && action.methodName === "request_derived_public_key") {
    return { title: "Create the governance signer", details: ["Required once before Base decisions"], warnings: [], recognized: true };
  }
  if (call.receiverId === input.relayAccountId && action.methodName === "propose") {
    const payload = relayPayload(action.args);
    if (!payload) {
      return { title: "Unrecognized action — review carefully", details: [], warnings: ["Malformed relay calldata"], recognized: false };
    }
    if (payload.selector === swapOwnerSelector) {
      try {
        const decoded = decodeFunctionData({ abi: safeOwnerAbi, data: payload.data });
        if (decoded.functionName === "swapOwner") {
          const oldOwner = getAddress(decoded.args[1]);
          const newOwner = getAddress(decoded.args[2]);
          return {
            title: "Replace a Treasury owner",
            details: [`${oldOwner} → ${newOwner}`],
            warnings: [
              ...(newOwner.toLowerCase().endsWith("dead") ? ["New owner is the burn address"] : []),
              ...(input.knownEvmAddresses && !input.knownEvmAddresses.some((address) => address.toLowerCase() === newOwner.toLowerCase())
                ? ["New owner address is not linked to a known member"]
                : []),
            ],
            recognized: true,
          };
        }
      } catch {
        // Fall through to the red unknown state.
      }
    }
    if (payload.selector === addOwnerSelector) {
      try {
        const decoded = decodeFunctionData({ abi: safeOwnerAbi, data: payload.data });
        if (decoded.functionName === "addOwnerWithThreshold") {
          return {
            title: "Add a Treasury owner",
            details: [`Owner: ${getAddress(decoded.args[0])}`, `New threshold: ${decoded.args[1]}`],
            warnings: [
              ...(decoded.args[0].toLowerCase().endsWith("dead") ? ["Owner is the burn address"] : []),
              ...(decoded.args[1] === 1n ? ["Critical: threshold becomes 1"] : []),
              ...(input.knownEvmAddresses && !input.knownEvmAddresses.some((address) => address.toLowerCase() === decoded.args[0].toLowerCase())
                ? ["Owner address is not linked to a known member"]
                : []),
            ],
            recognized: true,
          };
        }
      } catch {
        // Fall through to the red unknown state.
      }
    }
    if (payload.selector === multiSendSelector) {
      const details = [`Execution target: ${payload.target}`];
      try {
        const outer = decodeFunctionData({ abi: multiSendAbi, data: payload.data });
        if (outer.functionName === "multiSend") {
          const calls = decodeMultiSendTransactions(outer.args[0]);
          details.push(`${calls.length} permission changes in one decision`);
          for (const nested of calls) {
            try {
              const decoded = decodeFunctionData({ abi: rolesAbi, data: nested.data });
              if (decoded.functionName === "setAllowance") {
                details.push(`Available after update: ${tokenAmount(decoded.args[1].toString())}`);
                details.push(`Budget per period: ${tokenAmount(decoded.args[2].toString())}`);
                details.push(`Refill: ${tokenAmount(decoded.args[3].toString())} every ${Math.round(Number(decoded.args[4]) / 86_400)} days`);
              }
            } catch {
              // Other scoped calls are summarized by count.
            }
          }
        }
      } catch {
        return { title: "Unrecognized action — review carefully", details, warnings: ["Malformed permission batch"], recognized: false };
      }
      return {
        title: "Update an agent spending permission",
        details,
        warnings: [],
        recognized: true,
      };
    }
    return { title: "Unrecognized action — review carefully", details: [`Target: ${payload.target}`], warnings: ["Unknown Base call"], recognized: false };
  }
  if (action.methodName === "set_role") {
    const args = jsonArgs(action.args);
    const config = args?.config;
    const details: string[] = [];
    if (config && typeof config === "object" && "max_per_tx" in config) {
      details.push(`Maximum per payment: ${tokenAmount(config.max_per_tx)}`);
    }
    return { title: "Set a spending permission", details, warnings: [], recognized: true };
  }
  if (action.methodName === "register_agent") {
    const args = jsonArgs(action.args);
    return {
      title: "Register an AI agent",
      details: typeof args?.agent === "string" ? [`Agent: ${args.agent}`] : [],
      warnings: [],
      recognized: true,
    };
  }
  return { title: "Unrecognized action — review carefully", details: [], warnings: ["Unknown decision type"], recognized: false };
}

export function proposalEffect(input: {
  kind?: unknown;
  relayAccountId?: string | undefined;
}): string {
  return proposalDecision(input).title;
}

export function approvalCount(votes: Record<string, string> | undefined): number {
  return Object.values(votes ?? {}).filter((vote) => vote === "Approve").length;
}
