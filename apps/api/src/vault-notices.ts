/**
 * Notices: "something happened on this vault, read it now".
 *
 * The background jobs used to read every vault on timers (delegation every 30 s, rules every
 * 5 min, signed operations every 10 min): thousands of RPC reads a day per company, whether or not
 * anything happened. Almost everything that changes a vault passes through this server: a member's
 * vote in the console, an agent's call, a rule the keeper runs, a payment the worker settles.
 * Each of those publishes a notice; the jobs read that vault alone, at once, and the timers
 * become an hourly net.
 *
 * The API and the worker are two processes: a notice is acted on at once in the process that
 * publishes it, and written to one row per vault that the other reads every two seconds. The cost
 * is local database queries, whatever the number of companies.
 *
 * What does not pass through this server (a vote signed with a CLI) is seen by the net, or at
 * once when the block feed is on (chain-follower.ts), which publishes here too.
 */

export type NoticeReason = "vote" | "agent" | "rule" | "settled" | "delegation" | "recovery" | "created" | "block";

export interface NoticeRow { id: bigint; vaultAccountId: string; reason: string }

/** A short append-only log: a notice is never overwritten by another one. */
export interface NoticeTable {
  write(vaultAccountId: string, reason: string): Promise<bigint>;
  /** Rows with an id above `id`, oldest first. */
  after(id: bigint): Promise<NoticeRow[]>;
  /** Rows written since `date`, oldest first: where a process starts from. */
  since(date: Date): Promise<NoticeRow[]>;
  prune(before: Date): Promise<unknown>;
}

interface NoticeDatabase {
  vaultNotice: {
    create(args: { data: { vaultAccountId: string; reason: string }; select: { id: true } }): Promise<{ id: bigint }>;
    findMany(args: { where: { id: { gt: bigint } } | { createdAt: { gte: Date } }; orderBy: { id: "asc" }; select: { id: true; vaultAccountId: true; reason: true } }): Promise<NoticeRow[]>;
    deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<unknown>;
  };
}

export function noticeTable(db: NoticeDatabase): NoticeTable {
  const select = { id: true, vaultAccountId: true, reason: true } as const;
  return {
    write: async (vaultAccountId, reason) => (await db.vaultNotice.create({ data: { vaultAccountId, reason }, select: { id: true } })).id,
    after: (id) => db.vaultNotice.findMany({ where: { id: { gt: id } }, orderBy: { id: "asc" }, select }),
    since: (date) => db.vaultNotice.findMany({ where: { createdAt: { gte: date } }, orderBy: { id: "asc" }, select }),
    prune: (before) => db.vaultNotice.deleteMany({ where: { createdAt: { lt: before } } }),
  };
}

export type NoticeHandler = (vaultAccountId: string, reason: NoticeReason) => void;

const POLL_MS = 2_000;
/** A process started this long after a notice still acts on it (the other process restarted meanwhile). */
const START_LOOKBACK_MS = 60_000;
/**
 * Ids are read again this far back: two writers do not commit in the order of their ids, so a row
 * can appear with an id a little under the newest one already read.
 */
const REREAD_IDS = 50n;
const KEEP_MS = 60 * 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;

export class VaultNotices {
  private readonly handlers: NoticeHandler[] = [];
  private cursor: bigint | null = null;
  /** Ids already acted on (its own, or read), within the re-read window. */
  private readonly seen = new Set<bigint>();
  private readonly startedAt: number;
  private prunedAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: NoticeTable,
    private readonly now: () => number = () => Date.now(),
    private readonly warn: (event: Record<string, unknown>) => void = (event) => console.warn(JSON.stringify(event)),
  ) {
    this.startedAt = this.now();
    this.prunedAt = this.now();
  }

  /** The jobs of this process. */
  subscribe(handler: NoticeHandler): void {
    this.handlers.push(handler);
  }

  /** Something happened on this vault: this process acts now, the others within two seconds. */
  publish(vaultAccountId: string, reason: NoticeReason): void {
    this.deliver(vaultAccountId, reason);
    void this.db.write(vaultAccountId, reason)
      // Its own notice: already acted on.
      .then((id) => { this.seen.add(id); })
      .catch((error: unknown) => this.warn({ event: "vault_notice.write_failed", message: String(error).slice(0, 160) }));
  }

  /** Reads what the other processes published since the last call. */
  async poll(): Promise<void> {
    const rows = this.cursor === null
      ? await this.db.since(new Date(this.startedAt - START_LOOKBACK_MS))
      : await this.db.after(this.cursor - REREAD_IDS);
    this.cursor ??= 0n;
    for (const row of rows) {
      if (row.id > this.cursor) this.cursor = row.id;
      if (this.seen.has(row.id)) continue;
      this.seen.add(row.id);
      this.deliver(row.vaultAccountId, row.reason as NoticeReason);
    }
    for (const id of this.seen) if (id < this.cursor - 2n * REREAD_IDS) this.seen.delete(id);
    if (this.now() - this.prunedAt >= PRUNE_EVERY_MS) {
      this.prunedAt = this.now();
      await this.db.prune(new Date(this.now() - KEEP_MS));
    }
  }

  start(): void {
    this.timer ??= setInterval(() => void this.poll().catch((error: unknown) => this.warn({ event: "vault_notice.read_failed", message: String(error).slice(0, 160) })), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private deliver(vaultAccountId: string, reason: NoticeReason): void {
    for (const handler of this.handlers) {
      try { handler(vaultAccountId, reason); } catch (error) { this.warn({ event: "vault_notice.handler_failed", message: String(error).slice(0, 160) }); }
    }
  }
}

/** Null when `VAULT_NOTICES=off`: the jobs keep their timers alone, as before. */
export function vaultNotices(env: { VAULT_NOTICES?: string | undefined }, db: NoticeDatabase): VaultNotices | null {
  if (env.VAULT_NOTICES === "off") return null;
  const notices = new VaultNotices(noticeTable(db));
  notices.start();
  return notices;
}
