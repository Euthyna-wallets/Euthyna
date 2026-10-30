/**
 * The worker's only link to Euthyna: the listing's delivery token. It reads
 * assigned tasks and delivers results; it holds no NEAR key and never sees
 * the cheque.
 */
export type AssignedTask = { id: string; state: "submitted" | "working"; input: string; buyer: string; createdAt: string; expiresAt: string };
export type Delivery = { markdown: string; json?: unknown; files?: Array<{ name: string; url: string; mediaType?: string }> };

export class TransientError extends Error {}

export class MarketApi {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!/^mdt_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("MARKET_DELIVERY_TOKEN must be an mdt_ token from the console");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TransientError(`network: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 500 || response.status === 429) throw new TransientError(`HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(`${payload.error ?? response.status}: ${payload.message ?? ""}`.trim());
    return payload;
  }

  async assigned(): Promise<{ listing: string; tasks: AssignedTask[] }> {
    return this.call("GET", "/v1/market/tasks/assigned");
  }
  async start(id: string) {
    return this.call("POST", `/v1/market/tasks/${id}/start`, {});
  }
  async deliver(id: string, delivery: Delivery) {
    return this.call<{ state: string }>("POST", `/v1/market/tasks/${id}/deliver`, delivery);
  }
  async fail(id: string, reason: string) {
    return this.call("POST", `/v1/market/tasks/${id}/fail`, { reason: reason.slice(0, 500) });
  }
}
