import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";

import { buildAuthOptions, passkeyRelyingParty, type AuthEnvironment } from "./auth.js";
import { loadEnv } from "./env.js";

const authEnv: AuthEnvironment = {
  BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
  BETTER_AUTH_URL: "http://api.example.com",
  CONSOLE_ORIGIN: "http://console.example.com",
  PASSKEY_RP_ID: "console.example.com",
};

describe("console passkey origin", () => {
  it("binds the relying party to the console domain, not the API origin", () => {
    expect(passkeyRelyingParty(authEnv)).toEqual({
      rpID: "console.example.com",
      rpName: "MandateOS",
      origin: "http://console.example.com",
    });
    expect(new URL(authEnv.BETTER_AUTH_URL).hostname).not.toBe(passkeyRelyingParty(authEnv).rpID);
  });

  it("derives rpID from CONSOLE_ORIGIN when PASSKEY_RP_ID is absent", () => {
    const env = loadEnv({
      GUARD_ED25519_PRIVATE_KEY_BASE64: "unused",
      NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
      NEAR_RELAYER_PRIVATE_KEY: "ed25519:unused",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
      CONSOLE_ORIGIN: "https://console.example.com",
      BUDGET_TOKEN_ACCOUNT_ID: "test-ft.testnet",
    });
    expect(env.PASSKEY_RP_ID).toBe("console.example.com");
  });

  it("keeps email/password disabled and enables sessionless passkey registration", () => {
    const options = buildAuthOptions(authEnv, undefined, async () => ({
      id: "user-1",
      name: "Passkey User",
      email: "user@example.test",
      emailVerified: false,
      image: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    expect(options.emailAndPassword?.enabled).toBe(false);
    expect(options.plugins?.map((plugin) => plugin.id)).toContain("passkey");
  });

  it("accepts the console origin for passkey registration and rejects others", async () => {
    const options = buildAuthOptions(authEnv, undefined);
    const testOptions = { ...options, emailAndPassword: { enabled: true } };
    const { auth, signInWithTestUser } = await getTestInstance(testOptions, { port: 3001 });
    const { headers } = await signInWithTestUser();
    headers.set("origin", authEnv.CONSOLE_ORIGIN);

    const register = await auth.handler(
      new Request(`${authEnv.BETTER_AUTH_URL}/api/auth/passkey/generate-register-options`, {
        method: "GET",
        headers,
      }),
    );
    expect(register.status).toBe(200);
    const body = (await register.json()) as { rp: { id: string } };
    expect(body.rp.id).toBe("console.example.com");
    expect(body.rp.id).not.toBe(new URL(authEnv.BETTER_AUTH_URL).hostname);

    const context = await auth.$context;
    expect(context.trustedOrigins).toContain("http://console.example.com");
    expect(context.trustedOrigins).not.toContain("http://evil.example.com");
  });
});
