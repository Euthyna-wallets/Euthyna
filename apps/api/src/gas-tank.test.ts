import http from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseTransaction, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GasTank } from "./gas-tank.js";

// A Base Sepolia stand-in: balances by address, every sent transaction recorded and mined at once.
const balances = new Map<string, bigint>();
const sent: Hex[] = [];
let server: http.Server;
let url = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
      const answer = (call: { id: number; method: string; params: unknown[] }) => {
        const hex = (n: bigint | number) => `0x${n.toString(16)}`;
        const result = (() => {
          switch (call.method) {
            case "eth_chainId": return hex(84532);
            case "eth_getBalance": return hex(balances.get(String(call.params[0]).toLowerCase()) ?? 0n);
            case "eth_getTransactionCount": return "0x0";
            case "eth_estimateGas": return hex(21000);
            case "eth_gasPrice": return hex(6_000_000);
            case "eth_maxPriorityFeePerGas": return hex(1_000_000);
            case "eth_getBlockByNumber": return { baseFeePerGas: hex(5_000_000), number: "0x1", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", transactions: [] };
            case "eth_sendRawTransaction": { sent.push(call.params[0] as Hex); return `0x${"ab".repeat(32)}`; }
            case "eth_getTransactionReceipt": return { status: "0x1", blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}`, transactionHash: call.params[0], logs: [], cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", from: "0x" + "00".repeat(20), to: null, contractAddress: null, logsBloom: "0x" + "00".repeat(256), transactionIndex: "0x0", type: "0x2" };
            case "eth_blockNumber": return "0x2";
            default: return null;
          }
        })();
        return { jsonrpc: "2.0", id: call.id, result };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(calls) ? calls.map(answer) : answer(calls)));
    });
  }).listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function companyTransaction(gas: bigint, maxFeePerGas: bigint) {
  const company = privateKeyToAccount(generatePrivateKey());
  const raw = await company.signTransaction({ chainId: 84532, type: "eip1559", to: `0x${"cd".repeat(20)}`, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 1_000_000n, nonce: 0 });
  return { company, raw };
}

describe("testnet gas tank", () => {
  it("sends a wallet with no ETH what its transaction needs, and nothing when it already has it", async () => {
    sent.length = 0;
    const tank = new GasTank(generatePrivateKey(), url, 84532, 2_000_000_000_000_000n);
    const { company, raw } = await companyTransaction(100_000n, 12_000_000n);
    const topUp = await tank.topUpFor(raw);
    expect(topUp?.wallet).toBe(company.address);
    // gas x max fee + 0.00002 ETH margin
    expect(topUp?.sentWei).toBe(100_000n * 12_000_000n + 20_000_000_000_000n);
    expect(parseTransaction(sent[0]!).to?.toLowerCase()).toBe(company.address.toLowerCase());

    balances.set(company.address.toLowerCase(), 10n ** 18n);
    expect(await tank.topUpFor(raw)).toBeNull();
  });

  it("stops at the daily cap per wallet", async () => {
    sent.length = 0;
    const tank = new GasTank(generatePrivateKey(), url, 84532, 1_000_000_000_000n);
    const { raw } = await companyTransaction(100_000n, 12_000_000n);
    expect(await tank.topUpFor(raw)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("refuses to run on a mainnet", () => {
    expect(() => new GasTank(generatePrivateKey(), url, 8453, 1n)).toThrow(/testnets only/);
  });

  it("gives two relays sent at once two nonces, even when the RPC has not seen the first", async () => {
    // This stand-in always answers 0 to eth_getTransactionCount, like a lagging public RPC.
    const tank = new GasTank(generatePrivateKey(), url, 84532, 10n ** 16n);
    const before = sent.length;
    await Promise.all([tank.relay(`0x${"aa".repeat(20)}`, "0x01"), tank.relay(`0x${"bb".repeat(20)}`, "0x02")]);
    const nonces = sent.slice(before).map((raw) => parseTransaction(raw).nonce);
    expect(nonces).toEqual([0, 1]);
  });
});
