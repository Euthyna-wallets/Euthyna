/**
 * The watcher of a sealed order: whoever holds the order (a member, on their own machine) runs it.
 * Each tick reads the order's public state, quotes the swap, and fills when the market meets the
 * hidden limit: it proves the fill, sends it to contracts/sealed-orders, then follows the vault's
 * operation until the swap is on Base and settled. The hidden terms never leave this process.
 */
import { rateOf, type SealedOrder } from "@mandateos/sdk";

import type { Fill, FillProof } from "./prover.js";

export type OrderState = { filled: bigint; fills: number; cancelled: boolean };

export type WatcherDeps = {
  /** Unix seconds (the chain's clock is what counts; the contract allows a few minutes of skew). */
  now(): number;
  orderState(): Promise<OrderState | null>;
  /** What `amountIn` of tokenIn buys now (Uniswap quoter). */
  quote(amountIn: bigint): Promise<bigint>;
  prove(fill: Fill): Promise<FillProof>;
  /** Sends `fill` to the sealed-orders contract; the vault operation id when it was signed. */
  fill(input: { amountIn: bigint; rate: bigint; now: number; proof: string }): Promise<{ transaction: string; opId: number[] | null; failed: string | null }>;
};

export type Tick =
  | { status: "missing" | "cancelled" | "expired" | "done" }
  | { status: "waiting"; amountIn: bigint; marketRate: bigint }
  | { status: "filled"; amountIn: bigint; rate: bigint; transaction: string; opId: number[] }
  | { status: "refused"; amountIn: bigint; rate: bigint; transaction: string; reason: string };

/** One look at the market. `chunk` caps each fill (the rest waits for the next tick). */
export async function tick(order: SealedOrder, deps: WatcherDeps, chunk?: bigint): Promise<Tick> {
  const state = await deps.orderState();
  if (!state) return { status: "missing" };
  if (state.cancelled) return { status: "cancelled" };
  const now = deps.now();
  if (now > order.expiry) return { status: "expired" };
  const remaining = order.cap - state.filled;
  if (remaining <= 0n) return { status: "done" };
  const amountIn = chunk !== undefined && chunk > 0n && chunk < remaining ? chunk : remaining;
  const marketRate = rateOf(amountIn, await deps.quote(amountIn));
  if (marketRate < order.limitRate) return { status: "waiting", amountIn, marketRate };
  const { proof } = await deps.prove({ amountIn, filledBefore: state.filled, rate: marketRate, now });
  const sent = await deps.fill({ amountIn, rate: marketRate, now, proof });
  if (sent.failed || !sent.opId) {
    return { status: "refused", amountIn, rate: marketRate, transaction: sent.transaction, reason: sent.failed ?? "no operation" };
  }
  return { status: "filled", amountIn, rate: marketRate, transaction: sent.transaction, opId: sent.opId };
}

/** The `filled` or `fill_failed` event of a fill transaction's logs. */
export function fillOutcome(logs: string[]): { opId: number[] | null; failed: string | null } {
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(line.slice("EVENT_JSON:".length)) as { standard?: string; event?: string; data?: Array<{ op_id?: number[]; reason?: string }> };
      if (event.standard !== "euthyna-sealed-orders") continue;
      if (event.event === "filled") return { opId: event.data?.[0]?.op_id ?? null, failed: null };
      if (event.event === "fill_failed") return { opId: null, failed: event.data?.[0]?.reason ?? "fill failed" };
    } catch {
      /* not ours */
    }
  }
  return { opId: null, failed: "no fill event" };
}
