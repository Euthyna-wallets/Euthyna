import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("reads kept for a while", () => {
  it("reads once within the time, shares an in-flight read, and reads again after", async () => {
    const clock = { now: 0 };
    const cache = new TtlCache(() => clock.now);
    let reads = 0;
    const load = async () => { reads += 1; return reads; };
    expect(await Promise.all([cache.get("a", 15_000, load), cache.get("a", 15_000, load)])).toEqual([1, 1]);
    clock.now = 14_000;
    expect(await cache.get("a", 15_000, load)).toBe(1);
    clock.now = 16_000;
    expect(await cache.get("a", 15_000, load)).toBe(2);
  });

  it("drops by prefix, and does not keep a failed read", async () => {
    const cache = new TtlCache(() => 0);
    let reads = 0;
    const load = async () => { reads += 1; return reads; };
    await cache.get("list:x", 60_000, load);
    await cache.get("constant:y", 60_000, load);
    cache.clear("list:");
    expect(await cache.get("list:x", 60_000, load)).toBe(3);
    expect(await cache.get("constant:y", 60_000, load)).toBe(2);
    await expect(cache.get("bad", 60_000, async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(await cache.get("bad", 60_000, async () => "ok")).toBe("ok");
  });
});
