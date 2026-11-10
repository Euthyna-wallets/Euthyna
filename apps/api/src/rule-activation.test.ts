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
  const calls: string[] = [];
  const banks = new Set<string>();
  const refuse = new Set<string>();
  const executed: string[] = [];
  const standing: Record<string, Array<{ id: number; next_at_ns: string; runs?: number }>> = {};
  const payouts: Record<string, Array<{ reference: string; state: string; created_at_ns: string }>> = {};
  const follow: Record<string, { project: string; follow: boolean; last_queued: string | null }> = {};
  const active = { version: "ab".repeat(32) };
  const lanes: string[] = [];
  const duringRead: Record<string, () => void> = {};
  const near = {
    viewFunction: vi.fn(async (account: string, method: string) => {
      lanes.push(currentLane());
      calls.push(`${account}:${method}`);
      if (method === "list_dao_transactions") return [];
      if (method === "list_standing_orders") return standing[account] ?? [];
      if (method === "get_bank_signer_source") return follow[account] ?? null;
      if (method === "get_bank_config") return follow[account] || banks.has(account) ? { outlayer_id: "outlayer.testnet", signer_hash: "ab".repeat(32) } : null;
      if (method === "get_project") return { project_id: "ops.testnet/bank-signer", active_version: active.version };
      if (method === "count_bank_payouts") return (payouts[account] ?? []).length;
      if (method === "list_bank_payouts") return payouts[account] ?? [];
      reads.push(account);
      const hook = duringRead[account];
      if (hook) { delete duringRead[account]; hook(); return []; }
      if (account === "broken.nomos.testnet") throw new Error("CodeDoesNotExist");
      return rules[account] ?? [];
    }),
    getAccount: vi.fn(async () => ({ amount: (10n ** 25n).toString(), storage_usage: 1000 })),
    callFunction: vi.fn(async (account: string, method: string) => {
      executed.push(`${account}:${method}`);
      if (method === "execute_rule_change" && refuse.has(account)) throw new Error("Smart contract panicked: ERR_MEMBERSHIP_IN_USE");
      for (const rule of rules[account] ?? []) rule.state = "Executed";
      return `tx-${account}`;
    }),
  } as unknown as NearClient;
  const prisma = {
    treasury: {
      findMany: async () => vaults.map((vaultAccountId, index) => ({ organizationId: `org-${index}`, vaultAccountId })),
      findFirst: async () => ({ daoAccountId: "dao.testnet" }),
      findUnique: async ({ where }: { where: { organizationId_environment: { organizationId: string } } }) => {
        const index = Number(where.organizationId_environment.organizationId.slice(4));
        return { organizationId: `org-${index}`, vaultAccountId: vaults[index], daoAccountId: "dao.testnet" };
      },
    },
    operation: { findUnique: async () => null, create: async () => ({}) },
  } as unknown as PrismaClient;
  const service = new OmniRolesService(prisma, near, {} as KmsSigner, {} as KmsSigner, { proposalBondYocto: "1", proposalPeriodNs: "1" } as OmniRolesConfig);
  return { service, reads, executed, lanes, rules, standing, payouts, follow, active, calls, banks, refuse, duringRead };
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

    // After five minutes, the idle vaults are read again; the broken one waits longer.
    vi.setSystemTime(now.ms + 100_000);
    reads.length = 0;
    await service.activateAllReadyRules();
    expect(reads).toEqual([]); // not before the next known date (2 minutes) or five idle minutes
    vi.setSystemTime(now.ms + 301_000);
    await service.activateAllReadyRules();
    expect(reads.sort()).toEqual(["idle.nomos.testnet", "later.nomos.testnet", "ready.nomos.testnet"]);
  });

  it("a vote that lands while the job reads the vault is not pushed back to the idle read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 9, 21, 1, 30) };
    vi.setSystemTime(now.ms);
    const { service, executed, rules, duringRead } = world(now);
    // The pass reads idle's rules (empty), and meanwhile a member's vote queues one and asks to refresh.
    duringRead["idle.nomos.testnet"] = () => {
      rules["idle.nomos.testnet"]!.push({ queue_id: [3], change: { SetRole: {} }, state: "Queued", execute_after_ns: ns(now.ms + 60_000), expires_at_ns: ns(now.ms + 86_400_000) });
      void service.refresh("org-2");
    };
    await service.activateAllReadyRules();
    await Promise.resolve();
    // 9 s later the vault is read again and sees the veto window; it runs when the window ends.
    vi.setSystemTime(now.ms + 9_000);
    await service.activateAllReadyRules();
    vi.setSystemTime(now.ms + 64_000);
    executed.length = 0;
    await service.activateAllReadyRules();
    expect(executed).toContain("idle.nomos.testnet:execute_rule_change");
  });

  it("with notices on, an idle vault is read hourly, and at once when something happens on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 10, 8, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, reads, executed, rules } = world(now);
    let followed = true;
    service.withNotices(() => followed, () => undefined);
    await service.activateAllReadyRules();

    // Six minutes later the idle vault is not read: nothing happened on it.
    reads.length = 0;
    vi.setSystemTime(now.ms + 360_000);
    await service.activateAllReadyRules();
    expect(reads).not.toContain("idle.nomos.testnet");

    // A vote queues a rule: the notice makes the vault read on the next pass.
    rules["idle.nomos.testnet"]!.push({ queue_id: [3], change: { SetRole: {} }, state: "Queued", execute_after_ns: ns(now.ms + 420_000), expires_at_ns: ns(now.ms + 86_400_000) });
    service.notice("idle.nomos.testnet", "vote");
    vi.setSystemTime(now.ms + 362_000);
    await service.activateAllReadyRules();
    expect(reads).toContain("idle.nomos.testnet");
    vi.setSystemTime(now.ms + 424_000);
    executed.length = 0;
    await service.activateAllReadyRules();
    expect(executed).toContain("idle.nomos.testnet:execute_rule_change");
  });

  it("goes back to the five-minute read when notices are turned off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 10, 8, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, reads } = world(now);
    let followed = true;
    service.withNotices(() => followed, () => undefined);
    await service.activateAllReadyRules();

    followed = false;
    reads.length = 0;
    vi.setSystemTime(now.ms + 200_000);
    await service.activateAllReadyRules();
    expect(reads).not.toContain("idle.nomos.testnet");
    vi.setSystemTime(now.ms + 301_000);
    await service.activateAllReadyRules();
    expect(reads).toContain("idle.nomos.testnet");
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

  it("asks a vault that follows its enclave project to queue a new version, once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, follow, active } = world(now);
    const vault = "idle.nomos.testnet";
    const asked = () => executed.filter((call) => call === `${vault}:follow_bank_signer`).length;
    follow[vault] = { project: "ops.testnet/bank-signer", follow: true, last_queued: null };
    await service.activateAllReadyRules();
    expect(asked()).toBe(0); // the vault already runs the active version
    active.version = "cd".repeat(32);
    vi.setSystemTime(now.ms + 30 * 60_000);
    await service.activateAllReadyRules();
    expect(asked()).toBe(0); // the project is looked at once an hour
    vi.setSystemTime(now.ms + 61 * 60_000);
    await service.activateAllReadyRules();
    expect(asked()).toBe(1);
    // Queued (or vetoed) already: not asked again.
    follow[vault]!.last_queued = "cd".repeat(32);
    vi.setSystemTime(now.ms + 122 * 60_000);
    await service.activateAllReadyRules();
    expect(asked()).toBe(1);
  });

  it("reads what only a vote changes once, until the vault's rules move", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, calls, standing, rules } = world(now);
    const vault = "idle.nomos.testnet";
    standing[vault] = [{ id: 1, next_at_ns: ns(now.ms + 30 * 86_400_000), runs: 0 }];
    const orderReads = () => calls.filter((call) => call === `${vault}:list_standing_orders`).length;
    for (const minutes of [0, 6, 12, 18]) {
      vi.setSystemTime(now.ms + minutes * 60_000);
      await service.activateAllReadyRules();
    }
    expect(orderReads()).toBe(1);
    // A rule queued (or applied): read again.
    rules[vault] = [{ queue_id: [9], change: { AddStandingOrder: {} }, state: "Queued", execute_after_ns: ns(now.ms + 86_400_000), expires_at_ns: ns(now.ms + 2 * 86_400_000) }];
    vi.setSystemTime(now.ms + 24 * 60_000);
    await service.activateAllReadyRules();
    expect(orderReads()).toBe(2);
  });

  it("with notices on, reads a vault that pays IBANs every minute only while something happens on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 10, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, reads, banks } = world(now);
    const vault = "idle.nomos.testnet";
    banks.add(vault);
    service.withNotices(() => true, () => undefined);
    await service.activateAllReadyRules();
    const readsBetween = async (fromMinute: number, toMinute: number) => {
      reads.length = 0;
      for (let minute = fromMinute; minute <= toMinute; minute += 1) {
        vi.setSystemTime(now.ms + minute * 60_000 + 5_000);
        await service.activateAllReadyRules();
      }
      return reads.filter((read) => read === vault).length;
    };
    // Nothing happens: not read for the next ten minutes.
    expect(await readsBetween(1, 10)).toBe(0);
    // The agent asks for a payout: read at once, then every minute while the enclave may answer.
    service.notice(vault, "agent");
    // (This test looks once a minute and the read is due after 63 s: every other look.)
    expect(await readsBetween(11, 20)).toBeGreaterThanOrEqual(4);
    // Quiet again a quarter of an hour after the last notice.
    await readsBetween(21, 29);
    expect(await readsBetween(30, 40)).toBe(0);
  });

  it("keeps a screen's read of a quiet company for minutes, and reads again as soon as something happens on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 10, 10, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, calls } = world(now);
    service.withNotices(() => true, () => undefined);
    await service.activateAllReadyRules(); // learns the companies
    const vault = "idle.nomos.testnet";
    const screen = () => (service as unknown as { view(account: string, method: string): Promise<unknown> }).view(vault, "list_roles");
    const chainReads = () => calls.filter((call) => call === `${vault}:list_roles`).length;
    // Just seen: active for five minutes, as before (kept 6 s).
    await screen();
    vi.setSystemTime(now.ms + 10_000);
    await screen();
    expect(chainReads()).toBe(2);
    // Quiet: a console tab asking every 15 s for ten minutes reads the chain twice, not forty times.
    for (let second = 6 * 60; second < 16 * 60; second += 15) {
      vi.setSystemTime(now.ms + second * 1_000);
      await screen();
    }
    expect(chainReads()).toBe(4);
    // A vote: the next look reads the chain, and the company is active again.
    service.notice(vault, "vote");
    vi.setSystemTime(now.ms + 16 * 60_000 + 1_000);
    await screen();
    vi.setSystemTime(now.ms + 16 * 60_000 + 10_000);
    await screen();
    expect(chainReads()).toBe(6);
    // What only a noticed transaction changes (the DAO's policy) is kept 30 s even now, and a
    // notice drops it: here the vote of a new member.
    const policy = () => (service as unknown as { view(account: string, method: string): Promise<unknown> }).view(vault, "get_policy");
    const policyReads = () => calls.filter((call) => call === `${vault}:get_policy`).length;
    await policy();
    vi.setSystemTime(now.ms + 16 * 60_000 + 25_000);
    await policy();
    expect(policyReads()).toBe(1);
    service.notice(vault, "vote");
    await policy();
    expect(policyReads()).toBe(2);
    // An account that gets no notice (another contract) is read as before.
    const other = () => (service as unknown as { view(account: string, method: string): Promise<unknown> }).view("registry.testnet", "get");
    await other();
    vi.setSystemTime(now.ms + 16 * 60_000 + 40_000);
    await other();
    expect(calls.filter((call) => call === "registry.testnet:get").length).toBe(2);
  });

  it("tries a refused rule at once when a payment of the vault ends, and tells the other process what it ran", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 10, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, refuse } = world(now);
    const published: string[] = [];
    service.withNotices(() => true, (vault, reason) => published.push(`${vault}:${reason}`));
    refuse.add("ready.nomos.testnet"); // its role is held by a payment in flight
    await service.activateAllReadyRules();
    expect(published).toEqual([]);
    // 20 s later the payment settles: the worker's notice makes the keeper try again, without the 2-minute wait.
    vi.setSystemTime(now.ms + 20_000);
    refuse.delete("ready.nomos.testnet");
    executed.length = 0;
    service.notice("ready.nomos.testnet", "settled");
    vi.setSystemTime(now.ms + 22_000);
    await service.activateAllReadyRules();
    expect(executed).toEqual(["ready.nomos.testnet:execute_rule_change"]);
    expect(published).toEqual(["ready.nomos.testnet:rule"]);
  });

  it("reads a vault that pays IBANs every minute, so an agent's payout transfer starts at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, calls, banks } = world(now);
    banks.add("idle.nomos.testnet");
    const passes = (vault: string) => calls.filter((call) => call === `${vault}:list_dao_transactions`).length;
    await service.activateAllReadyRules();
    vi.setSystemTime(now.ms + 75_000);
    await service.activateAllReadyRules();
    expect(passes("idle.nomos.testnet")).toBe(2);
    expect(passes("later.nomos.testnet")).toBe(1); // no bank: waits for its own date
  });

  it("does not send a refused rule again on every pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = { ms: Date.UTC(2026, 10, 28, 9, 0, 0) };
    vi.setSystemTime(now.ms);
    const { service, executed, rules, refuse } = world(now);
    const vault = "idle.nomos.testnet";
    rules[vault] = [{ queue_id: [7], change: { RevokeMembership: {} }, state: "Queued", execute_after_ns: ns(now.ms - 1_000), expires_at_ns: ns(now.ms + 86_400_000) }];
    refuse.add(vault);
    const tries = () => executed.filter((call) => call === `${vault}:execute_rule_change`).length;
    await service.activateAllReadyRules();
    expect(tries()).toBe(1);
    for (const seconds of [30, 60, 90]) {
      vi.setSystemTime(now.ms + seconds * 1_000);
      await service.activateAllReadyRules();
    }
    expect(tries()).toBe(1); // not before two minutes
    vi.setSystemTime(now.ms + 125_000);
    await service.activateAllReadyRules();
    expect(tries()).toBe(2);
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
