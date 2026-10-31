/**
 * Paces NEAR RPC calls without letting background work starve the screens.
 *
 * Two lanes: foreground (requests from people and agents) and background
 * (the rule activation job). A free slot always goes to the oldest
 * foreground call first. At most `concurrency` calls run at once, and two
 * calls start at least `minIntervalMs` apart, so a public RPC is not flooded.
 * Code run inside `inBackground(...)` uses the background lane.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type Lane = "foreground" | "background";

const lane = new AsyncLocalStorage<Lane>();

/** Runs `work` with every RPC call it makes in the background lane. */
export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return lane.run("background", work);
}

export const currentLane = (): Lane => lane.getStore() ?? "foreground";

export class RpcLimiter {
  private active = 0;
  private nextStartAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queues: Record<Lane, Array<() => void>> = { foreground: [], background: [] };

  constructor(private readonly concurrency: number, private readonly minIntervalMs: number, private readonly now: () => number = () => Date.now()) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("RPC concurrency must be a positive integer");
  }

  /** Calls waiting in each lane (for logs and tests). */
  waiting(): Record<Lane, number> {
    return { foreground: this.queues.foreground.length, background: this.queues.background.length };
  }

  async run<T>(task: () => Promise<T>, which: Lane = currentLane()): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queues[which].push(resolve);
      this.pump();
    });
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private pump() {
    while (this.active < this.concurrency) {
      const queue = this.queues.foreground.length ? this.queues.foreground : this.queues.background;
      if (!queue.length) return;
      const wait = this.nextStartAt - this.now();
      if (wait > 0) {
        this.timer ??= setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      const start = queue.shift()!;
      this.active += 1;
      this.nextStartAt = this.now() + this.minIntervalMs;
      start();
    }
  }
}
