import { afterEach, describe, expect, it, vi } from "vitest";

import { vaultLogs } from "./chain-activity.js";

const VAULT = "acme.nomos.euthyna.testnet";
const hash = (index: number) => `tx${String(index).padStart(4, "0")}`;

/** An index holding `count` transactions of the vault, newest first; one agent operation in tx `opAt`. */
function index(count: number, opAt: number) {
  const asked: string[][] = [];
  const txs = Array.from({ length: count }, (_, i) => ({ transaction_hash: hash(i), tx_block_timestamp: String(BigInt(2_000_000 - i) * 1_000_000_000n), tx_block_height: 1_000_000 - i }));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/v0/account")) return new Response(JSON.stringify({ account_txs: txs, txs_count: txs.length }));
    asked.push(body.tx_hashes);
    return new Response(JSON.stringify({
      transactions: body.tx_hashes.map((h: string) => ({
        transaction: { hash: h },
        receipts: [{ execution_outcome: { outcome: { executor_id: VAULT, logs: h === hash(opAt) ? [`OMNIROLES_OPERATION_PREPARED:${"ab".repeat(32)}`] : ["OMNIROLES_RULE_EXECUTED:00"] } } }],
      })),
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { txs, asked };
}

afterEach(() => vi.unstubAllGlobals());

describe("vault activity from the chain", () => {
  it("finds an agent's operation however many transactions came after it (it used to stop at 100)", async () => {
    index(164, 120);
    const logs = await vaultLogs("https://index.example", VAULT);
    expect(logs).toEqual([expect.objectContaining({ kind: "evm", opId: `0x${"ab".repeat(32)}`, txHash: hash(120) })]);
  });

  it("reads each transaction once: the next call asks only for the new ones", async () => {
    const { txs, asked } = index(60, 10);
    await vaultLogs("https://index.example", "other.nomos.euthyna.testnet");
    const first = asked.flat().length;
    txs.unshift({ transaction_hash: "new-tx", tx_block_timestamp: String(3_000_000n * 1_000_000_000n), tx_block_height: 1_000_001 });
    await vaultLogs("https://index.example", "other.nomos.euthyna.testnet");
    expect(first).toBe(60);
    expect(asked.flat().slice(first)).toEqual(["new-tx"]);
  });

  it("throws when the index does not answer, so the screen can say the list is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(vaultLogs("https://index.example", "third.nomos.euthyna.testnet")).rejects.toThrow(/HTTP 429/);
  });
});
