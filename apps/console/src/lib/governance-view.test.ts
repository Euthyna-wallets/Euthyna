import { encodeFunctionData, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { proposalDecision } from "./governance-view.js";

const relay = "relay.testnet";
const safe = getAddress("0x1111111111111111111111111111111111111111");
const safeAbi = [
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

function base64Hex(value: Hex): string {
  return Buffer.from(value.slice(2), "hex").toString("base64");
}

function relayProposal(data: Hex): unknown {
  return {
    FunctionCall: {
      receiver_id: relay,
      actions: [{
        method_name: "propose",
        args: Buffer.from(JSON.stringify({ target: base64Hex(safe), data: base64Hex(data) })).toString("base64"),
      }],
    },
  };
}

describe("proposalDecision", () => {
  it("decodes owner replacement parameters from calldata, not proposer text", () => {
    const oldOwner = getAddress("0x2222222222222222222222222222222222222222");
    const newOwner = getAddress("0x3333333333333333333333333333333333333333");
    const data = encodeFunctionData({
      abi: safeAbi,
      functionName: "swapOwner",
      args: [getAddress("0x4444444444444444444444444444444444444444"), oldOwner, newOwner],
    });
    const decision = proposalDecision({
      kind: relayProposal(data),
      relayAccountId: relay,
      knownEvmAddresses: [newOwner],
    });
    expect(decision).toMatchObject({
      title: "Replace a Treasury owner",
      details: [`${oldOwner} → ${newOwner}`],
      warnings: [],
      recognized: true,
    });
  });

  it("warns when an owner is unknown and the threshold becomes one", () => {
    const owner = getAddress("0x5555555555555555555555555555555555555555");
    const data = encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [owner, 1n] });
    const decision = proposalDecision({ kind: relayProposal(data), relayAccountId: relay, knownEvmAddresses: [] });
    expect(decision.warnings).toEqual([
      "Critical: threshold becomes 1",
      "Owner address is not linked to a known member",
    ]);
  });

  it("renders unknown calldata as an unrecognized action", () => {
    const decision = proposalDecision({ kind: relayProposal("0xdeadbeef"), relayAccountId: relay });
    expect(decision.recognized).toBe(false);
    expect(decision.title).toContain("Unrecognized action");
  });
});
