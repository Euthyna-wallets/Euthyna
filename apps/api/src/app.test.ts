import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { MemoryRateLimiter } from "./rate-limit.js";
import type {
  AgentIdentity,
  AgentView,
  AuditEvent,
  AuthGateway,
  ConsoleIdentity,
  CreateAgentInput,
  CreatedAgent,
} from "./auth-gateway.js";
import type { Guard } from "./guard.js";
import type { NearClient } from "./near.js";
import type { BaseRelayer } from "./relayer.js";
import type { VaultOperation } from "./types.js";
import type { TreasuryGateway, TreasuryPlan, TreasuryView } from "./treasury.js";
import type { MandateGateway, MandatePreview } from "./mandates.js";
import type { RegistryService } from "./registry-db.js";
import type { PaymentService } from "./payments.js";
import type { ConsoleDataService } from "./console-data.js";

const operation: VaultOperation = {
  op_id: Array(32).fill(1) as number[],
  client_id: "acme",
  agent: "agent-a.near",
  role: "researcher",
  intent: {
    token: Array(20).fill(0x83),
    recipient: Array(20).fill(0x66),
    amount: "1000000",
    reference: "INV-1",
    gas_limit: "200000",
    max_fee_per_gas: "20000000000",
    max_priority_fee_per_gas: "1000000000",
  },
  policy_version: 1,
  registry_version: 1,
  evm_nonce: 0,
  transaction: {
    chain_id: 84532,
    nonce: 0,
    to: Array(20).fill(0x44),
    value: "0",
    input: [],
    gas_limit: "200000",
    max_fee_per_gas: "20000000000",
    max_priority_fee_per_gas: "1000000000",
  },
  tx_digest: Array(32).fill(2),
  expires_at_block: 100,
  state: "Prepared",
  signed_transaction: null,
};

const agentA: AgentIdentity = {
  agentId: "agent-a",
  organizationId: "org-1",
  nearAccountId: "agent-a.near",
  vaultAccountId: "vault-1.near",
  role: "researcher",
};

const agentB: AgentIdentity = {
  agentId: "agent-b",
  organizationId: "org-1",
  nearAccountId: "agent-b.near",
  vaultAccountId: "vault-1.near",
  role: "researcher",
};

const admin: ConsoleIdentity = { userId: "user-admin", organizationId: "org-1", role: "admin" };
const member: ConsoleIdentity = { userId: "user-member", organizationId: "org-1", role: "member" };

const requestBody = { vaultAccountId: "vault-1.near", opId: Array(32).fill(1) };
const consoleOrigin = "http://console.test";

class FakeAuth implements AuthGateway {
  readonly agents = new Map<string, AgentIdentity>();
  readonly consoles = new Map<string, ConsoleIdentity>();
  readonly audits: AuditEvent[] = [];
  readonly listedOrganizations: string[] = [];
  readonly created: CreateAgentInput[] = [];
  readonly revoked: Array<{ organizationId: string; agentId: string }> = [];

  handler(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  identifyAgent(apiKey: string | undefined): Promise<AgentIdentity | null> {
    return Promise.resolve(apiKey ? (this.agents.get(apiKey) ?? null) : null);
  }

  identifyConsole(headers: Headers): Promise<ConsoleIdentity | null> {
    const cookie = headers.get("cookie");
    return Promise.resolve(cookie ? (this.consoles.get(cookie) ?? null) : null);
  }

  listAgents(organizationId: string): Promise<AgentView[]> {
    this.listedOrganizations.push(organizationId);
    return Promise.resolve([]);
  }

  listMembers(): Promise<import("./auth-gateway.js").MemberView[]> {
    return Promise.resolve([]);
  }

  getAgent(organizationId: string, agentId: string): Promise<AgentView | null> {
    if (organizationId !== "org-1" || agentId !== "11111111-1111-4111-8111-111111111111") return Promise.resolve(null);
    return Promise.resolve({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Agent A",
      role: "researcher",
      nearAccountId: "agent-a.near",
      nearPublicKey: "ed25519:11111111111111111111111111111111",
      vaultAccountId: "vault-1.near",
      evmAddress: null,
      mpcPath: "agents/researcher/base",
      active: true,
      createdAt: new Date(0),
    });
  }

  createAgent(input: CreateAgentInput): Promise<CreatedAgent> {
    this.created.push(input);
    return Promise.resolve({
      agent: {
        id: "created-agent",
        name: input.name,
        role: input.role,
        nearAccountId: input.nearAccountId,
        nearPublicKey: input.nearPublicKey,
        vaultAccountId: input.vaultAccountId,
        evmAddress: null,
        mpcPath: input.mpcPath,
        active: true,
        createdAt: new Date(0),
      },
      apiKey: "mdo_secret",
    });
  }

  revokeAgent(organizationId: string, agentId: string): Promise<boolean> {
    this.revoked.push({ organizationId, agentId });
    return Promise.resolve(agentId === "agent-a" && organizationId === "org-1");
  }

  registerPasswordless(): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }

  recordAudit(event: AuditEvent): Promise<void> {
    this.audits.push(event);
    return Promise.resolve();
  }
}

function testApp(options?: { operation?: VaultOperation; consoleRole?: "admin" | "member"; treasuryStatus?: string }) {
  const auth = new FakeAuth();
  auth.agents.set("key-a", agentA);
  auth.agents.set("key-b", agentB);
  auth.consoles.set("session-admin", admin);
  auth.consoles.set("session-member", member);
  if (options?.consoleRole === "member") auth.consoles.delete("session-admin");

  let guardCalls = 0;
  const near = {
    getOperation: async () => options?.operation ?? operation,
    cancelNonce: async () => "near-cancel-hash",
    viewFunction: async (_accountId: string, method: string) =>
      method === "get_agent" ? { role: "researcher", active: true, evm_address: [1, 2] } : 3,
  } as unknown as NearClient;
  const guard = {
    approve: async () => {
      guardCalls += 1;
      return { decision: "escalate", reasons: ["recipient not registered"] };
    },
  } as unknown as Guard;
  const treasuryCalls = {
    wallets: [] as Array<{ organizationId: string; userId: string; nearAccountId: string; evmAddress: string }>,
    plans: [] as Array<{ organizationId: string; daoName: string }>,
    registers: [] as Array<{ organizationId: string; actorId: string }>,
    refreshes: [] as Array<{ organizationId: string; actorId: string }>,
  };
  const treasury = {
    linkWallets: async (organizationId: string, userId: string, input: { nearAccountId: string; evmAddress: string }) => {
      treasuryCalls.wallets.push({ organizationId, userId, ...input });
    },
    plan: async (organizationId: string, input: { environment: string; daoName: string; founderNearAccountId: string }) => {
      treasuryCalls.plans.push({ organizationId, daoName: input.daoName });
      return {} as TreasuryPlan;
    },
    register: async (organizationId: string, actorId: string) => {
      treasuryCalls.registers.push({ organizationId, actorId });
      return {} as TreasuryView;
    },
    refresh: async (organizationId: string, actorId: string) => {
      treasuryCalls.refreshes.push({ organizationId, actorId });
      return { status: "active" } as TreasuryView;
    },
    getTreasury: async () => ({ status: options?.treasuryStatus ?? "active" }) as TreasuryView,
  } as TreasuryGateway;
  const mandateCalls: Array<{ organizationId: string; role: string }> = [];
  const mandates: MandateGateway = {
    preview: async (organizationId: string, input: { role: string }) => {
      mandateCalls.push({ organizationId, role: input.role });
      return {} as MandatePreview;
    },
  };
  const registry = {
    loadRegistry: async () => ({
      clientId: "acme",
      registryVersion: 1,
      network: "base-sepolia",
      chainId: 84532,
      token: { symbol: "USDC", address: "0x2222222222222222222222222222222222222222", decimals: 6 },
      roles: {},
    }),
  } as unknown as RegistryService;
  const payments = {
    pay: async () => ({ status: 200, body: {} }),
    getOperation: async () => ({}),
    listEscalations: async () => [],
    decideEscalation: async () => ({}),
  } as unknown as PaymentService;
  const consoleData = {
    overview: async () => ({}),
    operations: async () => [],
    operation: async () => null,
    agentDetail: async () => null,
    governance: async () => ({ proposals: [], delay: null }),
  } as unknown as ConsoleDataService;
  const app = createApp({ near, guard, relayer: {} as BaseRelayer, auth, treasury, mandates, registry, payments, consoleData, consoleOrigin });
  return { app, auth, treasuryCalls, mandateCalls, guardCalls: () => guardCalls };
}

const headers = (extra: Record<string, string>) => ({ "content-type": "application/json", ...extra });
const consoleHeaders = (extra: Record<string, string> = {}) =>
  headers({ origin: consoleOrigin, ...extra });

describe("agent and console boundaries", () => {
  it("rejects an unauthenticated pay request", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/operations/pay", {
      method: "POST",
      headers: headers({}),
      body: JSON.stringify({ opId: Array(32).fill(1) }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a console session on an agent route", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/operations/pay", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ opId: Array(32).fill(1) }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an agent credential on a console route", async () => {
    const { app } = testApp();
    const emergency = await app.request("/v1/emergency/cancel", {
      method: "POST",
      headers: consoleHeaders({ "x-api-key": "key-a" }),
      body: JSON.stringify({ ...requestBody, gasLimit: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" }),
    });
    expect(emergency.status).toBe(401);
    const list = await app.request("/v1/console/agents", {
      headers: { "x-api-key": "key-a", origin: consoleOrigin },
    });
    expect(list.status).toBe(401);
  });

  it("accepts a pay request from a valid agent credential", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/operations/pay", {
      method: "POST",
      headers: headers({ "x-api-key": "key-a" }),
      body: JSON.stringify({ opId: Array(32).fill(1) }),
    });
    expect(response.status).toBe(200);
  });

  it("refuses a revoked agent because no API key resolves", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/operations/pay", {
      method: "POST",
      headers: headers({ "x-api-key": "revoked-key" }),
      body: JSON.stringify({ opId: Array(32).fill(1) }),
    });
    expect(response.status).toBe(401);
  });

  it("no longer exposes the legacy guard route", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/guard/visas", {
      method: "POST",
      headers: headers({ "x-api-key": "key-a" }),
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("blocks the first request over the window budget", () => {
    const limiter = new MemoryRateLimiter(2, 60_000);
    expect(limiter.allow("agent:a")).toBe(true);
    expect(limiter.allow("agent:a")).toBe(true);
    expect(limiter.allow("agent:a")).toBe(false);
    expect(limiter.allow("agent:b")).toBe(true);
  });
});

describe("agent detail", () => {
  it("returns the stored agent and its on-chain state", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/11111111-1111-4111-8111-111111111111", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: { id: string }; onChain: { agent: unknown; nextEvmNonce: number } };
    expect(body.agent.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.onChain.nextEvmNonce).toBe(3);
  });

  it("does not expose another organization's agent", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/22222222-2222-4222-8222-222222222222", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("treasury refresh", () => {
  it("lets an admin re-run verification", async () => {
    const { app, treasuryCalls } = testApp();
    const response = await app.request("/v1/console/treasury/refresh", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ environment: "uat" }),
    });
    expect(response.status).toBe(200);
    expect(treasuryCalls.refreshes).toEqual([{ organizationId: "org-1", actorId: "user-admin" }]);
  });

  it("forbids a member from refreshing", async () => {
    const { app, treasuryCalls } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/treasury/refresh", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({ environment: "uat" }),
    });
    expect(response.status).toBe(403);
    expect(treasuryCalls.refreshes).toEqual([]);
  });
});

describe("passwordless registration", () => {
  it("creates a session without exposing a password route", async () => {
    const { app } = testApp();
    const response = await app.request("/api/register/passkey-start", {
      method: "POST",
      headers: headers({ origin: consoleOrigin }),
      body: JSON.stringify({ email: "new@example.test", name: "New User" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 404 for the password sign-up route", async () => {
    const { app } = testApp();
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: headers({}),
      body: JSON.stringify({ email: "user@example.test", password: "password-123", name: "User" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("mandate preview", () => {
  it("previews a mandate for the session organization", async () => {
    const { app, mandateCalls } = testApp();
    const response = await app.request("/v1/console/mandates/preview", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        role: "researcher",
        operations: ["pay"],
        maxPerTx: "5000000",
        budget: "6000000",
        periodDays: 30,
        recipients: ["0x1111111111111111111111111111111111111111"],
        token: "0x2222222222222222222222222222222222222222",
        gas: {
          gasLimit: "200000",
          maxFeePerGas: "20000000000",
          maxPriorityFeePerGas: "1000000000",
          maxTotalFee: "30000000000000000",
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(mandateCalls).toEqual([{ organizationId: "org-1", role: "researcher" }]);
  });
});

describe("console CSRF protection", () => {
  it("rejects a console request without an Origin header", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents", {
      headers: { cookie: "session-admin" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a console request from another origin", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents", {
      headers: { cookie: "session-admin", origin: "http://evil.test" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a state-changing console request without JSON", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/emergency/cancel", {
      method: "POST",
      headers: { cookie: "session-member", origin: consoleOrigin, "content-type": "text/plain" },
      body: JSON.stringify({ ...requestBody, gasLimit: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1" }),
    });
    expect(response.status).toBe(415);
  });

  it("answers CORS preflight for the console origin", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents", {
      method: "OPTIONS",
      headers: { origin: consoleOrigin, "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("treasury onboarding", () => {
  it("links member wallets inside the session organization", async () => {
    const { app, treasuryCalls } = testApp();
    const response = await app.request("/v1/console/members/me/wallets", {
      method: "PATCH",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({ nearAccountId: "alice.testnet", evmAddress: "0x1111111111111111111111111111111111111111" }),
    });
    expect(response.status).toBe(200);
    expect(treasuryCalls.wallets).toEqual([
      {
        organizationId: "org-1",
        userId: "user-member",
        nearAccountId: "alice.testnet",
        evmAddress: "0x1111111111111111111111111111111111111111",
      },
    ]);
  });

  it("builds a treasury plan for the session organization", async () => {
    const { app, treasuryCalls } = testApp();
    const response = await app.request("/v1/console/treasury/plan", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ daoName: "acme", founderNearAccountId: "alice.testnet" }),
    });
    expect(response.status).toBe(200);
    expect(treasuryCalls.plans).toEqual([{ organizationId: "org-1", daoName: "acme" }]);
  });

  it("forbids a non-admin from registering a treasury", async () => {
    const { app, treasuryCalls } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/treasury/register", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        daoAccountId: "acme.sputnikv2.testnet",
        vaultAccountId: "acme-vault.alice.testnet",
        relayAccountId: "acme-relay.alice.testnet",
        safeAddress: "0x1111111111111111111111111111111111111111",
        rolesAddress: "0x2222222222222222222222222222222222222222",
        delayAddress: "0x3333333333333333333333333333333333333333",
        govAddress: "0x4444444444444444444444444444444444444444",
      }),
    });
    expect(response.status).toBe(403);
    expect(treasuryCalls.registers).toEqual([]);
  });
});

describe("console isolation and emergency", () => {
  it("lists agents for the session organization only", async () => {
    const { app, auth } = testApp();
    const response = await app.request("/v1/console/agents", {
      headers: { cookie: "session-admin", origin: consoleOrigin },
    });
    expect(response.status).toBe(200);
    expect(auth.listedOrganizations).toEqual(["org-1"]);
  });

  it("records an audit row and triggers emergency cancellation for a member", async () => {
    const signedOperation: VaultOperation = {
      ...operation,
      state: "PossiblySigned",
      signed_transaction: [0x02, 0x01],
    };
    const { app, auth } = testApp({ operation: signedOperation });
    const response = await app.request("/v1/emergency/cancel", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({ ...requestBody, gasLimit: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      nearTransactionHash: "near-cancel-hash",
      opId: requestBody.opId,
    });
    expect(auth.audits.map((event) => event.action)).toEqual([
      "emergency.cancel.requested",
      "emergency.cancel.submitted",
    ]);
  });

  it("blocks agent creation while the treasury is pending DAO hardening", async () => {
    const { app, auth } = testApp({ treasuryStatus: "pending_dao_hardening" });
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        name: "Research agent",
        role: "researcher",
        nearAccountId: "agent-c.near",
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: "vault-1.near",
        mpcPath: "agents/researcher/base",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "treasury_not_active", status: "pending_dao_hardening" });
    expect(auth.created).not.toContainEqual(expect.objectContaining({ nearAccountId: "agent-c.near" }));
  });

  it("forbids a member from creating agent credentials", async () => {
    const { app, auth } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        name: "Research agent",
        role: "researcher",
        nearAccountId: "agent-c.near",
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: "vault-1.near",
        mpcPath: "agents/researcher/base",
      }),
    });
    expect(response.status).toBe(403);
    expect(auth.created).toEqual([]);
  });

  it("creates an agent inside the session organization", async () => {
    const { app, auth } = testApp();
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        name: "Research agent",
        role: "researcher",
        nearAccountId: "agent-c.near",
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: "vault-1.near",
        mpcPath: "agents/researcher/base",
      }),
    });
    expect(response.status).toBe(201);
    expect(auth.created).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        nearAccountId: "agent-c.near",
        nearPublicKey: "ed25519:11111111111111111111111111111111",
      }),
    ]);
    expect(auth.audits).toContainEqual(
      expect.objectContaining({ action: "agent.created", actorId: "user-admin" }),
    );
  });

  it("does not revoke an agent from another organization", async () => {
    const { app, auth } = testApp();
    const response = await app.request("/v1/console/agents/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/revoke", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
    });
    expect(response.status).toBe(404);
    expect(auth.revoked).toEqual([
      { organizationId: "org-1", agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    ]);
  });
});
