/**
 * Waits until a vault's wallet has nothing in flight, then delegates it to the voted executor
 * (what the worker's keeper does every 2 minutes once deployed).
 *   VAULT=… CALLER_KEY=<near key json> TANK_KEY=<file> tsx scripts/delegate-when-free.mts
 */
import fs from "node:fs";
import type { Hex } from "viem";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";
import { keepDelegated } from "../src/delegation-keeper.js";

const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vault = process.env.VAULT!;
const k = JSON.parse(fs.readFileSync(process.env.CALLER_KEY!, "utf8"));
const caller = await pooledAccount(new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]), "testnet", k.account_id, k.private_key);
const tank = new GasTank(fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex, "https://sepolia.base.org", 84532, 2_000_000_000_000_000n);
const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never, tank);
const view = <T>(_v: string, methodName: string, args: Record<string, unknown> = {}) => caller.viewFunction({ contractId: vault, methodName, args }) as Promise<T>;
const near = { viewFunction: view, delegateWallet: async () => (await caller.functionCall({ contractId: vault, methodName: "delegate_wallet", args: { chain_id: 84532 }, gas: 300_000_000_000_000n, attachedDeposit: 0n })).transaction.hash };
for (;;) {
  const wallet = await view<{ in_flight: unknown[]; active_operation: unknown }>(vault, "get_wallet", { chain_id: 84532 }).catch(() => null);
  if (wallet && wallet.in_flight.length === 0 && !wallet.active_operation) break;
  step("wallet busy:", wallet?.in_flight.length, "in flight");
  await sleep(120_000);
}
for (let i = 0; i < 20; i++) {
  const outcome = await keepDelegated(near, base, vault, 84532).catch((e: Error) => `failed: ${e.message.slice(0, 160)}`);
  step("delegation:", outcome);
  if (outcome === "delegated") break;
  await sleep(outcome === "submitted" ? 6000 : 4000);
}
