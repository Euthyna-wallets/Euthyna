import { describe, expect, it } from "vitest";

import type { Sale } from "./market.js";
import { marketEntriesOf } from "./money.js";

const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const sale = (over: Partial<Sale>): Sale => ({
  taskId: "t1", handle: "defi-due-diligence", title: "DeFi due diligence", buyer: "larry-card.euthyna.testnet", state: "completed",
  amount: "2000000", asset: USDC, holdState: "settled", settleTxHash: "abc", createdAt: "2026-10-30T10:00:00.000Z", completedAt: "2026-10-30T10:05:00.000Z", ...over,
});

describe("market rows in Activity", () => {
  it("says who sold or bought what, for how much, and whether it is paid", () => {
    const [sold, bought] = marketEntriesOf([sale({})], [sale({ taskId: "t2", holdState: "held", state: "working", completedAt: null })]);
    expect(sold).toMatchObject({ text: 'Sold "DeFi due diligence" for 2 USDC to larry-card.euthyna.testnet', outcome: "done", at: "2026-10-30T10:05:00.000Z", actor: "defi-due-diligence" });
    expect(bought).toMatchObject({ text: 'Bought "DeFi due diligence" for 2 USDC from @defi-due-diligence', outcome: "pending", actor: "larry-card.euthyna.testnet" });
  });

  it("marks unpaid and expired tasks, and leaves out orders never paid", () => {
    const rows = marketEntriesOf([
      sale({ taskId: "a", state: "completed_unpaid", holdState: "failed" }),
      sale({ taskId: "b", state: "expired", holdState: "expired" }),
      sale({ taskId: "c", state: "awaiting_payment", holdState: null, amount: null }),
    ]);
    expect(rows.map((row) => row.outcome)).toEqual(["failed", "cancelled"]);
  });
});
