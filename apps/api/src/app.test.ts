import { proposedAgentAccountId } from "@mandateos/sdk";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
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
import type { Guard } from "./guard.js";
import type { GovernanceGateway } from "./governance.js";
import type { NearClient } from "./near.js";
import type { BaseRelayer } from "./relayer.js";
import type { VaultOperation } from "./types.js";
import type { TreasuryGateway, TreasuryPlan, TreasuryView } from "./treasury.js";
import type { MandateGateway, MandatePreview } from "./mandates.js";
import type { RegistryService } from "./registry-db.js";
import type { PaymentService } from "./payments.js";
import type { ConsoleDataService } from "./console-data.js";
import { WalletProofError, type WalletProofGateway } from "./wallet-proof.js";

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
  readonly revoked: Array<{ organizationId: string; agentId: string }> = [];
  sponsorshipReservation: import("./auth-gateway.js").NearSponsorshipReservation = "reserved";
  readonly completedSponsorships: Array<{ nearAccountId: string; succeeded: boolean }> = [];

  handler(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 404 }));
  }

  identifyAgent(apiKey: string | undefined): Promise<AgentIdentity | null> {
    return Promise.resolve(apiKey ? (this.agents.get(apiKey) ?? null) : null);
  }


  identifyPasskeyUser(headers: Headers) {
    const cookie = headers.get("cookie");
    const identity = cookie ? this.consoles.get(cookie) : null;
    return Promise.resolve(identity ? { userId: identity.userId, email: identity.email, emailVerified: identity.emailVerified } : null);
  }
  identifyConsole(headers: Headers): Promise<ConsoleIdentity | null> {
    const cookie = headers.get("cookie");
    return Promise.resolve(cookie ? (this.consoles.get(cookie) ?? null) : null);
  }

  listAgents(organizationId: string): Promise<AgentView[]> {
    this.listedOrganizations.push(organizationId);
    return Promise.resolve([]);
  }

  setAgentEvmAddress(organizationId: string, agentId: string, evmAddress: string) {
    return this.getAgent(organizationId, agentId).then((agent) => agent ? ({ ...agent, evmAddress }) : null);
  }

  listMembers(): Promise<import("./auth-gateway.js").MemberView[]> {
    return Promise.resolve([]);
  }

  setMemberWallets(_organizationId: string, memberId: string, input: { nearAccountId: string; evmAddress: string }) {
    return Promise.resolve({
      id: memberId,
      userId: "user-owner",
      role: "owner",
      nearAccountId: input.nearAccountId,
      evmAddress: input.evmAddress,
      email: "owner@acme.test",
      name: "Owner",
      walletProofClaimable: false,
      walletProofVerifiedAt: null,
      walletProofApprovedAt: null,
      walletProofApprovedBy: null,
    });
  }

  addMember(_organizationId: string, input: { name: string; nearAccountId: string; evmAddress: string }) {
    return Promise.resolve({
      id: "member-new",
      userId: "user-new",
      role: "member",
      nearAccountId: input.nearAccountId,
      evmAddress: input.evmAddress,
      email: null,
      name: input.name,
      walletProofClaimable: true,
      walletProofVerifiedAt: null,
      walletProofApprovedAt: null,
      walletProofApprovedBy: null,
    });
  }

  decideMemberWalletProof(
    _organizationId: string,
    memberId: string,
    actorId: string,
    input: { decision: "approve" | "reject" },
  ) {
    return Promise.resolve({
      id: memberId,
      userId: "user-member",
      role: "member",
      nearAccountId: input.decision === "approve" ? "member.testnet" : null,
      evmAddress: input.decision === "approve" ? "0x0000000000000000000000000000000000000001" : null,
      email: "member@example.test",
      name: "Member",
      walletProofClaimable: false,
      walletProofVerifiedAt: input.decision === "approve" ? new Date() : null,
      walletProofApprovedAt: input.decision === "approve" ? new Date() : null,
      walletProofApprovedBy: input.decision === "approve" ? actorId : null,
    });
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

  startPasskeyRegistration(): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify({ context: "signed-registration-context" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
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
  registrationRateLimitEnabled?: boolean;
  walletProofError?: WalletProofError;
}) {
  const auth = new FakeAuth();
  auth.agents.set("key-a", agentA);
  auth.agents.set("key-b", agentB);
  auth.consoles.set("session-admin", admin);
  auth.consoles.set("session-member", member);
  if (options?.consoleRole === "member") auth.consoles.delete("session-admin");
  if (options?.sponsorshipReservation) auth.sponsorshipReservation = options.sponsorshipReservation;

  let guardCalls = 0;
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
  const guard = {
    approve: async () => {
      guardCalls += 1;
      return { decision: "escalate", reasons: ["recipient not registered"] };
    },
  } as unknown as Guard;
  const treasuryCalls = {
    plans: [] as Array<{ organizationId: string; daoName: string }>,
    registers: [] as Array<{ organizationId: string; actorId: string }>,
    refreshes: [] as Array<{ organizationId: string; actorId: string }>,
  };
  const confirmationStatus = {
    digest: "deployment-digest",
    confirmedMemberIds: [admin.memberId, member.memberId],
    requiredMemberIds: [admin.memberId, member.memberId],
  };
  const treasury: TreasuryGateway = {
    plan: async (organizationId, input) => {
      treasuryCalls.plans.push({ organizationId, daoName: input.daoName });
      return {} as TreasuryPlan;
    },
    register: async (organizationId, actorId) => {
      treasuryCalls.registers.push({ organizationId, actorId });
      return {} as TreasuryView;
    },
    deployContracts: async () => ({ vaultTxHash: "v", relayTxHash: "r" }),
    confirmNearDeployment: async () => confirmationStatus,
    nearDeploymentConfirmations: async () => confirmationStatus,
    refresh: async (organizationId, actorId) => {
      treasuryCalls.refreshes.push({ organizationId, actorId });
      return { status: "active" } as TreasuryView;
    },
    getTreasury: async () => ({ status: options?.treasuryStatus ?? "active" }) as TreasuryView,
  };
  const mandateCalls: Array<{ organizationId: string; role: string }> = [];
  const mandates: MandateGateway = {
    preview: async (organizationId: string, input: { role: string }) => {
      mandateCalls.push({ organizationId, role: input.role });
      return {} as MandatePreview;
    },
    zodiacProposal: async () => ({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: "Zodiac",
      args: {},
      deposit: "0",
    }),
    budgetTokenStatus: async () => ({
      environment: "uat",
      tokenAccountId: "test-ft.testnet",
      symbol: "TestUSDC",
      decimals: 6,
      daoAccountId: "dao.testnet",
      vaultAccountId: "vault.testnet",
      daoStorageRegistered: true,
      vaultStorageRegistered: true,
      daoBalance: "6000000",
      storageDepositYocto: "1250000000000000000000",
    }),
    budgetTokenPlan: async () => ({
      status: {
        environment: "uat",
        tokenAccountId: "test-ft.testnet",
        symbol: "TestUSDC",
        decimals: 6,
        daoAccountId: "dao.testnet",
        vaultAccountId: "vault.testnet",
        daoStorageRegistered: true,
        vaultStorageRegistered: true,
        daoBalance: "6000000",
        storageDepositYocto: "1250000000000000000000",
      },
      actions: [],
    }),
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
  const walletProof: WalletProofGateway = {
    createChallenge: async (_identity, input) => {
      if (options?.walletProofError) throw options.walletProofError;
      return {
        id: "11111111-1111-4111-8111-111111111111",
        memberId: input.memberId,
        nearAccountId: input.nearAccountId,
        evmAddress: input.evmAddress,
        message: "proof",
        nonceBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        recipient: "mandateos.testnet",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    verify: async () => ({ memberId: admin.memberId, organizationId: admin.organizationId }),
    invitation: async (_identity, memberId) => ({
      memberId,
      memberName: "Ben",
      role: "member",
      organizationName: "ACME",
      invitedEmail: "ben@acme.test",
    }),
  };
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
  const governanceGas = {
    gasQuote: {
      gasLimit: "200000",
      maxFeePerGas: "20000000000",
      maxPriorityFeePerGas: "1000000000",
      baseFeePerGas: "6333333333",
      l1Fee: "1000",
      senderBalance: "1000000000000000000",
      requiredBalance: "4000000000001000",
      sufficientBalance: true,
    },
    warnings: [],
  };
  const governance: GovernanceGateway = {
    recordRelayExecution: async () => ({ opId: `0x${"01".repeat(32)}`, state: "PossiblySigned" }),
    unblockProposal: async () => ({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: "Unblock relay",
      args: {},
      deposit: "0",
    }),
    cancelUnderpricedProposal: async () => ({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: "Cancel underpriced operation",
      args: {},
      deposit: "0",
      ...governanceGas,
    }),
    swapOwnerProposal: async () => ({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: "Swap Safe owner",
      args: {},
      deposit: "0",
      ...governanceGas,
    }),
    addOwnerProposal: async () => ({
      receiverId: "dao.testnet",
      methodName: "add_proposal",
      description: "Add Safe owner",
      args: {},
      deposit: "0",
      ...governanceGas,
    }),
  };
  const app = createApp({
    near,
    guard,
    relayer: {} as BaseRelayer,
    auth,
    walletProof,
    agentProvisioning,
    treasury,
    governance,
    mandates,
    registry,
    payments,
    consoleData,
    consoleOrigin,
    nearParentAccount: "mandateos.testnet",
    nearSponsorDailyWalletLimit: 2,
    nearSponsorWalletAmountYocto: "500000000000000000000000",
    registrationRateLimitEnabled: options?.registrationRateLimitEnabled ?? true,
  });
  return { app, auth, treasuryCalls, mandateCalls, nearCalls, guardCalls: () => guardCalls };
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
  it("returns the stored agent and its on-chain state", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/11111111-1111-4111-8111-111111111111", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agent: { id: string }; onChain: { agent: unknown; nextEvmNonce: number } };
    expect(body.agent.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.onChain.nextEvmNonce).toBe(3);
    expect(body.agent).toMatchObject({ evmAddress: "0x0101010101010101010101010101010101010101" });
  });

  it("does not expose another organization's agent", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/agents/22222222-2222-4222-8222-222222222222", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("members", () => {
  it("adds a wallet-only member for an admin", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/members", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        name: "Alice",
        nearAccountId: "alice.testnet",
        evmAddress: "0x1111111111111111111111111111111111111111",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ nearAccountId: "alice.testnet", name: "Alice" });
  });

  it("invites a member by email without requiring wallet re-entry by the founder", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/members", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ name: "Bob", email: "bob@example.test" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "Bob" });
  });

  it("normalizes annotated wallet values", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/members", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        name: "Alice",
        nearAccountId: "busyvideo615.testnet (*testnet)",
        evmAddress: "0x1111111111111111111111111111111111111111 (Base Sepolia)",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ nearAccountId: "busyvideo615.testnet" });
  });

  it("lets an admin set wallets on an existing member", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/console/members/member-1/wallets", {
      method: "PATCH",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({
        nearAccountId: "owner.testnet",
        evmAddress: "0x3333333333333333333333333333333333333333",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nearAccountId: "owner.testnet" });
  });

  it("forbids a non-admin member from adding a member", async () => {
    const { app } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/members", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        name: "Bob",
        nearAccountId: "bob.testnet",
        evmAddress: "0x2222222222222222222222222222222222222222",
      }),
    });
    expect(response.status).toBe(403);
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
  const nearPublicKey = "ed25519:11111111111111111111111111111111";
  const nearAccountId = `w-${createHash("sha256").update(nearPublicKey).digest("hex").slice(0, 12)}.mandateos.testnet`;

  it("issues a signed passkey registration context and defers NEAR funding", async () => {
    const { app, nearCalls } = testApp();
    const response = await app.request("/api/register/passkey-start", {
      method: "POST",
      headers: headers({ origin: consoleOrigin, "x-real-ip": "198.51.100.1" }),
      body: JSON.stringify({ email: "NEW@example.test", name: "New User", nearPublicKey }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ context: "signed-registration-context", nearAccountId });
    expect(nearCalls.sponsored).toEqual([]);
  });


  it("rate-limits repeated registration by normalized email", async () => {
    const { app } = testApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.request("/api/register/passkey-start", {
        method: "POST",
        headers: headers({ origin: consoleOrigin, "x-real-ip": `198.51.100.${attempt + 1}` }),
        body: JSON.stringify({ email: "RateLimit@Example.test", name: "User" }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("rate-limits registration by remote IP across emails", async () => {
    const { app } = testApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.request("/api/register/passkey-start", {
        method: "POST",
        headers: headers({ origin: consoleOrigin, "x-real-ip": "203.0.113.10" }),
        body: JSON.stringify({ email: `user-${attempt}@example.test`, name: "User" }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });


  it("disables registration throttling only for explicit UAT demo mode", async () => {
    const { app } = testApp({ registrationRateLimitEnabled: false });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.request("/api/register/passkey-start", {
        method: "POST",
        headers: headers({ origin: consoleOrigin, "x-real-ip": "203.0.113.20" }),
        body: JSON.stringify({ email: "uat-demo@example.test", name: "UAT User" }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });
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

  it("refuses Better Auth email invitations in favor of wallet-proof claims", async () => {
    const { app } = testApp();
    const response = await app.request("/api/auth/organization/accept-invitation", {
      method: "POST",
      headers: headers({ cookie: "session-member" }),
      body: JSON.stringify({ invitationId: "invite-1" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "wallet_proof_required" });
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

describe("founder wallet sponsorship", () => {
  const nearPublicKey = "ed25519:11111111111111111111111111111111";
  const nearAccountId = `w-${createHash("sha256").update(nearPublicKey).digest("hex").slice(0, 12)}.mandateos.testnet`;

  it("funds the founder wallet only through the authenticated DAO-time route", async () => {
    const { app, auth, nearCalls } = testApp();
    const response = await app.request("/v1/console/treasury/sponsor-founder-wallet", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ nearAccountId, nearPublicKey }),
    });
    expect(response.status).toBe(201);
    expect(nearCalls.sponsored).toEqual([{
      accountId: nearAccountId,
      publicKey: nearPublicKey,
      amountYocto: "500000000000000000000000",
    }]);
    expect(auth.completedSponsorships).toEqual([{ nearAccountId, succeeded: true }]);
  });

  it("enforces the durable daily sponsorship cap before funding", async () => {
    const { app, nearCalls } = testApp({ sponsorshipReservation: "daily_limit" });
    const response = await app.request("/v1/console/treasury/sponsor-founder-wallet", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-admin" }),
      body: JSON.stringify({ nearAccountId, nearPublicKey }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "daily_sponsorship_limit" });
    expect(nearCalls.sponsored).toEqual([]);
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
  it("returns UAT budget-token state and an unsigned member-executed plan", async () => {
    const { app } = testApp();
    const status = await app.request("/v1/console/treasury/budget-token", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ decimals: 6, symbol: "TestUSDC" });

    const plan = await app.request("/v1/console/treasury/budget-token/plan", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({ amount: "6000000" }),
    });
    expect(plan.status).toBe(200);
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
  it("starts a wallet proof challenge from a passkey session", async () => {
    const { app } = testApp();
    const response = await app.request("/v1/profile/wallet-proof/challenge", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        memberId: "better-auth-member-id",
        nearAccountId: "alice.testnet",
        evmAddress: "0x1111111111111111111111111111111111111111",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      memberId: "better-auth-member-id",
      nearAccountId: "alice.testnet",
      evmAddress: "0x1111111111111111111111111111111111111111",
      message: "proof",
    });
  });

  it("returns 403 when a session email does not match the invited seat", async () => {
    const { app } = testApp({
      walletProofError: new WalletProofError(403, "invitation_email_mismatch", "This invitation belongs to another email address"),
    });
    const response = await app.request("/v1/profile/wallet-proof/challenge", {
      method: "POST",
      headers: consoleHeaders({ cookie: "session-member" }),
      body: JSON.stringify({
        memberId: "ben-invitation",
        nearAccountId: "mallory.testnet",
        evmAddress: "0x1111111111111111111111111111111111111111",
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "invitation_email_mismatch" });
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

  it("returns the public sponsor balance without requiring admin role", async () => {
    const { app } = testApp({ consoleRole: "member" });
    const response = await app.request("/v1/console/treasury/sponsor-status", {
      headers: consoleHeaders({ cookie: "session-member" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountId: "mandateos.testnet",
      balanceYocto: "832000000000000000000000",
      storageUsage: 182,
    });
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
    expect(auth.revoked).toEqual([
      { organizationId: "org-1", agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    ]);
  });
});
