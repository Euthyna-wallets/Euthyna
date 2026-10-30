import { describe, expect, it } from "vitest";

import { untilFinal } from "./omniroles.js";

describe("untilFinal", () => {
  it("waits for a fresh account to show up at finality final, then gives up", async () => {
    let reads = 0;
    await expect(untilFinal(async () => (reads += 1) >= 3, 5, 0)).resolves.toBe(true);
    expect(reads).toBe(3);
    await expect(untilFinal(async () => false, 4, 0)).resolves.toBe(false);
  });
});
