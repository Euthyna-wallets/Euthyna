import {
  canonicalMultiSendCallOnlyAddress,
  decodeMultiSendTransactions,
  rolesAbi,
} from "@mandateos/deployer";
import {
  decodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";

export const safeOwnerAbi = [
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

const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}] as const;

export interface ZodiacBatchExpectation {
  kind: "zodiac";
  member: Address;
  allowanceKey: Hex;
  allowance: {
    balance: bigint;
    maxRefill: bigint;
    refill: bigint;
    period: bigint;
    timestamp: bigint;
  };
}

export type SafeOwnerEffect =
  | {
      kind: "safe-owner";
      functionName: "swapOwner";
      previousOwner: Address;
      oldOwner: Address;
      newOwner: Address;
    }
  | {
      kind: "safe-owner";
      functionName: "addOwnerWithThreshold";
      newOwner: Address;
      threshold: bigint;
    };

export type GovernanceEffect = ZodiacBatchExpectation | SafeOwnerEffect;

export function decodeZodiacBatchExpectation(input: {
  chainId: number;
  rolesAddress: string;
  target: string;
  data: Hex;
  operation: number;
}): ZodiacBatchExpectation {
  const multiSend = canonicalMultiSendCallOnlyAddress(input.chainId);
  if (input.operation !== 1 || getAddress(input.target) !== multiSend) {
    throw new Error("relay operation is not a canonical MultiSendCallOnly delegatecall");
  }
  const decoded = decodeFunctionData({ abi: multiSendAbi, data: input.data });
  if (decoded.functionName !== "multiSend") throw new Error("relay calldata is not multiSend(bytes)");
  const calls = decodeMultiSendTransactions(decoded.args[0]);
  if (calls.length !== 4) throw new Error(`expected four Zodiac calls, got ${calls.length}`);
  const roles = getAddress(input.rolesAddress);
  if (calls.some((call) => call.operation !== 0 || call.to !== roles || call.value !== 0n)) {
    throw new Error("Zodiac batch contains a non-Call or a non-Roles target");
  }
  const decodedCalls = calls.map((call) => decodeFunctionData({ abi: rolesAbi, data: call.data }));
  const names = decodedCalls.map((call) => call.functionName);
  if (names.join(",") !== "assignRoles,scopeTarget,scopeFunction,setAllowance") {
    throw new Error(`unexpected Zodiac call order ${names.join(",")}`);
  }
  const assign = decodedCalls[0];
  const allowance = decodedCalls[3];
  if (assign?.functionName !== "assignRoles" || allowance?.functionName !== "setAllowance") {
    throw new Error("Zodiac batch decode failed");
  }
  const enabled = assign.args[2];
  if (enabled.length !== 1 || enabled[0] !== true) {
    throw new Error("Zodiac member assignment is not enabled");
  }
  return {
    kind: "zodiac",
    member: getAddress(assign.args[0]),
    allowanceKey: allowance.args[0],
    allowance: {
      balance: allowance.args[1],
      maxRefill: allowance.args[2],
      refill: allowance.args[3],
      period: allowance.args[4],
      timestamp: allowance.args[5],
    },
  };
}

export function decodeGovernanceEffect(input: {
  chainId: number;
  safeAddress: string;
  rolesAddress: string;
  target: string;
  value: string;
  data: Hex;
  operation: number;
}): GovernanceEffect {
  if (BigInt(input.value) !== 0n) throw new Error("governance call must not transfer ETH");
  const target = getAddress(input.target);
  if (target === getAddress(input.safeAddress) && input.operation === 0) {
    const decoded = decodeFunctionData({ abi: safeOwnerAbi, data: input.data });
    if (decoded.functionName === "swapOwner") {
      return {
        kind: "safe-owner",
        functionName: "swapOwner",
        previousOwner: getAddress(decoded.args[0]),
        oldOwner: getAddress(decoded.args[1]),
        newOwner: getAddress(decoded.args[2]),
      };
    }
    if (decoded.functionName === "addOwnerWithThreshold") {
      return {
        kind: "safe-owner",
        functionName: "addOwnerWithThreshold",
        newOwner: getAddress(decoded.args[0]),
        threshold: decoded.args[1],
      };
    }
    throw new Error("Safe governance call is not an allowed owner recovery selector");
  }
  return decodeZodiacBatchExpectation(input);
}
