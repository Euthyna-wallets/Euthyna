import { describe, it, expect } from "vitest";
import { OnchainAgentClient } from "@mandateos/sdk";
import { MandateMcpTools } from "./index.js";
type Hex = `0x${string}`;

const id = Array<number>(32).fill(1);
const block = `0x${"09".repeat(32)}` as Hex;
function fixture(options: { cancellation?: boolean; timeout?: boolean; refused?: boolean } = {}) {
  const calls: Array<{ method: string; args?: Record<string, unknown> }> = [];
  let state = "Prepared";
  const vault = {
    identity: () => ({ member: "agent.testnet", role: "payments", chain_id: 84532 }),
    prepareRequest: async () => { calls.push({ method: "prepare" }); return { op_id: id, state }; },
    authorize: async (_id: number[], approval: unknown) => { expect(approval).toBeNull(); calls.push({ method: "authorize" }); state = "PossiblySigned"; return "near-hash"; },
    cancelNonce: async () => { calls.push({ method: "cancel_nonce" }); return "near-cancel"; },
    view: async <T>(method: string): Promise<T> => {
      if (method === "get_wallet") return { address: Array(20).fill(3) } as T;
      if (method === "get_settlement_config") return { cancel_after_ns: "3600000000000", unconfirmed_after_ns: "21600000000000" } as T;
      return { state, signed_transaction: [2, 4, 6], cancellation: options.cancellation ? { signed_transaction: [8, 9] } : null, possibly_signed_at_ns: options.timeout ? "0" : (BigInt(Date.now()) * 1_000_000n).toString(), settlement: null } as T;
    },
    action: async (method: string, args: Record<string, unknown>) => { calls.push({ method, args }); if (method === "settle") state = "Confirmed"; if (method === "settle_cancellation") state = "Cancelled"; if (method === "release_unconfirmed") state = "Unconfirmed"; return "near-settle"; },
  };
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    calls.push({ method });
    if (method === "eth_chainId") return "0x14a34" as T;
    if (method === "eth_getTransactionReceipt") {
      expect(params[0]).toBe(options.cancellation ? "0x3fcd1e8100b3f771842b0ee87e45b9f769e90a9b0361f6e76592dd419c4294c5" : "0x76306eced855215d8a6617b962fbcd54b369d7b238b329f9dcebfc2c69651965");
      return (options.timeout ? null : { status: "0x1", blockHash: block }) as T;
    }
    if (method === "eth_getBlockByNumber") { expect(params[0]).toBe("finalized"); return { number: "0x10", hash: block } as T; }
    if (method === "eth_getBlockByHash") return { number: "0x10" } as T;
    return "0x1" as T;
  };
  return { tools: new MandateMcpTools(new OnchainAgentClient(vault, rpc, options.refused ? { preflightInvoice: async () => { throw new Error("Invoice refused"); } } : undefined)), calls };
}
describe("direct MCP without an API", () => {
  it("prepares and authorizes without a visa, then verifies finalized receipt", async () => {
    const { tools, calls } = fixture();
    const result = await tools.pay({ token: `0x${"01".repeat(20)}`, recipient: `0x${"02".repeat(20)}`, amount: "10", reference: "invoice", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" });
    expect(result.outcome).toBe("authorized");
    expect(calls.find((c) => c.method === "settle")?.args).toEqual({ op_id: id, block_hash: Array(32).fill(9) });
    expect(calls.some((c) => /visa|report_status/.test(c.method))).toBe(false);
  });
  it("settles a cancellation using its own transaction hash", async () => {
    const { tools, calls } = fixture({ cancellation: true });
    await tools.pay({ token: `0x${"01".repeat(20)}`, recipient: `0x${"02".repeat(20)}`, amount: "10", reference: "invoice", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" });
    expect(calls.some((c) => c.method === "settle_cancellation")).toBe(true);
  });
  it("broadcasts the stored transaction and frees an unconfirmed operation after timeout", async () => {
    const { tools, calls } = fixture({ timeout: true });
    await tools.pay({ token: `0x${"01".repeat(20)}`, recipient: `0x${"02".repeat(20)}`, amount: "10", reference: "invoice", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" });
    expect(calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(true);
    expect(calls.some((c) => c.method === "release_unconfirmed")).toBe(true);
  });
});


describe("direct generic calls and advisory checks", () => {
  it("executes an exact generic call without the API", async () => {
    const { tools, calls } = fixture();
    const result = await tools.call({ chainId:84532, to:`0x${"01".repeat(20)}`, data:"0x12345678", value:"0", allowanceAmount:"0", reference:"defi-call", gasLimit:"21000", maxFeePerGas:"2", maxPriorityFeePerGas:"1" });
    expect(result.outcome).toBe("authorized");
    expect(calls.some((c) => c.method === "settle")).toBe(true);
  });
  it("runs an available invoice advisory before any reservation", async () => {
    const { tools, calls } = fixture({ refused:true });
    await expect(tools.pay({ token:`0x${"01".repeat(20)}`, recipient:`0x${"02".repeat(20)}`, amount:"10", reference:"invoice", gasLimit:"21000", maxFeePerGas:"2", maxPriorityFeePerGas:"1" })).rejects.toThrow("Invoice refused");
    expect(calls.some((c) => c.method === "prepare")).toBe(false);
  });
});
