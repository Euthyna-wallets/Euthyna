/**
 * A Uniswap V3 pool for Noah's sandbox euro (EURC_TEST, what a company's IBAN settles into) on Base
 * Sepolia, so a judge can swap the euros the company received. Uniswap has no pool for this token:
 * this creates WETH/EURC_TEST (0.3 %) on the official factory at the market rate given in EUR_PER_ETH,
 * and the tank adds a WETH-only position just above it, the side a EURC → WETH swap moves into.
 *
 *   TANK_KEY=<file> EUR_PER_ETH=1899 WETH=0.0003 tsx scripts/eurc-pool-setup.mts
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const WETH = "0x4200000000000000000000000000000000000006" as Hex; // token0 (0x42… < 0x62…)
const EURC = "0x623ef90571256F905B2Fde947dC33098BdD8F4d8" as Hex; // token1
const FACTORY = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Hex;
const NPM = "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2" as Hex; // NonfungiblePositionManager, Base Sepolia
const FEE = 3000, SPACING = 60;
const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const tank = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex) });
const abi = parseAbi([
  "function factory() view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)",
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
]);
const wait = async (hash: Hex, what: string) => { const r = await pub.waitForTransactionReceipt({ hash }); console.log(what, r.status, hash); if (r.status !== "success") throw new Error(what); };

if ((await pub.readContract({ address: NPM, abi, functionName: "factory" })).toLowerCase() !== FACTORY.toLowerCase()) throw new Error("NPM is not Uniswap's");
const eurPerEth = Number(process.env.EUR_PER_ETH);
// price = token1 per token0 in raw units = EUR × 1e6 / 1e18.
const price = (eurPerEth * 1e6) / 1e18;
const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
let pool = await pub.readContract({ address: FACTORY, abi, functionName: "getPool", args: [WETH, EURC, FEE] });
if (/^0x0+$/.test(pool)) {
  await wait(await tank.writeContract({ address: NPM, abi, functionName: "createAndInitializePoolIfNecessary", args: [WETH, EURC, FEE, sqrtPriceX96] }), "pool created");
  pool = await pub.readContract({ address: FACTORY, abi, functionName: "getPool", args: [WETH, EURC, FEE] });
}
const [, tick] = await pub.readContract({ address: pool, abi, functionName: "slot0" });
console.log("pool", pool, "tick", tick);
// WETH only: the range starts one spacing above the current tick and spans ~5 % (8 spacings).
const tickLower = (Math.floor(tick / SPACING) + 1) * SPACING;
const tickUpper = tickLower + 8 * SPACING;
const amount = parseEther(process.env.WETH ?? "0.0003");
await wait(await tank.writeContract({ address: WETH, abi, functionName: "deposit", value: amount }), "wrap");
await wait(await tank.writeContract({ address: WETH, abi, functionName: "approve", args: [NPM, amount] }), "approve");
await wait(await tank.writeContract({ address: NPM, abi, functionName: "mint", args: [{ token0: WETH, token1: EURC, fee: FEE, tickLower, tickUpper, amount0Desired: amount, amount1Desired: 0n, amount0Min: 0n, amount1Min: 0n, recipient: tank.account.address, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }] }), `mint [${tickLower}, ${tickUpper}]`);
