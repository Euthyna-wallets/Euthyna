/**
 * Euthyna Market worker: one per seller listing. Polls its tasks with the
 * listing's delivery token (and wakes up on a signed webhook if configured),
 * runs the job, delivers or fails. No NEAR key, no database.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { MarketApi, TransientError, type AssignedTask, type Delivery } from "./api.js";
import { defiDueDiligenceJob } from "./jobs/defi-dd.js";
import { txCheckJob } from "./jobs/tx-check.js";
import { verifyWebhook } from "./webhook.js";

export const configSchema = z.object({
  EUTHYNA_API_URL: z.string().url(),
  MARKET_DELIVERY_TOKEN: z.string().regex(/^mdt_[A-Za-z0-9_-]{43}$/),
  MARKET_JOB: z.enum(["tx-check", "defi-due-diligence"]),
  WEBHOOK_SECRET: z.string().min(32).optional(),
  WEBHOOK_PORT: z.coerce.number().int().positive().default(8787),
  POLL_SECONDS: z.coerce.number().int().min(2).default(10),
  /** Per-task time limit; keep it under the listing's SLA. */
  TASK_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(1500),
  WORK_DIR: z.string().default("/work"),
  SKILL_DIR: z.string().default(fileURLToPath(new URL("../skills/defi-research-agent", import.meta.url))),
  ANTHROPIC_API_KEY: z.string().optional(),
});
export type WorkerConfig = z.infer<typeof configSchema>;

type Job = (task: AssignedTask) => Promise<Delivery>;

export function jobFor(config: WorkerConfig): Job {
  if (config.MARKET_JOB === "tx-check") return async (task) => txCheckJob(task.input);
  if (!config.ANTHROPIC_API_KEY) throw new Error("defi-due-diligence needs ANTHROPIC_API_KEY");
  return (task) => defiDueDiligenceJob(task.input, { taskId: task.id, skillDir: config.SKILL_DIR, workRoot: config.WORK_DIR, timeoutMs: config.TASK_TIMEOUT_SECONDS * 1000 });
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  // Structured, and never the token, the input or the result.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/** One task: start, run, deliver; transient API errors are retried, job errors fail the task (no charge). */
export async function runTask(api: MarketApi, task: AssignedTask, job: Job, timeoutMs: number, retries = 3): Promise<"delivered" | "failed" | "skipped"> {
  const retry = async <T>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  };
  if (task.state === "submitted") {
    try {
      await retry(() => api.start(task.id));
    } catch (error) {
      log("task.skip", { task: task.id, reason: error instanceof Error ? error.message : String(error) });
      return "skipped";
    }
  }
  const remaining = Date.parse(task.expiresAt) - Date.now() - 15_000;
  let delivery: Delivery;
  try {
    delivery = await withTimeout(job(task), Math.max(1_000, Math.min(timeoutMs, remaining)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log("task.failed", { task: task.id, reason: reason.slice(0, 200) });
    await retry(() => api.fail(task.id, reason)).catch(() => undefined);
    return "failed";
  }
  const result = await retry(() => api.deliver(task.id, delivery));
  log("task.delivered", { task: task.id, state: result.state });
  return "delivered";
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const config = configSchema.parse(env);
  const api = new MarketApi(config.EUTHYNA_API_URL, config.MARKET_DELIVERY_TOKEN);
  const job = jobFor(config);
  const running = new Set<string>();
  let wake: (() => void) | null = null;
  if (config.WEBHOOK_SECRET) {
    const secret = config.WEBHOOK_SECRET;
    createServer((request, response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) chunks.push(chunk); });
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const ok = request.method === "POST" && size <= 65_536 && verifyWebhook(secret, body, request.headers["x-euthyna-signature"] as string | undefined, request.headers["x-euthyna-timestamp"] as string | undefined);
        response.writeHead(ok ? 204 : 401).end();
        if (ok) wake?.();
      });
    }).listen(config.WEBHOOK_PORT);
    log("webhook.listening", { port: config.WEBHOOK_PORT });
  }
  log("worker.started", { job: config.MARKET_JOB });
  for (;;) {
    try {
      const { tasks } = await api.assigned();
      for (const task of tasks.filter((item) => !running.has(item.id))) {
        running.add(task.id);
        void runTask(api, task, job, config.TASK_TIMEOUT_SECONDS * 1000)
          .catch((error: unknown) => log("task.error", { task: task.id, reason: error instanceof Error ? error.message : String(error) }))
          .finally(() => running.delete(task.id));
      }
    } catch (error) {
      log("poll.error", { reason: error instanceof Error ? error.message : String(error) });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.POLL_SECONDS * 1000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
