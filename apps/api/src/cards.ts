/**
 * Agents' spending cards: a NEAR account next to the agent's, created by the
 * relayer with a public key the agent's euthyna-signer made. The relayer never
 * holds the card's key; it only pays the account and its token registration.
 */
import { cardAccountIdOf } from "@mandateos/sdk";
import { NEAR_TESTNET_TOKENS } from "@mandateos/sdk/roles";

/** Enough for the account's storage; the card never pays gas (relayers do). */
export const CARD_FUNDING_YOCTO = "10000000000000000000000"; // 0.01 NEAR
/** NEP-145 registration (the usual 0.00125 NEAR); tokens refund any excess. */
const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000";

export class CardError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: string, message: string) {
    super(message);
  }
}

export interface CardNear {
  getAccessKeys(accountId: string): Promise<{ keys: unknown[] }>;
  createSubaccount(accountId: string, publicKey: string, amountYocto: string): Promise<string>;
  callFunction(contractId: string, methodName: string, args: Record<string, unknown>, gas: string, depositYocto: string): Promise<string>;
}

const ED25519 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export async function createCard(near: CardNear, agentAccountId: string, input: { publicKey: string; token: string }) {
  if (!ED25519.test(input.publicKey)) throw new CardError(400, "invalid_public_key", "publicKey must be an ed25519 NEAR public key");
  if (!NEAR_TESTNET_TOKENS.some((token) => token.accountId === input.token)) throw new CardError(400, "invalid_token", "unknown NEAR token");
  let cardAccountId: string;
  try {
    cardAccountId = cardAccountIdOf(agentAccountId);
  } catch {
    throw new CardError(400, "not_an_euthyna_agent", "only agents created by Euthyna get a card");
  }
  const existing = await near.getAccessKeys(cardAccountId).catch((error: unknown) => {
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(error))) return null;
    throw error;
  });
  if (existing) {
    // Idempotent for the same key (a retried `euthyna-signer card`); never a second key.
    const keys = existing.keys.map((key) => (key as { public_key?: string }).public_key);
    if (keys.length === 1 && keys[0] === input.publicKey) {
      await register(near, input.token, cardAccountId);
      return { cardAccountId, created: false };
    }
    throw new CardError(409, "card_exists", `${cardAccountId} already exists with another key`);
  }
  await near.createSubaccount(cardAccountId, input.publicKey, CARD_FUNDING_YOCTO);
  await register(near, input.token, cardAccountId);
  return { cardAccountId, created: true };
}

/** Registers the card on the token so the vault can refill it. Safe to repeat. */
async function register(near: CardNear, token: string, accountId: string) {
  await near.callFunction(token, "storage_deposit", { account_id: accountId, registration_only: true }, "30000000000000", STORAGE_DEPOSIT_YOCTO);
}
