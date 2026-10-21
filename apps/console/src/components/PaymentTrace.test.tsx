// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaymentTrace } from "./PaymentTrace.js";

describe("PaymentTrace", () => {
  it("marks completed steps with timestamps and explorer links", () => {
    render(
      <PaymentTrace
        steps={[
          { step: "Agent request", at: "2026-10-21T10:00:00Z", txHash: null },
          { step: "Guard visa", at: "2026-10-21T10:01:00Z", txHash: null },
          { step: "Base broadcast", at: "2026-10-21T10:02:00Z", txHash: "0xabc" },
          { step: "Zodiac", at: null, txHash: null },
        ]}
      />,
    );
    expect(screen.getByText("Agent request")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    const link = screen.getByRole("link", { name: "0xabc" });
    expect(link.getAttribute("href")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(document.querySelectorAll(".trace-step.done")).toHaveLength(3);
  });
});
