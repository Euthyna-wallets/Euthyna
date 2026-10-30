import { describe, expect, it } from "vitest";

import { CARD_FUNDING_YOCTO, createCard, type CardNear } from "./cards.js";

const AGENT = "larry-09d0b2-agent.mandateos.testnet";
const CARD = "larry-09d0b2-card.mandateos.testnet";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const KEY = "ed25519:8tQ4vRBkq7WbXqT9hQh5n3tQyM2m4oZpWQ2bVQyT9Zx1";

function near(existing: string[] | null = null) {
  const calls: string[] = [];
  const fake: CardNear = {
    getAccount: async () => { if (!existing) throw new Error("account does not exist"); return {}; },
    // Like NEAR RPC: a missing account has an empty key list, not an error.
    getAccessKeys: async () => ({ keys: (existing ?? []).map((public_key) => ({ public_key })) }),
    createSubaccount: async (id, key, amount) => { calls.push(`create ${id} ${key} ${amount}`); return id; },
    callFunction: async (contract, method, args) => { calls.push(`${contract}.${method} ${JSON.stringify(args)}`); return "tx"; },
  };
  return { fake, calls };
}

describe("spending cards", () => {
  it("creates the card with the signer's key, funds its storage and registers it on the token", async () => {
    const { fake, calls } = near();
    await expect(createCard(fake, AGENT, { publicKey: KEY, token: USDC })).resolves.toEqual({ cardAccountId: CARD, created: true });
    expect(calls).toEqual([`create ${CARD} ${KEY} ${CARD_FUNDING_YOCTO}`, `${USDC}.storage_deposit {"account_id":"${CARD}","registration_only":true}`]);
  });
  it("is idempotent for the same key, and never adds a second one", async () => {
    await expect(createCard(near([KEY]).fake, AGENT, { publicKey: KEY, token: USDC })).resolves.toMatchObject({ created: false });
    await expect(createCard(near(["ed25519:other"]).fake, AGENT, { publicKey: KEY, token: USDC })).rejects.toMatchObject({ code: "card_exists" });
  });
  it("never adds a key to an existing card that has none", async () => {
    await expect(createCard(near([]).fake, AGENT, { publicKey: KEY, token: USDC })).rejects.toMatchObject({ code: "card_exists" });
  });
  it("refuses unknown tokens, bad keys and accounts Euthyna did not make", async () => {
    await expect(createCard(near().fake, AGENT, { publicKey: KEY, token: "usdc.fakes.testnet" })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(createCard(near().fake, AGENT, { publicKey: "ed25519:short", token: USDC })).rejects.toMatchObject({ code: "invalid_public_key" });
    await expect(createCard(near().fake, "bob.testnet", { publicKey: KEY, token: USDC })).rejects.toMatchObject({ code: "not_an_euthyna_agent" });
  });
});
