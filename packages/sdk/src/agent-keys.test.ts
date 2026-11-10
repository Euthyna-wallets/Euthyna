import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { sealedKeyOf, sealedPublicKeyOf } from "./agent-keys.js";

describe("sealedKeyOf", () => {
  it("derives a stable, different key that signs", () => {
    const main = KeyPair.fromRandom("ed25519");
    const sealed = sealedKeyOf(main.toString());
    expect(sealed.toString()).toBe(sealedKeyOf(main.toString()).toString());
    expect(sealed.getPublicKey().toString()).not.toBe(main.getPublicKey().toString());
    expect(sealedPublicKeyOf(main.toString())).toBe(sealed.getPublicKey().toString());
    const message = new TextEncoder().encode("hello");
    const { signature } = sealed.sign(message);
    expect(sealed.verify(message, signature)).toBe(true);
  });

  it("is fixed for a given key (agents in the field keep the same sealed key)", () => {
    const main = KeyPair.fromString("ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr");
    expect(sealedPublicKeyOf(main.toString())).toBe("ed25519:LsY7oSpvKzLExgnCUZL6piTw36sPu75M4gaWAJ7qwGR");
  });
});
