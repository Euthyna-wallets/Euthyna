/**
 * Follows NEAR's final blocks, one stream for every company, instead of reading each vault on a
 * timer. A block lists the receipts it ran: when one ran on an account we watch (a company's vault
 * or its DAO), the vault is reported, and the jobs read that vault alone, at once.
 *
 * The cost is one block per block (about 8 kB, from FastNEAR's block feed), whatever the number of
 * companies. The feed allows 180 requests a minute per IP without a key, which did not let our
 * server keep up (10 November 2026): it is off unless `NEAR_BLOCK_FEED_URL` is set, with a key.
 * One process follows it (the worker) and publishes what it sees as notices (vault-notices.ts). The timers stay as a net: slow while the feed is `healthy`, as before when it is not
 * (feed down, or this process too far behind). A gap (start, restart, falling behind) is reported
 * with `onGap`, and the jobs read every vault once.
 */

interface FeedBlock {
  block: { header: { height: number; timestamp_nanosec?: string } };
  shards: Array<{ receipt_execution_outcomes?: Array<{ receipt?: { receiver_id?: string } }> } | null>;
}

export interface ChainFollowerOptions {
  /** For example https://testnet.neardata.xyz */
  baseUrl: string;
  apiKey?: string | undefined;
  /** Watched account → the vault to report. Read again every `accountsTtlMs` (a new company). */
  accounts: () => Promise<Map<string, string>>;
  onTouch: (vaultAccountId: string, height: number) => void;
  /** The stream jumped: blocks were not read. */
  onGap: () => void;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
  accountsTtlMs?: number;
  minRequestIntervalMs?: number;
}

/** No block read for this long: the feed is not trusted, the timers go back to their own pace. */
export const FEED_STALE_MS = 60_000;
/** A block older than this when we read it: we are behind. Jump to the head and report a gap. */
const MAX_LAG_MS = 90_000;
/**
 * Falling behind twice within this long means the feed does not let us keep up (its rate limit):
 * it is not trusted for this long, and the timers work at their own pace instead of reading every
 * vault after each jump.
 */
const CANNOT_KEEP_UP_MS = 5 * 60_000;
/** A block the feed should have and does not: asked this many times, then skipped with a gap. */
const MISSING_TRIES = 5;
const ACCOUNTS_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * At least this long between two requests: 150 a minute at most, under the feed's public limit of
 * 180 a minute per IP. Testnet makes a block about every 0.8 s, so this still catches up.
 */
const MIN_REQUEST_INTERVAL_MS = 400;

/** The watched vaults a block touched. */
export function touchedVaults(block: FeedBlock, accounts: Map<string, string>): Set<string> {
  const vaults = new Set<string>();
  for (const shard of block.shards ?? []) {
    for (const outcome of shard?.receipt_execution_outcomes ?? []) {
      const vault = accounts.get(outcome.receipt?.receiver_id ?? "");
      if (vault) vaults.add(vault);
    }
  }
  return vaults;
}

export class ChainFollower {
  private next: number | null = null;
  private lastBlockAt = Number.NEGATIVE_INFINITY;
  private running = false;
  private watched = new Map<string, string>();
  private watchedAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private missing = 0;
  private fellBehindAt = Number.NEGATIVE_INFINITY;
  private distrustedUntil = Number.NEGATIVE_INFINITY;
  private wasHealthy = false;
  private rateLoggedAt = Number.NEGATIVE_INFINITY;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(private readonly options: ChainFollowerOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  /** The next block to read, once started. */
  height(): number | null {
    return this.next;
  }

  /** True while blocks arrive: every watched vault's activity is being reported. */
  healthy(): boolean {
    return this.now() - this.lastBlockAt < FEED_STALE_MS && this.now() >= this.distrustedUntil;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  stop(): void {
    this.running = false;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const paused = this.distrustedUntil - this.now();
        if (paused > 0) {
          await this.sleep(Math.min(paused, 30_000));
          continue;
        }
        const advanced = await this.step();
        this.failures = 0;
        if (!advanced) await this.sleep(1_000);
      } catch (error) {
        this.failures += 1;
        // A refusal for the rate is expected now and then: said once a minute at most.
        const rate = /answered 429/.test(String(error));
        if (rate ? this.now() - this.rateLoggedAt >= 60_000 : this.failures === 1 || this.failures % 30 === 0) {
          if (rate) this.rateLoggedAt = this.now();
          // Never the URL: it can carry the key.
          this.log({ event: "chain_feed.failed", failures: this.failures, message: String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) });
        }
        await this.sleep(Math.min(1_000 * 2 ** Math.min(this.failures, 5), 30_000));
      }
      const healthy = this.healthy();
      if (healthy !== this.wasHealthy) {
        this.wasHealthy = healthy;
        this.log({ event: healthy ? "chain_feed.following" : "chain_feed.stale", height: this.next });
      }
    }
  }

  /** Reads one block. False when there is nothing to read yet. Exposed for tests. */
  async step(): Promise<boolean> {
    if (this.next === null) {
      this.next = (await this.head()) + 1;
      this.lastBlockAt = this.now();
      // Whatever happened before this block was not seen.
      this.options.onGap();
      return true;
    }
    const result = await this.get(`/v0/block/${this.next}`);
    if (result.status === 404) {
      // Normally "not produced yet". If the head is past it, the feed lost it: skip it, with a gap.
      const head = await this.head();
      if (head >= this.next && (this.missing += 1) >= MISSING_TRIES) this.jump(head);
      return false;
    }
    if (result.status !== 200) throw new Error(`block feed answered ${result.status}`);
    const height = this.next;
    this.next += 1;
    this.missing = 0;
    // A height without a block (a skipped slot) comes back as null.
    if (!result.body) return true;
    const block = result.body as FeedBlock;
    // Catching up block by block after a pause would report old activity late while looking alive.
    const ageMs = this.now() - Number(BigInt(block.block.header.timestamp_nanosec ?? "0") / 1_000_000n);
    if (block.block.header.timestamp_nanosec && ageMs > MAX_LAG_MS) {
      if (this.now() - this.fellBehindAt < CANNOT_KEEP_UP_MS) {
        // Stop asking the feed for a while, and report no gap: the timers are back at their own
        // pace, and reading every vault after each jump would cost more than they do.
        this.distrustedUntil = this.now() + CANNOT_KEEP_UP_MS;
        this.fellBehindAt = Number.NEGATIVE_INFINITY;
        this.next = null;
        this.log({ event: "chain_feed.cannot_keep_up", height, pausedMs: CANNOT_KEEP_UP_MS });
        return false;
      }
      this.fellBehindAt = this.now();
      this.jump(await this.head());
      return true;
    }
    this.lastBlockAt = this.now();
    if (this.now() - this.watchedAt >= (this.options.accountsTtlMs ?? ACCOUNTS_TTL_MS)) {
      this.watched = await this.options.accounts();
      this.watchedAt = this.now();
    }
    for (const vault of touchedVaults(block, this.watched)) this.options.onTouch(vault, height);
    return true;
  }

  private jump(head: number): void {
    this.log({ event: "chain_feed.gap", from: this.next, to: head + 1 });
    this.next = head + 1;
    this.missing = 0;
    this.options.onGap();
  }

  private async head(): Promise<number> {
    const result = await this.get("/v0/last_block/final");
    const height = (result.body as FeedBlock | null)?.block?.header?.height;
    if (result.status !== 200 || typeof height !== "number") throw new Error(`block feed head answered ${result.status}`);
    return height;
  }

  private lastRequestAt = Number.NEGATIVE_INFINITY;

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const wait = this.lastRequestAt + (this.options.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    // The key goes in the query: the feed redirects, and a header would not follow.
    const key = this.options.apiKey ? `?apiKey=${encodeURIComponent(this.options.apiKey)}` : "";
    const response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/, "")}${path}${key}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = response.status === 200 ? await response.json() as unknown : null;
    if (response.status !== 200) await response.arrayBuffer().catch(() => undefined);
    return { status: response.status, body };
  }
}

/** The follower's position, written every few seconds: a sign of life to look at when in doubt. */
export interface ChainFeedTable {
  chainFeed: {
    upsert(args: { where: { name: string }; create: { name: string; height: bigint; gaps: number }; update: { height: bigint; gaps?: { increment: number } } }): Promise<unknown>;
  };
}

type FeedEnv = { NEAR_NETWORK_ID: string; NEAR_BLOCK_FEED_URL?: string | undefined; NEAR_BLOCK_FEED_API_KEY?: string | undefined };
type Treasuries = () => Promise<Array<{ vaultAccountId: string; daoAccountId: string | null }>>;
const HEARTBEAT_MS = 5_000;

/**
 * The follower, in the one process that runs it (the worker): off unless `NEAR_BLOCK_FEED_URL` is
 * set, because the feed's public limit does not let a server keep up without a key. It reports
 * what this server cannot know by itself (a vote signed elsewhere) as notices, like any other.
 */
export function followCompanies(
  env: FeedEnv,
  db: ChainFeedTable,
  treasuries: Treasuries,
  on: { touch: (vaultAccountId: string) => void; gap: () => void },
): ChainFollower | null {
  const baseUrl = env.NEAR_BLOCK_FEED_URL;
  if (!baseUrl || baseUrl === "off") return null;
  const name = env.NEAR_NETWORK_ID;
  const failed = (error: unknown) => console.warn(JSON.stringify({ event: "chain_feed.write_failed", message: String(error).slice(0, 160) }));
  let pendingGaps = 0;
  const follower = new ChainFollower({
    baseUrl,
    apiKey: env.NEAR_BLOCK_FEED_API_KEY,
    accounts: async () => {
      const watched = new Map<string, string>();
      for (const treasury of await treasuries()) {
        watched.set(treasury.vaultAccountId, treasury.vaultAccountId);
        if (treasury.daoAccountId) watched.set(treasury.daoAccountId, treasury.vaultAccountId);
      }
      return watched;
    },
    onTouch: (vaultAccountId) => on.touch(vaultAccountId),
    onGap: () => {
      pendingGaps += 1;
      on.gap();
    },
  });
  const heartbeat = async () => {
    const height = follower.height();
    if (height === null || !follower.healthy()) return;
    const gaps = pendingGaps;
    pendingGaps = 0;
    await db.chainFeed.upsert({ where: { name }, create: { name, height: BigInt(height), gaps }, update: { height: BigInt(height), ...(gaps ? { gaps: { increment: gaps } } : {}) } })
      .catch((error: unknown) => { pendingGaps += gaps; failed(error); });
  };
  setInterval(() => void heartbeat(), HEARTBEAT_MS).unref();
  follower.start();
  return follower;
}
