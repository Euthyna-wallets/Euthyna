import { readerKeyFromSignature, readerMessage } from "@euthyna/sdk/sealed-orders";

import { signNearMessage } from "../wallets.js";

/**
 * The member's reading key for a vault: X25519, derived from a signature of their own wallet
 * (NEP-413, deterministic), so the same key comes back on any device. Opens the sealed orders'
 * terms and the sealed bank beneficiaries. Kept in memory only.
 */
export async function readerKey(vault: string) {
  const message = readerMessage(vault);
  const signed = await signNearMessage({ message: message.message, recipient: message.recipient, nonceBase64: btoa(String.fromCharCode(...message.nonce)) });
  const signature = Uint8Array.from(atob(String(signed.signature)), (char) => char.charCodeAt(0));
  return readerKeyFromSignature(signature);
}
