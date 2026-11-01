import { describe, expect, it } from "vitest";

import { attempted, sentence } from "./money.js";

describe("refused requests", () => {
  it("never read as if the money moved", () => {
    expect(attempted(sentence("transfer 5 USDC to 0x9A3f…4a3e", "x"))).toBe("Tried to send 5 USDC to 0x9A3f…4a3e");
    expect(attempted("Swapped 1 ETH for USDC on Uniswap")).toBe("Tried to swap 1 ETH for USDC on Uniswap");
    expect(attempted("Operation")).toBe("Operation");
  });
});
