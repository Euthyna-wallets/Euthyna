/**
 * « Check a transaction »: what an EVM call does, in plain English, and what
 * could go wrong. Deterministic: no LLM, no network.
 */
import { BASE_SEPOLIA, describeCall, type ChainProfile } from "@mandateos/sdk/roles";
import { decodeFunctionData, getAddress, isAddress, isHex, parseAbi, type Hex } from "viem";
import { z } from "zod";

import type { Delivery } from "../api.js";

const PROFILES: Record<number, ChainProfile> = { [BASE_SEPOLIA.chainId]: BASE_SEPOLIA };
const CHAINS: Record<number, string> = { 1: "Ethereum", 8453: "Base", 84532: "Base Sepolia", 11155111: "Ethereum Sepolia", 42161: "Arbitrum One", 10: "OP Mainnet", 56: "BNB Smart Chain", 137: "Polygon" };
/** Any allowance this large is, in practice, unlimited (uint256.max, uint160.max, 2^200...). */
const UNLIMITED = 2n ** 128n;

const RISKY = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function transferOwnership(address newOwner)",
  "function upgradeTo(address newImplementation)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

export const txInputSchema = z.object({
  chainId: z.coerce.number().int().positive(),
  to: z.string().refine((value) => isAddress(value), "to must be an address"),
  data: z.string().refine((value) => isHex(value) && value.length % 2 === 0, "data must be 0x-prefixed hex").default("0x"),
  value: z.string().regex(/^\d+$/, "value is in wei").default("0"),
});
export type TxInput = z.infer<typeof txInputSchema>;

/** Accepts JSON, or "key: value" / "key=value" lines. */
export function parseTxInput(text: string): TxInput {
  const trimmed = text.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    raw = Object.fromEntries(trimmed.split(/\r?\n/).map((line) => line.match(/^\s*(chainId|chain_id|to|data|value)\s*[:=]\s*(\S+)\s*$/i)).filter(Boolean).map((match) => [match![1]!.replace("chain_id", "chainId"), match![2]]));
  }
  const parsed = txInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`input: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}. Send JSON {"chainId":84532,"to":"0x…","data":"0x…","value":"0"}.`);
  return parsed.data;
}

export type TxRisk = { severity: "critical" | "high" | "medium" | "low"; title: string; detail: string };

export function checkTransaction(input: TxInput): { description: string; functionName: string | null; risks: TxRisk[] } {
  const to = getAddress(input.to);
  const data = input.data as Hex;
  const value = BigInt(input.value);
  // Other chains: no known tokens or contracts, so nothing is named after Base Sepolia's.
  const profile: ChainProfile = PROFILES[input.chainId] ?? { chainId: input.chainId, name: CHAINS[input.chainId] ?? `chain ${input.chainId}`, tokens: [], protocols: {} as ChainProfile["protocols"], lending: {} };
  const description = describeCall(to, data, value, { profile, fullAddresses: true });
  const risks: TxRisk[] = [];
  let functionName: string | null = data === "0x" ? null : "unknown";
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: RISKY, data });
    } catch {
      return null;
    }
  })();
  if (decoded) {
    functionName = decoded.functionName;
    const args = decoded.args as readonly unknown[];
    switch (decoded.functionName) {
      case "approve":
      case "increaseAllowance": {
        const amount = args[1] as bigint;
        if (amount >= UNLIMITED) risks.push({ severity: "high", title: "Unlimited approval", detail: `${args[0]} could move every token of this kind the wallet holds, now and later. Approve only the amount needed.` });
        else if (amount > 0n) risks.push({ severity: "low", title: "Spending approval", detail: `${args[0]} may move up to ${amount} base units. Check that it is the contract you mean to use.` });
        break;
      }
      case "setApprovalForAll":
        if (args[1] === true) risks.push({ severity: "critical", title: "Approval for every NFT of the collection", detail: `${args[0]} could take all the wallet's NFTs of this contract. A classic drainer step.` });
        break;
      case "permit":
        risks.push({ severity: "high", title: "Signed permit", detail: `Grants ${args[1]} an allowance of ${args[2]} without an on-chain approve; signatures like this are a common phishing target.` });
        if ((args[2] as bigint) >= UNLIMITED) risks.push({ severity: "high", title: "Unlimited permit", detail: "The permit allows an unlimited amount." });
        break;
      case "transferFrom":
        risks.push({ severity: "medium", title: "Moves tokens from another address", detail: `Takes ${args[2]} from ${args[0]} to ${args[1]}, using an existing approval.` });
        break;
      case "transferOwnership":
        risks.push({ severity: "critical", title: "Hands over ownership", detail: `Makes ${args[0]} the owner of ${to}: it would control the contract.` });
        break;
      case "upgradeTo":
      case "upgradeToAndCall":
        risks.push({ severity: "critical", title: "Replaces the contract's code", detail: `Points ${to} at new code (${args[0]}). Whoever wrote it controls the contract and its funds.` });
        break;
      case "multicall":
      case "execute":
        risks.push({ severity: "medium", title: "Batched calls", detail: "Several actions run in one call; each inner call needs its own review, this check does not decode them." });
        break;
    }
  } else if (data !== "0x" && description.startsWith("call function")) {
    risks.push({ severity: "medium", title: "Unknown function", detail: `Selector ${data.slice(0, 10)} is not one this check knows. Verify the contract's source before signing.` });
  }
  if (value > 0n && data !== "0x") risks.push({ severity: "low", title: "Sends ETH with the call", detail: `${value} wei goes to the contract along with the call.` });
  if (!PROFILES[input.chainId]) risks.push({ severity: "low", title: "No token list for this chain", detail: "Token amounts are shown in base units; names come from the transaction only." });
  return { description, functionName, risks };
}

export function txCheckJob(text: string): Delivery {
  const input = parseTxInput(text);
  const result = checkTransaction(input);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const risks = [...result.risks].sort((a, b) => order[a.severity] - order[b.severity]);
  const markdown = [
    "# Transaction check",
    "",
    `**What it does:** ${result.description[0]!.toUpperCase()}${result.description.slice(1)}.`,
    "",
    `- Chain: ${CHAINS[input.chainId] ?? input.chainId} (${input.chainId})`,
    `- To: \`${getAddress(input.to)}\``,
    `- Function: ${result.functionName ?? "none (plain ETH transfer)"}`,
    `- Value: ${input.value} wei`,
    "",
    "## Risks",
    "",
    ...(risks.length ? risks.map((risk) => `- **${risk.severity}** · ${risk.title}: ${risk.detail}`) : ["- None found by this check."]),
    "",
    "_Decoded locally from the calldata. Not a simulation: state, prices and the contract's code were not read._",
  ].join("\n");
  return { markdown, json: { chainId: input.chainId, to: getAddress(input.to), value: input.value, functionName: result.functionName, description: result.description, risks } };
}
