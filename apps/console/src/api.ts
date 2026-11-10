export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/**
 * The API's full URL, for text the user copies elsewhere (signer command, MCP config).
 * In production the API is on the console's own origin, so API_BASE is "" (fine for fetch, not for a command).
 */
export const PUBLIC_API_URL = API_BASE || (typeof window === "undefined" ? "" : window.location.origin);

/**
 * One id per page load. The server keeps what it read from the chain until something it knows of
 * changes it; a page it has not seen before (a new tab, a reload) gets fresh reads. So F5 always
 * shows the chain as it is, including what was done outside this console.
 */
const PAGE_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", "x-euthyna-page": PAGE_ID, ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(body.message ?? body.error ?? response.statusText));
  }
  return body as T;
}

export type AgentRow = {
  id: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  vaultAccountId: string;
  evmAddress: string | null;
  mpcPath: string;
  active: boolean;
  /** The console user who hired it; only they or an admin can provision or revoke it. */
  createdByUserId: string | null;
  createdAt: string;
};
