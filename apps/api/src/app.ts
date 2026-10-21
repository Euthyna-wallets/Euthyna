import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AgentIdentity, AuthGateway, ConsoleIdentity } from "./auth-gateway.js";
import type { Guard } from "./guard.js";
import type { NearClient } from "./near.js";
import { MemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import { TreasuryError, type TreasuryGateway } from "./treasury.js";
import { RegistryError, type RegistryService } from "./registry-db.js";
import { PaymentError, type PaymentService } from "./payments.js";
import type { ConsoleDataService } from "./console-data.js";
import type { MandateGateway } from "./mandates.js";
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

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as `0x${string}`);

const opIdSchema = z.object({ opId: z.array(z.number().int().min(0).max(255)).length(32) });

const supplierSchema = z.object({
  name: z.string().min(1).max(120),
  contact: z.string().max(200).optional(),
  chainId: z.number().int().positive().default(84532),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const walletSchema = z.object({
  chainId: z.number().int().positive().default(84532),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const contractUpdateSchema = z.object({
  maxAmount: z.string().regex(/^\d+$/).optional(),
  periodicity: z.enum(["monthly", "quarterly", "annual", "one_off"]).optional(),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  role: z.string().min(1).max(80).optional(),
});

const contractSchema = z.object({
  reference: z.string().min(1).max(120),
  role: z.string().min(1).max(80),
  supplierId: z.string().uuid(),
  maxAmount: z.string().regex(/^\d+$/),
  periodicity: z.enum(["monthly", "quarterly", "annual", "one_off"]),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const mandateSchema = z.object({
  role: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  operations: z.array(z.enum(["pay", "swap", "bridge"])).min(1),
  maxPerTx: z.string().regex(/^\d+$/),
  budget: z.string().regex(/^\d+$/),
  periodDays: z.number().int().min(1).max(365),
  recipients: z.array(addressSchema).min(1),
  token: addressSchema,
  gas: z.object({
    gasLimit: z.string().regex(/^\d+$/),
    maxFeePerGas: z.string().regex(/^\d+$/),
    maxPriorityFeePerGas: z.string().regex(/^\d+$/),
    maxTotalFee: z.string().regex(/^\d+$/),
  }),
  agent: z
    .object({
      nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
      mpcPath: z.string().min(1).max(200),
      evmAddress: addressSchema.optional(),
    })
    .optional(),
});

const walletsSchema = z.object({
  nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  evmAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const treasuryPlanSchema = z.object({
  environment: z.string().min(1).default("uat"),
  daoName: z.string().min(2).max(40),
  founderNearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
});

const treasuryRegisterSchema = z.object({
  environment: z.string().min(1).default("uat"),
  daoAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  vaultAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  relayAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  rolesAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  delayAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  govAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});


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
  treasury: TreasuryGateway;
  mandates: MandateGateway;
  registry: RegistryService;
  payments: PaymentService;
  consoleData: ConsoleDataService;
  consoleOrigin: string;
  nearParentAccount: string;
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

function requireConsoleRequest(consoleOrigin: string) {
  return async (context: AppContext, next: Next) => {
    if (context.req.method === "OPTIONS") {
      await next();
      return;
    }
    if (context.req.header("origin") !== consoleOrigin) {
      throw new HTTPException(403, { message: "origin not allowed" });
    }
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      const contentType = (context.req.header("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        throw new HTTPException(415, { message: "application/json required" });
      }
    }
    await next();
  };
}

async function parseJsonPublic<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  return parsed.data;
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

export function createApp({
  near,
  guard,
  relayer,
  auth,
  treasury,
  mandates,
  registry: registryService,
  payments,
  consoleData,
  consoleOrigin,
  nearParentAccount,
}: AppDependencies): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const agentLimiter = new MemoryRateLimiter(120, 60_000);
  const consoleLimiter = new MemoryRateLimiter(600, 60_000);
  app.use(
    "*",
    cors({
      origin: consoleOrigin,
      credentials: true,
      allowHeaders: ["content-type", "x-api-key"],
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    }),
  );
  app.use("/v1/console/*", requireConsoleRequest(consoleOrigin));
  app.use("/v1/emergency/*", requireConsoleRequest(consoleOrigin));
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", (context) => {
    const path = context.req.path;
    if (path.endsWith("/sign-up/email") || path.endsWith("/sign-in/email")) {
      return context.json({ error: "not_found" }, 404);
    }
    return auth.handler(context.req.raw);
  });

  app.post("/api/register/passkey-start", async (context) => {
    const input = await parseJsonPublic(context, z.object({
      email: z.string().email(),
      name: z.string().min(1).max(120),
      nearPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/).optional(),
    }));
    const url = new URL(context.req.url);
    const response = await auth.registerPasswordless(`${url.protocol}//${url.host}`, consoleOrigin, input);
    if (!response.ok || !input.nearPublicKey) return response;
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const relayer = nearParentAccount;
    if (/^[0-9a-f]{64}$/.test(relayer)) {
      return context.json({ error: "relayer_must_be_named", message: "set a named NEAR relayer account to create wallets" }, 500);
    }
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const nearAccountId = `w-${suffix}.${relayer}`;
    if (nearAccountId.length > 64) {
      return context.json({ error: "near_account_too_long" }, 500);
    }
    await near.createSubaccount(nearAccountId, input.nearPublicKey, "1000000000000000000000000");
    return new Response(JSON.stringify({ ...payload, nearAccountId }), {
      status: response.status,
      headers: response.headers,
    });
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

  app.patch("/v1/console/members/me/wallets", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, walletsSchema);
    await treasury.linkWallets(consoleIdentity.organizationId, consoleIdentity.userId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "member.wallets_linked",
      metadata: { nearAccountId: input.nearAccountId, evmAddress: input.evmAddress },
    });
    return context.json({ nearAccountId: input.nearAccountId, evmAddress: input.evmAddress });
  });

  app.post("/v1/operations/pay", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const input = await parseJson(context, opIdSchema);
    const result = await payments.pay(agent.organizationId, agent, input.opId);
    return context.json(result.body, result.status);
  });

  app.get("/v1/operations/:opId", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const raw = context.req.param("opId") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HTTPException(400, { message: "invalid opId" });
    const opId = Array.from(Buffer.from(raw.slice(2), "hex"));
    return context.json(await payments.getOperation(agent.organizationId, agent.agentId, opId));
  });

  app.get("/v1/console/overview", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json(await consoleData.overview(consoleIdentity.organizationId));
  });

  app.get("/v1/console/operations", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ operations: await consoleData.operations(consoleIdentity.organizationId) });
  });

  app.get("/v1/console/operations/:opId", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const raw = context.req.param("opId") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HTTPException(400, { message: "invalid opId" });
    const result = await consoleData.operation(consoleIdentity.organizationId, raw);
    if (!result) return context.json({ error: "operation_not_found" }, 404);
    return context.json(result);
  });

  app.get("/v1/console/agents/:id/detail", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const result = await consoleData.agentDetail(consoleIdentity.organizationId, id);
    if (!result) return context.json({ error: "agent_not_found" }, 404);
    return context.json(result);
  });

  app.get("/v1/console/governance", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json(await consoleData.governance(consoleIdentity.organizationId));
  });

  app.get("/v1/console/registry", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json(await registryService.list(consoleIdentity.organizationId));
  });

  app.post("/v1/console/suppliers", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, supplierSchema);
    const change = await registryService.requestSupplier(consoleIdentity.organizationId, consoleIdentity.userId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "registry.supplier.requested",
      targetType: "registry_change",
      targetId: change.id,
    });
    return context.json(change, 202);
  });

  app.post("/v1/console/suppliers/:id/wallets", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const input = await parseJson(context, walletSchema);
    const change = await registryService.requestWallet(consoleIdentity.organizationId, consoleIdentity.userId, {
      supplierId: id,
      ...input,
    });
    return context.json(change, 202);
  });

  app.post("/v1/console/registry-changes/:id/decision", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const input = await parseJson(context, z.object({ decision: z.enum(["approve", "reject"]) }));
    const result = await registryService.decideChange(
      consoleIdentity.organizationId,
      consoleIdentity.userId,
      id,
      input.decision,
    );
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: `registry.${input.decision}`,
      targetType: "registry_change",
      targetId: id,
    });
    return context.json(result);
  });

  app.post("/v1/console/contracts", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, contractSchema);
    const change = await registryService.requestContract(consoleIdentity.organizationId, consoleIdentity.userId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "registry.contract.requested",
      targetType: "registry_change",
      targetId: change.id,
    });
    return context.json(change, 202);
  });

  app.patch("/v1/console/contracts/:id", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const input = await parseJson(context, contractUpdateSchema);
    const change = await registryService.requestContractUpdate(consoleIdentity.organizationId, consoleIdentity.userId, {
      contractId: id,
      ...input,
    });
    return context.json(change, 202);
  });

  app.get("/v1/console/escalations", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ escalations: await payments.listEscalations(consoleIdentity.organizationId) });
  });

  app.post("/v1/console/escalations/:id/decision", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const input = await parseJson(context, z.object({ decision: z.enum(["approve", "reject"]) }));
    const result = await payments.decideEscalation(
      consoleIdentity.organizationId,
      consoleIdentity.userId,
      id,
      input.decision,
    );
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: input.decision === "approve" ? "escalation.approved" : "escalation.rejected",
      targetType: "escalation",
      targetId: id,
    });
    return context.json(result);
  });

  app.post("/v1/console/mandates/preview", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, mandateSchema);
    const preview = await mandates.preview(consoleIdentity.organizationId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "mandate.previewed",
      targetType: "role",
      targetId: input.role,
    });
    return context.json(preview);
  });

  app.get("/v1/console/treasury", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const environment = context.req.query("environment") ?? "uat";
    return context.json({ treasury: await treasury.getTreasury(consoleIdentity.organizationId, environment) });
  });

  app.post("/v1/console/treasury/plan", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, treasuryPlanSchema);
    return context.json(await treasury.plan(consoleIdentity.organizationId, input));
  });

  app.post("/v1/console/treasury/refresh", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(
      context,
      z.object({ environment: z.string().min(1).default("uat") }),
    );
    const refreshed = await treasury.refresh(
      consoleIdentity.organizationId,
      consoleIdentity.userId,
      input.environment,
    );
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "treasury.refresh.requested",
      targetType: "treasury",
      metadata: { environment: input.environment, status: refreshed.status },
    });
    return context.json(refreshed);
  });

  app.post("/v1/console/treasury/create-dao", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, treasuryPlanSchema);
    const created = await treasury.createDao(consoleIdentity.organizationId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "treasury.dao_created",
      metadata: created,
    });
    return context.json(created);
  });

  app.post("/v1/console/treasury/deploy-contracts", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, treasuryPlanSchema);
    const deployed = await treasury.deployContracts(consoleIdentity.organizationId, input);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "treasury.contracts_deployed",
      metadata: deployed,
    });
    return context.json(deployed);
  });

  app.post("/v1/console/treasury/register", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, treasuryRegisterSchema);
    const registered = await treasury.register(consoleIdentity.organizationId, consoleIdentity.userId, input);
    return context.json(registered, 201);
  });

  app.get("/v1/console/members", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ members: await auth.listMembers(consoleIdentity.organizationId) });
  });

  app.get("/v1/console/agents/:id", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const parsedId = agentIdSchema.safeParse(context.req.param());
    if (!parsedId.success) throw new HTTPException(400, { message: parsedId.error.message });
    const agent = await auth.getAgent(consoleIdentity.organizationId, parsedId.data.id);
    if (!agent) return context.json({ error: "agent_not_found" }, 404);
    const currentTreasury = await treasury.getTreasury(consoleIdentity.organizationId, "uat");
    let onChain: unknown = { status: "no_treasury" };
    if (currentTreasury) {
      try {
        onChain = {
          status: "ok",
          agent: await near.viewFunction<unknown>(currentTreasury.vaultAccountId, "get_agent", {
            agent: agent.nearAccountId,
          }),
          nextEvmNonce: await near.viewFunction<number>(currentTreasury.vaultAccountId, "next_evm_nonce", {
            agent: agent.nearAccountId,
          }),
        };
      } catch (cause) {
        onChain = { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    return context.json({ agent, onChain, treasury: currentTreasury });
  });

  app.get("/v1/console/agents", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ agents: await auth.listAgents(consoleIdentity.organizationId) });
  });

  app.post("/v1/console/agents", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const currentTreasury = await treasury.getTreasury(consoleIdentity.organizationId, "uat");
    if (!currentTreasury || currentTreasury.status !== "active") {
      return context.json(
        { error: "treasury_not_active", status: currentTreasury?.status ?? "missing" },
        409,
      );
    }
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

  app.post("/v1/console/agents/:id/pause-proposal", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().parse(context.req.param("id"));
    const agent = await auth.getAgent(consoleIdentity.organizationId, id);
    if (!agent) return context.json({ error: "agent_not_found" }, 404);
    const currentTreasury = await treasury.getTreasury(consoleIdentity.organizationId, "uat");
    if (!currentTreasury) return context.json({ error: "treasury_missing" }, 409);
    return context.json({
      receiverId: currentTreasury.daoAccountId,
      methodName: "add_proposal",
      deposit: "100000000000000000000000",
      args: {
        proposal: {
          description: `Pause Vault after agent ${agent.name} incident`,
          kind: {
            FunctionCall: {
              receiver_id: currentTreasury.vaultAccountId,
              actions: [{ method_name: "pause", args: "", gas: "50000000000000", deposit: "0" }],
            },
          },
        },
      },
    });
  });

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof TreasuryError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof RegistryError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof PaymentError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    console.error(error);
    return context.json({ error: "request_failed", message: error.message }, 500);
  });
  return app;
}
