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

    await expect(client.getAccessKeys("account.testnet")).resolves.toEqual({ keys: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "https://rpc.testnet.near.org")).toBe(true);
  });
});
