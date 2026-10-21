import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";

import { buildAuthOptions, type AuthEnvironment } from "./auth.js";
import { loadEnv } from "./env.js";

const baseEnv: AuthEnvironment = {
  BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
  BETTER_AUTH_URL: "http://localhost:3000",
  CONSOLE_ORIGIN: "http://localhost:5173",
  PASSKEY_RP_ID: "localhost",
  AUTH_E2E_PASSWORD: "0",
};

function signUpRequest(url = baseEnv.BETTER_AUTH_URL) {
  return new Request(`${url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: baseEnv.CONSOLE_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "user@example.test", password: "password-123", name: "User" }),
  });
}

describe("email/password gating", () => {
  it("enables sign-up/email only with the flag", async () => {
    const { auth } = await getTestInstance(
      buildAuthOptions({ ...baseEnv, AUTH_E2E_PASSWORD: "1" }, undefined),
      { port: 3012 },
    );
    const response = await auth.handler(signUpRequest());
    expect(response.status).toBe(200);
  });

  it("refuses startup when the flag is set outside NODE_ENV=test", () => {
    expect(() =>
      loadEnv({
        GUARD_ED25519_PRIVATE_KEY_BASE64: "unused",
        NEAR_RELAYER_ACCOUNT_ID: "relayer.testnet",
        NEAR_RELAYER_PRIVATE_KEY: "ed25519:unused",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        BETTER_AUTH_SECRET: "0123456789012345678901234567890123456789",
        BUDGET_TOKEN_ACCOUNT_ID: "test-ft.testnet",
        AUTH_E2E_PASSWORD: "1",
      }),
    ).toThrow(/only allowed with NODE_ENV=test/);
  });
});
