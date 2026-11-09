/**
 * Two voted transfers from the same wallet, started without waiting for each other (sponsored calls
 * use no wallet nonce), relayed by the tank, and settled from NEAR MPC's `Safe` attestation (testnet).
 * Reuses the vault of sponsored-testnet-e2e.mts; its owner (a plain account here) stands for the DAO.
 *
 *   KEYS_DIR=… TAG=… OWNER_KEY=<key json> TANK_KEY=<file> tsx scripts/sponsored-parallel-e2e.mts
 */
import fs from "node:fs";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";

const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]);
const KEYS = process.env.KEYS_DIR!, TAG = process.env.TAG!, vaultId = `eut-sp-${TAG}.testnet`;
const key = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as { account_id: string; private_key: string };
const o = key(process.env.OWNER_KEY!);
const owner = await pooledAccount(pool, "testnet", o.account_id, o.private_key);
const vault = await pooledAccount(pool, "testnet", vaultId, key(`${KEYS}/${vaultId}.json`).private_key);
const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never,
  new GasTank(fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex, "https://sepolia.base.org", 84532, 2_000_000_000_000_000n), "safe");
const view = <T>(m: string, a: Record<string, unknown> = {}) => owner.viewFunction({ contractId: vaultId, methodName: m, args: a }) as Promise<T>;
const call = async (m: string, a: Record<string, unknown>) => {
  const out = await owner.functionCall({ contractId: vaultId, methodName: m, args: a, gas: 300_000_000_000_000n, attachedDeposit: 0n });
  const f = out.receipts_outcome.find((x) => (x.outcome.status as { Failure?: unknown }).Failure);
  if (f) throw new Error(`${m}: ${JSON.stringify((f.outcome.status as { Failure: unknown }).Failure).slice(0, 300)}`);
  return out;
};
const ret = (out: { status: unknown }) => JSON.parse(Buffer.from((out.status as { SuccessValue: string }).SuccessValue, "base64").toString());
const t0 = Date.now();
const since = () => `${Math.round((Date.now() - t0) / 1000)} s`;

await vault.deployContract(fs.readFileSync(new URL("../../../contracts/res/vault.wasm", import.meta.url)));
step("vault code", (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(new URL("../../../contracts/res/vault.wasm", import.meta.url))).digest("hex").slice(0, 8));
const wallet = `0x${Buffer.from((await view<{ address: number[] }>("get_wallet", { chain_id: 84532 })).address).toString("hex")}` as Hex;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const tx = (amount: bigint) => ({ chain_id: 84532, target: Array.from(Buffer.from(USDC.slice(2), "hex")), value: "0",
  calldata: Array.from(Buffer.from(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: ["0x000000000000000000000000000000000000bEEF", amount] }).slice(2), "hex")),
  gas_limit: "100000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "1000000" });
const ids: number[][] = ret(await call("submit_transactions", { transactions: [tx(10_000n), tx(20_000n)] }));
step("2 transfers voted (0.01 and 0.02 USDC)");
await sleep(3000);
// Start the first, then the second as soon as the first is signed: no wait for its settlement.
const signedOps: Array<{ id: number[]; data: number[] }> = [];
for (const id of ids) {
  await call("start_dao_transaction", { chain_id: 84532 });
  let op: { state: string; signed_transaction: number[] | null } | null = null;
  for (let i = 0; i < 20 && !op?.signed_transaction; i++) { await sleep(3000); op = await view("get_operation", { op_id: id }); }
  step(`started and signed ${Buffer.from(id).toString("hex").slice(0, 10)}`, op?.state, "sponsored:", JSON.stringify(await view("get_sponsored_operation", { op_id: id })), since());
  signedOps.push({ id, data: op!.signed_transaction! });
}
step("in flight at once:", (await view<{ in_flight: unknown[] }>("get_wallet", { chain_id: 84532 })).in_flight.length);
const relayed = [];
for (const { id, data } of signedOps) {
  const hash = await base.relay(wallet as never, data);
  relayed.push({ id, hash });
  step("relayed", hash, since());
}
await sleep(6000);
const logs = [];
for (const { id, hash } of relayed) logs.push({ id, hash, log: (await base.executedLog(hash, wallet as never, `0x${Buffer.from(id).toString("hex")}` as Hex))! });
const last = logs.reduce((m, l) => (l.log.blockNumber > m ? l.log.blockNumber : m), 0n);
while ((await base.finalizedBlockNumber()) < last) { step("waiting for the safe head…", since()); await sleep(20_000); }
step("both blocks safe", since());
for (const { id, hash, log } of logs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await call("settle_sponsored", { op_id: id, tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")), block_hash: Array.from(Buffer.from(log.blockHash.slice(2), "hex")), block_number: log.blockNumber.toString(), tx_index: String(log.transactionIndex), log_index: String(log.logIndex) }).catch((e: Error) => ({ error: e.message }));
    await sleep(4000);
    const state = (await view<{ state: string }>("get_operation", { op_id: id })).state;
    step("settle", "error" in out ? `error ${out.error.slice(0, 80)}` : out.transaction.hash, "→", state, since());
    if (state === "Confirmed") break;
    await sleep(20_000);
  }
}
