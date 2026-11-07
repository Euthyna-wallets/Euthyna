/**
 * Private bank beneficiaries: what a member's browser builds when the members vote an IBAN.
 *
 * Nothing that names the IBAN or its holder goes on chain. The vote carries:
 * - a commitment, sha256("euthyna-bank-beneficiary-v1" 0 vault 0 IBAN 0 holder 0 type 0 salt),
 *   salted so an IBAN cannot be found by trying candidates;
 * - an envelope only the bank signer's enclave can open (X25519 to its box key, AES-256-GCM, the
 *   vault's account as associated data), which it checks against the commitment before any payout;
 * - an envelope for the members' reading keys (the scheme of the sealed orders), so members read it.
 * Must match bank-signer/src/main.rs (`commitment_of`, `open`) byte for byte.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes, sha256, stringToBytes, type Hex } from "viem";

import { canonicalIban, validIban } from "./roles.js";
import { decryptForReader, encryptForReaders } from "./sealed-orders.js";

export type HolderType = "Business" | "Individual";
export type PrivateBeneficiary = { vault: string; iban: string; name: string; holder_type: HolderType; salt: string };
export type BeneficiaryVote = { commitment: string; sealedForSigner: string; sealedForMembers: string };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));

export function beneficiaryCommitment(vault: string, iban: string, name: string, holderType: string, salt: string): string {
  const parts = ["euthyna-bank-beneficiary-v1", vault, canonicalIban(iban), name, holderType, salt].map((part) => stringToBytes(part));
  const joined = parts.flatMap((part, index) => (index === 0 ? [part] : [new Uint8Array([0]), part]));
  return sha256(concatBytes(joined)).slice(2);
}

/** Seals for the enclave's X25519 box key (hex, 32 bytes), bound to the vault. `entropy` is for tests. */
export async function sealForSigner(value: PrivateBeneficiary, boxKeyHex: string, entropy?: { ephemeral: Uint8Array; iv: Uint8Array }): Promise<string> {
  const signerKey = hexToBytes(`0x${boxKeyHex.replace(/^0x/, "")}` as Hex);
  if (signerKey.length !== 32) throw new Error("the bank signer's box key is 32 bytes");
  const ephemeral = entropy?.ephemeral ?? random(32);
  const iv = entropy?.iv ?? random(12);
  const epk = x25519.getPublicKey(ephemeral);
  const key = hexToBytes(sha256(concatBytes([x25519.getSharedSecret(ephemeral, signerKey), epk, signerKey])));
  const aesKey = await globalThis.crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: stringToBytes(value.vault) as BufferSource }, aesKey, plaintext));
  return btoa(JSON.stringify({ v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) }));
}

/**
 * Everything a member's browser sends for the vote: the commitment and the two envelopes. The IBAN
 * and the holder stay in the browser and in the envelopes.
 */
export async function beneficiaryVote(input: {
  vault: string;
  iban: string;
  name: string;
  holderType: HolderType;
  boxKeyHex: string;
  readers: Array<{ account: string; publicKey: string }>;
}): Promise<BeneficiaryVote & { salt: string }> {
  if (!validIban(input.iban)) throw new Error("This IBAN does not pass the checksum");
  const name = input.name.trim();
  if (!name || name.length > 255 || !/^[ -~]+$/.test(name)) throw new Error("The account holder name must be 1 to 255 printable ASCII characters");
  const salt = bytesToHex(random(32)).slice(2);
  const value: PrivateBeneficiary = { vault: input.vault, iban: canonicalIban(input.iban), name, holder_type: input.holderType, salt };
  return {
    salt,
    commitment: beneficiaryCommitment(input.vault, value.iban, name, input.holderType, salt),
    sealedForSigner: await sealForSigner(value, input.boxKeyHex),
    sealedForMembers: await encryptForReaders(value, input.readers),
  };
}

/** A member reads a beneficiary, and checks it is the one committed on chain. */
export async function readBeneficiary(sealedForMembers: string, commitment: string, account: string, privateKey: Uint8Array): Promise<PrivateBeneficiary | null> {
  const value = (await decryptForReader(sealedForMembers, account, privateKey)) as PrivateBeneficiary | null;
  if (!value) return null;
  return beneficiaryCommitment(value.vault, value.iban, value.name, value.holder_type, value.salt) === commitment.toLowerCase() ? value : null;
}
