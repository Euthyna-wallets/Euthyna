/**
 * Sealed-order swaps on a fork of Base Sepolia (anvil): the calldata `fill` signs, sent from a company
 * wallet against the real Uniswap v3 pool. A rate at or under the market fills; a rate above it reverts
 * on chain, so a false rate in a proof can only make a fill fail.
 *   pnpm --filter @euthyna/sdk exec tsx scripts/sealed-order-fork.ts   (needs anvil; RPC: BASE_SEPOLIA_RPC_URL)
 */
import { spawn } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseAbi, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_UNISWAP as U, exactInputSingleCalldata, minOut, rateOf } from "../src/sealed-orders.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const PORT = 8547;
const WALLET: Hex = "0xC63Ac0Bc10dc950B97893818CE553528C1c55ce4"; // a company wallet from the 5 Nov walk
const POOL: Hex = "0x46880b404CD35c165EDdefF7421019F8dD25F4Ad"; // USDC/WETH 0.3% on Base Sepolia
const FEE = 3000;
const SLIPPAGE_BPS = 50;
const AMOUNT = 1_000_000n; // 1 USDC

const anvil = spawn(process.env.ANVIL ?? "anvil", ["--fork-url", RPC, "--port", String(PORT), "--silent"], { stdio: "inherit" });
const url = `http://127.0.0.1:${PORT}`;
const transport = http(url);
const chain = { ...baseSepolia, rpcUrls: { default: { http: [url] } } };
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const wallet = createWalletClient({ chain, transport });

async function ready() {
  for (let i = 0; i < 100; i++) {
    try { await pub.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("anvil did not start");
}

const quoter = parseAbi(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);

async function swap(rate: bigint) {
  const amountOutMinimum = minOut(AMOUNT, rate, SLIPPAGE_BPS);
  const data = exactInputSingleCalldata({ tokenIn: U.usdc, tokenOut: U.weth, fee: FEE, recipient: WALLET, amountIn: AMOUNT, amountOutMinimum });
  const before = await pub.readContract({ address: U.weth, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] });
  try {
    const hash = await wallet.sendTransaction({ account: WALLET, to: U.router, data, gas: 300_000n });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const after = await pub.readContract({ address: U.weth, abi: erc20Abi, functionName: "balanceOf", args: [WALLET] });
    return { status: receipt.status, received: after - before, amountOutMinimum };
  } catch (error) {
    return { status: "reverted", reason: (error as Error).message.split("\n").find((line) => /revert|Too little/i.test(line)) ?? "reverted", amountOutMinimum };
  }
}

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  await ready();
  await test.setBalance({ address: WALLET, value: 10n ** 18n });
  await test.setBalance({ address: POOL, value: 10n ** 18n });
  await test.impersonateAccount({ address: POOL });
  await test.impersonateAccount({ address: WALLET });
  await wallet.writeContract({ account: POOL, address: U.usdc, abi: erc20Abi, functionName: "transfer", args: [WALLET, 10n * AMOUNT] });
  await wallet.writeContract({ account: WALLET, address: U.usdc, abi: erc20Abi, functionName: "approve", args: [U.router, 10n * AMOUNT] });

  const { result } = await pub.simulateContract({ address: U.quoter, abi: quoter, functionName: "quoteExactInputSingle", args: [[U.usdc, U.weth, AMOUNT, FEE, 0n]] });
  const market = rateOf(AMOUNT, result[0]);
  console.log(`market: 1 USDC -> ${result[0]} wei (rate ${market})`);

  const fair = await swap(market);
  check(fair.status === "success" && (fair.received ?? 0n) >= fair.amountOutMinimum, `a fill at the market rate swaps (got ${fair.received} wei, min ${fair.amountOutMinimum})`);

  const greedy = await swap((market * 102n) / 100n);
  check(greedy.status === "reverted", `a fill claiming 2% above the market reverts (${greedy.reason ?? greedy.status}, min ${greedy.amountOutMinimum})`);
} finally {
  anvil.kill();
}
process.exit(failed ? 1 : 0);
