/**
 * An agent's second NEAR key, for sealed orders. The agent's main key can only call the vault; the
 * sealed-orders contract is another receiver, and a NEAR function-call key has one. So the account
 * gets a second function-call key, limited to that contract, derived from the main one: whoever
 * holds the agent's key file holds both, and nothing new has to be stored. Browser-safe.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { KeyPair, utils } from "near-api-js";
import { concatBytes, sha256, stringToBytes } from "viem";

/** The methods the sealed key may call, each without a deposit (the vault's credit pays storage). */
export const SEALED_KEY_METHODS = ["seal", "approve", "fill", "cancel"] as const;

const DOMAIN = "euthyna-agent-sealed-key-v1";

/** The sealed-orders key pair of an agent, from its main private key (`ed25519:…`). */
export function sealedKeyOf(privateKey: string): KeyPair {
  if (!privateKey.startsWith("ed25519:")) throw new Error("agent key: expected an ed25519 private key");
  const secret = utils.serialize.base_decode(privateKey.slice("ed25519:".length));
  if (secret.length !== 64 && secret.length !== 32) throw new Error("agent key: unexpected private key length");
  const seed = sha256(concatBytes([stringToBytes(DOMAIN), secret.slice(0, 32)]), "bytes");
  const publicKey = ed25519.getPublicKey(seed);
  return KeyPair.fromString(`ed25519:${utils.serialize.base_encode(concatBytes([seed, publicKey]))}`);
}

/** Its public key (`ed25519:…`), what the console registers when it hires the agent. */
export function sealedPublicKeyOf(privateKey: string): string {
  return sealedKeyOf(privateKey).getPublicKey().toString();
}
