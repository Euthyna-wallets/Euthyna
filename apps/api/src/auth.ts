import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { jwtVerify, SignJWT } from "jose";
import type { PrismaClient } from "@mandateos/db";

import type { Env } from "./env.js";

export const AGENT_API_KEY_CONFIG_ID = "agent";

/**
 * The subset of the Better Auth server API MandateOS relies on. Named here so
 * the HTTP layer and tests do not depend on inferred plugin generics.
 */
export interface MandateAuth {
  handler(request: Request): Promise<Response>;
  createRegistrationContext(input: { email: string; name: string; userId: string }): Promise<string>;
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

export type AuthEnvironment = Pick<
  Env,
  "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "PASSKEY_RP_ID" | "CONSOLE_ORIGIN" | "RESEND_API_KEY" | "AUTH_EMAIL_FROM"
>;

export function passkeyRelyingParty(env: AuthEnvironment) {
  return {
    rpID: env.PASSKEY_RP_ID,
    rpName: "MandateOS",
    origin: env.CONSOLE_ORIGIN,
  };
}

type RegistrationUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RegistrationResolver = (context: string) => Promise<RegistrationUser>;

/**
 * The console is served from its own origin. WebAuthn ceremonies and console
 * API calls are scoped to it; the API origin only hosts `/api/auth`.
 */
export function buildAuthOptions(
  env: AuthEnvironment,
  database: BetterAuthOptions["database"],
  resolveRegistrationUser?: RegistrationResolver,
): BetterAuthOptions {
  return {
    database,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.CONSOLE_ORIGIN],
    emailAndPassword: { enabled: false },
    plugins: [
      passkey({
        ...passkeyRelyingParty(env),
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            if (!resolveRegistrationUser) throw new Error("passkey registration context is not configured");
            if (typeof context !== "string") throw new Error("passkey registration context is required");
            return resolveRegistrationUser(context);
          },
        },
      }),
      emailOTP({
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        overrideDefaultEmailVerification: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
            throw new Error("email OTP delivery is not configured");
          }
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.RESEND_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              from: env.AUTH_EMAIL_FROM,
              to: [email],
              subject: type === "email-verification" ? "Verify your MandateOS email" : "Your MandateOS code",
              text: `Your MandateOS verification code is ${otp}. It expires in 10 minutes.`,
            }),
          });
          if (!response.ok) throw new Error(`OTP email delivery failed with HTTP ${response.status}`);
        },
      }),
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
  const issuer = `${env.BETTER_AUTH_URL}/api/auth/registration`;
  const audience = "mandateos:passkey-registration";
  const key = new TextEncoder().encode(env.BETTER_AUTH_SECRET);

  const resolveRegistrationUser: RegistrationResolver = async (context) => {
    const { payload } = await jwtVerify(context, key, {
      issuer,
      audience,
      algorithms: ["HS256"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string"
    ) {
      throw new Error("invalid passkey registration identity");
    }
    const email = payload.email.trim().toLowerCase();
    const existing = await client.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.id !== payload.sub) throw new Error("registration identity mismatch");
      const enrolled = await client.passkey.findFirst({
        where: { userId: existing.id },
        select: { id: true },
      });
      if (enrolled) throw new Error("registration already completed");
      return existing;
    }
    return client.user.create({
      data: {
        id: payload.sub,
        name: payload.name,
        email,
        emailVerified: false,
      },
    });
  };

  const auth = betterAuth(buildAuthOptions(
    env,
    prismaAdapter(client, { provider: "postgresql" }),
    resolveRegistrationUser,
  )) as unknown as MandateAuth;
  auth.createRegistrationContext = ({ email, name, userId }) =>
    new SignJWT({ email: email.trim().toLowerCase(), name })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  return auth;
}
