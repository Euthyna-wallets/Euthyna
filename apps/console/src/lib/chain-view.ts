/** Read a contract view straight from NEAR RPC, so the browser checks chain data itself. */
export async function chainView<T>(accountId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mandateos-view",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json() as { result?: { result?: number[]; error?: string }; error?: { message?: string } };
  if (payload.error || payload.result?.error || !payload.result?.result) throw new Error(payload.error?.message ?? payload.result?.error ?? `${accountId}.${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(payload.result.result))) as T;
}
