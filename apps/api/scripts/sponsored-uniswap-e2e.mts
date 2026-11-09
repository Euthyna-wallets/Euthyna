/**
 * A real Uniswap V3 swap (WETH → USDC, SwapRouter02 on Base Sepolia) from the company wallet, as one
 * sponsored executeBatch: approve + exactInputSingle + revoke. The role is the console's "swap" block
 * compiled by the SDK (router, pair, recipient = the wallet, daily budget). The wallet never holds ETH:
 * the tank wraps a little ETH and sends it the WETH to sell, then relays the swap.
 *
 *   KEYS_DIR=… TAG=… OWNER_KEY=<key json> TANK_KEY=<file> tsx scripts/sponsored-uniswap-e2e.mts
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA, compileRole } from "@euthyna/sdk/roles";
import { BASE_SEPOLIA_UNISWAP } from "@euthyna/sdk";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";

const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]);
const KEYS = process.env.KEYS_DIR!, TAG = process.env.TAG!;
const vaultId = `eut-sp-${TAG}.testnet`, agentId = `eut-sp-${TAG}-agent.testnet`;
const key = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as { account_id: string; private_key: string };
const ownerKey = key(process.env.OWNER_KEY!);
const owner = await pooledAccount(pool, "testnet", ownerKey.account_id, ownerKey.private_key);
const agent = await pooledAccount(pool, "testnet", agentId, key(`${KEYS}/${agentId}.json`).private_key);
const tankKey = fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex;
const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never, new GasTank(tankKey, "https://sepolia.base.org", 84532, 2_000_000_000_000_000n));
const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const tank = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(tankKey) });
const view = <T>(methodName: string, args: Record<string, unknown> = {}) => owner.viewFunction({ contractId: vaultId, methodName, args }) as Promise<T>;
const call = async (acc: typeof owner, methodName: string, args: Record<string, unknown>, gas = 300_000_000_000_000n) => {
  const out = await acc.functionCall({ contractId: vaultId, methodName, args, gas, attachedDeposit: 0n });
  const fail = out.receipts_outcome.find((o) => (o.outcome.status as { Failure?: unknown }).Failure);
  if (fail) throw new Error(`${methodName}: ${JSON.stringify((fail.outcome.status as { Failure: unknown }).Failure).slice(0, 400)}`);
  return out;
};
const ret = (out: { status: unknown }) => JSON.parse(Buffer.from((out.status as { SuccessValue: string }).SuccessValue, "base64").toString());
const bytes = (hex: string) => Array.from(Buffer.from(hex.slice(2), "hex"));
const { router, quoter, usdc, weth } = BASE_SEPOLIA_UNISWAP;
const walletView = await view<{ address: number[] }>("get_wallet", { chain_id: 84532 });
const wallet = `0x${Buffer.from(walletView.address).toString("hex")}` as Hex;
const AMOUNT_IN = 100_000_000_000_000n; // 0.0001 WETH

// 1. The role, as the console compiles it: swap WETH → USDC on Uniswap V3, 0.001 WETH a day.
const changes = compileRole({
  name: "uniswap",
  blocks: [{ kind: "swap", tokenIn: weth, tokensOut: [usdc], protocols: ["uniswap-v3"], budget: { amount: "0.001", periodDays: 1 }, maxApproval: "0.001" }],
  members: [{ accountId: agentId, kind: "Agent" }],
}, BASE_SEPOLIA);
const ids: number[] = [];
for (const change of changes) ids.push(ret(await call(owner, "queue_rule_change", { change })).queue_id);
await sleep(2500);
for (const id of ids) await call(owner, "execute_rule_change", { queue_id: id });
step("role 'uniswap' voted:", changes.map((c) => Object.keys(c)[0]).join(", "));

// 2. WETH to sell, sent to the wallet by the tank (the wallet itself holds no ETH).
const wethAbi = parseAbi(["function deposit() payable"]);
await pub.waitForTransactionReceipt({ hash: await tank.writeContract({ address: weth, abi: wethAbi, functionName: "deposit", value: AMOUNT_IN }) });
await pub.waitForTransactionReceipt({ hash: await tank.writeContract({ address: weth, abi: erc20Abi, functionName: "transfer", args: [wallet, AMOUNT_IN] }) });
const balances = async () => ({
  WETH: Number(await pub.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })) / 1e18,
  USDC: Number(await pub.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })) / 1e6,
  allowanceToRouter: (await pub.readContract({ address: weth, abi: erc20Abi, functionName: "allowance", args: [wallet, router] })).toString(),
  ETH: Number(await pub.getBalance({ address: wallet })) / 1e18,
});
step("before", JSON.stringify(await balances()));

// 3. Quote: the pool with the best price among the usual fee tiers; 3% slippage.
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
let best = { fee: 0, out: 0n };
for (const fee of [100, 500, 3000, 10000]) {
  const out = await pub.simulateContract({ address: quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: weth, tokenOut: usdc, amountIn: AMOUNT_IN, fee, sqrtPriceLimitX96: 0n }] }).then((r) => r.result[0], () => 0n);
  if (out > best.out) best = { fee, out };
}
step("quote", AMOUNT_IN, "wei WETH →", Number(best.out) / 1e6, "USDC, fee tier", best.fee);
const minOut = (best.out * 97n) / 100n;

// 4. The agent asks for the swap with its approval bundled; MPC signs once; the tank relays.
const routerAbi = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const swap = encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: weth, tokenOut: usdc, fee: best.fee, recipient: wallet, amountIn: AMOUNT_IN, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
const request = { chain_id: 84532, target: bytes(router), value: "0", calldata: bytes(swap), allowance_amount: AMOUNT_IN.toString(), reference: `uni-${TAG}-${Date.now()}`, gas_limit: "300000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "1000000" };
const op = ret(await call(agent, "prepare_with_approval", { role: "uniswap", request, approval: { token: bytes(weth), amount: AMOUNT_IN.toString() } }, 100_000_000_000_000n));
const opHex = Buffer.from(op.op_id).toString("hex");
step("prepared", opHex.slice(0, 12));
await call(agent, "authorize", { op_id: op.op_id, approval: null });
let signed: { signed_transaction: number[] | null; state: string } | null = null;
for (let i = 0; i < 20 && !signed?.signed_transaction; i++) { await sleep(3000); signed = await view("get_operation", { op_id: op.op_id }); }
step("signed by NEAR MPC:", signed?.state);
const hash = await base.relay(wallet as never, signed!.signed_transaction!);
const receipt = await pub.waitForTransactionReceipt({ hash });
step("relayed", hash, receipt.status, "gas paid by tank", Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18, "ETH");
step("after", JSON.stringify(await balances()));
console.log(JSON.stringify({ OP_ID: opHex, TX: hash }));
