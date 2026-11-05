import { describe, expect, it } from "vitest";
import type { MarketBuyer, OnchainAgentClient } from "@euthyna/sdk";
import { MandateMcpTools } from "./index.js";

describe("market tools", () => {
  it("convert max_price to base units and pass it on", async () => {
    const calls: unknown[] = [];
    const buyer = { hire: async (input: unknown) => { calls.push(input); return { outcome: "hired" }; }, agents: async () => [], status: async () => ({}) } as unknown as MarketBuyer;
    const tools = new MandateMcpTools({} as OnchainAgentClient, buyer);
    await tools.hireAgent({ handle: "defi-due-diligence", task: "aave", maxPrice: "2.5" });
    expect(calls).toEqual([{ handle: "defi-due-diligence", task: "aave", maxPriceAtomic: 2_500_000n }]);
    expect(() => tools.hireAgent({ handle: "x-y-z", task: "a", maxPrice: "1.0000001" })).toThrow(/6 decimals/);
  });
  it("say how to get a card when there is none", () => {
    const tools = new MandateMcpTools({} as OnchainAgentClient);
    expect(() => tools.listMarketAgents({})).toThrow(/euthyna-signer card/);
  });
});
