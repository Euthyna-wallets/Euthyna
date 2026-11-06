import { describe, expect, it } from "vitest";
import { RATE_SCALE, type SealedOrder } from "@mandateos/sdk";

import { commitmentOf, proveFill } from "./prover.js";
import { fillOutcome, tick, type WatcherDeps } from "./watcher.js";

const order: SealedOrder = {
  vaultId: "acme-vault.test.near",
  chainId: 84532,
  tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  tokenOut: "0x4200000000000000000000000000000000000006",
  fee: 3000,
  limitRate: 500_000_000n * RATE_SCALE, // at most 2000 USDC per WETH
  cap: 3_000_000n,
  expiry: 2_000_000_000,
  salt: 0x1234567890abcdefn,
};

function deps(over: Partial<WatcherDeps> & { outPerUsdc?: bigint } = {}) {
  const sent: Array<{ amountIn: bigint; rate: bigint }> = [];
  const base: WatcherDeps = {
    now: () => 1_900_000_000,
    orderState: async () => ({ filled: 0n, fills: 0, cancelled: false }),
    quote: async (amountIn) => (amountIn * (over.outPerUsdc ?? 559_270_439_304_943n)) / 1_000_000n,
    prove: async () => ({ proof: "cHJvb2Y=", publicInputs: [], commitment: "0x1" }),
    fill: async (input) => { sent.push(input); return { transaction: "tx", opId: [1, 2], failed: null }; },
  };
  return { deps: { ...base, ...over }, sent };
}

describe("sealed-order watcher", () => {
  it("waits while the market is under the hidden limit", async () => {
    // 1 USDC buys 4.5e14 wei (2222 USDC/WETH): worse than the 2000 limit.
    const { deps: d, sent } = deps({ outPerUsdc: 450_000_000_000_000n });
    const result = await tick(order, d);
    expect(result.status).toBe("waiting");
    expect(sent).toHaveLength(0);
  });

  it("fills the rest of the cap, or a chunk, once the market meets it", async () => {
    const { deps: d, sent } = deps({ orderState: async () => ({ filled: 1_000_000n, fills: 1, cancelled: false }) });
    expect((await tick(order, d)).status).toBe("filled");
    expect(sent[0]!.amountIn).toBe(2_000_000n);
    expect(sent[0]!.rate).toBe(559_270_439_304_943n * RATE_SCALE / 1_000_000n);
    const chunked = deps();
    await tick(order, chunked.deps, 500_000n);
    expect(chunked.sent[0]!.amountIn).toBe(500_000n);
  });

  it("stops on a cancelled, expired or full order", async () => {
    expect((await tick(order, deps({ orderState: async () => ({ filled: 0n, fills: 0, cancelled: true }) }).deps)).status).toBe("cancelled");
    expect((await tick(order, deps({ now: () => 2_000_000_001 }).deps)).status).toBe("expired");
    expect((await tick(order, deps({ orderState: async () => ({ filled: 3_000_000n, fills: 2, cancelled: false }) }).deps)).status).toBe("done");
  });

  it("reads the contract's events", () => {
    const filled = `EVENT_JSON:${JSON.stringify({ standard: "euthyna-sealed-orders", event: "filled", data: [{ op_id: [9, 9] }] })}`;
    const failed = `EVENT_JSON:${JSON.stringify({ standard: "euthyna-sealed-orders", event: "fill_failed", data: [{ reason: "vault refused the swap" }] })}`;
    expect(fillOutcome(["x", filled])).toEqual({ opId: [9, 9], failed: null });
    expect(fillOutcome([failed])).toEqual({ opId: null, failed: "vault refused the swap" });
  });
});

describe("sealed-order prover", () => {
  it("computes the commitment prove.mjs and the contract tests use", async () => {
    // circuits/sealed-order known_commitment: Poseidon2(1..9). Here, a real order.
    expect(await commitmentOf(order)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("proves a fill within the terms and refuses one outside them", async () => {
    const rate = 559_270_439_304_943n * RATE_SCALE / 1_000_000n;
    const proof = await proveFill(order, { amountIn: 1_000_000n, filledBefore: 0n, rate, now: 1_900_000_000 });
    expect(proof.publicInputs).toHaveLength(10);
    await expect(proveFill(order, { amountIn: 1_000_000n, filledBefore: 0n, rate: order.limitRate - 1n, now: 1_900_000_000 })).rejects.toThrow(/rate below the limit/);
    await expect(proveFill(order, { amountIn: 4_000_000n, filledBefore: 0n, rate, now: 1_900_000_000 })).rejects.toThrow(/over the cap/);
  }, 60_000);
});
