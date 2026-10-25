import { ExecutionRevertedError, HttpRequestError, EstimateGasExecutionError, type Hex, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { estimateCalls, GasEstimateError, rpcUrls } from "./evm-gas.js";

const from = "0x834e5A4d6685E2B14189136Aca6fDe051266ef30" as Hex;
const call = (gas?: bigint) => ({ to: "0x0000000000000000000000000000000000000001" as Hex, value: 0n, data: "0x" as Hex, gas });

function client(input: { estimate?: () => Promise<bigint>; simulate?: () => Promise<unknown> }) {
  return {
    estimateGas: vi.fn(input.estimate ?? (async () => 100_000n)),
    simulateBlocks: vi.fn(input.simulate ?? (async () => [])),
  } as unknown as PublicClient & { estimateGas: ReturnType<typeof vi.fn>; simulateBlocks: ReturnType<typeof vi.fn> };
}

const revert = () => new EstimateGasExecutionError(new ExecutionRevertedError({ message: "execution reverted: ERC20: insufficient allowance" }), {});

describe("estimateCalls", () => {
  it("estimates a single call with 30% headroom and does not simulate", async () => {
    const rpc = client({});
    await expect(estimateCalls(rpc, from, [call()])).resolves.toEqual([130_000n]);
    expect(rpc.simulateBlocks).not.toHaveBeenCalled();
  });

  it("estimates later calls after the earlier ones, in one simulation", async () => {
    const rpc = client({
      simulate: async () => [{ calls: [{ status: "success", gasUsed: 46_000n }, { status: "success", gasUsed: 200_000n }] }],
    });
    await expect(estimateCalls(rpc, from, [call(), call()])).resolves.toEqual([130_000n, 330_000n]);
    expect(rpc.simulateBlocks.mock.calls[0]![0].blocks[0].calls).toHaveLength(2);
  });

  it("refuses a call that would revert instead of guessing a limit", async () => {
    const rpc = client({ estimate: async () => { throw revert(); } });
    await expect(estimateCalls(rpc, from, [call()])).rejects.toMatchObject({ code: "would_revert", index: 0 });
  });

  it("refuses a later call that fails after the earlier ones", async () => {
    const rpc = client({
      simulate: async () => [{ calls: [{ status: "success", gasUsed: 46_000n }, { status: "failure", gasUsed: 30_000n, error: new Error("insufficient balance") }] }],
    });
    await expect(estimateCalls(rpc, from, [call(), call()])).rejects.toMatchObject({ code: "would_revert", index: 1 });
  });

  it("reports an unavailable chain when no RPC answers", async () => {
    const rpc = client({ estimate: async () => { throw new HttpRequestError({ url: "https://rpc.example" }); } });
    const error = await estimateCalls(rpc, from, [call()]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GasEstimateError);
    expect(error).toMatchObject({ code: "rpc_unavailable" });
  });

  it("keeps a dApp's higher gas figure as a floor", async () => {
    await expect(estimateCalls(client({}), from, [call(500_000n)])).resolves.toEqual([500_000n]);
    await expect(estimateCalls(client({}), from, [call(21_000n)])).resolves.toEqual([130_000n]);
  });
});

describe("rpcUrls", () => {
  it("tries the configured RPC first, then public ones, without duplicates", () => {
    const urls = rpcUrls(11155111, ["https://my.rpc", "https://sepolia.drpc.org"]);
    expect(urls[0]).toBe("https://my.rpc");
    expect(urls.filter((url) => url === "https://sepolia.drpc.org")).toHaveLength(1);
    expect(urls.length).toBeGreaterThan(2);
  });
});
