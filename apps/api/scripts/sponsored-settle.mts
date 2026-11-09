/**
 * Second half of sponsored-testnet-e2e.mts, for when Base Sepolia finality outlasts the first run:
 * waits for the block holding the Executed log to finalize, then settles the operation on NEAR.
 *
 *   KEYS_DIR=… TAG=… OP_ID=<hex> TX=<0x…> pnpm --filter @euthyna/api exec tsx scripts/sponsored-settle.mts
 */
import fs from "node:fs";
import type { Hex } from "viem";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { BaseRelayer } from "../src/relayer.js";

const pool = new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]);
const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vaultId = `eut-sp-${process.env.TAG}.testnet`;
const k = JSON.parse(fs.readFileSync(`${process.env.KEYS_DIR}/eut-sp-${process.env.TAG}-agent.testnet.json`, "utf8"));
const agent = await pooledAccount(pool, "testnet", k.account_id, k.private_key);
const opHex = process.env.OP_ID!, hash = process.env.TX as Hex, opId = Array.from(Buffer.from(opHex, "hex"));
const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never);
const walletView = await agent.viewFunction({ contractId: vaultId, methodName: "get_wallet", args: { chain_id: 84532 } }) as { address: number[] };
const wallet = `0x${Buffer.from(walletView.address).toString("hex")}` as Hex;
const log = (await base.executedLog(hash, wallet as never, `0x${opHex}` as Hex))!;
step("Executed log in block", log.blockNumber);
for (;;) {
  const finalized = await base.finalizedBlockNumber();
  if (finalized >= log.blockNumber) break;
  step("finalized", finalized, "missing", log.blockNumber - finalized, "blocks");
  await sleep(120_000);
}
const out = await agent.functionCall({ contractId: vaultId, methodName: "settle_sponsored", gas: 300_000_000_000_000n, attachedDeposit: 0n,
  args: { op_id: opId, tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")), block_hash: Array.from(Buffer.from(log.blockHash.slice(2), "hex")), block_number: log.blockNumber.toString(), tx_index: String(log.transactionIndex), log_index: String(log.logIndex) } });
step("settle tx", out.transaction.hash);
for (let i = 0; i < 20; i++) {
  await sleep(4000);
  const op = await agent.viewFunction({ contractId: vaultId, methodName: "get_operation", args: { op_id: opId } }) as { state: string };
  step("operation state:", op.state);
  if (op.state !== "Settling" && op.state !== "PossiblySigned") break;
}
