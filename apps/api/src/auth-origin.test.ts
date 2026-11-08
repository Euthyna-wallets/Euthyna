import { createHash } from "node:crypto";

import { serializeNep413 } from "@near-wallet-selector/core";
import { getTestInstance } from "better-auth/test";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { buildAuthOptions, type AuthEnvironment } from "./auth.js";

const authEnv: AuthEnvironment = {
  BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
  BETTER_AUTH_URL: "http://api.example.com",
  CONSOLE_ORIGIN: "http://console.example.com",
};
const near = { recipient: "console.example.com", isFullAccessKey: async () => true };

describe("console authentication", () => {
  it("keeps email/password disabled and signs people in with NEAR only", () => {
    const options = buildAuthOptions(authEnv, undefined, near);
    expect(options.emailAndPassword?.enabled).toBe(false);
    const plugins = options.plugins?.map((plugin) => plugin.id) ?? [];
    expect(plugins).toContain("near-sign-in");
    expect(plugins).not.toContain("passkey");
    expect(plugins).not.toContain("email-otp");
  });

  it("issues a NEP-413 challenge for the console origin only", async () => {
    // The test harness seeds a user with email/password; the console never enables it.
    const { auth } = await getTestInstance({ ...buildAuthOptions(authEnv, undefined, near), emailAndPassword: { enabled: true } }, { port: 3001 });
    const challenge = await auth.handler(new Request(`${authEnv.BETTER_AUTH_URL}/api/auth/near/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: authEnv.CONSOLE_ORIGIN },
      body: JSON.stringify({ accountId: "alice.testnet" }),
    }));
    expect(challenge.status).toBe(200);
    const body = (await challenge.json()) as { message: string; recipient: string };
    expect(body.recipient).toBe("console.example.com");
    expect(body.message).toContain("account_id: alice.testnet");

    const context = await auth.$context;
    expect(context.trustedOrigins).toContain("http://console.example.com");
    expect(context.trustedOrigins).not.toContain("http://evil.example.com");
  });

  it("says NEAR is not answering, instead of blaming the key, when the key check fails", async () => {
    const down = { recipient: "console.example.com", isFullAccessKey: async () => { throw new Error("NEAR RPC HTTP 429"); } };
    const { auth } = await getTestInstance({ ...buildAuthOptions(authEnv, undefined, down), emailAndPassword: { enabled: true } }, { port: 3001 });
    const headers = { "content-type": "application/json", origin: authEnv.CONSOLE_ORIGIN };
    const challenge = (await (await auth.handler(new Request(`${authEnv.BETTER_AUTH_URL}/api/auth/near/challenge`, {
      method: "POST", headers, body: JSON.stringify({ accountId: "alice.testnet" }),
    }))).json()) as { message: string; recipient: string; nonceBase64: string };
    const key = KeyPair.fromRandom("ed25519");
    const digest = createHash("sha256").update(serializeNep413({ message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(challenge.nonceBase64, "base64") })).digest();
    const response = await auth.handler(new Request(`${authEnv.BETTER_AUTH_URL}/api/auth/sign-in/near`, {
      method: "POST", headers,
      body: JSON.stringify({ accountId: "alice.testnet", publicKey: key.getPublicKey().toString(), signature: Buffer.from(key.sign(digest).signature).toString("base64"), nonceBase64: challenge.nonceBase64 }),
    }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { message: string }).message).toMatch(/NEAR did not answer/);
  });
});
