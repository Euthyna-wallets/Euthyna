// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaymentTrace, sequenceTrace } from "./PaymentTrace.js";

const steps = [
  { step: "Agent request", at: "2026-10-21T10:00:00Z", txHash: null },
  { step: "Guard visa", at: "2026-10-21T10:01:00Z", txHash: null },
  { step: "Vault", at: "2026-10-21T10:02:00Z", txHash: null },
  { step: "MPC signature", at: "2026-10-21T10:03:00Z", txHash: null },
  { step: "Base broadcast", at: "2026-10-21T10:04:00Z", txHash: "0xabc" },
  { step: "Zodiac", at: "2026-10-21T10:05:00Z", txHash: "0xabc" },
  { step: "Confirmed", at: "2026-10-21T10:06:00Z", txHash: "0xabc" },
];

afterEach(cleanup);

describe("PaymentTrace", () => {
  it("renders the strict three-lock order and only completed steps", () => {
    render(<PaymentTrace steps={steps} state="Confirmed" />);
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Agent request", "Guard visa", "Vault", "MPC signature", "Base broadcast", "Zodiac", "Confirmed",
    ]);
    expect(document.querySelectorAll(".trace-step.done")).toHaveLength(7);
    expect(screen.getAllByRole("link", { name: "0xabc" })[0]?.getAttribute("href")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  it("derives progress from the operation state, not timestamps", () => {
    const rows = sequenceTrace(steps.map((step) => ({ ...step, at: null })), "Broadcast");
    expect(rows.map((row) => row.done)).toEqual([true, true, true, true, true, false, false]);
  });

  it("marks all steps done for a confirmed operation", () => {
    const rows = sequenceTrace(steps.map((step) => ({ ...step, at: null })), "Confirmed");
    expect(rows.every((row) => row.done)).toBe(true);
  });

  it("does not show Reverted or Cancelled unless present", () => {
    render(<PaymentTrace steps={steps} state="Confirmed" />);
    expect(screen.queryByText("Reverted")).toBeNull();
    expect(screen.queryByText("Cancelled")).toBeNull();
  });
});
