import { describe, expect, it } from "vitest";
import { OnchainAgentClient } from "@mandateos/sdk";
import { MandateMcpTools } from "./index.js";

const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const id = Array<number>(32).fill(7);

function fixture(options: { refuse?: string; legacy?: boolean; stuck?: boolean } = {}) {
  const calls: Array<{ method: string; args?: Record<string, unknown> }> = [];
  let op: Record<string, unknown> | null = null;
  const vault = {
    identity: () => ({ member: "larry-agent.testnet", role: "card-refill", chain_id: 84532 }),
    prepareRequest: async () => { throw new Error("not used"); },
    authorize: async () => { throw new Error("not used"); },
    cancelNonce: async () => { throw new Error("not used"); },
    view: async <T>(method: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, ...(args ? { args } : {}) });
      if (method === "check_near") {
        if (options.legacy) throw new Error("MethodNotFound");
        return (options.refuse ? { allowed: false, reason: options.refuse } : { allowed: true, reason: null }) as T;
      }
      if (method === "get_near_operation_by_reference") return op as T;
      if (method === "get_settlement_config") return { cancel_after_ns: "1", unconfirmed_after_ns: "21600000000000" } as T;
      throw new Error(`unexpected view ${method}`);
    },
    action: async (method: string, args: Record<string, unknown>, gas?: string) => {
      calls.push({ method, args: { ...args, gas } });
      if (method === "execute_near") {
        const request = args.request as Record<string, unknown>;
        op = { op_id: id, state: options.stuck ? "Pending" : "Confirmed", created_at_ns: options.stuck ? "0" : (BigInt(Date.now()) * 1_000_000n).toString(), request };
      }
      if (method === "release_near_unconfirmed" && op) op = { ...op, state: "Unconfirmed" };
      return "near-tx";
    },
  };
  const rpc = async <T>(): Promise<T> => { throw new Error("no EVM RPC for NEAR transfers"); };
  return { tools: new MandateMcpTools(new OnchainAgentClient(vault, rpc)), calls };
}

describe("near_transfer", () => {
  it("checks, then executes with enough gas, and reads the result by reference", async () => {
    const { tools, calls } = fixture();
    const result = await tools.nearTransfer({ token: "USDC", receiverId: "card-larry.euthyna.testnet", amount: "5000000", reference: "refill-1" });
    expect(result).toMatchObject({ outcome: "sent", state: "Confirmed", receiverId: "card-larry.euthyna.testnet", amount: "5000000", nearTransactionHash: "near-tx" });
    const check = calls.find((call) => call.method === "check_near")!;
    expect(check.args).toEqual({ role: "card-refill", member: "larry-agent.testnet", request: { token: USDC, receiver_id: "card-larry.euthyna.testnet", amount: "5000000", memo: null, reference: "refill-1" } });
    const execute = calls.find((call) => call.method === "execute_near")!;
    expect(BigInt(execute.args!.gas as string)).toBeGreaterThanOrEqual(50_000_000_000_000n);
  });

  it("stops at the vault's refusal without sending anything", async () => {
    const { tools, calls } = fixture({ refuse: "ERR_MIN_PER_TRANSFER" });
    await expect(tools.nearTransfer({ token: "USDC", receiverId: "card-larry.euthyna.testnet", amount: "1", reference: "dust" }))
      .resolves.toEqual({ outcome: "refused", reason: "ERR_MIN_PER_TRANSFER", refusedBy: "vault" });
    expect(calls.some((call) => call.method === "execute_near")).toBe(false);
  });

  it("says when the vault is too old for NEAR transfers", async () => {
    const { tools } = fixture({ legacy: true });
    await expect(tools.nearTransfer({ token: "USDC", receiverId: "bob.testnet", amount: "5", reference: "x" }))
      .resolves.toMatchObject({ outcome: "refused", reason: expect.stringMatching(/upgrade by vote/) });
  });

  it("frees a transfer whose callback never ran, after the timeout", async () => {
    const { tools, calls } = fixture({ stuck: true });
    const result = await tools.nearTransfer({ token: "USDC", receiverId: "bob.testnet", amount: "5000000", reference: "stuck" });
    expect(result).toMatchObject({ state: "Unconfirmed" });
    expect(calls.find((call) => call.method === "release_near_unconfirmed")?.args).toMatchObject({ op_id: id });
    await expect(tools.nearStatus({ reference: "stuck" })).resolves.toMatchObject({ state: "Unconfirmed" });
  });

  it("refuses a reused reference before sending", async () => {
    const { tools, calls } = fixture();
    await tools.nearTransfer({ token: "USDC", receiverId: "bob.testnet", amount: "5000000", reference: "same" });
    await expect(tools.nearTransfer({ token: "USDC", receiverId: "bob.testnet", amount: "5000000", reference: "same" }))
      .resolves.toEqual({ outcome: "refused", reason: "ERR_REFERENCE_ALREADY_USED", refusedBy: "vault" });
    expect(calls.filter((call) => call.method === "execute_near")).toHaveLength(1);
  });
});
