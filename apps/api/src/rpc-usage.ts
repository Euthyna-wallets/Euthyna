import { currentLane } from "./rpc-limiter.js";

/**
 * Counts this process's NEAR RPC requests and logs them once a minute, by who asked (a screen or
 * a background job), by endpoint of the pool (0 is the paid one) and by what was asked. To know
 * what spends the RPC quota from the logs, instead of guessing from the provider's total.
 *
 * No URL and no account in the keys: an endpoint's URL carries its key, and accounts would make
 * one line per company.
 */
export class RpcUsage {
  private counts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
    private readonly lane: () => string = currentLane,
  ) {}

  record(endpoint: number, method: string, params: unknown): void {
    const key = `${this.lane()} #${endpoint} ${describe(method, params)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Logs the window and starts a new one. Nothing is logged for a window without requests. */
  flush(windowSeconds: number): void {
    if (!this.counts.size) return;
    const entries = [...this.counts].sort((a, b) => b[1] - a[1]);
    this.counts = new Map();
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const byEndpoint: Record<string, number> = {};
    const byLane: Record<string, number> = {};
    for (const [key, count] of entries) {
      const [lane, endpoint] = key.split(" ");
      byLane[lane!] = (byLane[lane!] ?? 0) + count;
      byEndpoint[endpoint!] = (byEndpoint[endpoint!] ?? 0) + count;
    }
    this.log({ event: "near.rpc_usage", windowSeconds, total, byLane, byEndpoint, top: entries.slice(0, 15).map(([key, count]) => `${count} ${key}`) });
  }

  start(everyMs = 60_000): void {
    this.timer ??= setInterval(() => this.flush(everyMs / 1000), everyMs);
    this.timer.unref?.();
  }
}

/** "query call_function list_roles", "query view_account", "block", "send_tx"… */
function describe(method: string, params: unknown): string {
  if (method !== "query" || typeof params !== "object" || params === null) return method;
  const query = params as { request_type?: unknown; method_name?: unknown };
  const type = typeof query.request_type === "string" ? query.request_type : "?";
  return typeof query.method_name === "string" ? `query ${type} ${query.method_name}` : `query ${type}`;
}

/** This process's counter: every RPC client of the pool records here. */
export const rpcUsage = new RpcUsage();
