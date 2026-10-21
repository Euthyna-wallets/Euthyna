import { Hono, type Context, type Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AgentIdentity, AuthGateway, ConsoleIdentity } from "./auth-gateway.js";
import type { Guard } from "./guard.js";
import type { NearClient } from "./near.js";
import { MemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import type { BaseRelayer } from "./relayer.js";

const requestSchema = z.object({
  vaultAccountId: z.string().min(2),
  opId: z.array(z.number().int().min(0).max(255)).length(32),
});

const cancellationSchema = requestSchema.extend({
  gasLimit: z.string().regex(/^\d+$/),
  maxFeePerGas: z.string().regex(/^\d+$/),
  maxPriorityFeePerGas: z.string().regex(/^\d+$/),
});

const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
  nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  nearPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
  vaultAccountId: z.string().min(2).max(64),
  mpcPath: z.string().min(1).max(200),
});

const agentIdSchema = z.object({ id: z.string().uuid() });

interface AppVariables {
  agent: AgentIdentity;
  console: ConsoleIdentity;
}

type AppContext = Context<{ Variables: AppVariables }>;

export interface AppDependencies {
  near: NearClient;
  guard: Guard;
  relayer: BaseRelayer;
  auth: AuthGateway;
}

function isAdmin(identity: ConsoleIdentity): boolean {
  return identity.role === "admin" || identity.role === "owner";
}

function requireAgent(auth: AuthGateway, limiter: RateLimiter) {
  return async (context: AppContext, next: Next) => {
    const identity = await auth.identifyAgent(context.req.header("x-api-key"));
    if (!identity) throw new HTTPException(401, { message: "unauthorized" });
    if (!limiter.allow(`agent:${identity.agentId}`)) {
      throw new HTTPException(429, { message: "rate limit exceeded" });
    }
    context.set("agent", identity);
    await next();
  };
}

function requireConsole(auth: AuthGateway, limiter: RateLimiter) {
  return async (context: AppContext, next: Next) => {
    const identity = await auth.identifyConsole(context.req.raw.headers);
    if (!identity) throw new HTTPException(401, { message: "unauthorized" });
    if (!limiter.allow(`organization:${identity.organizationId}`)) {
      throw new HTTPException(429, { message: "rate limit exceeded" });
    }
    context.set("console", identity);
    await next();
  };
}

function requireConsoleAdmin(auth: AuthGateway, limiter: RateLimiter) {
  const authenticate = requireConsole(auth, limiter);
  return async (context: AppContext, next: Next) => {
    await authenticate(context, async () => {
      if (!isAdmin(context.get("console"))) {
        throw new HTTPException(403, { message: "admin required" });
      }
      await next();
    });
  };
}

async function parseJson<T>(context: AppContext, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.message });
  }
  return parsed.data;
}

export function createApp({ near, guard, relayer, auth }: AppDependencies): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const agentLimiter = new MemoryRateLimiter(120, 60_000);
  const consoleLimiter = new MemoryRateLimiter(600, 60_000);
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", (context) => auth.handler(context.req.raw));

  app.post("/v1/guard/visas", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const input = await parseJson(context, requestSchema);
    if (input.vaultAccountId !== agent.vaultAccountId) {
      await auth.recordAudit({
        organizationId: agent.organizationId,
        actorType: "agent",
        actorId: agent.agentId,
        action: "guard.visa.denied",
        targetType: "operation",
        targetId: Buffer.from(input.opId).toString("hex"),
        metadata: { reason: "vault_not_owned_by_agent" },
      });
      return context.json({ error: "vault_not_owned_by_agent" }, 403);
    }

    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    if (operation.agent !== agent.nearAccountId) {
      await auth.recordAudit({
        organizationId: agent.organizationId,
        actorType: "agent",
        actorId: agent.agentId,
        action: "guard.visa.denied",
        targetType: "operation",
        targetId: Buffer.from(input.opId).toString("hex"),
        metadata: { reason: "agent_mismatch", operationAgent: operation.agent },
      });
      return context.json({ error: "agent_mismatch" }, 403);
    }

    const result = await guard.approve(operation);
    await auth.recordAudit({
      organizationId: agent.organizationId,
      actorType: "agent",
      actorId: agent.agentId,
      action: result.decision === "approve" ? "guard.visa.issued" : "guard.escalation",
      targetType: "operation",
      targetId: Buffer.from(input.opId).toString("hex"),
      metadata:
        result.decision === "approve"
          ? { vendorId: result.vendorId, reference: operation.intent.reference }
          : { reasons: result.reasons },
    });
    return context.json(result, result.decision === "approve" ? 200 : 409);
  });

  app.post("/v1/relayer/broadcast", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const input = await parseJson(context, requestSchema);
    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    return context.json(await relayer.broadcastAndConfirm(input.vaultAccountId, operation));
  });

  app.post("/v1/emergency/cancel", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, cancellationSchema);
    const opIdHex = Buffer.from(input.opId).toString("hex");
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "emergency.cancel.requested",
      targetType: "operation",
      targetId: opIdHex,
      metadata: { vaultAccountId: input.vaultAccountId },
    });
    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    if (operation.state !== "PossiblySigned") {
      await auth.recordAudit({
        organizationId: consoleIdentity.organizationId,
        actorType: "console",
        actorId: consoleIdentity.userId,
        action: "emergency.cancel.rejected",
        targetType: "operation",
        targetId: opIdHex,
        metadata: { state: operation.state },
      });
      return context.json({ error: "not_possibly_signed", state: operation.state }, 409);
    }
    const nearTransactionHash = await near.cancelNonce(
      input.vaultAccountId,
      input.opId,
      input.gasLimit,
      input.maxFeePerGas,
      input.maxPriorityFeePerGas,
    );
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "emergency.cancel.submitted",
      targetType: "operation",
      targetId: opIdHex,
      metadata: { nearTransactionHash },
    });
    return context.json({ nearTransactionHash, opId: input.opId });
  });

  app.get("/v1/console/agents", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ agents: await auth.listAgents(consoleIdentity.organizationId) });
  });

  app.post("/v1/console/agents", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, createAgentSchema);
    const created = await auth.createAgent({
      organizationId: consoleIdentity.organizationId,
      ...input,
    });
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "agent.created",
      targetType: "agent",
      targetId: created.agent.id,
      metadata: {
        nearAccountId: created.agent.nearAccountId,
        role: created.agent.role,
      },
    });
    return context.json(created, 201);
  });

  app.post("/v1/console/agents/:id/revoke", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const parsedId = agentIdSchema.safeParse(context.req.param());
    if (!parsedId.success) throw new HTTPException(400, { message: parsedId.error.message });
    const revoked = await auth.revokeAgent(consoleIdentity.organizationId, parsedId.data.id);
    if (!revoked) return context.json({ error: "agent_not_found" }, 404);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "agent.revoked",
      targetType: "agent",
      targetId: parsedId.data.id,
    });
    return context.json({ agentId: parsedId.data.id, active: false });
  });

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return context.json({ error: "request_failed", message: error.message }, 500);
  });
  return app;
}
