import { describe, expect, it } from "vitest";
import { VaultNotices, type NoticeRow, type NoticeTable } from "./vault-notices.js";

/** One log shared by two processes. `hold` keeps a write uncommitted, as a slow transaction would. */
function shared(clock: { now: number }) {
  const rows: Array<NoticeRow & { at: number; visible: boolean }> = [];
  let nextId = 1n;
  const held: Array<() => void> = [];
  const state = { hold: false };
  const table: NoticeTable = {
    async write(vaultAccountId, reason) {
      const row = { id: nextId++, vaultAccountId, reason, at: clock.now, visible: !state.hold };
      rows.push(row);
      if (state.hold) held.push(() => { row.visible = true; });
      return row.id;
    },
    after: async (id) => rows.filter((row) => row.visible && row.id > id),
    since: async (date) => rows.filter((row) => row.visible && row.at >= date.getTime()),
    prune: async (before) => { for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.at < before.getTime()) rows.splice(i, 1); },
  };
  return { rows, table, state, commitHeld: () => held.splice(0).forEach((commit) => commit()) };
}

function process(table: NoticeTable, clock: { now: number }) {
  const got: string[] = [];
  const notices = new VaultNotices(table, () => clock.now, () => undefined);
  notices.subscribe((vault, reason) => got.push(`${vault}:${reason}`));
  return { notices, got };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("vault notices between the API and the worker", () => {
  it("acts at once where it is published, and once in the other process", async () => {
    const clock = { now: 1_000_000 };
    const { table } = shared(clock);
    const api = process(table, clock);
    const worker = process(table, clock);
    api.notices.publish("acme.vault.testnet", "vote");
    expect(api.got).toEqual(["acme.vault.testnet:vote"]);
    await flush();
    await worker.notices.poll();
    await worker.notices.poll();
    await api.notices.poll();
    expect(worker.got).toEqual(["acme.vault.testnet:vote"]);
    expect(api.got).toEqual(["acme.vault.testnet:vote"]); // not twice on its own notice
  });

  it("keeps every notice and its reason when both processes write the same vault at once", async () => {
    const clock = { now: 1_000_000 };
    const { table } = shared(clock);
    const api = process(table, clock);
    const worker = process(table, clock);
    api.notices.publish("acme.vault.testnet", "vote");
    worker.notices.publish("acme.vault.testnet", "settled");
    api.notices.publish("acme.vault.testnet", "rule");
    await flush();
    await api.notices.poll();
    await worker.notices.poll();
    expect(api.got).toEqual(["acme.vault.testnet:vote", "acme.vault.testnet:rule", "acme.vault.testnet:settled"]);
    expect(worker.got).toEqual(["acme.vault.testnet:settled", "acme.vault.testnet:vote", "acme.vault.testnet:rule"]);
  });

  it("sees a notice committed after a newer one was already read", async () => {
    const clock = { now: 1_000_000 };
    const { table, state, commitHeld } = shared(clock);
    const api = process(table, clock);
    const worker = process(table, clock);
    await api.notices.poll();
    state.hold = true;
    worker.notices.publish("a.vault.testnet", "agent"); // id 1, not committed yet
    state.hold = false;
    worker.notices.publish("b.vault.testnet", "settled"); // id 2
    await flush();
    await api.notices.poll();
    expect(api.got).toEqual(["b.vault.testnet:settled"]);
    commitHeld();
    await api.notices.poll();
    await api.notices.poll();
    expect(api.got).toEqual(["b.vault.testnet:settled", "a.vault.testnet:agent"]);
  });

  it("starts from the last minute, not from the whole log, and prunes what is older than an hour", async () => {
    const clock = { now: 10_000_000 };
    const { table, rows } = shared(clock);
    clock.now -= 2 * 60 * 60_000;
    await table.write("old.vault.testnet", "vote");
    clock.now += 2 * 60 * 60_000 - 30_000;
    await table.write("recent.vault.testnet", "agent");
    clock.now += 30_000;
    const api = process(table, clock);
    await api.notices.poll();
    expect(api.got).toEqual(["recent.vault.testnet:agent"]);
    clock.now += 11 * 60_000;
    await api.notices.poll();
    expect(rows.map((row) => row.vaultAccountId)).toEqual(["recent.vault.testnet"]);
  });
});
