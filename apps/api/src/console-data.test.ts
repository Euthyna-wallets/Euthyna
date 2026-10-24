import { describe, expect, it } from "vitest";

import { governancePricingStatus } from "./console-data.js";

describe("governancePricingStatus", () => {
  it("marks only pre-inclusion active transactions Underpriced", () => {
    expect(governancePricingStatus("PossiblySigned", "100", 101n)).toEqual({
      underpriced: true,
      displayState: "Underpriced",
    });
    expect(governancePricingStatus("Broadcast", "100", 101n).underpriced).toBe(true);
    expect(governancePricingStatus("Queued", "100", 101n)).toEqual({
      underpriced: false,
      displayState: "Queued",
    });
    expect(governancePricingStatus("PossiblySigned", "101", 101n).underpriced).toBe(false);
  });
});
