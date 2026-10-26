export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
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
