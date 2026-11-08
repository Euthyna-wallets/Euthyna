/**
 * Operations read from the chain, not from our database: agents that act
 * directly on the vault (MCP + euthyna-signer) never go through the API, so the
 * vault's own logs are the record. Uses a public NEAR transaction index
 * (FastNEAR) to find the vault's transactions, then reads their receipt logs.
 */

export type VaultLog = { kind: "evm" | "dao" | "solana" | "near" | "bank"; opId: `0x${string}`; txHash: string; at: string };

const PATTERNS: Array<[VaultLog["kind"], RegExp]> = [
  ["evm", /^OMNIROLES_OPERATION_PREPARED:([0-9a-f]{64})$/],
  ["dao", /^OMNIROLES_DAO_TRANSACTION_SCHEDULED:([0-9a-f]{64})$/],
  ["solana", /^OMNIROLES_SOLANA_OPERATION:([0-9a-f]{64})$/],
  ["near", /^OMNIROLES_NEAR_OPERATION:([0-9a-f]{64})$/],
  ["bank", /^OMNIROLES_BANK_PAYOUT_REQUESTED:([0-9a-f]{64})$/],
];

type AccountTx = { transaction_hash: string; tx_block_timestamp: string; tx_block_height?: number | string };
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

/**
 * A transaction's logs never change: each one is read from the index once, then kept here. So
 * every call can scan the vault's whole history and only pays for the transactions it has not
 * seen yet (the keeper's own calls fill a vault's history quickly; a window of the last N would
 * push an agent's operations out of view).
 */
const logsByTx = new Map<string, VaultLog[]>();
const MAX_KEPT_TXS = 50_000;
const MAX_PAGES = 20;

/** Every transaction of the account, newest first (the index pages by block height). */
async function accountTxs(base: string, accountId: string): Promise<AccountTx[]> {
  const all = new Map<string, AccountTx>();
  let maxBlockHeight: number | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { account_txs: txs, txs_count: total } = await post<{ account_txs: AccountTx[]; txs_count?: number }>(`${base}/v0/account`, { account_id: accountId, max_block_height: maxBlockHeight });
    const before = all.size;
    for (const tx of txs) all.set(tx.transaction_hash, tx);
    if (!txs.length || all.size === before || (total !== undefined && all.size >= total)) break;
    const lowest = Math.min(...txs.map((tx) => Number(tx.tx_block_height ?? Number.POSITIVE_INFINITY)));
    if (!Number.isFinite(lowest)) break;
    maxBlockHeight = lowest - 1;
  }
  return [...all.values()].sort((a, b) => (BigInt(b.tx_block_timestamp) > BigInt(a.tx_block_timestamp) ? 1 : -1));
}

/**
 * The vault's operations, newest first, from its whole history. Throws when the index does not
 * answer: the caller says the list is incomplete instead of showing a shorter one.
 */
export async function vaultLogs(indexerUrl: string, vaultAccountId: string): Promise<VaultLog[]> {
  const base = indexerUrl.replace(/\/$/, "");
  const txs = await accountTxs(base, vaultAccountId);
  const when = new Map(txs.map((tx) => [tx.transaction_hash, new Date(Number(BigInt(tx.tx_block_timestamp) / 1_000_000n)).toISOString()]));
  const unread = txs.map((tx) => tx.transaction_hash).filter((hash) => !logsByTx.has(`${vaultAccountId}:${hash}`));
  for (let index = 0; index < unread.length; index += 20) {
    const chunk = unread.slice(index, index + 20);
    const { transactions } = await post<{ transactions: Array<IndexedTx | null> }>(`${base}/v0/transactions`, { tx_hashes: chunk });
    const read = new Map<string, VaultLog[]>();
    for (const tx of transactions) {
      if (!tx) continue;
      const logs: VaultLog[] = [];
      for (const receipt of tx.receipts ?? []) {
        const executor = receipt.execution_outcome?.outcome?.executor_id ?? receipt.receipt?.receiver_id;
        if (executor !== vaultAccountId) continue; // only the vault's own logs count
        for (const log of receipt.execution_outcome?.outcome?.logs ?? []) {
          for (const [kind, pattern] of PATTERNS) {
            const match = log.match(pattern);
            if (match) logs.push({ kind, opId: `0x${match[1]!}`, txHash: tx.transaction.hash, at: "" });
          }
        }
      }
      read.set(tx.transaction.hash, logs);
    }
    // A transaction the index does not have yet is asked again next time.
    for (const hash of chunk) if (read.has(hash)) logsByTx.set(`${vaultAccountId}:${hash}`, read.get(hash)!);
    if (logsByTx.size > MAX_KEPT_TXS) logsByTx.clear();
  }
  const found = new Map<string, VaultLog>();
  // Oldest first, so an operation keeps the transaction that announced it.
  for (const tx of [...txs].reverse()) {
    for (const log of logsByTx.get(`${vaultAccountId}:${tx.transaction_hash}`) ?? []) {
      if (!found.has(log.opId.slice(2))) found.set(log.opId.slice(2), { ...log, at: when.get(tx.transaction_hash) ?? new Date(0).toISOString() });
    }
  }
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at));
}
