import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PrismaClient } from "@mandateos/db";

import { a2aState, assertPublicWebhook, MarketService, privateAddress, toAtomic } from "./service.js";

describe("webhook targets", () => {
  const publicHost = async () => ["93.184.216.34"];
  it("accept https on public hosts only", async () => {
    await expect(assertPublicWebhook("https://worker.example.com/hook", publicHost)).resolves.toEqual(["93.184.216.34"]);
    for (const url of ["http://worker.example.com/hook", "https://user:pw@worker.example.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://db.internal/", "not a url"]) {
      await expect(assertPublicWebhook(url, publicHost), url).rejects.toMatchObject({ code: "invalid_webhook" });
    }
  });
  it("refuse names that resolve inside a private network", async () => {
    for (const address of ["10.0.0.5", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "127.0.0.1", "198.18.0.1", "192.0.0.8", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "ff02::1"]) {
      expect(privateAddress(address), address).toBe(true);
      await expect(assertPublicWebhook("https://worker.example.com/", async () => ["93.184.216.34", address])).rejects.toMatchObject({ code: "invalid_webhook" });
    }
    expect(privateAddress("8.8.8.8")).toBe(false);
    await expect(assertPublicWebhook("https://nowhere.example.com/", async () => [])).rejects.toMatchObject({ code: "invalid_webhook" });
  });
});

describe("prices", () => {
  it("convert to base units exactly and refuse anything else", () => {
    expect(toAtomic("2", 6)).toBe("2000000");
    expect(toAtomic("0.5", 6)).toBe("500000");
    expect(toAtomic("1.000001", 6)).toBe("1000001");
    for (const bad of ["0", "0.000000", "-1", "1.0000001", "1e3", ""]) expect(() => toAtomic(bad, 6), bad).toThrow();
  });
});

describe("webhook signatures and A2A states", () => {
  const market = new MarketService({} as PrismaClient, {} as never, {} as never, { network: "near:testnet", webhookSecret: "s".repeat(40), dailySettlements: 1, relayerLowYocto: 0n, settlementMarginSeconds: 600 });
  it("sign timestamp and body with a per-listing key", () => {
    const key = market.webhookKey("listing-1");
    expect(key).not.toBe(market.webhookKey("listing-2"));
    expect(market.signWebhook("listing-1", "{}", "1700000000")).toBe(`sha256=${createHmac("sha256", key).update("1700000000.{}").digest("hex")}`);
  });
  it("map task states", () => {
    expect(a2aState("working")).toBe("TASK_STATE_WORKING");
    expect(a2aState("completed_unpaid")).toBe("TASK_STATE_COMPLETED");
    expect(a2aState("expired")).toBe("TASK_STATE_FAILED");
  });
});
