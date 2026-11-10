import { AsyncLocalStorage } from "node:async_hooks";

import { currentLane } from "./rpc-limiter.js";

const origin = new AsyncLocalStorage<string>();

/** Runs `work` with every RPC request it makes counted under `label` (an HTTP route, a job's name). */
export function withOrigin<T>(label: string, work: () => Promise<T>): Promise<T> {
  return origin.run(label, work);
}

/**
 * "GET /v1/operations/:id": the path with what identifies a company, an account or an operation
 * replaced, so that the log has one line per route and names nobody.
 */
export function routeLabel(method: string, path: string): string {
  const segments = path.split("?")[0]!.split("/").map((segment) =>
    /^0x[0-9a-fA-F]+$|^\d+$|^[0-9a-fA-F-]{16,}$|\.(testnet|near)$|^[A-Za-z0-9_-]{20,}$/.test(segment) ? ":id" : segment);
  return `${method} ${segments.join("/")}`;
}

/**
 * Counts this process's NEAR RPC requests and logs them once a minute, by who asked (the HTTP
 * route being served, or a background job), by endpoint of the pool (0 is the paid one) and by
 * what was asked. To know
 * what spends the RPC quota from the logs, instead of guessing from the provider's total.
 *
 * No URL and no account in the keys: an endpoint's URL carries its key, and accounts would make
 * one line per company.
 */
export class RpcUsage {
  private counts = new Map<string, number>();
  private routes = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly log: (event: Record<string, unknown>) => void = (event) => console.log(JSON.stringify(event)),
    private readonly lane: () => string = () => origin.getStore() ?? currentLane(),
  ) {}

  record(endpoint: number, method: string, params: unknown): void {
    const key = `${this.lane()} #${endpoint} ${describe(method, params)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** An HTTP request served, whether or not it reads the chain: how often each route is asked. */
  served(route: string): void {
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
  }

  /** Logs the window and starts a new one. Nothing is logged for a window without requests. */
  flush(windowSeconds: number): void {
    const http = [...this.routes].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([route, count]) => `${count} ${route}`);
    this.routes = new Map();
    if (!this.counts.size) return;
    const entries = [...this.counts].sort((a, b) => b[1] - a[1]);
    this.counts = new Map();
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    const byEndpoint: Record<string, number> = {};
    const byLane: Record<string, number> = {};
    for (const [key, count] of entries) {
      // "<who> #<endpoint> <what>": who may contain spaces ("GET /v1/…").
      const at = key.indexOf(" #");
      const lane = key.slice(0, at);
      const endpoint = key.slice(at + 1).split(" ")[0]!;
      byLane[lane] = (byLane[lane] ?? 0) + count;
      byEndpoint[endpoint] = (byEndpoint[endpoint] ?? 0) + count;
    }
    this.log({ event: "near.rpc_usage", windowSeconds, total, byLane, byEndpoint, top: entries.slice(0, 15).map(([key, count]) => `${count} ${key}`), ...(http.length ? { http } : {}) });
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
