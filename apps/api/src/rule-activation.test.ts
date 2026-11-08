/**
 * The rule activation job: a voted rule runs as soon as its veto window ends,
 * idle vaults are not read every pass, passes never overlap, and the job's
 * RPC calls wait behind the screens'.
 */
import type { PrismaClient } from "@euthyna/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KmsSigner } from "./kms.js";
import type { NearClient } from "./near.js";
import { OmniRolesService, type OmniRolesConfig } from "./omniroles.js";
import { currentLane, inBackground, RpcLimiter } from "./rpc-limiter.js";

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const vaults = ["ready.nomos.testnet", "later.nomos.testnet", "idle.nomos.testnet", "broken.nomos.testnet"];

function world(now: { ms: number }) {
  const rules: Record<string, Array<{ queue_id: number[]; change: unknown; state: string; execute_after_ns: string; expires_at_ns: string }>> = {
    "ready.nomos.testnet": [{ queue_id: [1], change: { SetRole: {} }, state: "Queued", execute_after_ns: ns(now.ms - 1_000), expires_at_ns: ns(now.ms + 86_400_000) }],
    "later.nomos.testnet": [{ queue_id: [2], change: { SetRole: {} }, state: "Queued", execute_after_ns: ns(now.ms + 120_000), expires_at_ns: ns(now.ms + 86_400_000) }],
    "idle.nomos.testnet": [],
  };
  const reads: string[] = [];
  const executed: string[] = [];
  const standing: Record<string, Array<{ id: number; next_at_ns: string; runs?: number }>> = {};
  const payouts: Record<string, Array<{ reference: string; state: string; created_at_ns: string }>> = {};
  const lanes: string[] = [];
  const near = {
    viewFunction: vi.fn(async (account: string, method: string) => {
      lanes.push(currentLane());
      if (method === "list_dao_transactions") return [];
      if (method === "list_standing_orders") return standing[account] ?? [];
      if (method === "count_bank_payouts") return (payouts[account] ?? []).length;
      if (method === "list_bank_payouts") return payouts[account] ?? [];
      reads.push(account);
      if (account === "broken.nomos.testnet") throw new Error("CodeDoesNotExist");
      return rules[account] ?? [];
    }),
    getAccount: vi.fn(async () => ({ amount: (10n ** 25n).toString(), storage_usage: 1000 })),
    callFunction: vi.fn(async (account: string, method: string) => {
      executed.push(`${account}:${method}`);
      for (const rule of rules[account] ?? []) rule.state = "Executed";
      return `tx-${account}`;
    }),
  } as unknown as NearClient;
  const prisma = {
    treasury: {
      findMany: async () => vaults.map((vaultAccountId, index) => ({ organizationId: `org-${index}`, vaultAccountId })),
      findUnique: async ({ where }: { where: { organizationId_environment: { organizationId: string } } }) => {
        const index = Number(where.organizationId_environment.organizationId.slice(4));
        return { organizationId: `org-${index}`, vaultAccountId: vaults[index], daoAccountId: "dao.testnet" };
      },
    },
    operation: { findUnique: async () => null, create: async () => ({}) },
  } as unknown as PrismaClient;
  const service = new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, { proposalBondYocto: "1", proposalPeriodNs: "1" } as OmniRolesConfig);
  return { service, reads, executed, lanes, rules, standing, payouts };
}

afterEach(() => vi.useRealTimers());

describe("rule activation job", () => {
  it("runs due rules at once, then reads each vault only when it is due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 9, 31, 21, 30, 41) };
    vi.setSystemTime(now.ms);
    const { service, reads, executed, lanes } = world(now);

    expect(await service.activateAllReadyRules()).toEqual({ checked: 4, skipped: false });
    expect(executed).toEqual(["ready.nomos.testnet:execute_rule_change"]);
    expect(lanes.every((lane) => lane === "background")).toBe(true);

    // 30 s later: nothing is due, no vault is read.
    reads.length = 0;
    vi.setSystemTime(now.ms + 30_000);
    expect(await service.activateAllReadyRules()).toEqual({ checked: 0, skipped: false });
    expect(reads).toEqual([]);

    // After a minute, the idle vaults are read again; the broken one waits longer.
    vi.setSystemTime(now.ms + 61_000);
    await service.activateAllReadyRules();
    expect(reads.sort()).toEqual(["idle.nomos.testnet", "later.nomos.testnet", "ready.nomos.testnet"]);
  });

  it("reads a vault right after its veto window ends, not a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 9, 31, 21, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, rules } = world(now);
    rules["later.nomos.testnet"]![0]!.execute_after_ns = ns(now.ms + 20_000);
    await service.activateAllReadyRules();
    expect(executed).not.toContain("later.nomos.testnet:execute_rule_change");
    vi.setSystemTime(now.ms + 23_500);
    await service.activateAllReadyRules();
    expect(executed).toContain("later.nomos.testnet:execute_rule_change");
  });

  it("runs a payroll order once its date has come, and comes back for it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, standing } = world(now);
    standing["idle.nomos.testnet"] = [{ id: 7, next_at_ns: ns(now.ms + 10_000) }];
    await service.activateAllReadyRules();
    expect(executed).not.toContain("idle.nomos.testnet:run_standing_order");
    // Read again just after its date (plus the margin for the chain's clock), not a minute later.
    vi.setSystemTime(now.ms + 13_500);
    await service.activateAllReadyRules();
    expect(executed).toContain("idle.nomos.testnet:run_standing_order");
  });

  it("does not run a refused payroll payout again on every pass: it waits, then gives up after three tries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, standing, payouts } = world(now);
    const vault = "idle.nomos.testnet";
    const runs = () => executed.filter((call) => call === `${vault}:run_standing_order`).length;
    standing[vault] = [{ id: 3, next_at_ns: ns(now.ms - 60_000), runs: 0 }];
    payouts[vault] = [{ reference: "SO3-1", state: "Failed", created_at_ns: ns(now.ms - 5_000) }];
    await service.activateAllReadyRules();
    expect(runs()).toBe(0);
    // 15 minutes after the refusal, one more try.
    vi.setSystemTime(now.ms + 15 * 60_000);
    await service.activateAllReadyRules();
    expect(runs()).toBe(1);
    // Three refusals of the same run: it waits for the members.
    payouts[vault].push({ reference: "SO3-1", state: "Failed", created_at_ns: ns(now.ms + 15 * 60_000) }, { reference: "SO3-1", state: "Failed", created_at_ns: ns(now.ms + 46 * 60_000) });
    vi.setSystemTime(now.ms + 5 * 3_600_000);
    await service.activateAllReadyRules();
    expect(runs()).toBe(1);
  });

  it("never runs two passes at once", async () => {
    const { service } = world({ ms: Date.now() });
    const [first, second] = await Promise.all([service.activateAllReadyRules(), service.activateAllReadyRules()]);
    expect(first.skipped).toBe(false);
    expect(second).toEqual({ checked: 0, skipped: true });
  });
});

describe("RPC limiter", () => {
  it("gives a free slot to a waiting screen call before the background job", async () => {
    const limiter = new RpcLimiter(1, 0);
    const order: string[] = [];
    let release!: () => void;
    const blocker = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const background = Promise.all([1, 2, 3].map((n) => limiter.run(async () => { order.push(`job-${n}`); }, "background")));
    const screen = limiter.run(async () => { order.push("screen"); }, "foreground");
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    release();
    await Promise.all([blocker, background, screen]);
    expect(order[0]).toBe("screen");
  });

  it("runs several calls at once, up to its concurrency, spaced in time", async () => {
    const limiter = new RpcLimiter(3, 20);
    let running = 0;
    let peak = 0;
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(async () => {
      starts.push(Date.now());
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 60));
      running -= 1;
    })));
    expect(peak).toBe(3);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(15);
  });

  it("marks calls made inside inBackground", async () => {
    expect(currentLane()).toBe("foreground");
    expect(await inBackground(async () => currentLane())).toBe("background");
  });
});
