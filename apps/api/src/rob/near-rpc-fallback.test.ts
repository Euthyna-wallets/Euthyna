import { describe, expect, it, vi } from "vitest";

import { NearRpc } from "./near-tx.js";

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "rob", result }), { status: 200 });

describe("Rob's RPC", () => {
  it("asks the fallback when the public endpoint refuses for its rate, and only then", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      if (url === "https://public.example") return new Response(JSON.stringify({ jsonrpc: "2.0", id: "rob", error: { code: -429, message: "Rate limits exceeded" } }), { status: 200 });
      return ok({ header: { height: 7 } });
    }) as unknown as typeof fetch;
    const rpc = new NearRpc("https://public.example", fetcher, "https://private.example");
    await expect(rpc.call("block", { finality: "final" })).resolves.toEqual({ header: { height: 7 } });
    expect(urls).toEqual(["https://public.example", "https://private.example"]);
  });

  it("does not hide a real error behind the fallback", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "rob", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }), { status: 200 })) as unknown as typeof fetch;
    const rpc = new NearRpc("https://public.example", fetcher, "https://private.example");
    await expect(rpc.call("query", {})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
