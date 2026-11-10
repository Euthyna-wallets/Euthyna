import { describe, expect, it } from "vitest";
import { AgentGasKeeper } from "./agent-gas.js";

const NEAR = 10n ** 24n;
function world(balances: Record<string, bigint>) {
  const sent: Array<{ to: string; yocto: bigint }> = [];
  const reads: string[] = [];
  const clock = { now: 1_000_000 };
  const near = {
    getAccount: async (id: string) => { reads.push(id); return { amount: balances[id]!.toString(), storage_usage: 182 }; },
    executeActions: async (to: string, actions: Array<{ depositYocto: string }>) => { const yocto = BigInt(actions[0]!.depositYocto); sent.push({ to, yocto }); balances[to] = balances[to]! + yocto; return "tx"; },
  };
  const keeper = new AgentGasKeeper(near, { belowYocto: 35n * NEAR / 100n, toYocto: 60n * NEAR / 100n, perAgentPerDay: 2, totalPerDayYocto: 15n * NEAR / 10n }, () => clock.now, () => undefined);
  return { keeper, sent, reads, clock, balances };
}

describe("agents are topped up before they run out of NEAR for gas", () => {
  it("tops up an agent under the floor to the target, and leaves one above it alone", async () => {
    const { keeper, sent } = world({ "low.testnet": 288n * NEAR / 1000n, "fine.testnet": NEAR });
    await keeper.check("low.testnet");
    await keeper.check("fine.testnet");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("low.testnet");
    // 0.6 NEAR minus what is available (balance minus 182 bytes of storage).
    expect(sent[0]!.yocto).toBe(60n * NEAR / 100n - (288n * NEAR / 1000n - 182n * 10n ** 19n));
  });

  it("reads an agent's balance at most once every five minutes", async () => {
    const { keeper, reads, clock } = world({ "fine.testnet": NEAR });
    await keeper.check("fine.testnet");
    clock.now += 60_000;
    await keeper.check("fine.testnet");
    clock.now += 5 * 60_000;
    await keeper.check("fine.testnet");
    expect(reads).toHaveLength(2);
  });

  it("stops at the cap per agent per day and the total per day", async () => {
    const { keeper, sent, clock, balances } = world({ "drain.testnet": 0n, "other.testnet": 0n });
    for (let i = 0; i < 4; i += 1) { await keeper.check("drain.testnet"); balances["drain.testnet"] = 0n; clock.now += 5 * 60_000 + 1; }
    expect(sent.filter((item) => item.to === "drain.testnet")).toHaveLength(2);
    // Another 0.6 NEAR would pass the 1.5 NEAR a day for all agents.
    await keeper.check("other.testnet");
    expect(sent.filter((item) => item.to === "other.testnet")).toHaveLength(0);
    clock.now += 24 * 60 * 60_000;
    await keeper.check("other.testnet");
    expect(sent.filter((item) => item.to === "other.testnet")).toHaveLength(1);
  });
});
