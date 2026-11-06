/**
 * Sealed orders for the agent: place one inside its swap role, list them, and fill the open ones when
 * the market meets their hidden limit. The order files (the only plaintext copy of the terms outside
 * the members' keys) are kept under the agent's config directory, readable by its user only.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OrderFile, SealedAgent } from "@euthyna/sdk/sealed-agent";
import { parseOrder } from "@euthyna/sdk/sealed-orders";
import { commitmentOf } from "@euthyna/sdk/sealed-prover";
import { formatUnits, parseUnits } from "viem";

type Stored = OrderFile;

export type SealedAgentLike = Pick<SealedAgent, "place" | "orders" | "tick" | "settle">;

export class SealedOrdersMcp {
  constructor(
    private readonly agent: SealedAgentLike,
    private readonly vault: string,
    private readonly role: string,
    private readonly dir: string,
  ) {}

  private files(): Array<{ path: string; file: Stored }> {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ path: join(this.dir, name), file: JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Stored }))
      .filter(({ file }) => file.vault === this.vault);
  }

  private save(file: Stored): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${file.vault}-${file.id}.json`);
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  async place(input: { maxPriceUsdc: number; capUsdc: string; days: number; approveUsdc?: string | undefined }) {
    const { file, transactions } = await this.agent.place({
      vault: this.vault, role: this.role, maxPriceUsdc: input.maxPriceUsdc, capUsdc: input.capUsdc, days: input.days,
      ...(input.approveUsdc ? { approveUsdc: input.approveUsdc } : {}),
    });
    const path = this.save(file);
    return {
      id: file.id, commitment: file.commitment, nearTransactions: transactions, orderFile: path,
      onChain: "only the hash; the members read the terms with their key",
      next: "call fill_sealed_orders from time to time: it fills when the market meets the limit",
    };
  }

  /**
   * Takes over an order a member placed (by a vote, or in their role) and handed to this agent: the
   * terms must hash to an order of this company on chain. The agent then fills it with the others.
   */
  async adopt(input: { orderFile: string }) {
    let file: OrderFile;
    try {
      file = JSON.parse(input.orderFile) as OrderFile;
    } catch {
      throw new Error("orderFile is not the JSON of an order file");
    }
    if (file.vault !== this.vault) throw new Error(`this order is for ${file.vault}, not this company (${this.vault})`);
    const commitment = (await commitmentOf(parseOrder(file.order))).toLowerCase();
    const onChain = (await this.agent.orders(this.vault)).find((order) => order.commitment === commitment);
    if (!onChain) throw new Error("no order of this company has these terms: check the file, or wait for the vote to pass");
    if (onChain.cancelled) throw new Error(`order #${onChain.id} is cancelled`);
    const path = this.save({ ...file, id: onChain.id, commitment, role: onChain.role });
    return { id: onChain.id, role: onChain.role, orderFile: path, next: "fill_sealed_orders now fills it with your other orders" };
  }

  /** The vault's orders as the chain shows them; the terms only for the ones this agent holds. */
  async list() {
    const held = new Map(this.files().map(({ file }) => [file.id, file]));
    const orders = await this.agent.orders(this.vault);
    return orders.map((order) => {
      const mine = held.get(order.id);
      const terms = mine ? parseOrder(mine.order) : null;
      return {
        id: order.id, role: order.role, sealer: order.sealer, commitment: order.commitment,
        filledUsdc: formatUnits(BigInt(order.filled), 6), fills: order.fills, cancelled: order.cancelled,
        ...(terms ? { yourTerms: { capUsdc: formatUnits(terms.cap, 6), expiresAt: new Date(terms.expiry * 1000).toISOString(), limitRate: terms.limitRate.toString() } } : {}),
      };
    });
  }

  /** One look at the market for each open order this agent holds; then pending swaps are settled. */
  async fill(input: { chunkUsdc?: string | undefined }) {
    const results = [];
    for (const { file } of this.files()) {
      const pending = file.pending ?? [];
      const still: number[][] = [];
      for (const opId of pending) {
        const state = await this.agent.settle(file.vault, opId, 0);
        if (state === "PossiblySigned") still.push(opId);
      }
      const tick = await this.agent.tick(file, input.chunkUsdc ? parseUnits(input.chunkUsdc, 6) : undefined);
      if (tick.status === "filled") {
        await this.agent.settle(file.vault, tick.opId, 0); // broadcasts now; settles once the Base block is final
        still.push(tick.opId);
      }
      this.save({ ...file, pending: still });
      results.push({
        id: file.id,
        status: tick.status,
        ...(tick.status === "filled" ? { amountUsdc: formatUnits(tick.amountIn, 6), nearTransaction: tick.transaction } : {}),
        ...(tick.status === "refused" ? { reason: tick.reason } : {}),
        ...(tick.status === "needs-approval" ? { reason: `the router may take ${formatUnits(tick.allowance, 6)} USDC, under the ${formatUnits(tick.amountIn, 6)} to fill: place an approval within the role` } : {}),
        swapsAwaitingSettlement: still.length,
      });
    }
    return results.length ? results : { message: "no sealed order held by this agent" };
  }
}
