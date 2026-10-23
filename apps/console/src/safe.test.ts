import { decodeMultiSendTransactions } from "@mandateos/deployer";
import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { encodeMultiSendCall } from "./safe.js";

const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}] as const;

describe("Safe MultiSend batch", () => {
  it("wraps packed child calls in multiSend(bytes) calldata", () => {
    const target = getAddress("0x1111111111111111111111111111111111111111");
    const encoded = encodeMultiSendCall([{ to: target, value: 0n, data: "0x1234" }]);
    const decoded = decodeFunctionData({ abi: multiSendAbi, data: encoded });
    expect(decoded.functionName).toBe("multiSend");
    if (decoded.functionName !== "multiSend") throw new Error("expected multiSend");
    expect(decodeMultiSendTransactions(decoded.args[0])).toEqual([{
      operation: 0,
      to: target,
      value: 0n,
      data: "0x1234",
    }]);
  });
});
