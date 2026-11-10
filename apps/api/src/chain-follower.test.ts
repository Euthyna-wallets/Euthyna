import { describe, expect, it } from "vitest";
import { ChainFeedReader, ChainFollower, FEED_STALE_MS, touchedVaults, type ChainFeedTable } from "./chain-follower.js";

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
  const slept: number[] = [];
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
    sleep: async (ms) => { slept.push(ms); clock.now += ms; },
    log: () => undefined,
  });
  return { follower, touched, clock, requests, slept, gaps: () => gaps };
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

  it("is not trusted for five minutes when it falls behind twice in a row: the feed does not let it keep up", async () => {
    const head = { value: 100 };
    const blocks = new Map<number, unknown>();
    const { follower, clock, gaps } = fixture(blocks, head);
    await follower.step();
    for (const next of [101, 301]) {
      blocks.set(next, block(next, [], clock.now));
      clock.now += 2 * 60_000;
      head.value = next + 199;
      await follower.step();
    }
    expect(follower.healthy()).toBe(false);
    // The second time reports no gap: the timers are back, every vault must not be read again.
    expect(gaps()).toBe(2);
    // After the five minutes it starts again from the head.
    clock.now += 5 * 60_000;
    head.value = 900;
    await follower.step();
    expect(gaps()).toBe(3);
    expect(follower.healthy()).toBe(true);
  });

  it("skips a block the feed lost, with a gap", async () => {
    const head = { value: 100 };
    const { follower, gaps } = fixture(new Map(), head);
    await follower.step();
    head.value = 105; // 101 never comes
    for (let i = 0; i < 5; i += 1) await follower.step();
    expect(gaps()).toBe(2);
  });

  it("stays under the feed's public limit of 180 requests a minute", async () => {
    const head = { value: 100 };
    const blocks = new Map<number, unknown>();
    const { follower, clock, requests } = fixture(blocks, head);
    await follower.step();
    const start = clock.now;
    // A burst of blocks to catch up on: the requests are still spaced.
    for (let h = 101; h <= 400; h += 1) blocks.set(h, null);
    while (clock.now - start < 60_000) await follower.step();
    expect(requests.length).toBeLessThanOrEqual(1 + 151);
  });

  it("sends the key in the query and never logs it", async () => {
    const urls: string[] = [];
    const logged: string[] = [];
    const follower = new ChainFollower({
      baseUrl: "https://feed.test",
      apiKey: "secret-key",
      accounts: async () => accounts,
      onTouch: () => undefined,
      onGap: () => undefined,
      fetcher: (async (url: string) => { urls.push(url); throw new Error(`fetch failed for ${url}`); }) as typeof fetch,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      log: (event) => logged.push(JSON.stringify(event)),
    });
    follower.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    follower.stop();
    expect(urls[0]).toBe("https://feed.test/v0/last_block/final?apiKey=secret-key");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join()).not.toContain("secret-key");
  });
});

describe("the other processes read what the follower saw", () => {
  function table() {
    const state = { feed: null as { height: bigint; gaps: number; updatedAt: Date } | null, touches: [] as Array<{ vaultAccountId: string; height: bigint }> };
    const db = {
      chainFeed: { upsert: async () => undefined, findUnique: async () => state.feed },
      chainTouch: { upsert: async () => undefined, findMany: async ({ where }: { where: { height: { gt: bigint } } }) => state.touches.filter((touch) => touch.height > where.height.gt) },
    } as ChainFeedTable;
    return { state, db };
  }

  it("reports each touched vault once, and a gap when the follower skipped blocks", async () => {
    const { state, db } = table();
    const clock = { now: 1_000_000 };
    const touched: string[] = [];
    let gaps = 0;
    const reader = new ChainFeedReader(db, "testnet", { touch: (vault) => touched.push(vault), gap: () => { gaps += 1; } }, () => clock.now);
    await reader.poll();
    expect(reader.healthy()).toBe(false); // no follower yet

    state.feed = { height: 100n, gaps: 0, updatedAt: new Date(clock.now) };
    state.touches.push({ vaultAccountId: "old.vault.testnet", height: 90n });
    await reader.poll();
    expect(reader.healthy()).toBe(true);
    expect(touched).toEqual([]); // before this process started: its own first pass reads every vault

    state.touches.push({ vaultAccountId: "acme.vault.testnet", height: 105n });
    state.feed = { height: 106n, gaps: 0, updatedAt: new Date(clock.now) };
    await reader.poll();
    await reader.poll();
    expect(touched).toEqual(["acme.vault.testnet"]);

    state.feed = { height: 500n, gaps: 1, updatedAt: new Date(clock.now) };
    await reader.poll();
    expect(gaps).toBe(1);

    // The follower stops writing: after a minute the timers are on their own again.
    clock.now += FEED_STALE_MS + 1;
    await reader.poll();
    expect(reader.healthy()).toBe(false);
  });
});
