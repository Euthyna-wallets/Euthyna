export interface RateLimiter {
  allow(key: string): boolean;
}

/**
 * Fixed-window limiter for a single API instance. UAT deployments use it as a
 * second, coarser guard behind Better Auth's per-key limiter; a multi-instance
 * deployment must replace it with a shared store.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.maxRequests) return false;
    bucket.count += 1;
    return true;
  }
}
