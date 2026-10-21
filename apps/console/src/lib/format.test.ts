import { describe, expect, it } from "vitest";

import { formatBytesAddress, formatEth, formatNonce, formatToken } from "./format.js";

describe("format helpers", () => {
  it("formats token base units with token decimals and symbol", () => {
    expect(formatToken("2500000", 6, "TestUSDC")).toBe("2.50 TestUSDC");
    expect(formatToken("1000000", 6, "TestUSDC")).toBe("1.00 TestUSDC");
    expect(formatToken("0", 6, "TestUSDC")).toBe("0.00 TestUSDC");
  });

  it("formats wei as ETH with four decimals", () => {
    expect(formatEth("1000000000000000000")).toBe("1.0000 ETH");
    expect(formatEth("562601935759999279")).toBe("0.5626 ETH");
  });

  it("renders byte arrays as hex addresses", () => {
    expect(formatBytesAddress(Array(20).fill(0x22))).toBe(`0x${"22".repeat(20)}`);
    expect(formatBytesAddress("0xabc")).toBe("0xabc");
  });

  it("renders a real nonce", () => {
    expect(formatNonce(7)).toBe("7");
    expect(formatNonce(null)).toBe("—");
  });
});
