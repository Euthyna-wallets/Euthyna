import { describe, expect, it } from "vitest";

import { usdValue } from "./prices.js";

describe("treasury prices", () => {
  it("values the euro stablecoin at its market price, dollars at 1, and leaves unknown tokens out", () => {
    const prices = { ETH: 3000, EURC: 1.11 };
    expect(usdValue("EURC", "85.79", prices)).toBeCloseTo(95.23, 2);
    expect(usdValue("USDC", "10", prices)).toBe(10);
    expect(usdValue("WETH", "0.002", prices)).toBe(6);
    expect(usdValue("XYZ", "1", prices)).toBeNull();
  });
});
