/** Euthyna Market: public calls (no cookies) and console calls (members). */
import { API_BASE, api } from "../api.js";

export type MarketAgent = {
  handle: string; title: string; description: string; category: string; seller: string;
  price: string; asset: string; symbol: string | null; payTo: string; slaSeconds: number;
  inputHint: string; outputHint: string; delivered: number; successRate: number | null; rating: number | null;
};

export type MarketTaskView = {
  id: string;
  title: string;
  handle: string;
  input: string;
  createdAt: string;
  status: { state: string; timestamp: string; message?: string };
  artifacts: Array<{ parts: Array<{ kind: string; text?: string; data?: unknown; mediaType?: string }> }>;
  metadata: { buyer: string; payment: { state: string; amount: string; asset: string; payTo: string; settleTxHash: string | null } | null; unpaid: boolean };
};

export type OrderPayment = { receiverId: string; methodName: "ft_transfer"; args: { receiver_id: string; amount: string; memo: string }; deposit: string; gas: string };

async function publicCall<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(body.message ?? body.error ?? response.statusText)) as Error & { code?: string; status?: number };
    error.code = String(body.error ?? "");
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export const market = {
  agents: (q = "", sort = "delivered") => publicCall<{ agents: MarketAgent[] }>(`/v1/market/agents?${new URLSearchParams({ q, sort })}`),
  order: (input: { handle: string; buyer: string; input: string }) =>
    publicCall<{ taskId: string; payBefore: string; payment: OrderPayment }>("/v1/market/orders", { method: "POST", body: JSON.stringify(input) }),
  paid: (taskId: string, txHash: string) => publicCall<{ task: MarketTaskView }>(`/v1/market/orders/${taskId}/paid`, { method: "POST", body: JSON.stringify({ txHash }) }),
  task: (id: string) => publicCall<{ task: MarketTaskView }>(`/v1/market/tasks/${id}`),
};

export type Listing = {
  id: string; handle: string; title: string; description: string; category: string; priceAtomic: string; asset: string; payTo: string;
  slaSeconds: number; inputHint: string; outputHint: string; status: "draft" | "live" | "paused"; webhookUrl: string | null; hasDeliveryToken: boolean; createdAt: string;
};
export type Sale = { taskId: string; handle: string; title: string; buyer: string; state: string; amount: string | null; asset: string; holdState: string | null; settleTxHash: string | null; createdAt: string; completedAt: string | null };

export const marketConsole = {
  listings: () => api<{ listings: Listing[] }>("/v1/console/market/listings"),
  create: (input: Record<string, unknown>) => api<{ listing: Listing }>("/v1/console/market/listings", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: Record<string, unknown>) => api<{ listing: Listing }>(`/v1/console/market/listings/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  rotate: (id: string) => api<{ deliveryToken: string; webhookSecret: string }>(`/v1/console/market/listings/${id}/token`, { method: "POST", body: "{}" }),
  sales: () => api<{ sales: Sale[]; revenueAtomic: string }>("/v1/console/market/sales"),
  purchases: () => api<{ purchases: Sale[]; spentAtomic: string }>("/v1/console/market/purchases"),
};

/** 2000000 base units of a 6-decimal token -> "2". */
export function tokenAmount(atomic: string | null | undefined, decimals = 6): string {
  if (!atomic) return "—";
  const value = BigInt(atomic);
  const unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / unit}${fraction ? `.${fraction}` : ""}`;
}

export function slaText(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
