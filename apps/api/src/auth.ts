import { apiKey } from "@better-auth/api-key";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins";
import type { PrismaClient } from "@euthyna/db";

import type { Env } from "./env.js";
import { nearSignIn, type NearSignInOptions } from "./near-auth.js";

export const AGENT_API_KEY_CONFIG_ID = "agent";

/**
 * The subset of the Better Auth server API Euthyna relies on. Named here so
 * the HTTP layer and tests do not depend on inferred plugin generics.
 */
export interface MandateAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string; email: string; emailVerified: boolean };
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

export type AuthEnvironment = Pick<Env, "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "CONSOLE_ORIGIN">;

/**
 * People sign in with their NEAR wallet (see near-auth.ts); agents use API keys.
 * The console is served from its own origin; the API origin only hosts `/api/auth`.
 */
export function buildAuthOptions(
  env: AuthEnvironment,
  database: BetterAuthOptions["database"],
  near?: NearSignInOptions,
): BetterAuthOptions {
  return {
    database,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.CONSOLE_ORIGIN],
    emailAndPassword: { enabled: false },
    plugins: [
      organization(),
      ...(near ? [nearSignIn(near)] : []),
      apiKey({
        configId: AGENT_API_KEY_CONFIG_ID,
        references: "user",
        storage: "database",
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 60 },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: AuthEnvironment, client: PrismaClient, near?: NearSignInOptions): MandateAuth {
  return betterAuth(buildAuthOptions(env, prismaAdapter(client, { provider: "postgresql" }), near)) as unknown as MandateAuth;
}
