/** Rob the Agent: public HTTP surface, /v1/rob/*. No account, no cookie: a rate limit per address. */
import type { Context, Hono } from "hono";
import { z } from "zod";

import { clientIp } from "../market/routes.js";
import type { RateLimiter } from "../rate-limit.js";
import { registerRobExtras } from "./extras.js";
import { RobError, type RobService } from "./service.js";

const signedSchema = z.object({ transaction: z.string().min(1).max(20_000), signature: z.string().min(1).max(200) }).strict();
const playSchema = z.object({ card: z.string().min(1).max(64), signed: signedSchema.optional() }).strict();
const forgeSchema = z.object({ method: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).default({}), signed: signedSchema.optional() }).strict();
const sessionSchema = z.object({ publicKey: z.string().min(1).max(100) }).strict();
const prepareSchema = z.object({
  publicKey: z.string().min(1).max(100),
  card: z.string().min(1).max(64).optional(),
  forge: z.object({ method: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).default({}) }).strict().optional(),
}).strict().refine((value) => Boolean(value.card) !== Boolean(value.forge), { message: "send either card or forge" });

export type RobLimiters = { session: RateLimiter; play: RateLimiter; read: RateLimiter };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRobRoutes(app: Hono<any>, rob: RobService, options: { limiters: RobLimiters; trustProxy: boolean; maxInFlight?: number }) {
  let inFlight = 0;
  const ipOf = (context: Context) => clientIp(context, options.trustProxy);
  const limit = (limiter: RateLimiter, name: string) => async (context: Context, next: () => Promise<void>) => {
    if (!limiter.allow(`rob:${name}:${ipOf(context)}`)) return context.json({ error: "rate_limited", message: "slow down: try again in a minute" }, 429);
    await next();
  };
  const body = async <T>(context: Context, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new RobError(400, "invalid_request", parsed.error.issues.map((issue) => issue.message).join("; "));
    return parsed.data;
  };
  // Each play waits for NEAR (about 3 seconds): cap how many run at once.
  const onChain = async <T>(work: () => Promise<T>): Promise<T> => {
    if (inFlight >= (options.maxInFlight ?? 40)) throw new RobError(503, "busy", "the vault is busy: try again in a few seconds");
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
    }
  };

  app.get("/v1/rob/cards", limit(options.limiters.read, "read"), (context) => context.json(rob.cards()));
  app.get("/v1/rob/stats", limit(options.limiters.read, "read"), async (context) => {
    context.header("cache-control", "public, max-age=10");
    return context.json(await rob.stats());
  });
  app.post("/v1/rob/session", limit(options.limiters.session, "session"), async (context) => {
    const { publicKey } = await body(context, sessionSchema);
    return context.json(await onChain(() => rob.session(publicKey, rob.clientHash(ipOf(context)))));
  });
  app.post("/v1/rob/prepare", limit(options.limiters.play, "play"), async (context) => {
    const input = await body(context, prepareSchema);
    return context.json(await rob.prepare({ publicKey: input.publicKey, ...(input.card ? { card: input.card } : {}), ...(input.forge ? { forge: input.forge } : {}) }));
  });
  app.post("/v1/rob/play", limit(options.limiters.play, "play"), async (context) => {
    const input = await body(context, playSchema);
    return context.json(await onChain(() => rob.play({ card: input.card, ...(input.signed ? { signed: input.signed } : {}), clientHash: rob.clientHash(ipOf(context)) })));
  });
  app.post("/v1/rob/forge", limit(options.limiters.play, "play"), async (context) => {
    const input = await body(context, forgeSchema);
    return context.json(await onChain(() => rob.forge({ method: input.method, args: input.args, ...(input.signed ? { signed: input.signed } : {}), clientHash: rob.clientHash(ipOf(context)) })));
  });

  registerRobExtras(app, { rob, limiters: options.limiters, trustProxy: options.trustProxy });
}
