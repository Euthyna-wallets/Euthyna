import { afterEach, describe, expect, it, vi } from "vitest";

import { readDaoPolicyRpc } from "./wallets.js";

function rpcResult(value: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: "mandateos-browser",
    result: { result: [...new TextEncoder().encode(JSON.stringify(value))] },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("readDaoPolicyRpc", () => {
  it("reads and normalizes council, threshold and factory warning directly from RPC", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcResult({
        roles: [{ name: "council", kind: { Group: ["carol.testnet", "alice.testnet", "bob.testnet"] } }],
        default_vote_policy: { threshold: "2" },
      }))
      .mockResolvedValueOnce(rpcResult({ factory_id: "factory-v2.mandateos.testnet", auto_update: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readDaoPolicyRpc("acme.factory-v2.mandateos.testnet")).resolves.toEqual({
      council: ["alice.testnet", "bob.testnet", "carol.testnet"],
      threshold: "2",
      autoUpdate: true,
      factoryId: "factory-v2.mandateos.testnet",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response without an exact council group", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpcResult({ roles: [], default_vote_policy: { threshold: "2" } })));
    await expect(readDaoPolicyRpc("bad.factory-v2.mandateos.testnet")).rejects.toThrow(
      "DAO council role missing",
    );
  });
});
