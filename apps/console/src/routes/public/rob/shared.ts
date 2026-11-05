/**
 * Rob the Agent: what the page and its sections share. The API helper, the throwaway key kept in this browser,
 * and the shapes the API answers with.
 */
import { KeyPair, utils } from "near-api-js";

import { API_BASE } from "../../../api.js";

export const BRAND = "Cinzel, serif";
export const MONO = "'JetBrains Mono', monospace";
export const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

export type Card = {
  id: string;
  numeral: string;
  title: string;
  rarity: "BRONZE" | "MARBLE" | "LEGENDARY" | "BOSS";
  line: number;
  by: string;
  attempt: string;
  why: string;
  playable: boolean;
  signer: "function-call" | "ruggy" | "scripted" | "none";
};
export type Deck = { ruggy: string; vault: string; dao: string; suppliers: string[]; token: string; role: string; laws: string[]; cards: Card[] };
export type Stats = { attacks: number; players: number; denied: number; lawfulPayments: number; linesOfDefense: number; stolen: number };
export type Play = {
  card: string;
  verdict: "denied" | "counter" | "vetoed" | "paid";
  refusedBy: "vault" | "near" | "dao" | "ruggy" | "council" | null;
  line: number | null;
  error: string | null;
  tx: string | null;
  nearblocks: string | null;
  call: string;
  signedBy: string;
  counter?: { counter: number; expires_in: number; to: string };
  steps?: Array<{ label: string; detail: string; tx: string | null }>;
  ms: number;
};
/** What the verdict panel shows: the card played (null for a forged call) and the chain's answer. */
export type Shown = { card: Card | null; state: "sending" | "done" | "error"; play?: Play; message?: string };

export async function robCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(json.message ?? json.error ?? response.statusText), { status: response.status, code: json.error });
  return json;
}

/** The throwaway key, kept in this browser for a day (best effort: a fresh one otherwise). */
const KEY_STORE = "rob.throwaway";
export type Throwaway = { secret: string; publicKey: string; createdAt: number; onRuggy: boolean };
export function loadKey(): Throwaway {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORE) ?? "null") as Throwaway | null;
    if (saved && Date.now() - saved.createdAt < 23 * 3_600_000) return saved;
  } catch { /* storage unavailable: a key for this visit only */ }
  const pair = KeyPair.fromRandom("ed25519");
  // Saved at once: a reload (a wallet round trip, a link opened in this tab) must not lose the key its top-up went to.
  const fresh: Throwaway = { secret: pair.toString(), publicKey: pair.getPublicKey().toString(), createdAt: Date.now(), onRuggy: false };
  saveKey(fresh);
  return fresh;
}
export function loadKeyFresh(): Throwaway {
  try {
    localStorage.removeItem(KEY_STORE);
  } catch { /* fine */ }
  return loadKey();
}
export function saveKey(key: Throwaway) {
  try {
    localStorage.setItem(KEY_STORE, JSON.stringify(key));
  } catch { /* fine */ }
}
export function keyPairOf(key: Throwaway) {
  return KeyPair.fromString(key.secret as Parameters<typeof KeyPair.fromString>[0]);
}
export function shortKey(publicKey: string) {
  const body = publicKey.replace(/^ed25519:/, "");
  return `ed25519:${body.slice(0, 3)}…${body.slice(-3)}`;
}
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  bytes.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text);
}
/** The player's own account: the implicit account of their key (64 hex characters). */
export function attackerOf(publicKey: string): string {
  return Array.from(utils.PublicKey.fromString(publicKey).data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
