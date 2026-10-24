import { toFunctionSelector } from "viem";

const swapOwnerSelector = toFunctionSelector("swapOwner(address,address,address)");
const addOwnerSelector = toFunctionSelector("addOwnerWithThreshold(address,uint256)");
const multiSendSelector = toFunctionSelector("multiSend(bytes)");

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

function relaySelector(argsBase64: string): string | null {
  try {
    const json = JSON.parse(atob(argsBase64)) as unknown;
    if (!json || typeof json !== "object" || !("data" in json) || typeof json.data !== "string") return null;
    const bytes = Uint8Array.from(atob(json.data), (character) => character.charCodeAt(0));
    return `0x${Array.from(bytes.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

export function cleanProposalDescription(description: string | undefined): string {
  return (description ?? "Governance action").replace(/\s*\[mandate:[^\]]+\]\s*$/i, "");
}

export function proposalEffect(input: {
  description?: string;
  kind?: unknown;
  relayAccountId?: string | undefined;
}): string {
  const call = functionCall(input.kind);
  if (!call) {
    if (input.kind && typeof input.kind === "object" && "Transfer" in input.kind) return "Fund the Vault budget";
    return cleanProposalDescription(input.description);
  }
  const action = call.actions[0];
  if (!action) return cleanProposalDescription(input.description);
  if (call.receiverId === input.relayAccountId && action.methodName === "cancel_nonce") {
    return "Cancel an underpriced Base transaction and release the relay";
  }
  if (call.receiverId === input.relayAccountId && action.methodName === "request_derived_public_key") {
    return "Create the DAO governance address on Base";
  }
  if (call.receiverId === input.relayAccountId && action.methodName === "propose") {
    const selector = relaySelector(action.args);
    if (selector === swapOwnerSelector) return "Replace a Safe owner through the Delay";
    if (selector === addOwnerSelector) return "Add a Safe owner and update the threshold";
    if (selector === multiSendSelector) return "Configure the agent's Zodiac role, suppliers and allowance";
    return "Queue a decoded Base governance action";
  }
  if (action.methodName === "set_role") return "Set the Vault role, budget and supplier limits";
  if (action.methodName === "register_agent") return "Register the agent in the Vault";
  return cleanProposalDescription(input.description);
}

export function approvalCount(votes: Record<string, string> | undefined): number {
  return Object.values(votes ?? {}).filter((vote) => vote === "Approve").length;
}
