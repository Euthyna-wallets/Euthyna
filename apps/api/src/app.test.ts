import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Env } from "./env.js";
import type { Guard } from "./guard.js";
import type { NearClient } from "./near.js";
import type { BaseRelayer } from "./relayer.js";

const env: Env = {
  PORT: 3000,
  NEAR_NETWORK_ID: "testnet",
  NEAR_RPC_URL: "https://rpc.testnet.near.org",
  BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
  VENDOR_REGISTRY_PATH: "config/clients/acme/vendors.json",
  GUARD_ED25519_PRIVATE_KEY_BASE64: "unused",
  NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
  NEAR_RELAYER_PRIVATE_KEY: "ed25519:unused",
  AGENT_API_TOKEN: "test-token-at-least-24-characters",
};

const requestBody = {
  vaultAccountId: "acme-vault.testnet",
  opId: Array(32).fill(1),
};

function testApp() {
  const near = {
    getOperation: async () => ({ state: "Prepared" }),
  } as unknown as NearClient;
  const guard = {
    approve: async () => ({ decision: "escalate", reasons: ["recipient not registered"] }),
  } as unknown as Guard;
  const relayer = {} as BaseRelayer;
  return createApp(env, near, guard, relayer);
}

describe("Hono API", () => {
  it("rejects an unauthenticated Guard request", async () => {
    const response = await testApp().request("/v1/guard/visas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(401);
  });

  it("returns an explicit escalation instead of a visa for an uncovered case", async () => {
    const response = await testApp().request("/v1/guard/visas", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AGENT_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      decision: "escalate",
      reasons: ["recipient not registered"],
    });
  });
});
