import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_FUNCTION_CALL_METHODS,
  decodeNearSuccessValue,
  FileAgentKeyStore,
  HttpAgentApi,
  MandateAgentClient,
  omniRolesPaymentRequest,
  proposedAgentAccountId,
  type AgentApiGateway,
  type PaymentIntent,
  type VaultGateway,
} from "./index.js";

const opId = Array(32).fill(1) as number[];
const intent: PaymentIntent = {
  token: Array(20).fill(2),
  recipient: Array(20).fill(3),
  amount: "1000000",
  reference: "INV-1",
  gas_limit: "200000",
  max_fee_per_gas: "20000000000",
  max_priority_fee_per_gas: "1000000000",
};

function fixture(apiStatus = 200) {
  const calls: string[] = [];
  const vault: VaultGateway = {
    prepare: async () => {
      calls.push("prepare");
      return { op_id: opId, state: "Prepared" };
    },
    authorize: async () => {
      calls.push("authorize");
      return "near-authorize-hash";
    },
    cancelNonce: async () => {
      calls.push("cancel_nonce");
      return "near-cancel-hash";
    },
  };
  const api: AgentApiGateway = {
    // Gas is quoted only when callers omit EIP-1559 fields.
    gasQuote: async () => {
      calls.push("gas_quote");
      return {
        gas: {
          gasLimit: "200000",
          maxFeePerGas: "20000000000",
          maxPriorityFeePerGas: "1000000000",
          sufficientBalance: true,
        },
        warnings: [],
      };
    },
    requestVisa: async () => {
      calls.push("visa");
      if (apiStatus === 200) return { status: 200, body: { visa: { op_id: opId }, signature: "signature" } };
      if (apiStatus === 202) return { status: 202, body: { escalationId: "esc-1", reasons: ["bank details changed"] } };
      return { status: 422, body: { error: "recipient_not_allowed", message: "recipient not allowed" } };
    },
    recordAuthorization: async (_operation, hash) => {
      calls.push(`record_authorization:${hash}`);
      return {};
    },
    recordCancellation: async (_operation, hash) => {
      calls.push(`record_cancellation:${hash}`);
      return {};
    },
    status: async () => ({ status: "Confirmed" }),
  };
  return { client: new MandateAgentClient(vault, api), calls };
}

describe("MandateAgentClient", () => {
  it("automatically registers the finalized authorize transaction hash", async () => {
    const { client, calls } = fixture();
    await expect(client.pay(intent)).resolves.toMatchObject({
      outcome: "authorized",
      nearTransactionHash: "near-authorize-hash",
    });
    expect(calls).toEqual([
      "prepare",
      "visa",
      "authorize",
      "record_authorization:near-authorize-hash",
    ]);
  });


  it("quotes Base gas before prepare when the caller omits EIP-1559 fields", async () => {
    const { client, calls } = fixture();
    await client.pay({
      token: intent.token,
      recipient: intent.recipient,
      amount: intent.amount,
      reference: intent.reference,
    });
    expect(calls).toEqual([
      "gas_quote",
      "prepare",
      "visa",
      "authorize",
      "record_authorization:near-authorize-hash",
    ]);
  });
  it("does not authorize an escalation or refusal", async () => {
    const escalated = fixture(202);
    await expect(escalated.client.pay(intent)).resolves.toMatchObject({ outcome: "escalated" });
    expect(escalated.calls).toEqual(["prepare", "visa"]);

    const refused = fixture(422);
    await expect(refused.client.pay(intent)).resolves.toMatchObject({ outcome: "refused" });
    expect(refused.calls).toEqual(["prepare", "visa"]);
  });

  it("lets the agent call cancel_nonce and registers its NEAR hash", async () => {
    const { client, calls } = fixture();
    await expect(client.cancel(opId, {
      gasLimit: "21000",
      maxFeePerGas: "30000000000",
      maxPriorityFeePerGas: "2000000000",
    })).resolves.toMatchObject({ nearTransactionHash: "near-cancel-hash" });
    expect(calls).toEqual(["cancel_nonce", "record_cancellation:near-cancel-hash"]);
  });

  it("posts authorization and cancellation hashes to their operation endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
      return new Response(JSON.stringify({ state: "PossiblySigned" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const api = new HttpAgentApi("http://localhost:3000", "agent-key", fetcher as typeof fetch);
    await api.recordAuthorization(opId, "near-authorize");
    await api.recordCancellation(opId, "near-cancel");
    expect(requests).toEqual([
      {
        url: `http://localhost:3000/v1/operations/0x${"01".repeat(32)}/authorization`,
        body: { nearTransactionHash: "near-authorize" },
      },
      {
        url: `http://localhost:3000/v1/operations/0x${"01".repeat(32)}/cancellation`,
        body: { nearTransactionHash: "near-cancel" },
      },
    ]);
  });

  it("decodes the NEAR SuccessValue returned by prepare", () => {
    const prepared = { op_id: opId, state: "Prepared" };
    expect(decodeNearSuccessValue({
      status: { SuccessValue: Buffer.from(JSON.stringify(prepared)).toString("base64") },
    })).toEqual(prepared);
  });
});

describe("FileAgentKeyStore", () => {
  it("creates and reuses a client-side ed25519 key file with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mandateos-sdk-"));
    const path = join(directory, "agent-key.json");
    const store = new FileAgentKeyStore(path);
    const created = await store.loadOrCreate("testnet", "agent.testnet");
    const loaded = await store.loadOrCreate("testnet", "agent.testnet");
    expect(loaded).toEqual(created);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ publicKey: created.publicKey });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("OmniRoles SDK", () => {
  it("derives the account id and exposes only member-authorized FunctionCall methods", () => {
    expect(proposedAgentAccountId("Compta Bot", "mandateos.testnet")).toBe("compta-bot-agent.mandateos.testnet");
    expect(AGENT_FUNCTION_CALL_METHODS).toEqual([
      "prepare",
      "authorize",
      "cancel_nonce",
      "renounce_role",
    ]);
  });

  it("encodes a direct ERC-20 transfer from the shared chain wallet", () => {
    const request = omniRolesPaymentRequest(intent, 84_532);
    expect(request).toMatchObject({
      chain_id: 84_532,
      target: intent.token,
      value: "0",
      allowance_amount: intent.amount,
      reference: intent.reference,
    });
    expect(request.calldata.slice(0, 4)).toEqual([0xa9, 0x05, 0x9c, 0xbb]);
    expect(request.calldata.slice(16, 36)).toEqual(intent.recipient);
    expect(BigInt(`0x${Buffer.from(request.calldata.slice(36)).toString("hex")}`)).toBe(1_000_000n);
  });
});
