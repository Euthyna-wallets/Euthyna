import { describe, expect, it, vi } from "vitest";

import { reserveStdoutForMcp } from "./stdio-logging.js";

describe("reserveStdoutForMcp", () => {
  it("routes dependency transaction logs to stderr instead of protocol stdout", () => {
    const target = {
      log: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    reserveStdoutForMcp(target);
    target.log("Receipts: receipt-id");
    target.info("transaction submitted");
    target.debug("Log [vault.testnet]: sign request");

    expect(target.error.mock.calls).toEqual([
      ["Receipts: receipt-id"],
      ["transaction submitted"],
      ["Log [vault.testnet]: sign request"],
    ]);
  });
});
