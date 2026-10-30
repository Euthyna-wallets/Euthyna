/**
 * Market HTTP surface. Public: catalog, A2A agent cards and JSON-RPC, x402
 * discovery. Worker: delivery-token endpoints. Console: listings and sales
 * (mounted by the app under its console auth).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { Context, Hono } from "hono";
import { z } from "zod";

import type { RateLimiter } from "../rate-limit.js";
import { a2aState, MarketError, type MarketService } from "./service.js";

type Task = Awaited<ReturnType<MarketService["task"]>>;

/** A2A task view: state, and the result as artifacts (markdown text + JSON data). */
export function a2aTask(task: Task) {
  // The result is released only once the cheque is paid: a buyer who spends
  // the balance or the nonce in between gets nothing.
  const paid = task.state === "completed" && task.hold?.state === "settled";
  const artifacts = paid && task.resultMarkdown !== null && task.resultMarkdown !== undefined
    ? [{
        artifactId: `${task.id}-result`,
        name: "result",
        parts: [
          { kind: "text", text: task.resultMarkdown, mediaType: "text/markdown" },
          ...(task.resultJson ? [{ kind: "data", data: task.resultJson, mediaType: "application/json" }] : []),
        ],
      }]
    : [];
  return {
    id: task.id,
    contextId: task.id,
    kind: "task",
    status: {
      state: a2aState(task.state),
      timestamp: (task.completedAt ?? task.startedAt ?? task.createdAt).toISOString(),
      ...(task.failureReason ? { message: task.failureReason } : task.state === "completed_unpaid" ? { message: "delivered, but the payment failed: the result is withheld" } : {}),
    },
    artifacts,
    metadata: {
      listing: task.listing.handle,
      buyer: task.buyerAccountId,
      payment: task.hold ? { state: task.hold.state, amount: task.hold.amount, asset: task.hold.asset, payTo: task.hold.payTo, settleTxHash: task.hold.settleTxHash } : null,
      unpaid: task.state === "completed_unpaid",
    },
  };
}

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number()]).nullable().optional(),
  method: z.string().max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});
const messageSchema = z.object({
  message: z.object({
    parts: z.array(z.object({ kind: z.string().optional(), text: z.string().optional() }).passthrough()).min(1).max(20),
  }).passthrough(),
}).passthrough();

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** The client's address: the socket's, or the proxy's header only when told to trust it. */
export function clientIp(context: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // The last hop added by our own proxy is the one it saw; earlier ones are the client's claim.
    const hops = context.req.header("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean) ?? [];
    if (hops.length) return hops[hops.length - 1]!;
  }
  const socket = (context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return socket?.remoteAddress ?? "unknown";
}

export function registerMarketPublicRoutes(app: Hono<any>, market: MarketService, options: { baseUrl: string; limiter: RateLimiter; syncWaitMs?: number; trustProxy?: boolean; maxWaiting?: number }) {
  let waiting = 0;
  const limited = async (context: Context, next: () => Promise<void>) => {
    const ip = clientIp(context, options.trustProxy ?? false);
    if (!options.limiter.allow(`market:${ip}`)) return context.json({ error: "rate_limited" }, 429);
    await next();
  };

  app.get("/v1/market/agents", limited, async (context) => {
    const query = context.req.query("q")?.slice(0, 80);
    const sort = context.req.query("sort");
    const agents = await market.catalog(query || undefined);
    if (sort === "price") agents.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1));
    else if (sort === "rating") agents.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    else agents.sort((a, b) => b.delivered - a.delivered);
    return context.json({ agents });
  });

  app.get("/.well-known/x402", limited, async (context) => context.json(await market.x402Recipients()));

  app.get("/a2a/:handle/.well-known/agent-card.json", limited, async (context) =>
    context.json(await market.agentCard(context.req.param("handle") ?? "", options.baseUrl)));

  app.post("/a2a/:handle/v1", limited, async (context) => {
    const raw = await context.req.json().catch(() => null);
    const parsed = rpcSchema.safeParse(raw);
    if (!parsed.success) return context.json(rpcError(null, -32600, "invalid JSON-RPC request"), 400);
    const { id, method, params } = parsed.data;
    const handle = context.req.param("handle") ?? "";
    try {
      if (method === "GetTask" || method === "tasks/get") {
        const taskId = z.string().uuid().safeParse(params?.id);
        if (!taskId.success) return context.json(rpcError(id, -32602, "params.id must be a task id"));
        const task = await market.task(taskId.data);
        if (task.listing.handle !== handle) return context.json(rpcError(id, -32001, "task not found"));
        return context.json({ jsonrpc: "2.0", id, result: a2aTask(task) });
      }
      if (method !== "SendMessage" && method !== "message/send") return context.json(rpcError(id, -32601, `unknown method ${method}`));
      const message = messageSchema.safeParse(params);
      if (!message.success) return context.json(rpcError(id, -32602, "params.message.parts is required"));
      const text = message.data.message.parts.map((part) => part.text ?? "").join("\n").trim();
      const outcome = await market.submit(handle, context.req.header("x-payment"), text);
      if ("paymentRequired" in outcome) return context.json(outcome.paymentRequired, 402);
      // Answer synchronously when the work is quick; otherwise the buyer polls GetTask.
      // Bounded: past `maxWaiting` open waits, answer at once.
      const wait = waiting < (options.maxWaiting ?? 50) ? options.syncWaitMs ?? 60_000 : 0;
      waiting += 1;
      try {
        const task = await market.waitFor(outcome.task.id, wait, 2_000);
        return context.json({ jsonrpc: "2.0", id, result: a2aTask(task) });
      } finally {
        waiting -= 1;
      }
    } catch (error) {
      if (error instanceof MarketError) {
        if (error.status === 404) return context.json(rpcError(id, -32001, error.message, { code: error.code }), 404);
        return context.json(rpcError(id, -32000, error.message, { code: error.code }), error.status);
      }
      throw error;
    }
  });
}

const deliverSchema = z.object({
  markdown: z.string().min(1),
  json: z.unknown().optional(),
  files: z.array(z.object({ name: z.string().max(200), url: z.string().url().max(2048), mediaType: z.string().max(100).optional() })).max(20).optional(),
});

export function registerMarketWorkerRoutes(app: Hono<any>, market: MarketService, limiter: RateLimiter) {
  const worker = async (context: Context) => {
    if (!limiter.allow(`market-worker:${context.req.header("authorization")?.slice(-12) ?? "none"}`)) throw new MarketError(503, "rate_limited", "slow down");
    return market.workerListing(context.req.header("authorization"));
  };
  const taskId = (context: Context) => {
    const parsed = z.string().uuid().safeParse(context.req.param("id"));
    if (!parsed.success) throw new MarketError(400, "invalid_task", "task id must be a uuid");
    return parsed.data;
  };
  const view = (task: Task) => ({ task: a2aTask(task), state: task.state });

  app.get("/v1/market/tasks/assigned", async (context) => {
    const listing = await worker(context);
    return context.json({ listing: listing.handle, tasks: await market.assigned(listing.id) });
  });
  app.post("/v1/market/tasks/:id/start", async (context) => {
    const listing = await worker(context);
    return context.json(view(await market.start(listing.id, taskId(context))));
  });
  app.post("/v1/market/tasks/:id/deliver", async (context) => {
    const listing = await worker(context);
    const body = deliverSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) throw new MarketError(400, "invalid_result", "markdown is required; json and files are optional");
    return context.json(view(await market.deliver(listing.id, taskId(context), body.data)));
  });
  app.post("/v1/market/tasks/:id/fail", async (context) => {
    const listing = await worker(context);
    const body = z.object({ reason: z.string().min(1).max(500) }).safeParse(await context.req.json().catch(() => null));
    if (!body.success) throw new MarketError(400, "invalid_reason", "reason is required");
    return context.json(view(await market.fail(listing.id, taskId(context), body.data.reason)));
  });
}

export const listingCreateSchema = z.object({
  handle: z.string().min(3).max(40),
  title: z.string().min(3).max(80),
  description: z.string().min(10).max(2000),
  category: z.string().max(40).optional(),
  price: z.string().regex(/^\d+(\.\d+)?$/),
  asset: z.enum(["USDC", "TestUSDC"]).optional(),
  slaSeconds: z.number().int().min(10).max(86_400).optional(),
  inputHint: z.string().max(500).optional(),
  outputHint: z.string().max(500).optional(),
  agentId: z.string().max(64).nullable().optional(),
  webhookUrl: z.string().url().max(2048).nullable().optional(),
});

export const listingUpdateSchema = listingCreateSchema.omit({ handle: true, asset: true, agentId: true }).partial().extend({
  status: z.enum(["draft", "live", "paused"]).optional(),
});
