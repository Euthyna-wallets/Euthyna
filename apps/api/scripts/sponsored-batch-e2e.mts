/**
 * approve + swap + revoke in one sponsored transaction, live on NEAR testnet + Base Sepolia with the
 * real NEAR MPC. Reuses the vault of sponsored-testnet-e2e.mts (TAG), upgrades its code to this
 * branch's wasm, moves its wallet to EXECUTOR by vote, and swaps on a test router the tank deploys
 * (test token in, test token out: Base Sepolia's USDC faucet is behind a captcha).
 *
 *   KEYS_DIR=… TAG=… OWNER_KEY=<key json> TANK_KEY=<file> EXECUTOR=0x… OUT=<forge out dir> tsx scripts/sponsored-batch-e2e.mts
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";
import { keepDelegated } from "../src/delegation-keeper.js";

const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]);
const KEYS = process.env.KEYS_DIR!, TAG = process.env.TAG!, EXECUTOR = process.env.EXECUTOR as Hex, OUT = process.env.OUT!;
const vaultId = `eut-sp-${TAG}.testnet`, agentId = `eut-sp-${TAG}-agent.testnet`;
const key = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as { account_id: string; private_key: string };
const owner = await pooledAccount(pool, "testnet", key(process.env.OWNER_KEY!).account_id, key(process.env.OWNER_KEY!).private_key);
const vault = await pooledAccount(pool, "testnet", vaultId, key(`${KEYS}/${vaultId}.json`).private_key);
const agent = await pooledAccount(pool, "testnet", agentId, key(`${KEYS}/${agentId}.json`).private_key);
const tankKey = fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex;
const tank = new GasTank(tankKey, "https://sepolia.base.org", 84532, 2_000_000_000_000_000n);
const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never, tank);
const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const tankWallet = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(tankKey) });
const view = <T>(methodName: string, args: Record<string, unknown> = {}) => owner.viewFunction({ contractId: vaultId, methodName, args }) as Promise<T>;
const call = async (acc: typeof owner, methodName: string, args: Record<string, unknown>, gas = 300_000_000_000_000n) => {
  const out = await acc.functionCall({ contractId: vaultId, methodName, args, gas, attachedDeposit: 0n });
  const fail = out.receipts_outcome.find((o) => (o.outcome.status as { Failure?: unknown }).Failure);
  if (fail) throw new Error(`${methodName}: ${JSON.stringify((fail.outcome.status as { Failure: unknown }).Failure).slice(0, 400)}`);
  return out;
};
const ret = (out: { status: unknown }) => JSON.parse(Buffer.from((out.status as { SuccessValue: string }).SuccessValue, "base64").toString());
const bytes = (hex: string) => Array.from(Buffer.from(hex.slice(2), "hex"));
const artifact = (name: string, file = "EuthynaExecutor.t.sol") => JSON.parse(fs.readFileSync(`${OUT}/${file}/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex } };

// 1. This branch's vault code (prepare_with_approval).
const wasm = fs.readFileSync(new URL("../../../contracts/res/vault.wasm", import.meta.url));
await vault.deployContract(wasm);
step("vault code", (await import("node:crypto")).createHash("sha256").update(wasm).digest("hex").slice(0, 8));

// 2. A test market: tokens in and out, a router that pulls the input with transferFrom.
const deploy = async (name: string) => (await pub.waitForTransactionReceipt({ hash: await tankWallet.deployContract({ abi: artifact(name).abi, bytecode: artifact(name).bytecode.object }) })).contractAddress!;
const erc20 = artifact("Erc20").abi, router = artifact("Router").abi;
const [tokenIn, tokenOut, routerAddress] = [await deploy("Erc20"), await deploy("Erc20"), await deploy("Router")];
const walletView = await view<{ address: number[] }>("get_wallet", { chain_id: 84532 });
const wallet = `0x${Buffer.from(walletView.address).toString("hex")}` as Hex;
for (const [token, to] of [[tokenIn, wallet], [tokenOut, routerAddress]] as const) {
  await pub.waitForTransactionReceipt({ hash: await tankWallet.writeContract({ address: token, abi: erc20, functionName: "mint", args: [to, 100_000_000n] }) });
}
step("market", { tokenIn, tokenOut, router: routerAddress });

// 3. Votes (the owner stands for the DAO): the role may swap on the router and approve it on the input token.
const role = {
  guard_required: false, enabled: true,
  permissions: [
    { chain_id: 84532, target: bytes(routerAddress), selector: bytes(encodeFunctionData({ abi: router, functionName: "swap", args: [tokenIn, tokenOut, 0n, 0n] }).slice(0, 10)), conditions: [], allow_value: false },
    { chain_id: 84532, target: bytes(tokenIn), selector: [0x09, 0x5e, 0xa7, 0xb3], conditions: [], allow_value: false },
  ],
  operation_delay_threshold: null, operation_delay_ns: 0, co_sign_threshold: null, co_signer_role: null, velocity: null,
  gas_limit: "400000", max_fee_per_gas: "100000000000", max_priority_fee_per_gas: "10000000000", max_total_fee: "30000000000000000",
};
const ids: number[] = [];
for (const change of [{ SetRole: { role: "swaps", config: role } }, { GrantMembership: { role: "swaps", member: agentId, kind: "Agent", starts_at_ns: "0", ends_at_ns: null, max_uses: null } }, { SetEvmExecutor: { chain_id: 84532, executor: bytes(EXECUTOR) } }]) {
  ids.push(ret(await call(owner, "queue_rule_change", { change })).queue_id);
}
await sleep(2500);
for (const id of ids) await call(owner, "execute_rule_change", { queue_id: id });
step("rules applied; executor", await view("get_evm_executor", { chain_id: 84532 }));

// 4. The keeper moves the wallet to the new executor.
const near = { viewFunction: <T>(_v: string, m: string, a?: Record<string, unknown>) => view<T>(m, a), delegateWallet: () => call(owner, "delegate_wallet", { chain_id: 84532 }).then((o) => o.transaction.hash) };
for (let i = 0; i < 20; i++) {
  const outcome = await keepDelegated(near, base, vaultId, 84532);
  step("delegation:", outcome);
  if (outcome === "delegated") break;
  await sleep(outcome === "submitted" ? 6000 : 3000);
}

// 5. The agent swaps 4 in for at least 8 out: one prepare, one MPC signature, one relayed transaction.
const swap = encodeFunctionData({ abi: router, functionName: "swap", args: [tokenIn, tokenOut, 4_000_000n, 8_000_000n] });
const request = { chain_id: 84532, target: bytes(routerAddress), value: "0", calldata: bytes(swap), allowance_amount: "0", reference: `swap-${TAG}-${Date.now()}`, gas_limit: "300000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "1000000" };
const op = ret(await call(agent, "prepare_with_approval", { role: "swaps", request, approval: { token: bytes(tokenIn), amount: "4000000" } }, 100_000_000_000_000n));
const opHex = Buffer.from(op.op_id).toString("hex");
step("prepared", opHex.slice(0, 12), JSON.stringify(await view("get_sponsored_operation", { op_id: op.op_id })));
await call(agent, "authorize", { op_id: op.op_id, approval: null });
let signed: { signed_transaction: number[] | null; state: string } | null = null;
for (let i = 0; i < 20 && !signed?.signed_transaction; i++) { await sleep(3000); signed = await view("get_operation", { op_id: op.op_id }); }
const data = `0x${Buffer.from(signed!.signed_transaction!).toString("hex")}` as Hex;
step("signed by MPC:", signed?.state, "selector", data.slice(0, 10));
const hash = await base.relay(wallet as never, signed!.signed_transaction!);
const receipt = await pub.waitForTransactionReceipt({ hash });
const read = (token: Hex, fn: "balanceOf" | "allowance", args: Hex[]) => pub.readContract({ address: token, abi: erc20, functionName: fn, args }) as Promise<bigint>;
step("relayed", hash, receipt.status, "logs", receipt.logs.length);
step("wallet in", Number(await read(tokenIn, "balanceOf", [wallet])) / 1e6, "out", Number(await read(tokenOut, "balanceOf", [wallet])) / 1e6,
  "allowance left", (await read(tokenIn, "allowance", [wallet, routerAddress])).toString(), "wallet ETH", Number(await base.balance(wallet as never)) / 1e18);
const log = await base.executedLog(hash, wallet as never, `0x${opHex}` as Hex);
step("Executed log", JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log(JSON.stringify({ OP_ID: opHex, TX: hash }));
