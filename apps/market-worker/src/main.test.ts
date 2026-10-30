import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MarketApi, TransientError, type AssignedTask } from "./api.js";
import { runTask } from "./main.js";
import { verifyWebhook } from "./webhook.js";

const TOKEN = `mdt_${"a".repeat(43)}`;
const task = (state: AssignedTask["state"] = "submitted"): AssignedTask => ({ id: "11111111-1111-4111-8111-111111111111", state, input: "x", buyer: "bob.testnet", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });

function fakeApi(options: { flaky?: number } = {}) {
  const calls: string[] = [];
  let flaky = options.flaky ?? 0;
  const api = new MarketApi("https://api.example", TOKEN, (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace("https://api.example", "");
    calls.push(`${init?.method} ${path}`);
    if (flaky > 0) {
      flaky -= 1;
      return new Response("{}", { status: 503 });
    }
    return new Response(JSON.stringify({ state: "completed" }), { status: 200 });
  }) as typeof fetch);
  return { api, calls };
}

describe("runTask", () => {
  it("starts, runs and delivers", async () => {
    const { api, calls } = fakeApi();
    await expect(runTask(api, task(), async () => ({ markdown: "# ok" }), 5_000)).resolves.toBe("delivered");
    expect(calls.map((call) => call.split("/").pop())).toEqual(["start", "deliver"]);
  });

  it("fails the task (no charge) when the job throws or times out", async () => {
    const { api, calls } = fakeApi();
    await expect(runTask(api, task("working"), async () => { throw new Error("source down"); }, 5_000)).resolves.toBe("failed");
    expect(calls.at(-1)).toMatch(/\/fail$/);
    const slow = fakeApi();
    await expect(runTask(slow.api, task("working"), () => new Promise(() => undefined), 1_000)).resolves.toBe("failed");
    expect(slow.calls.at(-1)).toMatch(/\/fail$/);
  });

  it("retries transient API errors only", async () => {
    const { api, calls } = fakeApi({ flaky: 2 });
    await expect(runTask(api, task(), async () => ({ markdown: "# ok" }), 5_000, 3)).resolves.toBe("delivered");
    expect(calls.filter((call) => call.endsWith("/start"))).toHaveLength(3);
    expect(new TransientError("x")).toBeInstanceOf(Error);
  });

  it("refuses a malformed delivery token at start", () => {
    expect(() => new MarketApi("https://api.example", "not-a-token")).toThrow(/mdt_/);
  });
});

describe("webhook", () => {
  const secret = "s".repeat(64);
  const sign = (body: string, ts: string) => `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  it("accepts a fresh signed push and refuses stale, forged or unsigned ones", () => {
    const now = 1_800_000_000;
    expect(verifyWebhook(secret, "{}", sign("{}", String(now)), String(now), now)).toBe(true);
    expect(verifyWebhook(secret, "{}", sign("{}", String(now - 600)), String(now - 600), now)).toBe(false);
    expect(verifyWebhook(secret, '{"a":1}', sign("{}", String(now)), String(now), now)).toBe(false);
    expect(verifyWebhook(secret, "{}", undefined, String(now), now)).toBe(false);
  });
});
