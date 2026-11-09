import { describe, expect, it, vi } from "vitest";

import { landedAnyway, untilFinal } from "./omniroles.js";

describe("untilFinal", () => {
  it("waits for a fresh account to show up at finality final, then gives up", async () => {
    let reads = 0;
    await expect(untilFinal(async () => (reads += 1) >= 3, 5, 0)).resolves.toBe(true);
    expect(reads).toBe(3);
    await expect(untilFinal(async () => false, 4, 0)).resolves.toBe(false);
  });
});

describe("landedAnyway", () => {
  it("keeps going when the RPC errored but the contract exists", async () => {
    let checks = 0;
    await expect(landedAnyway(new Error("Internal server error"), async () => ++checks >= 2)).resolves.toMatch(/landed/);
  });
  it("rethrows the RPC error when nothing landed", async () => {
    vi.useFakeTimers();
    const pending = landedAnyway(new Error("Internal server error"), async () => false);
    const assertion = expect(pending).rejects.toThrow("Internal server error");
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});
