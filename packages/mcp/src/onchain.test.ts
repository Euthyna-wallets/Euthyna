import { describe, it, expect } from "vitest";
import { OnchainAgentClient } from "@euthyna/sdk";
import { MandateMcpTools } from "./index.js";
type Hex = `0x${string}`;

const id = Array<number>(32).fill(1);
const block = `0x${"09".repeat(32)}` as Hex;
function fixture(options: { cancellation?: boolean; timeout?: boolean; refused?: boolean; originalWins?: boolean; proofPending?: boolean; vaultRefuses?: boolean; api?: boolean; sponsored?: boolean } = {}) {
  const calls: Array<{ method: string; args?: Record<string, unknown> }> = [];
  let state = "Prepared";
  const vault = {
    identity: () => ({ member: "agent.testnet", role: "payments", chain_id: 84532 }),
    prepareRequest: async () => { calls.push({ method: "prepare" }); return { op_id: id, state }; },
    authorize: async (_id: number[], approval: unknown) => { expect(approval).toBeNull(); calls.push({ method: "authorize" }); state = "PossiblySigned"; return "near-hash"; },
    cancelNonce: async () => { calls.push({ method: "cancel_nonce" }); return "near-cancel"; },
    view: async <T>(method: string): Promise<T> => {
      if (method === "check_operation") return (options.vaultRefuses ? { allowed: false, reason: "ERR_PERMISSION_DENIED" } : { allowed: true, reason: null }) as T;
      if (method === "get_wallet") return { address: Array(20).fill(3) } as T;
      if (method === "get_sponsored_operation") return (options.sponsored ? { deadline: 1, approval: null } : null) as T;
      if (method === "get_settlement_config") return { cancel_after_ns: "3600000000000", unconfirmed_after_ns: "21600000000000" } as T;
      return { state, signed_transaction: [2, 4, 6], cancellation: options.cancellation ? { signed_transaction: [8, 9] } : null, possibly_signed_at_ns: options.timeout ? "0" : (BigInt(Date.now()) * 1_000_000n).toString(),  } as T;
    },
    action: async (method: string, args: Record<string, unknown>) => { calls.push({ method, args }); if (method === "settle" && !options.proofPending) state = "Confirmed"; if (method === "settle_cancellation") state = "Cancelled"; if (method === "release_unconfirmed") state = "Unconfirmed"; return "near-settle"; },
  };
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    calls.push({ method });
    if (method === "eth_chainId") return "0x14a34" as T;
    if (method === "eth_getTransactionReceipt") {
      const original = "0x76306eced855215d8a6617b962fbcd54b369d7b238b329f9dcebfc2c69651965";
      const cancellation = "0x3fcd1e8100b3f771842b0ee87e45b9f769e90a9b0361f6e76592dd419c4294c5";
      expect([original, cancellation]).toContain(params[0]);
      const winner = options.cancellation && !options.originalWins ? cancellation : original;
      return (options.timeout || params[0] !== winner ? null : { status: "0x1", blockHash: block }) as T;
    }
    if (method === "eth_getBlockByNumber") { expect(params[0]).toBe("safe"); return { number: "0x10", hash: block } as T; }
    if (method === "eth_getBlockByHash") return { number: "0x10" } as T;
    return "0x1" as T;
  };
  const reported: unknown[] = [];
  const advisory = options.refused ? { preflightInvoice: async () => { throw new Error("Invoice refused"); } }
    : options.api ? { preflightInvoice: async () => {}, check: async (request: unknown) => { reported.push(request); return { allowed: false } as never; } }
    : undefined;
  return { tools: new MandateMcpTools(new OnchainAgentClient(vault, rpc, advisory)), calls, reported };
}
describe("direct MCP without an API", () => {
  it("leaves a sponsored call to Euthyna's relayer: nothing broadcast by the agent", async () => {
    const { tools, calls } = fixture({ sponsored: true });
    const result = await tools.pay({ token: `0x${"01".repeat(20)}`, recipient: `0x${"02".repeat(20)}`, amount: "10", reference: "invoice", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" });
    expect(result.outcome).toBe("authorized");
    expect(calls.some((c) => c.method === "eth_sendRawTransaction" || c.method === "settle")).toBe(false);
  });
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


it("proves the original if it wins despite an existing cancellation", async () => {
  const {tools,calls}=fixture({cancellation:true,originalWins:true});
  await tools.pay({token:`0x${"01".repeat(20)}`,recipient:`0x${"02".repeat(20)}`,amount:"10",reference:"race",gasLimit:"21000",maxFeePerGas:"2",maxPriorityFeePerGas:"1"});
  expect(calls.some((c)=>c.method==="settle")).toBe(true);
  expect(calls.some((c)=>c.method==="settle_cancellation")).toBe(false);
  expect(calls.filter((c)=>c.method==="eth_getTransactionReceipt")).toHaveLength(2);
});


it("does not broadcast a competing cancellation while original settlement is pending", async () => {
  const {tools,calls}=fixture({cancellation:true,originalWins:true,proofPending:true});
  const result=await tools.pay({token:`0x${"01".repeat(20)}`,recipient:`0x${"02".repeat(20)}`,amount:"10",reference:"original-landed",gasLimit:"21000",maxFeePerGas:"2",maxPriorityFeePerGas:"1"});
  expect(result).toMatchObject({state:"PossiblySigned"});
  expect(calls.some((c)=>c.method==="eth_sendRawTransaction")).toBe(false);
});

describe("refusals reach the API", () => {
  const payment = { token: `0x${"01".repeat(20)}`, recipient: `0x${"02".repeat(20)}`, amount: "10", reference: "invoice", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" };
  it("returns a refusal without reserving anything, and reports it so the members see it", async () => {
    const { tools, calls, reported } = fixture({ vaultRefuses: true, api: true });
    const result = await tools.pay(payment);
    expect(result).toEqual({ outcome: "refused", reason: "ERR_PERMISSION_DENIED", refusedBy: "vault" });
    expect(calls.some((c) => c.method === "prepare")).toBe(false);
    expect(reported).toHaveLength(1);
  });
  it("reports a refused dry run, and nothing when the vault allows it", async () => {
    const refused = fixture({ vaultRefuses: true, api: true });
    expect((await refused.tools.check({ token: payment.token, recipient: payment.recipient, amount: "10", reference: "dry" })).allowed).toBe(false);
    expect(refused.reported).toHaveLength(1);
    const allowed = fixture({ api: true });
    expect((await allowed.tools.check({ token: payment.token, recipient: payment.recipient, amount: "10", reference: "dry" })).allowed).toBe(true);
    expect(allowed.reported).toHaveLength(0);
  });
  it("still refuses when there is no API", async () => {
    const { tools } = fixture({ vaultRefuses: true });
    expect((await tools.pay(payment)).outcome).toBe("refused");
  });
});
