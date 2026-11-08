import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NearClient } from "./near.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NearClient RPC throttling", () => {
  it("backs off and retries an HTTP 429 without changing endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "mandateos",
        result: { keys: [] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new NearClient({
      NEAR_NETWORK_ID: "testnet",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
      NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
      NEAR_RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    });

    const started = Date.now();
    await expect(client.getAccessKeys("account.testnet")).resolves.toEqual({ keys: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "https://rpc.testnet.near.org")).toBe(true);
    // "Retry-After: 0" does not turn the backoff into an instant retry.
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it("paces the console's proxied reads with the server's own", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "mandateos", result: { ok: true } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NearClient({
      NEAR_NETWORK_ID: "testnet",
      NEAR_RPC_URL: "https://rpc.testnet.near.org",
      NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
      NEAR_RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      NEAR_RPC_CONCURRENCY: 2,
      NEAR_RPC_MIN_INTERVAL_MS: 0,
    });
    await Promise.all(Array.from({ length: 6 }, () => client.proxyRpc("query", {})));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("moves to the fallback endpoint at once when the primary's quota is spent, and stays there a while", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === "https://private.example/key") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "mandateos", error: { code: -32003, message: "daily request limit reached" } }), { status: 429 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "mandateos", result: { keys: [] } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NearClient({
      NEAR_NETWORK_ID: "testnet",
      NEAR_RPC_URL: "https://private.example/key",
      NEAR_RPC_FALLBACK_URL: "https://public.example",
      NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
      NEAR_RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      NEAR_RPC_MIN_INTERVAL_MS: 0,
    });
    const started = Date.now();
    await expect(client.getAccessKeys("account.testnet")).resolves.toEqual({ keys: [] });
    expect(Date.now() - started).toBeLessThan(400); // no backoff spent on a quota that will not come back
    await client.getAccessKeys("account.testnet");
    expect(urls).toEqual(["https://private.example/key", "https://public.example", "https://public.example"]);
  });
});
