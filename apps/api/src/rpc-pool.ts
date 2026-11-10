/**
 * A pool of NEAR RPC endpoints, in order of preference (the paid one first, then public ones).
 *
 * An endpoint that refuses for its rate or its quota is set aside for a while and the call goes
 * to the next one at once; the preferred endpoint is used again as soon as its rest is over.
 * Only refusals that never reached the chain move a call: a rate or quota refusal, a 5xx or a
 * connection failure. An answer from the chain (a contract error, an unknown account) is the
 * answer, from any endpoint.
 */
import { rpcUsage } from "./rpc-usage.js";
import { KeyPair, keyStores, Near, providers, type Account } from "near-api-js";

const RATE_REST_FIRST_MS = 30_000;
const REST_MAX_MS = 10 * 60_000;

export type RestReason = "rate" | "quota" | "down";

/** A refusal for the rate or the quota: nothing reached the chain. */
export function isRateRefusal(status: number | undefined, text: string): RestReason | null {
  if (/quota|daily request limit|credits? (are )?exhausted/i.test(text)) return "quota";
  if (status === 429 || /"code"\s*:\s*-?429\b|\[-?429\]|rate limits? exceeded|too many requests/i.test(text)) return "rate";
  return null;
}

/** The host only: a paid endpoint's URL carries its key in the path or the query. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
};

export class RpcPool {
  readonly urls: string[];
  private readonly state = new Map<string, { until: number; strikes: number }>();

  constructor(urls: Array<string | undefined>, private readonly now: () => number = () => Date.now()) {
    this.urls = [...new Set(urls.filter((url): url is string => Boolean(url)))];
    if (!this.urls.length) throw new Error("at least one NEAR RPC endpoint is needed");
  }

  /** The preferred endpoint not resting and not tried yet; when all rest, the one whose rest ends first. */
  pick(tried: ReadonlySet<string> = new Set()): string | null {
    const open = this.urls.filter((url) => !tried.has(url));
    if (!open.length) return null;
    const now = this.now();
    return open.find((url) => (this.state.get(url)?.until ?? 0) <= now)
      ?? open.reduce((best, url) => ((this.state.get(url)?.until ?? 0) < (this.state.get(best)?.until ?? 0) ? url : best));
  }

  /** Set an endpoint aside: a spent quota for 10 minutes, a rate refusal 30 s then twice longer each time. */
  rest(url: string, reason: RestReason): void {
    const strikes = (this.state.get(url)?.strikes ?? 0) + 1;
    const ms = reason === "quota" ? REST_MAX_MS : Math.min(RATE_REST_FIRST_MS * 2 ** (strikes - 1), REST_MAX_MS);
    this.state.set(url, { until: this.now() + ms, strikes });
    console.warn(JSON.stringify({ event: "near.rpc_rest", endpoint: this.urls.indexOf(url), host: hostOf(url), reason, seconds: ms / 1_000 }));
  }

  ok(url: string): void {
    if (this.state.get(url)?.strikes) this.state.delete(url);
  }

  resting(url: string): boolean {
    return (this.state.get(url)?.until ?? 0) > this.now();
  }
}

/**
 * near-api-js's JSON-RPC provider on the pool: every method (views, blocks, transactions) goes
 * through `sendJsonRpc`, so a signed transaction refused for its rate is resent, as the same bytes,
 * to the next endpoint. A timeout is not resent: the transaction may have been accepted.
 */
export class PooledJsonRpcProvider extends providers.JsonRpcProvider {
  private readonly byUrl = new Map<string, providers.JsonRpcProvider>();

  constructor(private readonly pool: RpcPool) {
    super({ url: pool.urls[0]! });
  }

  private on(url: string): providers.JsonRpcProvider {
    let provider = this.byUrl.get(url);
    if (!provider) {
      provider = new providers.JsonRpcProvider({ url });
      this.byUrl.set(url, provider);
    }
    return provider;
  }

  async sendJsonRpc<T>(method: string, params: object): Promise<T> {
    const tried = new Set<string>();
    for (;;) {
      const url = this.pool.pick(tried);
      if (!url) throw new Error(`NEAR RPC: every endpoint refused ${method} for its rate or quota`);
      tried.add(url);
      rpcUsage.record(this.pool.urls.indexOf(url), method, params);
      try {
        const result = await this.on(url).sendJsonRpc<T>(method, params);
        this.pool.ok(url);
        return result;
      } catch (error) {
        const cause = (error as { cause?: unknown }).cause;
        const reason = isRateRefusal(typeof cause === "number" ? cause : undefined, `${String((error as Error).message ?? error)} ${JSON.stringify(cause ?? "")}`);
        if (!reason) throw error;
        this.pool.rest(url, reason);
      }
    }
  }
}

/** An account whose calls and transactions go through the pool. */
export async function pooledAccount(pool: RpcPool, networkId: string, accountId: string, privateKey: string): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, KeyPair.fromString(privateKey as `ed25519:${string}`));
  const near = new Near({ networkId, nodeUrl: pool.urls[0]!, keyStore, provider: new PooledJsonRpcProvider(pool) } as ConstructorParameters<typeof Near>[0]);
  return near.account(accountId);
}
