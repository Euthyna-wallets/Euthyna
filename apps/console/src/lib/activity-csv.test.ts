import { describe, expect, it } from "vitest";

import { activityCsv, type Entry } from "./money.js";

const entry = (over: Partial<Entry>): Entry => ({
  id: "1", at: "2026-11-07T16:30:00.000Z", actor: "naomi.testnet", role: "payments", text: "Paid 12 EURC to Supplier, invoice INV-7",
  outcome: "done", chain: "Base Sepolia", reason: null, operation: null, request: null, ...over,
});

describe("activity CSV", () => {
  it("has a header, one quoted row per entry and the transaction hash", () => {
    const csv = activityCsv([entry({ operation: { reference: "INV-7", evm: { hash: "0xabc", status: "success", blockNumber: "1" } } as Entry["operation"] })], () => "Naomi");
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe("date_utc,who,role,what,outcome,chain,reference,transaction,reason");
    expect(row).toBe('"2026-11-07T16:30:00.000Z","Naomi","payments","Paid 12 EURC to Supplier, invoice INV-7","done","Base Sepolia","INV-7","0xabc",""');
  });

  it("neutralises formulas and escapes quotes", () => {
    const csv = activityCsv([entry({ text: '=HYPERLINK("http://evil")', reason: 'over "budget"' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"over ""budget"""');
  });
});
