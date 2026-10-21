// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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

describe("PaymentTrace", () => {
  it("renders the strict three-lock order and only completed steps", () => {
    render(<PaymentTrace steps={steps} />);
    expect(screen.getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Agent request", "Guard visa", "Vault", "MPC signature", "Base broadcast", "Zodiac", "Confirmed",
    ]);
    expect(document.querySelectorAll(".trace-step.done")).toHaveLength(7);
    expect(screen.getAllByRole("link", { name: "0xabc" })[0]?.getAttribute("href")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  it("never marks a step done before its predecessor", () => {
    const rows = sequenceTrace([
      steps[0]!,
      { ...steps[1]!, at: null },
      steps[2]!,
      steps[6]!,
    ]);
    expect(rows.map((row) => row.done)).toEqual([true, false, false, false]);
  });

  it("does not show Reverted or Cancelled unless present", () => {
    render(<PaymentTrace steps={steps} />);
    expect(screen.queryByText("Reverted")).toBeNull();
    expect(screen.queryByText("Cancelled")).toBeNull();
  });
});
