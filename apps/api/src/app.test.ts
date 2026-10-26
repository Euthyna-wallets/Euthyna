import { proposedAgentAccountId } from "@mandateos/sdk";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createApp, MAX_PENDING_HIRES_PER_MEMBER } from "./app.js";
import type { AgentProvisioningService } from "./agent-provisioning.js";
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
import type { NearClient } from "./near.js";
import type { VaultOperation } from "./types.js";
import type { RegistryService } from "./registry-db.js";
import type { PaymentService } from "./payments.js";

const transferCalldata = [
  0xa9, 0x05, 0x9c, 0xbb,
  ...Array(12).fill(0),
  ...Array(20).fill(0x66),
  ...Array(29).fill(0),
  0x0f, 0x42, 0x40,
] as number[];
const operation: VaultOperation = {
  op_id: Array(32).fill(1) as number[],
  client_id: "acme",
  member: "agent-a.near",
  role: "researcher",
  request: {
    chain_id: 84532,
    target: Array(20).fill(0x83),
    value: "0",
    calldata: transferCalldata,
    allowance_amount: "1000000",
    reference: "INV-1",
    gas_limit: "200000",
    max_fee_per_gas: "20000000000",
    max_priority_fee_per_gas: "1000000000",
  },
  permission_index: 0,
  consumptions: [{ key: Array(32).fill(0x55), amount: "1000000", calls_only: false }],
  measured_value: "1000000",
  policy_version: 1,
  registry_version: 1,
  evm_nonce: 0,
  transaction: {
    chain_id: 84532,
    nonce: 0,
    to: Array(20).fill(0x83),
    value: "0",
    input: transferCalldata,
    gas_limit: "200000",
    max_fee_per_gas: "20000000000",
    max_priority_fee_per_gas: "1000000000",
  },
  tx_digest: Array(32).fill(2),
  created_at_ns: "1",
  expires_at_ns: "100000000000",
  execute_after_ns: null,
  visa_authorized: false,
  cosigned_by: null,
  possibly_signed_at_ns: null,
  state: "Prepared",
  signature: null,
  signed_transaction: null,
  cancellation: null,
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

const admin: ConsoleIdentity = { userId: "user-admin", memberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: "org-1", role: "admin", email: "admin@example.test", emailVerified: true };
const member: ConsoleIdentity = { userId: "user-member", memberId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organizationId: "org-1", role: "member", email: "member@example.test", emailVerified: true };

const requestBody = { vaultAccountId: "vault-1.near", opId: Array(32).fill(1) };
const consoleOrigin = "http://console.test";

class FakeAuth implements AuthGateway {
  readonly agents = new Map<string, AgentIdentity>();
  readonly consoles = new Map<string, ConsoleIdentity>();
  readonly audits: AuditEvent[] = [];
  readonly listedOrganizations: string[] = [];
  readonly created: CreateAgentInput[] = [];
  readonly listed: AgentView[] = [];
  readonly revoked: Array<{ organizationId: string; agentId: string }> = [];
  sponsorshipReservation: import("./auth-gateway.js").NearSponsorshipReservation = "reserved";
  readonly completedSponsorships: Array<{ nearAccountId: string; succeeded: boolean }> = [];

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
    return Promise.resolve(this.listed.filter(() => organizationId === "org-1"));
  }

  setAgentEvmAddress(organizationId: string, agentId: string, evmAddress: string) {
    return this.getAgent(organizationId, agentId).then((agent) => agent ? ({ ...agent, evmAddress }) : null);
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
      createdByUserId: "user-admin",
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
        createdByUserId: input.createdByUserId,
        createdAt: new Date(0),
      },
      apiKey: "mdo_secret",
    });
  }

  revokeAgent(organizationId: string, agentId: string): Promise<boolean> {
    this.revoked.push({ organizationId, agentId });
    return Promise.resolve(agentId === "agent-a" && organizationId === "org-1");
  }


  reserveNearWalletSponsorship() {
    return Promise.resolve(this.sponsorshipReservation);
  }

  completeNearWalletSponsorship(nearAccountId: string, succeeded: boolean): Promise<void> {
    this.completedSponsorships.push({ nearAccountId, succeeded });
    return Promise.resolve();
  }


  recordAudit(event: AuditEvent): Promise<void> {
    this.audits.push(event);
    return Promise.resolve();
  }
}

function testApp(options?: {
  operation?: VaultOperation;
  consoleRole?: "admin" | "member";
  treasuryStatus?: string;
  sponsorshipReservation?: import("./auth-gateway.js").NearSponsorshipReservation;
}) {
  const auth = new FakeAuth();
  auth.agents.set("key-a", agentA);
  auth.agents.set("key-b", agentB);
  auth.consoles.set("session-admin", admin);
  auth.consoles.set("session-member", member);
  if (options?.consoleRole === "member") auth.consoles.delete("session-admin");
  if (options?.sponsorshipReservation) auth.sponsorshipReservation = options.sponsorshipReservation;

  const nearCalls = {
    sponsored: [] as Array<{ accountId: string; publicKey: string; amountYocto: string }>,
  };
  const near = {
    getOperation: async () => options?.operation ?? operation,
    getAccount: async () => ({ code_hash: "11111111111111111111111111111111", amount: "832000000000000000000000", storage_usage: 182 }),
    getAccessKeys: async () => ({ keys: [] }),
    createSubaccount: async (accountId: string, publicKey: string, amountYocto: string) => {
      nearCalls.sponsored.push({ accountId, publicKey, amountYocto });
      return accountId;
    },
    cancelNonce: async () => "near-cancel-hash",
    viewFunction: async (_accountId: string, method: string) =>
      method === "get_agent" ? { role: "researcher", active: true, evm_address: Array(20).fill(1) } : 3,
    proxyRpc: async (method: string) => ({ proxiedMethod: method }),
  } as unknown as NearClient;
  const registry = {} as unknown as RegistryService;
  const payments = {
    gasQuote: async () => ({
      gas: {
        gasLimit: "100000",
        maxFeePerGas: "20000000000",
        maxPriorityFeePerGas: "1000000000",
        baseFeePerGas: "6333333333",
        l1Fee: "1000",
        senderBalance: "1000000000000000000",
        requiredBalance: "2000000000001000",
        sufficientBalance: true,
      },
      warnings: [],
    }),
    pay: async () => ({ status: 200, body: {} }),
    getOperation: async () => ({}),
    recordAuthorization: async (
      organizationId: string,
      agent: AgentIdentity,
      opId: number[],
      nearTransactionHash: string,
    ) => ({
      organizationId,
      agentId: agent.agentId,
      opId,
      nearTransactionHash,
      state: "PossiblySigned",
    }),
    recordCancellation: async (
      organizationId: string,
      agent: AgentIdentity,
      opId: number[],
      nearTransactionHash: string,
    ) => ({
      organizationId,
      agentId: agent.agentId,
      opId,
      nearTransactionHash,
      state: "CancellationRequested",
    }),
  } as unknown as PaymentService;
  const agentProvisioning = {
    provision: async () => ({
      status: "provisioned",
      transactionHash: "near-provision",
      attestation: { valid: true },
    }),
    status: async () => ({
      status: "provisioned",
      transactionHash: "near-provision",
      confirmedAt: null,
      attestation: { valid: true },
    }),
    confirm: async () => ({
      status: "confirmed",
      confirmedAt: new Date(0),
      attestation: { valid: true },
    }),
  } as unknown as AgentProvisioningService;
  const app = createApp({
    near,
    auth,
    agentProvisioning,
    treasuries: {
      activeTreasury: async () => ({ status: options?.treasuryStatus ?? "active", daoAccountId: "dao.testnet", vaultAccountId: "vault-1.near" }),
    },
    registry,
    payments,
    consoleOrigin,
    nearParentAccount: "mandateos.testnet",
  });
  return { app, auth, nearCalls };
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

  it("records the finalized NEAR authorization transaction for worker recovery", async () => {
    const { app } = testApp();
    const nearTransactionHash = "1".repeat(43);
    const response = await app.request(`/v1/operations/0x${"01".repeat(32)}/authorization`, {
      method: "POST",
      headers: headers({ "x-api-key": "key-a" }),
      body: JSON.stringify({ nearTransactionHash }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizationId: "org-1",
      agentId: "agent-a",
      nearTransactionHash,
      state: "PossiblySigned",
    });
  });

  it("records an agent-signed cancellation transaction for worker recovery", async () => {
    const { app } = testApp();
    const nearTransactionHash = "2".repeat(43);
    const response = await app.request(`/v1/operations/0x${"01".repeat(32)}/cancellation`, {
      method: "POST",
      headers: headers({ "x-api-key": "key-a" }),
      body: JSON.stringify({ nearTransactionHash }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizationId: "org-1",
      agentId: "agent-a",
      nearTransactionHash,
      state: "CancellationRequested",
    });
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
  it("returns the stored agent", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/11111111-1111-4111-8111-111111111111", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: { id: string } };
    expect(body.agent.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("does not expose another organization's agent", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/22222222-2222-4222-8222-222222222222", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("sign-in boundaries", () => {
  it("returns 404 for password sign-up and sign-in routes", async () => {
    const { app } = testApp();
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/email"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: headers({}),
        body: JSON.stringify({ email: "user@example.test", password: "password-123", name: "User" }),
      });
      expect(response.status).toBe(404);
    }
  });

  it("refuses Better Auth invitations: members follow the DAO", async () => {
    const { app } = testApp();
    const response = await app.request("/api/auth/organization/accept-invitation", {
      method: "POST",
      headers: headers({ cookie: "session-member" }),
      body: JSON.stringify({ invitationId: "invite-1" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "members_follow_the_dao" });
  });
});


describe("console NEAR RPC proxy", () => {
  it("forwards only allowlisted methods for an authenticated console session", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/near-rpc", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "query", params: { finality: "final" } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { proxiedMethod: "query" },
    });
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

  const hireBody = (name: string) => JSON.stringify({
    name,
    role: "researcher",
    nearAccountId: proposedAgentAccountId(name, "mandateos.testnet", "org-1"),
    nearPublicKey: "ed25519:11111111111111111111111111111111",
    vaultAccountId: "vault-1.near",
    mpcPath: "agents/researcher/base",
  });
  const pendingHire = (n: number, createdByUserId: string): AgentView => ({
    id: `pending-${createdByUserId}-${n}`,
    name: `Pending ${n}`,
    role: "researcher",
    nearAccountId: `pending-${n}.mandateos.testnet`,
    nearPublicKey: "ed25519:11111111111111111111111111111111",
    vaultAccountId: "vault-1.near",
    evmAddress: null,
    mpcPath: "agents/researcher/base",
    active: true,
    createdByUserId,
    createdAt: new Date(0),
  });

  it("lets a council member hire an agent, recorded as theirs", async () => {
    const { app, auth } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: hireBody("Member agent"),
    });
    expect(response.status).toBe(201);
    expect(auth.created).toEqual([expect.objectContaining({ organizationId: "org-1", createdByUserId: "user-member" })]);
  });

  it(`caps a member at ${MAX_PENDING_HIRES_PER_MEMBER} hires waiting for a role`, async () => {
    const { app, auth } = testApp({ consoleRole: "member" });
    for (let n = 0; n < MAX_PENDING_HIRES_PER_MEMBER; n += 1) auth.listed.push(pendingHire(n, "user-member"));
    auth.listed.push(pendingHire(99, "user-other"));
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: hireBody("One too many"),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "too_many_pending_hires", limit: MAX_PENDING_HIRES_PER_MEMBER }));
    expect(auth.created).toEqual([]);
  });

  it("does not cap an admin", async () => {
    const { app, auth } = testApp();
    for (let n = 0; n < MAX_PENDING_HIRES_PER_MEMBER + 2; n += 1) auth.listed.push(pendingHire(n, "user-admin"));
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: hireBody("Admin agent"),
    });
    expect(response.status).toBe(201);
  });

  it("forbids a member from provisioning or revoking an agent someone else hired", async () => {
    const { app, auth } = testApp({ consoleRole: "member" });
    for (const action of ["provision", "revoke"]) {
      const response = await app.request(`/v1/console/agents/11111111-1111-4111-8111-111111111111/${action}`, {
        method: "POST",
        headers: consoleHeaders({ cookie: "session-member" }),
      });
      expect(response.status).toBe(403);
    }
    expect(auth.revoked).toEqual([]);
  });

  it("tells the console which account an agent will get, so its key can be made in euthyna-signer first", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/proposed-account?name=Research%20agent", {
      headers: consoleHeaders({ cookie: "session-admin" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: proposedAgentAccountId("Research agent", "mandateos.testnet", "org-1") });

    const invalid = await app.request("/v1/console/agents/proposed-account?name=%20", { headers: consoleHeaders({ cookie: "session-admin" }) });
    expect(invalid.status).toBe(422);
    const member = await app.request("/v1/console/agents/proposed-account?name=x1", { headers: consoleHeaders({ cookie: "session-member" }) });
    expect(member.status).toBe(200);
  });

  it("creates an agent inside the session organization", async () => {
    const { app, auth } = testApp();
    const response = await app.request("/v1/console/agents", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        name: "Research agent",
        role: "researcher",
        nearAccountId: proposedAgentAccountId("Research agent", "mandateos.testnet", "org-1"),
        nearPublicKey: "ed25519:11111111111111111111111111111111",
        vaultAccountId: "vault-1.near",
        mpcPath: "agents/researcher/base",
      }),
    });
    expect(response.status).toBe(201);
    expect(auth.created).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        nearAccountId: expect.stringMatching(/^research-agent-[0-9a-f]{6}-agent\.mandateos\.testnet$/),
        nearPublicKey: "ed25519:11111111111111111111111111111111",
      }),
    ]);
    expect(auth.audits).toContainEqual(
      expect.objectContaining({ action: "agent.created", actorId: "user-admin" }),
    );
  });

  it("provisions an agent and rate-limits repeated sponsor requests", async () => {
    const { app, auth } = testApp();
    const path = "/v1/console/agents/11111111-1111-4111-8111-111111111111/provision";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await app.request(path, {
        method: "POST",
        headers: consoleHeaders({ cookie: "session-admin" }),
      })).status);
    }
    expect(statuses).toEqual([...Array(10).fill(201), 429]);
    expect(auth.audits).toContainEqual(
      expect.objectContaining({ action: "agent.provisioned", actorId: "user-admin" }),
    );
  });

  it("does not revoke an agent from another organization", async () => {
    const { app, auth } = testApp();
    const response = await app.request("/v1/console/agents/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/revoke", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
    });
    expect(response.status).toBe(404);
    expect(auth.revoked).toEqual([]);
  });
});
