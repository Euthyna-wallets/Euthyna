import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NearClient } from "./near.js";
import { isRateRefusal, PooledJsonRpcProvider, RpcPool } from "./rpc-pool.js";

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("RPC pool", () => {
  it("tells a refusal for the rate or the quota from an answer of the chain", () => {
    expect(isRateRefusal(429, "")).toBe("rate");
    expect(isRateRefusal(200, '{"code":-429,"message":"Rate limits exceeded"}')).toBe("rate");
    expect(isRateRefusal(200, "daily request limit reached")).toBe("quota");
    expect(isRateRefusal(200, '{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT"}}')).toBeNull();
    expect(isRateRefusal(200, "Exceeded the prepaid gas")).toBeNull();
  });

  it("goes down the list, then back to the paid endpoint once its rest is over", () => {
    const now = { ms: 0 };
    const pool = new RpcPool(["https://paid.example/key", "https://a.example", "https://b.example"], () => now.ms);
    expect(pool.pick()).toBe("https://paid.example/key");
    pool.rest("https://paid.example/key", "rate");
    pool.rest("https://a.example", "quota");
    expect(pool.pick()).toBe("https://b.example");
    now.ms += 31_000;
    expect(pool.pick()).toBe("https://paid.example/key");
    pool.rest("https://paid.example/key", "rate"); // a second refusal: twice longer
    now.ms += 31_000;
    expect(pool.pick()).toBe("https://b.example");
  });

  it("serves a read from the third endpoint when the first two refuse, with no wait", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url === "https://paid.example/key") return answer({ jsonrpc: "2.0", id: "mandateos", error: { code: -32003, message: "daily request limit reached" } }, 429);
      if (url === "https://a.example") return answer({ jsonrpc: "2.0", id: "mandateos", error: { code: -429, message: "Rate limits exceeded" } });
      return answer({ jsonrpc: "2.0", id: "mandateos", result: { keys: [] } });
    }));
    const client = new NearClient({
      NEAR_NETWORK_ID: "testnet",
      NEAR_RPC_URL: "https://paid.example/key",
      NEAR_RPC_URLS: "https://a.example, https://b.example",
      NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
      NEAR_RELAYER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
      NEAR_RPC_MIN_INTERVAL_MS: 0,
    });
    const started = Date.now();
    await expect(client.getAccessKeys("account.testnet")).resolves.toEqual({ keys: [] });
    expect(Date.now() - started).toBeLessThan(400);
    expect(urls).toEqual(["https://paid.example/key", "https://a.example", "https://b.example"]);
  });

  it("near-api-js calls (transactions included) move on a rate refusal, never on an answer of the chain", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url === "https://paid.example/key") return new Response("Too Many Requests", { status: 429 });
      return answer({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }));
    const provider = new PooledJsonRpcProvider(new RpcPool(["https://paid.example/key", "https://a.example"]));
    await expect(provider.sendJsonRpc("broadcast_tx_commit", ["AAAA"])).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://paid.example/key", "https://a.example"]);

    urls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return answer({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", data: "Account foo.testnet does not exist while viewing" } });
    }));
    await expect(new PooledJsonRpcProvider(new RpcPool(["https://paid.example/key", "https://a.example"])).sendJsonRpc("query", {})).rejects.toThrow();
    expect(urls).toEqual(["https://paid.example/key"]);
  });
});
