import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import type { PrismaClient } from "@mandateos/db";

import type { Env } from "./env.js";

export const AGENT_API_KEY_CONFIG_ID = "agent";

/**
 * The subset of the Better Auth server API MandateOS relies on. Named here so
 * the HTTP layer and tests do not depend on inferred plugin generics.
 */
export interface MandateAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string };
      session: Record<string, unknown>;
    } | null>;
    verifyApiKey(input: {
      body: { key: string; configId: string };
    }): Promise<{
      valid: boolean;
      key: { referenceId: string; enabled?: boolean | null } | null;
    }>;
    createApiKey(input: {
      body: { configId: string; userId: string; name: string };
    }): Promise<{ key: string }>;
  };
}

export type AuthEnvironment = Pick<
  Env,
  "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "PASSKEY_RP_ID" | "CONSOLE_ORIGIN" | "AUTH_E2E_PASSWORD"
>;

export function passkeyRelyingParty(env: AuthEnvironment) {
  return {
    rpID: env.PASSKEY_RP_ID,
    rpName: "MandateOS",
    origin: env.CONSOLE_ORIGIN,
  };
}

/**
 * The console is served from its own origin. WebAuthn ceremonies and console
 * API calls are scoped to it; the API origin only hosts `/api/auth`.
 */
export function buildAuthOptions(
  env: AuthEnvironment,
  database: BetterAuthOptions["database"],
): BetterAuthOptions {
  return {
    database,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.CONSOLE_ORIGIN],
    // Password bootstrap exists only for the E2E harness. Passkeys remain the
    // normal credential; production startup rejects AUTH_E2E_PASSWORD=1.
    emailAndPassword: {
      enabled: env.AUTH_E2E_PASSWORD === "1",
      requireEmailVerification: false,
    },
    plugins: [
      passkey(passkeyRelyingParty(env)),
      organization(),
      apiKey({
        configId: AGENT_API_KEY_CONFIG_ID,
        references: "user",
        storage: "database",
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 60 },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: AuthEnvironment, client: PrismaClient): MandateAuth {
  const auth = betterAuth(buildAuthOptions(env, prismaAdapter(client, { provider: "postgresql" })));
  // BetterAuthOptions erases plugin-generated API methods. MandateAuth names the
  // exact subset this app uses; the auth and gateway tests exercise it.
  return auth as unknown as MandateAuth;
}
