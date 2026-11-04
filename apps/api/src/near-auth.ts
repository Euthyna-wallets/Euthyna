import { randomBytes } from "node:crypto";

import { verifySignature } from "@near-wallet-selector/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

/**
 * Sign in with a NEAR wallet (NEP-413). A console user *is* a NEAR account:
 * the same account that votes in the company DAO.
 */
export const NEAR_PROVIDER_ID = "near";
const CHALLENGE_PREFIX = "near-sign-in:";
const CHALLENGE_TTL_MS = 5 * 60_000;

export const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function nearUserEmail(accountId: string): string {
  return `${accountId}@near.mandateos.invalid`;
}

export function nearSignInMessage(accountId: string, nonceBase64: string): string {
  return ["Sign in to Euthyna", `account_id: ${accountId}`, `nonce: ${nonceBase64}`].join("\n");
}

export interface NearSignInOptions {
  /** NEP-413 recipient the wallet signs for. */
  recipient: string;
  /** True when publicKey is a full-access key of accountId on chain. */
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  /** False when the account does not exist on chain yet (an implicit account nobody funded). */
  accountExists?(accountId: string): Promise<boolean>;
}

const accountSchema = z.string().trim().toLowerCase().regex(NEAR_ACCOUNT_ID, "invalid NEAR account id");

export function nearSignIn(options: NearSignInOptions) {
  return {
    id: "near-sign-in",
    endpoints: {
      nearChallenge: createAuthEndpoint("/near/challenge", {
        method: "POST",
        body: z.object({ accountId: accountSchema }).strict(),
      }, async (ctx) => {
        const nonceBase64 = randomBytes(32).toString("base64");
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: `${CHALLENGE_PREFIX}${ctx.body.accountId}:${nonceBase64}`,
          value: ctx.body.accountId,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        });
        return ctx.json({
          message: nearSignInMessage(ctx.body.accountId, nonceBase64),
          nonceBase64,
          recipient: options.recipient,
        });
      }),
      signInNear: createAuthEndpoint("/sign-in/near", {
        method: "POST",
        body: z.object({
          accountId: accountSchema,
          publicKey: z.string().min(1).max(200),
          signature: z.string().min(1).max(200),
          nonceBase64: z.string().min(1).max(100),
        }).strict(),
        requireRequest: true,
      }, async (ctx) => {
        const { accountId, publicKey, signature, nonceBase64 } = ctx.body;
        const consumed = await ctx.context.internalAdapter.consumeVerificationValue(`${CHALLENGE_PREFIX}${accountId}:${nonceBase64}`);
        if (!consumed) throw APIError.fromStatus("UNAUTHORIZED", { message: "sign-in challenge expired or already used" });

        let valid = false;
        try {
          valid = verifySignature({
            publicKey,
            signature,
            message: nearSignInMessage(accountId, nonceBase64),
            nonce: Buffer.from(nonceBase64, "base64"),
            recipient: options.recipient,
          });
        } catch {
          valid = false;
        }
        if (!valid) throw APIError.fromStatus("UNAUTHORIZED", { message: "invalid NEP-413 signature" });
        if (!await options.isFullAccessKey(accountId, publicKey)) {
          if (options.accountExists && !await options.accountExists(accountId)) {
            throw APIError.fromStatus("UNAUTHORIZED", {
              message: `${accountId} does not exist on NEAR yet. Create an account in a NEAR wallet, or send this one 0.1 NEAR to activate it.`,
            });
          }
          throw APIError.fromStatus("UNAUTHORIZED", { message: `the signing key is not a full-access key of ${accountId}` });
        }

        const linked = await ctx.context.adapter.findOne<{ userId: string }>({
          model: "account",
          where: [{ field: "accountId", value: accountId }, { field: "providerId", value: NEAR_PROVIDER_ID }],
        });
        let user = linked ? await ctx.context.internalAdapter.findUserById(linked.userId) : null;
        if (!user) {
          // Members added by an admin already have a user with this email.
          user = (await ctx.context.internalAdapter.findUserByEmail(nearUserEmail(accountId)))?.user ?? null;
          user ??= await ctx.context.internalAdapter.createUser({ name: accountId, email: nearUserEmail(accountId), emailVerified: true }, { method: "near" });
          await ctx.context.internalAdapter.createAccount({ userId: user.id, providerId: NEAR_PROVIDER_ID, accountId });
        }
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw APIError.fromStatus("INTERNAL_SERVER_ERROR", { message: "could not create a session" });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ success: true, user: { id: user.id, nearAccountId: accountId } });
      }),
    },
  } satisfies BetterAuthPlugin;
}

export function hasFullAccessKey(keys: unknown[], publicKey: string): boolean {
  return keys.some((entry) => {
    if (!entry || typeof entry !== "object" || !("public_key" in entry) || !("access_key" in entry)) return false;
    if (entry.public_key !== publicKey) return false;
    const accessKey = entry.access_key;
    return Boolean(accessKey && typeof accessKey === "object" && "permission" in accessKey && accessKey.permission === "FullAccess");
  });
}
