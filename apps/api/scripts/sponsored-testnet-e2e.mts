/**
 * Sponsored execution (EIP-7702) end to end on NEAR testnet + Base Sepolia, with the real NEAR MPC:
 * a fresh vault (this branch's wasm), its wallet delegated to EuthynaExecutor, an agent's payment
 * signed as Execute, relayed and paid for by the gas tank, settled on the MPC-attested log.
 * The company wallet never holds ETH.
 *
 *   OWNER_KEY=<key json> TANK_KEY=<file> EXECUTOR=0x… pnpm --filter @euthyna/api exec tsx scripts/sponsored-testnet-e2e.mts
 */
import fs from "node:fs";
import { KeyPair, keyStores, Near } from "near-api-js";
import { encodeFunctionData, type Hex } from "viem";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";
import { keepDelegated } from "../src/delegation-keeper.js";

const NET = "testnet";
const RPC = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
const BASE_RPC = "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SUPPLIER = "0x000000000000000000000000000000000000bEEF";
const EXECUTOR = process.env.EXECUTOR as Hex;
const WASM = fs.readFileSync(new URL("../../../contracts/res/vault.wasm", import.meta.url));
const owner = JSON.parse(fs.readFileSync(process.env.OWNER_KEY!, "utf8")) as { account_id: string; private_key: string };
const tank = new GasTank(fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex, BASE_RPC, 84532, 2_000_000_000_000_000n);
const pool = new RpcPool(RPC);
const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = process.env.TAG ?? Date.now().toString(36).slice(-5);

const KEYS = process.env.KEYS_DIR ?? ".";
async function fresh(name: string) {
  const saved = `${KEYS}/${name}.json`;
  if (fs.existsSync(saved)) {
    const k = JSON.parse(fs.readFileSync(saved, "utf8"));
    return pooledAccount(pool, NET, k.account_id, k.private_key);
  }
  const kp = KeyPair.fromRandom("ed25519");
  fs.writeFileSync(saved, JSON.stringify({ account_id: name, private_key: kp.toString() }), { mode: 0o600 });
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: name, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`helper ${r.status} ${await r.text()}`);
  return pooledAccount(pool, NET, name, kp.toString());
}
const ownerAcc = await pooledAccount(pool, NET, owner.account_id, owner.private_key);
const view = <T>(contractId: string, methodName: string, args: Record<string, unknown> = {}) => ownerAcc.viewFunction({ contractId, methodName, args }) as Promise<T>;
const call = async (acc: typeof ownerAcc, contractId: string, methodName: string, args: Record<string, unknown>, gas = 300_000_000_000_000n, deposit = 0n) => {
  const out = await acc.functionCall({ contractId, methodName, args, gas, attachedDeposit: deposit });
  const fail = out.receipts_outcome.find((o) => (o.outcome.status as { Failure?: unknown }).Failure);
  if (fail) throw new Error(`${methodName}: ${JSON.stringify((fail.outcome.status as { Failure: unknown }).Failure).slice(0, 300)}`);
  return out;
};

// 1. A fresh vault with this branch's code; a plain account is its owner (a DAO in production).
const vaultId = `eut-sp-${tag}.testnet`, agentId = `eut-sp-${tag}-agent.testnet`;
const resuming = fs.existsSync(`${KEYS}/${vaultId}.json`);
const vault = await fresh(vaultId);
const agent = await fresh(agentId);
if (!resuming) {
// The vault's code takes ~11 NEAR of storage: FUNDERS (key files) top the new account up.
// FUNDERS: "keyfile:NEAR,keyfile:NEAR".
for (const entry of (process.env.FUNDERS ?? "").split(",").filter(Boolean)) {
  const [file, near] = entry.split(":");
  const k = JSON.parse(fs.readFileSync(file!, "utf8")) as { account_id: string; private_key: string };
  const funder = await pooledAccount(pool, NET, k.account_id, k.private_key);
  await funder.sendMoney(vaultId, BigInt(Math.round(Number(near) * 1000)) * 10n ** 21n);
}
await vault.deployContract(WASM);
}
const initialized = await view(vaultId, "get_settlement_config").then(() => true, () => false);
if (!initialized) {
const random32 = () => Buffer.from(KeyPair.fromRandom("ed25519").getPublicKey().data).toString("base64");
await call(vault, vaultId, "new", {
  client_id: `sp-${tag}`, owner_id: owner.account_id, mpc_contract_id: "v1.signer-prod.testnet",
  visa_public_key: random32(), status_public_key: random32(), policy_version: 1, registry_version: 1,
  operation_ttl_ns: 3_600_000_000_000, rule_delay_ns: 1_000_000_000, rule_expiration_ns: 86_400_000_000_000,
  council: [owner.account_id], settlement_config: null,
});
}
step("vault", vaultId, "deployed, sha256", (await import("node:crypto")).createHash("sha256").update(WASM).digest("hex").slice(0, 8));

// 2. Its Base Sepolia wallet, derived by NEAR MPC.
let walletView = await view<{ address: number[] | null } | null>(vaultId, "get_wallet", { chain_id: 84532 });
if (!walletView?.address) await call(ownerAcc, vaultId, "request_wallet", { chain_id: 84532 });
for (let i = 0; i < 30 && !walletView?.address; i++) { await sleep(3000); walletView = await view(vaultId, "get_wallet", { chain_id: 84532 }); }
if (!walletView?.address) throw new Error("wallet not derived");
const wallet = `0x${Buffer.from(walletView.address!).toString("hex")}` as Hex;
step("wallet", wallet);

// 3. Rules: a payments role (USDC to one supplier), its budget, the agent, and sponsored execution.
const budgetKey = Array.from(Buffer.alloc(32, 7));
const transfer = encodeFunctionData({ abi: [{ type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [SUPPLIER, 0n] });
const role = {
  guard_required: false, enabled: true,
  permissions: [{ chain_id: 84532, target: Array.from(Buffer.from(USDC.slice(2), "hex")), selector: [0xa9, 0x05, 0x9c, 0xbb],
    conditions: [{ parent: 0, paramType: 5, operator: 5, compValue: "0x" },
      { parent: 0, paramType: 1, operator: 16, compValue: `0x${"0".repeat(24)}${SUPPLIER.slice(2).toLowerCase()}` },
      { parent: 0, paramType: 1, operator: 28, compValue: `0x${Buffer.from(budgetKey).toString("hex")}` }],
    allow_value: false }],
  operation_delay_threshold: null, operation_delay_ns: 0, co_sign_threshold: null, co_signer_role: null, velocity: null,
  gas_limit: "300000", max_fee_per_gas: "100000000000", max_priority_fee_per_gas: "10000000000", max_total_fee: "30000000000000000",
};
const changes = [
  { SetRole: { role: "payments", config: role } },
  { SetAllowance: { key: budgetKey, balance: "10000000", refill: "0", max_refill: "10000000", period_ns: 0 } },
  { GrantMembership: { role: "payments", member: agentId, kind: "Agent", starts_at_ns: "0", ends_at_ns: null, max_uses: null } },
  { SetEvmExecutor: { chain_id: 84532, executor: Array.from(Buffer.from(EXECUTOR.slice(2), "hex")) } },
];
const ids: number[][] = [];
if (!(await view(vaultId, "get_evm_executor", { chain_id: 84532 }))) for (const change of changes) {
  const out = await call(ownerAcc, vaultId, "queue_rule_change", { change });
  ids.push(JSON.parse(Buffer.from((out.status as { SuccessValue: string }).SuccessValue, "base64").toString()).queue_id);
}
await sleep(2500);
for (const id of ids) await call(ownerAcc, vaultId, "execute_rule_change", { queue_id: id });
step("rules applied; executor", await view(vaultId, "get_evm_executor", { chain_id: 84532 }));

// 4. The wallet delegates to the executor: MPC signs the authorization, the tank submits it.
const base = new BaseRelayer(BASE_RPC, { delegateWallet: () => Promise.resolve("") } as never, {} as never, tank);
const near = { viewFunction: view, delegateWallet: (v: string, c: number) => call(ownerAcc, v, "delegate_wallet", { chain_id: c }).then((o) => o.transaction.hash) };
for (let i = 0; i < 20; i++) {
  const outcome = await keepDelegated(near, base, vaultId, 84532);
  step("delegation:", outcome);
  if (outcome === "delegated") break;
  await sleep(outcome === "submitted" ? 6000 : 3000);
}
step("wallet code", await base.code(wallet as never), "ETH", Number(await base.balance(wallet as never)) / 1e18);

// 5. The agent pays (0 USDC to the supplier: the point is who pays the gas), the vault signs Execute.
const request = { chain_id: 84532, target: Array.from(Buffer.from(USDC.slice(2), "hex")), value: "0", calldata: Array.from(Buffer.from(transfer.slice(2), "hex")), allowance_amount: "0", reference: `sp-${tag}-1`, gas_limit: "120000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "1000000" };
const prepared = await call(agent, vaultId, "prepare", { role: "payments", request });
const op = JSON.parse(Buffer.from((prepared.status as { SuccessValue: string }).SuccessValue, "base64").toString());
step("prepared", Buffer.from(op.op_id).toString("hex").slice(0, 12), "sponsored", JSON.stringify(await view(vaultId, "get_sponsored_operation", { op_id: op.op_id })));
await call(agent, vaultId, "authorize", { op_id: op.op_id, approval: null });
let signed: { signed_transaction: number[] | null; state: string } | null = null;
for (let i = 0; i < 20 && !signed?.signed_transaction; i++) { await sleep(3000); signed = await view(vaultId, "get_operation", { op_id: op.op_id }); }
step("signed by MPC:", signed?.state, "calldata bytes", signed?.signed_transaction?.length, "wallet nonce kept", (await view<{ next_nonce: number }>(vaultId, "get_wallet", { chain_id: 84532 })).next_nonce);

// 6. The tank relays it; the wallet runs it.
const hash = await base.relay(wallet as never, signed!.signed_transaction!);
step("relayed", hash);
let log = null;
for (let i = 0; i < 30 && !log; i++) { await sleep(2000); log = await base.executedLog(hash, wallet as never, `0x${Buffer.from(op.op_id).toString("hex")}` as Hex); }
step("Executed log", JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), "wallet ETH", Number(await base.balance(wallet as never)) / 1e18);

// 7. Once Base Sepolia finalizes the block, the vault settles on NEAR MPC's attestation of the log.
while ((await base.finalizedBlockNumber()) < log!.blockNumber) { step("waiting for finality…"); await sleep(30_000); }
const settled = await call(agent, vaultId, "settle_sponsored", { op_id: op.op_id, tx_hash: Array.from(Buffer.from(hash.slice(2), "hex")), block_hash: Array.from(Buffer.from(log!.blockHash.slice(2), "hex")), block_number: log!.blockNumber.toString(), tx_index: String(log!.transactionIndex), log_index: String(log!.logIndex) });
step("settle tx", settled.transaction.hash);
await sleep(4000);
step("operation state:", (await view<{ state: string }>(vaultId, "get_operation", { op_id: op.op_id })).state);
