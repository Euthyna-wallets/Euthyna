import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
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

/**
 * Better Auth owns console identities (passkey), organizations, memberships and
 * per-agent API credentials. MandateOS never stores the agent's NEAR
 * function-call key: the console only registers the public key.
 */
export function createAuth(
  env: Pick<Env, "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "PASSKEY_RP_ID">,
  client: PrismaClient,
): MandateAuth {
  return betterAuth({
    database: prismaAdapter(client, { provider: "postgresql" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    emailAndPassword: { enabled: false },
    plugins: [
      passkey({
        rpID: env.PASSKEY_RP_ID,
        rpName: "MandateOS",
        origin: env.BETTER_AUTH_URL,
      }),
      organization(),
      apiKey({
        configId: AGENT_API_KEY_CONFIG_ID,
        references: "user",
        storage: "database",
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 60 },
      }),
    ],
  });
}
