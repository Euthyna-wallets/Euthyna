import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks a `market.task.created` push: `x-euthyna-signature` must be
 * sha256=HMAC(secret, "<x-euthyna-timestamp>.<body>") and the timestamp
 * recent, so an old push cannot be replayed. A push only says "poll now":
 * the worker still reads the task from the API with its token.
 */
export function verifyWebhook(secret: string, body: string, signature: string | undefined, timestamp: string | undefined, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
