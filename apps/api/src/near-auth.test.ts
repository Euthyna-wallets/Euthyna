import { createHash } from "node:crypto";

import { serializeNep413, verifySignature } from "@near-wallet-selector/core";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { hasFullAccessKey, NEAR_ACCOUNT_ID, nearSignInMessage, nearUserEmail } from "./near-auth.js";

// Same signing as the console's test and demo signers (NEP-413).
function sign(keyPair: KeyPair, message: string, recipient: string, nonce: Buffer) {
  const digest = createHash("sha256").update(serializeNep413({ message, recipient, nonce })).digest();
  return Buffer.from(keyPair.sign(digest).signature).toString("base64");
}

describe("NEAR sign-in", () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const nonce = Buffer.alloc(32, 7);
  const message = nearSignInMessage("alice.testnet", nonce.toString("base64"));

  it("verifies a NEP-413 signature bound to the account, nonce and recipient", () => {
    const signature = sign(keyPair, message, "console.mandateos.app", nonce);
    const publicKey = keyPair.getPublicKey().toString();
    expect(verifySignature({ publicKey, signature, message, nonce, recipient: "console.mandateos.app" })).toBe(true);
    expect(verifySignature({ publicKey, signature, message, nonce, recipient: "evil.example" })).toBe(false);
    expect(verifySignature({ publicKey, signature, message: nearSignInMessage("bob.testnet", nonce.toString("base64")), nonce, recipient: "console.mandateos.app" })).toBe(false);
  });

  it("accepts only full-access keys", () => {
    const publicKey = keyPair.getPublicKey().toString();
    expect(hasFullAccessKey([{ public_key: publicKey, access_key: { permission: "FullAccess" } }], publicKey)).toBe(true);
    expect(hasFullAccessKey([{ public_key: publicKey, access_key: { permission: { FunctionCall: {} } } }], publicKey)).toBe(false);
    expect(hasFullAccessKey([], publicKey)).toBe(false);
  });

  it("validates account ids and maps them to a stable user email", () => {
    expect(NEAR_ACCOUNT_ID.test("alice.mandateos-e2e.testnet")).toBe(true);
    expect(NEAR_ACCOUNT_ID.test("Alice.testnet")).toBe(false);
    expect(NEAR_ACCOUNT_ID.test("a")).toBe(false);
    expect(nearUserEmail("alice.testnet")).toBe("alice.testnet@near.mandateos.invalid");
  });
});
