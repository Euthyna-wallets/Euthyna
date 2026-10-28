/**
 * Operations read from the chain, not from our database: agents that act
 * directly on the vault (MCP + euthyna-signer) never go through the API, so the
 * vault's own logs are the record. Uses a public NEAR transaction index
 * (FastNEAR) to find the vault's transactions, then reads their receipt logs.
 */

export type VaultLog = { kind: "evm" | "dao" | "solana"; opId: `0x${string}`; txHash: string; at: string };

const PATTERNS: Array<[VaultLog["kind"], RegExp]> = [
  ["evm", /^OMNIROLES_OPERATION_PREPARED:([0-9a-f]{64})$/],
  ["dao", /^OMNIROLES_DAO_TRANSACTION_SCHEDULED:([0-9a-f]{64})$/],
  ["solana", /^OMNIROLES_SOLANA_OPERATION:([0-9a-f]{64})$/],
];

type AccountTx = { transaction_hash: string; tx_block_timestamp: string };
type IndexedTx = {
  transaction: { hash: string };
  receipts: Array<{ receipt?: { receiver_id?: string }; execution_outcome?: { outcome?: { logs?: string[]; executor_id?: string } } }>;
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR index ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** The vault's operations, newest first, from its last `limit` transactions. */
export async function vaultLogs(indexerUrl: string, vaultAccountId: string, limit = 100): Promise<VaultLog[]> {
  const base = indexerUrl.replace(/\/$/, "");
  const account = await post<{ account_txs: AccountTx[] }>(`${base}/v0/account`, { account_id: vaultAccountId, max_block_height: null });
  const recent = [...account.account_txs]
    .sort((a, b) => (BigInt(b.tx_block_timestamp) > BigInt(a.tx_block_timestamp) ? 1 : -1))
    .slice(0, limit);
  const when = new Map(recent.map((tx) => [tx.transaction_hash, new Date(Number(BigInt(tx.tx_block_timestamp) / 1_000_000n)).toISOString()]));
  const found = new Map<string, VaultLog>();
  for (let index = 0; index < recent.length; index += 20) {
    const chunk = recent.slice(index, index + 20).map((tx) => tx.transaction_hash);
    const { transactions } = await post<{ transactions: Array<IndexedTx | null> }>(`${base}/v0/transactions`, { tx_hashes: chunk });
    for (const tx of transactions) {
      if (!tx) continue;
      for (const receipt of tx.receipts ?? []) {
        const executor = receipt.execution_outcome?.outcome?.executor_id ?? receipt.receipt?.receiver_id;
        if (executor !== vaultAccountId) continue; // only the vault's own logs count
        for (const log of receipt.execution_outcome?.outcome?.logs ?? []) {
          for (const [kind, pattern] of PATTERNS) {
            const match = log.match(pattern);
            if (match && !found.has(match[1]!)) {
              found.set(match[1]!, { kind, opId: `0x${match[1]!}`, txHash: tx.transaction.hash, at: when.get(tx.transaction.hash) ?? new Date(0).toISOString() });
            }
          }
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at));
}
