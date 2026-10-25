import { createHash } from "node:crypto";
import type { RoleDraft } from "@mandateos/sdk/roles";
import { OmniRolesError, type OmniRolesService } from "./omniroles.js";

import { proposedAgentAccountId } from "@mandateos/sdk";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { AgentProvisioningError, type AgentProvisioningService } from "./agent-provisioning.js";
import { onChainAgentEvmAddress } from "./agent-chain.js";
import type { AgentIdentity, AuthGateway, ConsoleIdentity } from "./auth-gateway.js";
import type { Guard } from "./guard.js";
import { GovernanceError, type GovernanceGateway } from "./governance.js";
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
  nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/).optional(),
  nearPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
  vaultAccountId: z.string().min(2).max(64),
  mpcPath: z.string().min(1).max(200),
});

const agentIdSchema = z.object({ id: z.string().uuid() });

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
  agent: z
    .object({
      nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
      mpcPath: z.string().min(1).max(200),
      evmAddress: addressSchema.optional(),
    })
    .optional(),
});

const nearAccountSchema = z
  .string()
  .transform((value) => value.trim().split(/\s+/)[0]!.replace(/\(.*\)$/, ""))
  .pipe(z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/));

const paymentGasQuoteSchema = z.object({
  token: addressSchema,
  recipient: addressSchema,
  amount: z.string().regex(/^[1-9]\d*$/),
});
const evmAddressSchema = z
  .string()
  .transform((value) => value.trim().split(/\s+/)[0]!)
  .pipe(z.string().regex(/^0x[0-9a-fA-F]{40}$/));

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

const nearDeploymentAttestationSchema = treasuryRegisterSchema.pick({
  environment: true,
  daoAccountId: true,
  vaultAccountId: true,
  relayAccountId: true,
  delayAddress: true,
  govAddress: true,
});

const nearSponsorshipSchema = z.object({
  nearAccountId: z.string().min(2).max(64).regex(/^[a-z0-9._-]+$/),
  nearPublicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/),
});
const budgetTokenPlanSchema = z.object({
  amount: z.string().regex(/^[1-9]\d*$/),
});
const governanceExecutionSchema = z.object({
  proposalId: z.number().int().nonnegative(),
  nearTransactionHash: z.string().min(32).max(64),
  signerAccountId: nearAccountSchema,
});
const governanceUnblockSchema = z.object({
  opId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const governanceSwapOwnerSchema = z.object({
  oldOwner: evmAddressSchema,
  newOwner: evmAddressSchema,
});
const governanceAddOwnerSchema = z.object({
  newOwner: evmAddressSchema,
});
const nearRpcProxySchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.enum(["query", "block", "send_tx", "broadcast_tx_commit", "tx", "EXPERIMENTAL_tx_status"]),
  params: z.unknown(),
});





function derivedWalletAccountId(publicKey: string, parent: string): string {
  const suffix = createHash("sha256").update(publicKey).digest("hex").slice(0, 12);
  return `w-${suffix}.${parent}`;
}

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
  agentProvisioning: AgentProvisioningService;
  treasury: TreasuryGateway;
  governance: GovernanceGateway;
  mandates: MandateGateway;
  registry: RegistryService;
  payments: PaymentService;
  consoleData: ConsoleDataService;
  consoleOrigin: string;
  nearParentAccount: string;
  nearSponsorDailyWalletLimit: number;
  nearSponsorWalletAmountYocto: string;
  omniroles?: OmniRolesService;
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
  agentProvisioning,
  treasury,
  governance,
  mandates,
  registry: registryService,
  payments,
  consoleData,
  consoleOrigin,
  nearParentAccount,
  nearSponsorDailyWalletLimit,
  nearSponsorWalletAmountYocto,
  omniroles,
}: AppDependencies): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const agentLimiter = new MemoryRateLimiter(120, 60_000);
  const consoleLimiter = new MemoryRateLimiter(600, 60_000);
  const agentProvisionLimiter = new MemoryRateLimiter(10, 60 * 60_000);
  app.use(
    "*",
    cors({
      origin: consoleOrigin,
      credentials: true,
      allowHeaders: ["content-type", "x-api-key"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use("/v1/console/*", requireConsoleRequest(consoleOrigin));
  app.use("/v1/emergency/*", requireConsoleRequest(consoleOrigin));
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

  app.post("/v1/console/governance/relay-operation", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, governanceExecutionSchema);
    return context.json(await governance.recordRelayExecution(consoleIdentity.organizationId, input));
  });
  app.post("/v1/console/governance/unblock-proposal", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, governanceUnblockSchema);
    return context.json(await governance.unblockProposal(consoleIdentity.organizationId, input.opId));
  });
  app.post("/v1/console/governance/cancel-underpriced-proposal", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, governanceUnblockSchema);
    return context.json(await governance.cancelUnderpricedProposal(consoleIdentity.organizationId, input.opId));
  });
  app.post("/v1/console/governance/swap-owner-proposal", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, governanceSwapOwnerSchema);
    return context.json(await governance.swapOwnerProposal(consoleIdentity.organizationId, input));
  });
  app.post("/v1/console/governance/add-owner-proposal", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, governanceAddOwnerSchema);
    return context.json(await governance.addOwnerProposal(consoleIdentity.organizationId, input));
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
  app.post("/v1/console/mandates/zodiac-proposal", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, mandateSchema);
    return context.json(await mandates.zodiacProposal(consoleIdentity.organizationId, input));
  });

  app.get("/v1/console/treasury/budget-token", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    return context.json(await mandates.budgetTokenStatus(consoleIdentity.organizationId));
  });

  app.post("/v1/console/treasury/budget-token/plan", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, budgetTokenPlanSchema);
    return context.json(await mandates.budgetTokenPlan(consoleIdentity.organizationId, input.amount));
  });


  app.get("/v1/console/treasury", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const environment = context.req.query("environment") ?? "uat";
    return context.json({ treasury: await treasury.getTreasury(consoleIdentity.organizationId, environment) });
  });

  app.post("/v1/console/treasury/plan", requireConsole(auth, consoleLimiter), async (context) => {
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

  app.get("/v1/console/treasury/sponsor-status", requireConsole(auth, consoleLimiter), async (context) => {
    const account = await near.getAccount(nearParentAccount);
    return context.json({
      accountId: nearParentAccount,
      balanceYocto: account.amount,
      storageUsage: account.storage_usage ?? null,
    });
  });
  app.post(
    "/v1/console/treasury/sponsor-founder-wallet",
    requireConsoleAdmin(auth, consoleLimiter),
    async (context) => {
      const consoleIdentity = context.get("console");
      const input = await parseJson(context, nearSponsorshipSchema);
      const expectedAccountId = derivedWalletAccountId(input.nearPublicKey, nearParentAccount);
      if (input.nearAccountId !== expectedAccountId) {
        return context.json({ error: "near_account_mismatch", expectedAccountId }, 422);
      }

      const reservation = await auth.reserveNearWalletSponsorship({
        organizationId: consoleIdentity.organizationId,
        userId: consoleIdentity.userId,
        nearAccountId: input.nearAccountId,
        publicKey: input.nearPublicKey,
        dailyLimit: nearSponsorDailyWalletLimit,
      });
      if (reservation === "already_sponsored") {
        return context.json({ nearAccountId: input.nearAccountId, status: "already_sponsored" });
      }
      if (reservation === "daily_limit") {
        return context.json({ error: "daily_sponsorship_limit" }, 429);
      }
      if (reservation === "in_progress") {
        return context.json({ error: "sponsorship_in_progress" }, 409);
      }
      if (reservation === "member_mismatch") {
        return context.json({ error: "founder_wallet_mismatch" }, 403);
      }
      if (reservation === "conflict") {
        return context.json({ error: "sponsorship_conflict" }, 409);
      }

      try {
        await near.createSubaccount(input.nearAccountId, input.nearPublicKey, nearSponsorWalletAmountYocto);
        await auth.completeNearWalletSponsorship(input.nearAccountId, true);
      } catch (cause) {
        let alreadyCreatedForKey = false;
        try {
          const accessKeys = await near.getAccessKeys(input.nearAccountId);
          alreadyCreatedForKey = accessKeys.keys.some((key) => {
            if (!key || typeof key !== "object" || !("public_key" in key)) return false;
            return key.public_key === input.nearPublicKey;
          });
        } catch {
          // Account lookup failed; release the reservation below.
        }
        await auth.completeNearWalletSponsorship(input.nearAccountId, alreadyCreatedForKey);
        if (!alreadyCreatedForKey) throw cause;
      }

      await auth.recordAudit({
        organizationId: consoleIdentity.organizationId,
        actorType: "console",
        actorId: consoleIdentity.userId,
        action: "near_wallet.sponsored",
        targetType: "near_account",
        targetId: input.nearAccountId,
        metadata: { amountYocto: nearSponsorWalletAmountYocto },
      });
      return context.json({ nearAccountId: input.nearAccountId, status: "sponsored" }, 201);
    },
  );



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

  app.post("/v1/console/treasury/deployment-confirmations/status", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, nearDeploymentAttestationSchema);
    return context.json(await treasury.nearDeploymentConfirmations(consoleIdentity.organizationId, input));
  });

  app.post("/v1/console/treasury/deployment-confirmations/confirm", requireConsole(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const input = await parseJson(context, nearDeploymentAttestationSchema);
    const status = await treasury.confirmNearDeployment(
      consoleIdentity.organizationId,
      consoleIdentity.memberId,
      input,
    );
    await auth.recordAudit({
      organizationId: consoleIdentity.organizationId,
      actorType: "console",
      actorId: consoleIdentity.userId,
      action: "treasury.near_deployment_confirmed",
      targetType: "member",
      targetId: consoleIdentity.memberId,
      metadata: { digest: status.digest },
    });
    return context.json(status);
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

  app.post("/v1/console/agents/:id/provision", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const agentId = z.string().uuid().parse(context.req.param("id"));
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

  app.post("/v1/console/agents/:id/provision-confirm", requireConsoleAdmin(auth, consoleLimiter), async (context) => {
    const consoleIdentity = context.get("console");
    const agentId = z.string().uuid().parse(context.req.param("id"));
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
    let agent = await auth.getAgent(consoleIdentity.organizationId, parsedId.data.id);
    if (!agent) return context.json({ error: "agent_not_found" }, 404);
    const currentTreasury = await treasury.getTreasury(consoleIdentity.organizationId, "uat");
    let onChain: unknown = { status: "no_treasury" };
    if (currentTreasury) {
      try {
        const chainAgent = await near.viewFunction<unknown>(currentTreasury.vaultAccountId, "get_agent", {
          agent: agent.nearAccountId,
        });
        const derivedAddress = onChainAgentEvmAddress(chainAgent);
        if (derivedAddress && derivedAddress !== agent.evmAddress) {
          agent = await auth.setAgentEvmAddress(
            consoleIdentity.organizationId,
            agent.id,
            derivedAddress,
          ) ?? agent;
        }
        onChain = {
          status: "ok",
          agent: chainAgent,
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

  if (omniroles) {
    const daoNameSchema = z.object({ daoName: z.string().min(2).max(60) });
    const roleDraftSchema = z.object({
      draft: z.object({
        name: z.string(),
        blocks: z.array(z.union([
          z.object({
            kind: z.literal("payments"),
            token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            recipients: z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), label: z.string().max(80) })).min(1).max(20),
            budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
          }),
          z.object({
            kind: z.literal("swap"),
            tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            tokensOut: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1).max(10),
            protocols: z.array(z.enum(["uniswap-v3", "uniswap-v2"])).min(1),
            budget: z.object({ amount: z.string().regex(/^\d+(\.\d+)?$/), periodDays: z.number().positive().max(366) }),
            maxApproval: z.string().regex(/^\d+(\.\d+)?$/),
          }),
        ])).min(1).max(10),
        members: z.array(z.object({
          accountId: z.string().min(2).max(64),
          kind: z.enum(["Agent", "Human"]),
          maxUses: z.number().int().positive().nullable().optional(),
        })).max(20),
      }),
    });
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
    app.post("/v1/console/omniroles/proposals/wallet", requireConsole(auth, consoleLimiter), async (context) =>
      context.json(await omniroles.walletProposal(orgOf(context))));
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
    app.post("/v1/console/omniroles/proposals/pause", requireConsole(auth, consoleLimiter), async (context) => {
      const input = await parseJson(context, z.object({ pause: z.boolean() }));
      return context.json(await omniroles.pauseProposal(orgOf(context), input.pause));
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
      const input = await parseJson(context, z.object({ request: z.record(z.string(), z.unknown()) }));
      return context.json(await omniroles.checkOperation(agent.organizationId, agent, input.request));
    });
  }

  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof OmniRolesError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof TreasuryError) {
      return context.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof GovernanceError) {
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
