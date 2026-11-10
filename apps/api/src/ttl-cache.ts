/**
 * Keeps the answer of a read for a while, and shares one in-flight read between callers. For
 * reads a console page asks again on every poll. `clear` drops everything (something changed).
 */
export class TtlCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    const entry = { at: this.now(), value: value as Promise<unknown> };
    this.entries.set(key, entry);
    // A failed read is not kept.
    value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return value;
  }

  /** Drops the entries whose key starts with `prefix` (all of them without one). */
  clear(prefix = ""): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
