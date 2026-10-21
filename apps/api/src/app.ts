import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import type { Env } from "./env.js";
import { Guard } from "./guard.js";
import { NearClient } from "./near.js";
import { BaseRelayer } from "./relayer.js";

const requestSchema = z.object({
  vaultAccountId: z.string().min(2),
  opId: z.array(z.number().int().min(0).max(255)).length(32),
});

const cancellationSchema = requestSchema.extend({
  gasLimit: z.string().regex(/^\d+$/),
  maxFeePerGas: z.string().regex(/^\d+$/),
  maxPriorityFeePerGas: z.string().regex(/^\d+$/),
});

export function createApp(
  env: Env,
  near: NearClient,
  guard: Guard,
  relayer: BaseRelayer,
): Hono {
  const app = new Hono();
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/v1/*", bearerAuth({ token: env.AGENT_API_TOKEN }));

  app.post("/v1/guard/visas", async (context) => {
    const input = requestSchema.parse(await context.req.json());
    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    const result = await guard.approve(operation);
    return context.json(result, result.decision === "approve" ? 200 : 409);
  });

  app.post("/v1/relayer/broadcast", async (context) => {
    const input = requestSchema.parse(await context.req.json());
    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    return context.json(await relayer.broadcastAndConfirm(input.vaultAccountId, operation));
  });

  app.post("/v1/emergency/cancel", async (context) => {
    const input = cancellationSchema.parse(await context.req.json());
    const operation = await near.getOperation(input.vaultAccountId, input.opId);
    if (operation.state !== "PossiblySigned") {
      return context.json({ error: "not_possibly_signed", state: operation.state }, 409);
    }
    const nearTransactionHash = await near.cancelNonce(
      input.vaultAccountId,
      input.opId,
      input.gasLimit,
      input.maxFeePerGas,
      input.maxPriorityFeePerGas,
    );
    return context.json({ nearTransactionHash, opId: input.opId });
  });

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return context.json({ error: "request_failed", message: error.message }, 500);
  });
  return app;
}
