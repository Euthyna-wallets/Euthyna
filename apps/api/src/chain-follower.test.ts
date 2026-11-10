import { describe, expect, it } from "vitest";
import { ChainFollower, FEED_STALE_MS, touchedVaults } from "./chain-follower.js";

const accounts = new Map([["acme.vault.testnet", "acme.vault.testnet"], ["acme.dao.testnet", "acme.vault.testnet"]]);
function block(height: number, receivers: string[], atMs: number) {
  return {
    block: { header: { height, timestamp_nanosec: (BigInt(atMs) * 1_000_000n).toString() } },
    shards: [null, { receipt_execution_outcomes: receivers.map((receiver_id) => ({ receipt: { receiver_id } })) }],
  };
}

function fixture(blocks: Map<number, unknown>, head: { value: number }) {
  const clock = { now: 1_000_000 };
  const touched: Array<[string, number]> = [];
  let gaps = 0;
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/v0/last_block/final") return new Response(JSON.stringify(block(head.value, [], clock.now)), { status: 200 });
    const height = Number(path.split("/").pop());
    if (!blocks.has(height)) return new Response('{"type":"BLOCK_DOES_NOT_EXIST"}', { status: 404 });
    return new Response(JSON.stringify(blocks.get(height)), { status: 200 });
  }) as typeof fetch;
  const follower = new ChainFollower({
    baseUrl: "https://feed.test/",
    accounts: async () => accounts,
    onTouch: (vault, height) => touched.push([vault, height]),
    onGap: () => { gaps += 1; },
    fetcher,
    now: () => clock.now,
    log: () => undefined,
  });
  return { follower, touched, clock, requests, gaps: () => gaps };
}

describe("following the chain instead of reading each vault", () => {
  it("reports a vault when a receipt runs on it or on its DAO, once per block", () => {
    expect([...touchedVaults(block(1, ["acme.dao.testnet", "acme.vault.testnet", "other.testnet"], 0), accounts)]).toEqual(["acme.vault.testnet"]);
    expect(touchedVaults(block(1, ["other.testnet"], 0), accounts).size).toBe(0);
  });

  it("starts after the head with a gap, then reports the blocks in order", async () => {
    const head = { value: 100 };
    const blocks = new Map<number, unknown>();
    const { follower, touched, clock, gaps } = fixture(blocks, head);
    expect(follower.healthy()).toBe(false);
    await follower.step();
    expect(gaps()).toBe(1);
    expect(follower.healthy()).toBe(true);
    blocks.set(101, block(101, ["other.testnet"], clock.now));
    blocks.set(102, null); // a skipped slot
    blocks.set(103, block(103, ["acme.dao.testnet"], clock.now));
    for (let i = 0; i < 3; i += 1) expect(await follower.step()).toBe(true);
    expect(touched).toEqual([["acme.vault.testnet", 103]]);
    // Nothing new yet: no block, no gap.
    expect(await follower.step()).toBe(false);
    expect(gaps()).toBe(1);
  });

  it("is no longer trusted when blocks stop arriving", async () => {
    const { follower, clock } = fixture(new Map(), { value: 100 });
    await follower.step();
    clock.now += FEED_STALE_MS + 1;
    expect(follower.healthy()).toBe(false);
  });

  it("jumps to the head with a gap instead of replaying old blocks late", async () => {
    const head = { value: 100 };
    const blocks = new Map<number, unknown>();
    const { follower, touched, clock, gaps } = fixture(blocks, head);
    await follower.step();
    blocks.set(101, block(101, ["acme.vault.testnet"], clock.now));
    clock.now += 10 * 60_000; // this process was paused for ten minutes
    head.value = 1_100;
    await follower.step();
    expect(touched).toEqual([]);
    expect(gaps()).toBe(2);
    blocks.set(1_101, block(1_101, ["acme.vault.testnet"], clock.now));
    await follower.step();
    expect(touched).toEqual([["acme.vault.testnet", 1_101]]);
  });

  it("skips a block the feed lost, with a gap", async () => {
    const head = { value: 100 };
    const { follower, gaps } = fixture(new Map(), head);
    await follower.step();
    head.value = 105; // 101 never comes
    for (let i = 0; i < 5; i += 1) await follower.step();
    expect(gaps()).toBe(2);
  });
});
