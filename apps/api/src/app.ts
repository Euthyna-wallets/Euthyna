import { checkInvoice } from "./payments.js";
import type { RoleDraft } from "@euthyna/sdk/roles";
import { OmniRolesError, type OmniRolesService } from "./omniroles.js";
import { listingCreateSchema, listingUpdateSchema, registerMarketPublicRoutes, registerMarketWorkerRoutes } from "./market/routes.js";
import { registerRobRoutes } from "./rob/routes.js";
import { RobError, type RobService } from "./rob/service.js";
import { MarketError, type MarketService } from "./market/service.js";
import { CardError, createCard } from "./cards.js";
import { RecoveryError, type RecoveryService } from "./recovery/service.js";
import { BankError, type BankService } from "./bank/service.js";
import { verifyNoahWebhook, type InvoiceService } from "./bank/invoices.js";
import { cardAccountIdOf } from "@euthyna/sdk";

import { proposedAgentAccountId } from "@euthyna/sdk";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { AgentProvisioningError, type AgentProvisioningService } from "./agent-provisioning.js";
import type { AgentIdentity, AuthGateway, ConsoleIdentity } from "./auth-gateway.js";
import type { NearClient } from "./near.js";
import { MemoryRateLimiter, type RateLimiter } from "./rate-limit.js";
import { RegistryError, type RegistryService } from "./registry-db.js";
import { PaymentError, type PaymentService } from "./payments.js";
import { PAIRING_TTL_MS, newPairingCode, pairingCodeHash, type PairingRecord, type PairingStore } from "./pairings.js";

const requestSchema = z.object({
  vaultAccountId: z.string().min(2),
  opId: z.array(z.number().int().min(0).max(255)).length(32),
});

const cancellationSchema = requestSchema;

const createAgentSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
  nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/).optional(),
  nearPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
  vaultAccountId: z.string().min(2).max(64),
  mpcPath: z.string().min(1).max(200),
});

const agentIdSchema = z.object({ id: z.string().uuid() });

const agentRoleSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/, "role: lowercase letters, digits, - or _, up to 32 characters");
const createPairingSchema = z.object({
  name: z.string().min(1).max(80),
  role: agentRoleSchema,
  vaultAccountId: z.string().min(2).max(64),
});
const redeemPairingSchema = z.object({
  code: z.string().min(10).max(64),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/),
  hostname: z.string().max(64).transform((value) => value.replace(/[^\w.-]/g, "").slice(0, 64)).default(""),
});

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as `0x${string}`);

const opIdSchema = z.object({
  opId: z.array(z.number().int().min(0).max(255)).length(32),
  invoice: z.object({
    text: z.string().max(10_000).optional(),
    claimedRecipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  }).optional(),
});
const authorizationSchema = z.object({
  nearTransactionHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
});

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

const paymentGasQuoteSchema = z.object({
  token: addressSchema,
  recipient: addressSchema,
  amount: z.string().regex(/^[1-9]\d*$/),
});
const nearRpcProxySchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.enum(["query", "block", "send_tx", "broadcast_tx_commit", "tx", "EXPERIMENTAL_tx_status"]),
  params: z.unknown(),
});

interface AppVariables {
  agent: AgentIdentity;
  console: ConsoleIdentity;
}
type AppContext = Context<{ Variables: AppVariables }>;

/** The company treasury (DAO + vault) as the agent routes need it. */
export interface TreasuryLookup {
  activeTreasury(organizationId: string): Promise<{ status: string; daoAccountId: string; vaultAccountId: string } | null>;
}

export interface AppDependencies {
  near: NearClient;
  auth: AuthGateway;
  agentProvisioning: AgentProvisioningService;
  treasuries: TreasuryLookup;
  registry: RegistryService;
  payments: PaymentService;
  consoleOrigin: string;
  nearParentAccount: string;
  pairings: PairingStore;
  omniroles?: OmniRolesService;
  /** Euthyna Market gateway; absent when not configured. */
  market?: MarketService | undefined;
  /** Rob the Agent, the public game (only when its accounts are configured). */
  rob?: RobService | undefined;
  /** Public base URL of this API, used in A2A agent cards. */
  publicBaseUrl?: string;
  /** Trust the reverse proxy's X-Forwarded-For for market rate limits. */
  marketTrustProxy?: boolean;
  /** Founder seat recovery with ZK Email; absent when not configured. */
  recovery?: RecoveryService | undefined;
  /** The company's euro account (Noah); absent when not configured. */
  bank?: BankService | undefined;
  invoices?: InvoiceService | undefined;
  /** Noah's webhook public key (sandbox or production): their FiatDeposit events are verified with it. */
  noahWebhookKey?: string | undefined;
}

/** A role draft from the console's role editor (`/proposals/role`). */
export const roleDraftSchema = z.object({
  draft: z.object({
    guardRequired: z.boolean().optional(),
    suppliersOnly: z.boolean().optional(),
    name: z.string(),
    blocks: z.array(z.union([
      z.object({
        kind: z.literal("payments"),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        recipients: z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), label: z.string().max(80) })).max(20),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
      }),
      z.object({
        kind: z.literal("swap"),
        tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        tokensOut: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(10),
        protocols: z.array(z.enum(["uniswap-v3", "uniswap-v2"])).min(1),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
        maxApproval: z.string().regex(/^\d+(\.\d+)?$/),
        /** contracts/sealed-orders joins the role (the "Allow sealed orders" box). */
        sealedOrders: z.boolean().optional(),
      }),
      z.object({
        kind: z.literal("lending"),
        protocol: z.literal("aave-v3"),
        token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
        maxApproval: z.string().regex(/^\d+(\.\d+)?$/),
      }),
      z.object({
        kind: z.literal("solana-transfer"),
        token: z.enum(["USDC"]).nullable(),
        recipients: z.array(z.object({ address: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/), label: z.string().max(80) })).min(1).max(32),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
      }),
      z.object({
        kind: z.literal("near-transfer"),
        token: z.enum(["USDC", "TestUSDC"]),
        receivers: z.array(z.object({ accountId: z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64), label: z.string().max(80) })).min(1).max(32),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
        maxPerTransfer: z.string().regex(/^\d+(\.\d+)?$/),
        minPerTransfer: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      }),
      z.object({
        kind: z.literal("wrap"),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
      }),
      z.object({
        kind: z.literal("share-revenue"),
        sharesAccountId: z.string().regex(/^[a-z0-9._-]{2,64}$/),
        budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
      }),
    ])).min(1).max(10),
    members: z.array(z.object({
      accountId: z.string().min(2).max(64),
      kind: z.enum(["Agent", "Human"]),
      maxUses: z.number().int().positive().nullable().optional(),
    })).max(20),
    // Editing a role: budgets left as they are, members removed, Solana rights cleared.
    keepBudgets: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(32).optional(),
    revokeMembers: z.array(z.string().min(2).max(64)).max(20).optional(),
    clearSolanaPermissions: z.boolean().optional(),
  }),
});

function isAdmin(identity: ConsoleIdentity): boolean {
  return identity.role === "admin" || identity.role === "owner";
}

/**
 * Any council member may hire: hiring grants nothing, an agent acts only once a
 * role is voted. To bound the NEAR accounts our relayer pays for, a member may
 * have this many hires without a role at a time; admins are not capped.
 */
export const MAX_PENDING_HIRES_PER_MEMBER = 5;

/** Members manage only the agents they hired; admins manage all. */
function canManageAgent(identity: ConsoleIdentity, agent: { createdByUserId: string | null }): boolean {
  return isAdmin(identity) || agent.createdByUserId === identity.userId;
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
    // Browsers omit Origin on same-origin GETs (console and API behind one host);
    // Sec-Fetch-Site is browser-set and cannot be forged by a cross-site page.
    const origin = context.req.header("origin");
    const sameOrigin = origin === undefined && context.req.header("sec-fetch-site") === "same-origin";
    if (origin !== consoleOrigin && !sameOrigin) {
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

async function parseJson<T>(context: AppContext, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // A readable message: the console shows body.message, a raw zod issue list shows nothing.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "body"}: ${issue.message}`)
      .join("; ");
    throw new HTTPException(400, { message: `invalid request, ${detail}` });
  }
  return parsed.data;
}

export function createApp({
  near,
  auth,
  agentProvisioning,
  treasuries,
  registry: registryService,
  payments,
  consoleOrigin,
  nearParentAccount,
  pairings,
  omniroles,
  market,
  rob,
  publicBaseUrl,
  marketTrustProxy,
  recovery,
  bank,
  invoices,
  noahWebhookKey,
}: AppDependencies): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const agentLimiter = new MemoryRateLimiter(120, 60_000);
  const consoleLimiter = new MemoryRateLimiter(600, 60_000);
  const agentProvisionLimiter = new MemoryRateLimiter(10, 60 * 60_000);
  const pairingLimiter = new MemoryRateLimiter(20, 60_000);
  const networkId = nearParentAccount.endsWith(".testnet") ? "testnet" : "mainnet";

  /** Active agents this member hired that hold no voted role yet; null when the vault cannot be read. */
  async function pendingHiresOf(organizationId: string, userId: string): Promise<number | null> {
    const mine = (await auth.listAgents(organizationId)).filter((agent) => agent.active && agent.createdByUserId === userId);
    if (mine.length === 0) return 0;
    if (!omniroles) return mine.length;
    try {
      const { roles } = await omniroles.roles(organizationId);
      const withRole = new Set(roles.flatMap((role) => role.members.map((member) => member.member)));
      return mine.filter((agent) => !withRole.has(agent.nearAccountId)).length;
    } catch {
      return null;
    }
  }

  /** Why this console user may not hire now, or null. Open pairing codes count as hires. */
  async function hiringRefusal(identity: ConsoleIdentity): Promise<{ status: 409 | 503; body: Record<string, unknown> } | null> {
    const currentTreasury = await treasuries.activeTreasury(identity.organizationId);
    if (!currentTreasury || currentTreasury.status !== "active") {
      return { status: 409, body: { error: "treasury_not_active", status: currentTreasury?.status ?? "missing" } };
    }
    if (isAdmin(identity)) return null;
    const pending = await pendingHiresOf(identity.organizationId, identity.userId);
    if (pending === null) {
      return { status: 503, body: { error: "roles_unavailable", message: "Could not read the vault's roles; try again." } };
    }
    const open = await pairings.countOpen(identity.organizationId, identity.userId, new Date());
    if (pending + open >= MAX_PENDING_HIRES_PER_MEMBER) {
      return {
        status: 409,
        body: {
          error: "too_many_pending_hires",
          message: `You already have ${pending + open} hired agents without a voted role (limit ${MAX_PENDING_HIRES_PER_MEMBER}). Give them a role or revoke some first.`,
          limit: MAX_PENDING_HIRES_PER_MEMBER,
        },
      };
    }
    return null;
  }

  function pairingView(pairing: PairingRecord) {
    const status = pairing.agentId ? "paired" : pairing.redeemedAt ? "pairing" : pairing.expiresAt <= new Date() ? "expired" : "waiting";
    return {
      pairingId: pairing.id,
      status,
      name: pairing.name,
      role: pairing.role,
      accountId: pairing.nearAccountId,
      vaultAccountId: pairing.vaultAccountId,
      expiresAt: pairing.expiresAt.toISOString(),
      agentId: pairing.agentId,
      publicKey: pairing.publicKey,
      hostname: pairing.hostname,
    };
  }
  // The market is public: any origin, no cookies. Everything else: the console only.
  const publicCors = cors({ origin: "*", allowHeaders: ["content-type", "x-payment", "authorization"], allowMethods: ["GET", "POST", "OPTIONS"], exposeHeaders: ["x-payment-response"] });
  const consoleCors = cors({
    origin: consoleOrigin,
    credentials: true,
    allowHeaders: ["content-type", "x-api-key"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  const isPublicMarket = (path: string) => path.startsWith("/a2a/") || path.startsWith("/v1/market/") || path === "/.well-known/x402";
  app.use("*", (context, next) => (isPublicMarket(context.req.path) ? publicCors(context, next) : consoleCors(context, next)));
  app.use("/v1/console/*", requireConsoleRequest(consoleOrigin));
  app.use("/v1/emergency/*", requireConsoleRequest(consoleOrigin));
  app.use("/v1/recovery/*", requireConsoleRequest(consoleOrigin));
  app.get("/health", (context) => context.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", async (context) => {
    const path = context.req.path;
    if (path.endsWith("/sign-up/email") || path.endsWith("/sign-in/email")) {
      return context.json({ error: "not_found" }, 404);
    }
    // Members are the NEAR accounts of the DAO: no Better Auth invitations or member edits.
    if (/\/organization\/(invite-member|accept-invitation|reject-invitation|cancel-invitation|add-member|remove-member|update-member-role|leave)$/.test(path)) {
      return context.json({ error: "members_follow_the_dao" }, 403);
    }
    return auth.handler(context.req.raw);
  });
  app.post("/v1/console/near-rpc", requireConsole(auth, consoleLimiter), async (context) => {
    const input = await parseJson(context, nearRpcProxySchema);
    try {
      const result = await near.proxyRpc(input.method, input.params);
      return context.json({ jsonrpc: "2.0" as const, id: input.id, result });
    } catch (error) {
      return context.json({
        jsonrpc: "2.0" as const,
        id: input.id,
        error: {
          code: -32_000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
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

  app.post("/v1/operations/pay", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const input = await parseJson(context, opIdSchema);
    const result = await payments.pay(agent.organizationId, agent, input.opId, input.invoice);
    return context.json(result.body, result.status);
  });
  app.post("/v1/operations/gas-quote", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const input = await parseJson(context, paymentGasQuoteSchema);
    return context.json(await payments.gasQuote(agent.organizationId, agent, input));
  });

  app.post("/v1/operations/:opId/authorization", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const raw = context.req.param("opId") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HTTPException(400, { message: "invalid opId" });
    const opId = Array.from(Buffer.from(raw.slice(2), "hex"));
    const input = await parseJson(context, authorizationSchema);
    return context.json(await payments.recordAuthorization(
      agent.organizationId,
      agent,
      opId,
      input.nearTransactionHash,
    ));
  });

  app.post("/v1/operations/:opId/cancellation", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const raw = context.req.param("opId") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HTTPException(400, { message: "invalid opId" });
    const opId = Array.from(Buffer.from(raw.slice(2), "hex"));
    const input = await parseJson(context, authorizationSchema);
    return context.json(await payments.recordCancellation(
      agent.organizationId,
      agent,
      opId,
      input.nearTransactionHash,
    ));
  });

  app.get("/v1/operations/:opId", requireAgent(auth, agentLimiter), async (context) => {
    const agent = context.get("agent");
    const raw = context.req.param("opId") ?? "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new HTTPException(400, { message: "invalid opId" });
    const opId = Array.from(Buffer.from(raw.slice(2), "hex"));
    return context.json(await payments.getOperation(agent.organizationId, agent.agentId, opId));
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

  /** The NEAR account an agent of this name will get: euthyna-signer creates its key for it before hiring. */
  /** The agent if this console user may manage it, else an HTTP error. */
  async function managedAgent(context: AppContext, agentId: string) {
    const identity = context.get("console");
    const agent = await auth.getAgent(identity.organizationId, agentId);
    if (!agent) throw new HTTPException(404, { message: "agent_not_found" });
    if (!canManageAgent(identity, agent)) throw new HTTPException(403, { message: "only the member who hired this agent, or an admin, can do this" });
    return agent;
  }

  // Pairing: the console makes a one-time code, `euthyna-signer pair <code>` redeems it
  // with the agent's public key and receives the API key. Nothing is copied by hand.
  app.post("/v1/console/agents/pairings", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, createPairingSchema);
    const refusal = await hiringRefusal(consoleIdentity);
    if (refusal) return context.json(refusal.body, refusal.status);
    let nearAccountId: string;
    try {
      nearAccountId = proposedAgentAccountId(input.name, nearParentAccount, consoleIdentity.organizationId);
    } catch (error) {
      return context.json({ error: "invalid_agent_name", message: error instanceof Error ? error.message : String(error) }, 422);
    }
    const taken = (await auth.listAgents(consoleIdentity.organizationId)).some((agent) => agent.nearAccountId === nearAccountId);
    if (taken) {
      return context.json({ error: "agent_name_taken", message: `An agent already uses ${nearAccountId}: pick another name.` }, 409);
    }
    const code = newPairingCode();
    const pairing = await pairings.create({
      organizationId: consoleIdentity.organizationId,
      createdByUserId: consoleIdentity.userId,
      name: input.name,
      role: input.role,
      nearAccountId,
      vaultAccountId: input.vaultAccountId,
      mpcPath: `agents/${input.role}/base`,
      codeHash: pairingCodeHash(code),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    });
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "agent.pairing_created",
      targetType: "agent_pairing",
      targetId: pairing.id,
      metadata: { nearAccountId, role: input.role },
    });
    // The code is shown once, here; only its hash is kept.
    return context.json({ ...pairingView(pairing), code }, 201);
  });

  app.get("/v1/console/agents/pairings/:id", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const id = z.string().uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "pairing_not_found" }, 404);
    const pairing = await pairings.get(consoleIdentity.organizationId, id.data);
    if (!pairing) return context.json({ error: "pairing_not_found" }, 404);
    if (!isAdmin(consoleIdentity) && pairing.createdByUserId !== consoleIdentity.userId) {
      return context.json({ error: "pairing_not_found" }, 404);
    }
    return context.json(pairingView(pairing));
  });

  app.post("/v1/agents/pair", async (context) => {
    const caller = context.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
    if (!pairingLimiter.allow(`pair:${caller}`) || !pairingLimiter.allow("pair:all")) {
      return context.json({ error: "rate_limited" }, 429);
    }
    const input = await parseJson(context, redeemPairingSchema);
    const unusable = { error: "pairing_invalid", message: "This pairing code is unknown, already used or expired. Get a new one in the console." };
    const now = new Date();
    const pairing = await pairings.findOpen(pairingCodeHash(input.code), now);
    if (!pairing) return context.json(unusable, 404);
    const currentTreasury = await treasuries.activeTreasury(pairing.organizationId);
    if (!currentTreasury || currentTreasury.status !== "active") {
      return context.json({ error: "treasury_not_active", message: "The company treasury is not active yet." }, 409);
    }
    // Single use: of two signers racing with the same code, only one gets past this.
    if (!(await pairings.claim(pairing.id, input.publicKey, input.hostname, now))) return context.json(unusable, 404);
    let created;
    try {
      created = await auth.createAgent({
        organizationId: pairing.organizationId,
        name: pairing.name,
        role: pairing.role,
        nearAccountId: pairing.nearAccountId,
        nearPublicKey: input.publicKey,
        vaultAccountId: pairing.vaultAccountId,
        mpcPath: pairing.mpcPath,
        createdByUserId: pairing.createdByUserId,
      });
    } catch {
      return context.json({ error: "agent_not_created", message: `Could not hire ${pairing.nearAccountId}; is the name already used? Get a new code with another name.` }, 409);
    }
    await pairings.attachAgent(pairing.id, created.agent.id);
    await auth.recordAudit({
      organizationId: pairing.organizationId,
      actorType: "console",
      actorId: pairing.createdByUserId,
      action: "agent.created",
      targetType: "agent",
      targetId: created.agent.id,
      metadata: { nearAccountId: created.agent.nearAccountId, role: created.agent.role, via: "pairing", hostname: input.hostname },
    });
    return context.json({
      agentId: created.agent.id,
      accountId: created.agent.nearAccountId,
      vaultAccountId: created.agent.vaultAccountId,
      networkId,
      role: created.agent.role,
      apiKey: created.apiKey,
    }, 201);
  });

  app.get("/v1/console/agents/proposed-account", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const name = context.req.query("name") ?? "";
    try {
      return context.json({ accountId: proposedAgentAccountId(name, nearParentAccount, consoleIdentity.organizationId) });
    } catch (error) {
      return context.json({ error: "invalid_agent_name", message: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  app.post("/v1/console/agents/:id/provision", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const agentId = z.string().uuid().parse(context.req.param("id"));
    await managedAgent(context, agentId);
    if (!agentProvisionLimiter.allow(`agent-provision:${consoleIdentity.organizationId}:${consoleIdentity.userId}`)) {
      return context.json({ error: "agent_provision_rate_limited" }, 429);
    }
    const provisioned = await agentProvisioning.provision(consoleIdentity.organizationId, agentId);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "agent.provisioned",
      targetType: "agent",
      targetId: agentId,
      metadata: { transactionHash: provisioned.transactionHash, status: provisioned.status },
    });
    return context.json(provisioned, provisioned.transactionHash ? 201 : 200);
  });

  app.get("/v1/console/agents/:id/provision", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const agentId = z.string().uuid().parse(context.req.param("id"));
    return context.json(await agentProvisioning.status(consoleIdentity.organizationId, agentId));
  });

  app.post("/v1/console/agents/:id/provision-confirm", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const agentId = z.string().uuid().parse(context.req.param("id"));
    await managedAgent(context, agentId);
    const confirmed = await agentProvisioning.confirm(consoleIdentity.organizationId, agentId);
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "agent.provisioning_confirmed",
      targetType: "agent",
      targetId: agentId,
      metadata: { confirmedAt: confirmed.confirmedAt?.toISOString() ?? null },
    });
    return context.json(confirmed);
  });

  app.get("/v1/console/agents/:id", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const parsedId = agentIdSchema.safeParse(context.req.param());
    if (!parsedId.success) throw new HTTPException(400, { message: parsedId.error.message });
    const agent = await auth.getAgent(consoleIdentity.organizationId, parsedId.data.id);
    if (!agent) return context.json({ error: "agent_not_found" }, 404);
    return context.json({ agent });
  });

  app.get("/v1/console/agents", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json({ agents: await auth.listAgents(consoleIdentity.organizationId) });
  });

  app.post("/v1/console/agents", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const refusal = await hiringRefusal(consoleIdentity);
    if (refusal) return context.json(refusal.body, refusal.status);
    const input = await parseJson(context, createAgentSchema);
    const expectedAccountId = proposedAgentAccountId(input.name, nearParentAccount, consoleIdentity.organizationId);
    if (input.nearAccountId && input.nearAccountId !== expectedAccountId) {
      return context.json({ error: "agent_account_mismatch", expectedAccountId }, 422);
    }
    const created = await auth.createAgent({
      organizationId: consoleIdentity.organizationId,
      name: input.name,
      role: input.role,
      nearAccountId: expectedAccountId,
      nearPublicKey: input.nearPublicKey,
      vaultAccountId: input.vaultAccountId,
      mpcPath: input.mpcPath,
      createdByUserId: consoleIdentity.userId,
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

  app.post("/v1/console/agents/:id/revoke", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const parsedId = agentIdSchema.safeParse(context.req.param());
    if (!parsedId.success) throw new HTTPException(400, { message: parsedId.error.message });
    await managedAgent(context, parsedId.data.id);
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

  if (omniroles) {
    const daoNameSchema = z.object({ daoName: z.string().min(2).max(60) });
    const membershipSchema = z.object({
      role: z.string().min(2).max(32),
      member: z.string().min(2).max(64),
      kind: z.enum(["Agent", "Human"]),
      action: z.enum(["grant", "revoke"]),
      maxUses: z.number().int().positive().nullable().optional(),
    });
    const orgOf = (context: AppContext) => context.get("console").organizationId;
    app.get("/v1/console/omniroles/status", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.status(orgOf(context))));
    app.post("/v1/console/omniroles/plan", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, daoNameSchema);
      return context.json(await omniroles.plan(orgOf(context), input.daoName));
    });
    app.post("/v1/console/omniroles/create", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, daoNameSchema);
      const result = await omniroles.create(orgOf(context), input.daoName);
      await auth.recordAudit({
        organizationId: orgOf(context),
        actorType: "console",
        actorId: context.get("console").userId,
        action: "treasury.created",
        targetType: "treasury",
        targetId: input.daoName,
        metadata: result,
      });
      return context.json(result);
    });
    app.get("/v1/console/omniroles/holdings", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.holdings(orgOf(context))));
    app.get("/v1/console/omniroles/versions", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.versions(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/upgrade", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ codeHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) }));
      return context.json(await omniroles.upgradeProposal(orgOf(context), input.codeHash));
    });
    app.post("/v1/console/omniroles/proposals/wallet", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ chainId: z.number().int().positive().optional(), solana: z.boolean().optional() }));
      return context.json(await omniroles.walletProposal(orgOf(context), input.chainId, input.solana ?? false));
    });
    app.post("/v1/console/omniroles/proposals/transaction", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({
        title: z.string().max(120).optional(),
        transactions: z.array(z.object({
          chainId: z.number().int().positive(),
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
          value: z.string().regex(/^\d+$/).optional(),
          data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).max(50_000).optional(),
          gas: z.string().regex(/^\d+$/).optional(),
        })).min(1).max(10),
      }));
      return context.json(await omniroles.transactionProposal(orgOf(context), input));
    });
    app.get("/v1/console/omniroles/suppliers", requireConsole(auth, consoleLimiter), async (context) => context.json(await omniroles.suppliers(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/suppliers", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ entries: z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), label: z.string().max(64) })).max(256), migrate: z.boolean().optional() }));
      return context.json(await omniroles.suppliersProposal(orgOf(context), input));
    });
    app.get("/v1/console/omniroles/bank", requireConsole(auth, consoleLimiter), async (context) => context.json(await omniroles.bank(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/bank-beneficiary", requireConsole(auth, consoleLimiter), async (context) => {
      // Sealed in the member's browser: no IBAN, no holder name reaches this server.
      const input = await parseJson(context, z.union([
        z.object({ remove: z.number().int().positive() }),
        z.object({
          label: z.string().max(32).regex(/^[ -~]*$/).default(""),
          commitment: z.string().regex(/^[0-9a-fA-F]{64}$/),
          sealedForSigner: z.string().min(16).max(2048).regex(/^[A-Za-z0-9+/=]+$/),
          sealedForMembers: z.string().min(16).max(8192).regex(/^[A-Za-z0-9+/=]+$/),
        }).strict(),
      ]));
      return context.json("remove" in input ? await omniroles.bankBeneficiaryRemoval(orgOf(context), input.remove) : await omniroles.bankBeneficiaryProposal(orgOf(context), input));
    });
    app.get("/v1/console/omniroles/standing-orders", requireConsole(auth, consoleLimiter), async (context) => context.json(await omniroles.standingOrders(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/standing-order", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({
        beneficiaryId: z.number().int().positive(),
        amount: z.string().regex(/^\d+$/).default("0"),
        firstAt: z.string().default(""),
        periodDays: z.number().min(0.001).max(366).default(30),
        count: z.number().int().positive().nullable().default(null),
        label: z.string().max(32).regex(/^[ -~]*$/).default(""),
        remove: z.number().int().positive().optional(),
      }));
      return context.json(await omniroles.standingOrderProposal(orgOf(context), input));
    });
    app.post("/v1/console/omniroles/proposals/bank-permission", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({
        role: z.string().min(1).max(64),
        budget: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable(),
        maxPerPayout: z.string().regex(/^\d+$/).nullable(),
        newBudget: z.object({ amount: z.string().regex(/^\d+$/), periodDays: z.number().min(0).max(366) }).optional(),
      }));
      return context.json(await omniroles.bankPermissionProposal(orgOf(context), input));
    });
    app.post("/v1/console/omniroles/proposals/bank-config", requireConsoleAdmin(auth, consoleLimiter), async (context) => context.json(await omniroles.bankConfigProposal(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/bank-signer-source", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const body = z.object({ follow: z.boolean() }).parse(await context.req.json());
      return context.json(await omniroles.bankSignerSourceProposal(orgOf(context), body.follow));
    });
    app.post("/v1/console/omniroles/proposals/role", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, roleDraftSchema);
      return context.json(await omniroles.roleProposal(orgOf(context), input.draft as RoleDraft));
    });
    app.post("/v1/console/omniroles/proposals/membership", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, membershipSchema);
      return context.json(await omniroles.membershipProposal(orgOf(context), {
        role: input.role,
        member: input.member,
        kind: input.kind,
        action: input.action,
        maxUses: input.maxUses ?? null,
      }));
    });
    app.post("/v1/console/omniroles/proposals/members", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ members: z.array(z.string().min(2).max(64)).min(3).max(20) }));
      return context.json(await omniroles.membersProposals(orgOf(context), input.members));
    });
    app.post("/v1/console/omniroles/proposals/fire", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ member: z.string().regex(/^[a-z0-9._-]{2,64}$/) }));
      return context.json(await omniroles.fireProposal(orgOf(context), input.member));
    });
    app.post("/v1/console/omniroles/proposals/budget", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ key: z.string().regex(/^0x[0-9a-fA-F]{64}$/), amount: z.string().regex(/^\d+(\.\d+)?$/) }));
      return context.json(await omniroles.budgetProposal(orgOf(context), input));
    });
    app.post("/v1/console/omniroles/proposals/pause", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ pause: z.boolean() }));
      return context.json(await omniroles.pauseProposal(orgOf(context), input.pause));
    });
    app.get("/v1/console/omniroles/shares", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.shares(orgOf(context), context.get("console").nearAccountId ?? null)));
    app.post("/v1/console/omniroles/shares", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({
        name: z.string().min(2).max(60),
        symbol: z.string().regex(/^[A-Z0-9]{2,8}$/),
        totalSupply: z.number().int().min(1).max(1_000_000_000),
        priceNear: z.string().regex(/^\d+(\.\d{1,24})?$/),
        allocations: z.array(z.object({ accountId: z.string().min(2).max(64), shares: z.number().int().min(1) })).max(20),
      }));
      const result = await omniroles.createShares(orgOf(context), input);
      await auth.recordAudit({
        organizationId: orgOf(context),
        actorType: "console",
        actorId: context.get("console").userId,
        action: "shares.created",
        targetType: "shares",
        targetId: result.accountId,
        metadata: { transaction: result.transaction, wasmSha256: result.wasmSha256, symbol: input.symbol, totalSupply: input.totalSupply },
      });
      return context.json(result);
    });
    app.post("/v1/console/omniroles/proposals/shares", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.sharesProposals(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/revenue", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ amountNear: z.string().regex(/^\d+(\.\d{1,24})?$/) }));
      return context.json(await omniroles.revenueProposal(orgOf(context), input.amountNear));
    });
    app.post("/v1/console/omniroles/proposals/proceeds", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ chainId: z.number().int().positive(), amountNear: z.string().regex(/^\d+(\.\d{1,24})?$/) }));
      return context.json(await omniroles.proceedsProposals(orgOf(context), input));
    });
    app.get("/v1/console/omniroles/sealed", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.sealedOrders(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/sealed-order", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({
        role: z.string().min(1).max(64),
        commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        slippageBps: z.number().int().min(0).max(500),
        terms: z.string().max(8192).nullable(),
        approveUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable(),
      }));
      return context.json(await omniroles.sealedOrderProposal(orgOf(context), input));
    });
    app.post("/v1/console/omniroles/proposals/sealed-cancel", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ id: z.number().int().min(0) }));
      return context.json(await omniroles.sealedCancelProposal(orgOf(context), input.id));
    });
    app.get("/v1/console/omniroles/directory", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.directory(orgOf(context))));
    app.post("/v1/console/omniroles/proposals/registry", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ name: z.string().min(1).max(64), description: z.string().max(280).default("") }));
      return context.json(await omniroles.registryProposal(orgOf(context), input));
    });
    app.get("/v1/console/omniroles/members", requireConsole(auth, consoleLimiter), async (context) =>
      context.json({ ...(await omniroles.members(orgOf(context))), me: context.get("console").nearAccountId ?? null }));
    app.post("/v1/console/omniroles/members", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ nearAccountId: z.string().min(2).max(64), name: z.string().max(80).optional() }));
      return context.json(await omniroles.addMember(orgOf(context), input));
    });
    app.delete("/v1/console/omniroles/members/:id", requireConsoleAdmin(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.removeMember(orgOf(context), context.req.param("id") ?? "", context.get("console").memberId)));
    app.post("/v1/console/omniroles/refresh", requireConsole(auth, consoleLimiter), async (context) => {
      await omniroles.refresh(orgOf(context));
      return context.json({ ok: true });
    });
    app.get("/v1/console/omniroles/governance", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.governance(orgOf(context))));
    app.post("/v1/console/omniroles/rules/activate", requireConsole(auth, consoleLimiter), async (context) =>
      context.json({ transactions: await omniroles.activateReadyRules(orgOf(context)) }));
    app.get("/v1/console/omniroles/roles", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.roles(orgOf(context))));
    app.get("/v1/console/omniroles/activity", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.activity(orgOf(context))));
    app.post("/v1/operations/check", requireAgent(auth, agentLimiter), async (context) => {
      const agent = context.get("agent");
      const input = await parseJson(context, z.object({ request: z.record(z.string(), z.unknown()), advisoryOnly: z.boolean().optional(), invoice: z.object({ text: z.string().max(100000).optional(), claimedRecipient: z.string().optional() }).optional() }));
      const request = input.request;
      if (input.advisoryOnly) return context.json(checkInvoice({ calldata: Array.isArray(request.calldata) ? request.calldata as number[] : [] }, input.invoice));
      const guardable = typeof request.chain_id === "number" && Array.isArray(request.target) && Array.isArray(request.calldata);
      return context.json(await omniroles.checkOperation(
        agent.organizationId,
        agent,
        request,
        guardable
          ? () => payments.preview(agent.organizationId, agent, {
            chain_id: request.chain_id as number,
            target: request.target as number[],
            calldata: request.calldata as number[],
            reference: typeof request.reference === "string" ? request.reference : "",
          })
          : undefined,
      ));
    });
    app.get("/v1/agent/share-revenue", requireAgent(auth, agentLimiter), async (context) => {
      const amountWei = context.req.query("amountWei") ?? "";
      if (!/^\d{1,30}$/.test(amountWei)) return context.json({ error: "invalid_amount", message: "amountWei must be a whole number of wei" }, 400);
      return context.json(await omniroles.shareRevenueOperation(context.get("agent").organizationId, amountWei));
    });
    app.get("/v1/agent/mandate", requireAgent(auth, agentLimiter), async (context) => {
      const agent = context.get("agent");
      const mandate = await omniroles.agentMandate(agent.organizationId, agent);
      return context.json({ ...mandate, recipients: await payments.recipients(agent.organizationId, agent, mandate.chainId) });
    });
  }

  if (rob) {
    registerRobRoutes(app, rob, {
      limiters: { session: new MemoryRateLimiter(5, 3_600_000), play: new MemoryRateLimiter(30, 60_000), read: new MemoryRateLimiter(120, 60_000) },
      trustProxy: marketTrustProxy ?? false,
    });
  }

  if (market) {
    const marketLimiter = new MemoryRateLimiter(120, 60_000);
    registerMarketPublicRoutes(app, market, { baseUrl: publicBaseUrl ?? "http://localhost:3000", limiter: marketLimiter, trustProxy: marketTrustProxy ?? false });
    registerMarketWorkerRoutes(app, market, new MemoryRateLimiter(600, 60_000));
    const vaultOf = async (organizationId: string) => {
      const treasury = await treasuries.activeTreasury(organizationId);
      if (!treasury || treasury.status !== "active") throw new MarketError(409, "treasury_not_active", "the company vault is not active yet");
      return treasury.vaultAccountId;
    };
    const orgId = (context: { get: (key: "console") => ConsoleIdentity }) => context.get("console").organizationId;
    app.get("/v1/console/market/listings", requireConsole(auth, consoleLimiter), async (context) => context.json({ listings: await market.listings(orgId(context)) }));
    app.post("/v1/console/market/listings", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, listingCreateSchema);
      const listing = await market.createListing(orgId(context), await vaultOf(orgId(context)), input);
      return context.json({ listing }, 201);
    });
    app.patch("/v1/console/market/listings/:id", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, listingUpdateSchema);
      return context.json({ listing: await market.updateListing(orgId(context), context.req.param("id") ?? "", input) });
    });
    app.post("/v1/console/market/listings/:id/token", requireConsoleAdmin(auth, consoleLimiter), async (context) =>
      context.json(await market.rotateDeliveryToken(orgId(context), context.req.param("id") ?? "")));
    app.get("/v1/console/market/sales", requireConsole(auth, consoleLimiter), async (context) => context.json(await market.sales(orgId(context))));
    // Agents buy with their spending card (or their own account).
    app.get("/v1/console/market/purchases", requireConsole(auth, consoleLimiter), async (context) => {
      const agents = await auth.listAgents(orgId(context));
      const buyers = agents.flatMap((agent) => {
        try {
          return [agent.nearAccountId, cardAccountIdOf(agent.nearAccountId)];
        } catch {
          return [agent.nearAccountId];
        }
      });
      return context.json(await market.purchases(buyers));
    });
  }

  // The agent's spending card: its euthyna-signer made the key and sends only the public key.
  app.post("/v1/agent/card", requireAgent(auth, agentProvisionLimiter), async (context) => {
    const input = await parseJson(context, z.object({ publicKey: z.string().max(80), token: z.string().max(64) }));
    const agent = context.get("agent");
    const result = await createCard(near, agent.nearAccountId, input);
    await auth.recordAudit({ organizationId: agent.organizationId, actorType: "agent", actorId: agent.agentId, action: "agent.card.created", targetType: "near_account", targetId: result.cardAccountId, metadata: { token: input.token, created: result.created } });
    return context.json(result, result.created ? 201 : 200);
  });

  if (recovery) {
    const recoveryLimiter = new MemoryRateLimiter(10, 60 * 60_000);
    const limited = (key: string) => {
      if (!recoveryLimiter.allow(key)) throw new HTTPException(429, { message: "rate limit exceeded" });
    };
    // Enrollments, recoveries and cancellations are transactions on the recovery contract, signed
    // in the browser. Here: what the contract holds, for the console, and the members' vote.
    app.get("/v1/console/recovery", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await recovery.list(context.get("console").organizationId)));
    app.post("/v1/console/recovery/proposals", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ lostAccountId: z.string().min(2).max(64) }));
      return context.json(await recovery.proposals(context.get("console").organizationId, input.lostAccountId));
    });
    // The browser needs the domain's DKIM key to build a proof (it cannot query DNS); the
    // contract only accepts keys in its own registry.
    app.get("/v1/recovery/dkim-key", async (context) => {
      const domain = (context.req.query("domain") ?? "").toLowerCase();
      const selector = context.req.query("selector") ?? "";
      limited(`recovery-dkim:${domain}`);
      return context.json({ records: await recovery.dkimRecords(domain, selector) });
    });
  }

  // The company's euro account: any member reads it; an admin opens it; deposits are simulated in the sandbox.
  app.get("/v1/console/bank", requireConsole(auth, consoleLimiter), async (context) => {
    if (!bank) return context.json({ configured: false });
    return context.json({ configured: true, ...(await bank.view(context.get("console").organizationId)) });
  });
  app.post("/v1/console/bank", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    if (!bank) throw new HTTPException(404, { message: "no bank partner is configured" });
    const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[\x20-\x7E]+$/, "printable ASCII only");
    const input = await parseJson(context, z.object({
      registeredName: text(120),
      registrationNumber: text(64),
      entityType: z.enum(["LimitedLiabilityCompany", "PublicCompany", "SoleProprietorship", "Partnership", "Corporation", "Trust", "PrivateFoundation", "Charity", "NonProfitOrganization", "PublicAgency"]),
      country: z.string().regex(/^[A-Z]{2}$/),
      street: text(120),
      city: text(80),
      postCode: text(20),
      state: text(80),
      incorporationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      taxId: text(64),
      email: z.string().email().max(160).optional(),
    }));
    const console = context.get("console");
    const view = await bank.open(console.organizationId, input);
    await auth.recordAudit({ organizationId: console.organizationId, actorType: "console", actorId: console.userId, action: "bank.account.opened", targetType: "bank_account", targetId: view.account?.iban ?? "", metadata: { destination: view.account?.destinationAddress, network: view.account?.network } });
    return context.json({ configured: true, ...view }, 201);
  });
  // Invoices: issued by the company, paid by SEPA to its IBAN, matched by their creditor reference.
  app.get("/v1/console/invoices", requireConsole(auth, consoleLimiter), async (context) => {
    if (!invoices) return context.json({ invoices: [], account: null });
    return context.json(await invoices.list(context.get("console").organizationId));
  });
  app.post("/v1/console/invoices", requireConsole(auth, consoleLimiter), async (context) => {
    if (!invoices) throw new HTTPException(404, { message: "no bank partner is configured" });
    const input = await parseJson(context, z.object({
      customerName: z.string().trim().min(1).max(120),
      customerEmail: z.string().email().max(200).optional(),
      description: z.string().trim().min(1).max(500),
      amount: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/),
      dueInDays: z.number().int().min(0).max(365).default(30),
    }));
    const console = context.get("console");
    const invoice = await invoices.create(console.organizationId, input);
    await auth.recordAudit({ organizationId: console.organizationId, actorType: "console", actorId: console.userId, action: "invoice.created", targetType: "invoice", targetId: invoice.number, metadata: { amount: invoice.amount } });
    return context.json(invoice);
  });
  app.post("/v1/console/invoices/:id/cancel", requireConsole(auth, consoleLimiter), async (context) => {
    if (!invoices) throw new HTTPException(404, { message: "no bank partner is configured" });
    return context.json(await invoices.cancel(context.get("console").organizationId, context.req.param("id") ?? ""));
  });
  app.post("/v1/console/invoices/:id/simulate", requireConsole(auth, consoleLimiter), async (context) => {
    if (!invoices) throw new HTTPException(404, { message: "no bank partner is configured" });
    return context.json(await invoices.simulatePayment(context.get("console").organizationId, context.req.param("id") ?? ""));
  });
  // The bank partner's webhook (register https://<api>/v1/webhooks/noah, event FiatDeposit). Signed
  // by the partner (ECDSA P-384 over the raw body): anything unsigned or forged is refused.
  app.post("/v1/webhooks/noah", async (context) => {
    if (!invoices || !noahWebhookKey) return context.json({ ok: false }, 404);
    const raw = await context.req.text();
    if (raw.length > 64_000 || !verifyNoahWebhook(raw, context.req.header("Webhook-Signature"), noahWebhookKey)) return context.json({ ok: false }, 401);
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return context.json({ ok: false }, 400);
    }
    const result = await invoices.onFiatDeposit(event as Parameters<InvoiceService["onFiatDeposit"]>[0]);
    if (result.matched) console.log(JSON.stringify({ event: "invoice.deposit_matched", invoice: result.matched }));
    return context.json({ ok: true });
  });
  app.get("/v1/console/bank/rails", requireConsole(auth, consoleLimiter), async (context) => {
    if (!bank) return context.json({ rails: [] });
    return context.json(await bank.rails(context.get("console").organizationId));
  });
  app.post("/v1/console/bank/simulate", requireConsole(auth, consoleLimiter), async (context) => {
    if (!bank) throw new HTTPException(404, { message: "no bank partner is configured" });
    const input = await parseJson(context, z.object({ amount: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).refine((value) => Number(value) > 0 && Number(value) <= 1000, "between 0.01 and 1000 EUR") }));
    return context.json(await bank.simulateDeposit(context.get("console").organizationId, input.amount));
  });

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof RecoveryError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof BankError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof CardError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof MarketError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof RobError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof OmniRolesError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof AgentProvisioningError) {
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

