/** Live test of eth-infinitism's Simple7702Account (v0.8, deployed) on Base Sepolia: a throwaway key's EOA
 * delegates to it, a paymaster pays, the tank acts as bundler (handleOps). */
import fs from "node:fs";
import { concat, createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, pad, parseAbi, toHex, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const S = process.env.S!; // folder with base-gas-tank.key and aa7702/out (OnlyPaymaster, see docs/sponsored-gas.md)
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", ACCOUNT_IMPL = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyFile = `${S}/aa7702/throwaway.key`;
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const owner = privateKeyToAccount(fs.readFileSync(keyFile, "utf8").trim() as Hex);
const tankAcc = privateKeyToAccount(fs.readFileSync(`${S}/base-gas-tank.key`, "utf8").trim() as Hex);
const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const tank = createWalletClient({ chain: baseSepolia, transport, account: tankAcc });
const wallet = owner.address;
const art = (path: string) => JSON.parse(fs.readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const OUT = "/home/claude/mandateos/contracts/evm/executor/out/EuthynaExecutor.t.sol";
const erc20 = art(`${OUT}/Erc20.json`), router = art(`${OUT}/Router.json`), pm = art(`${S}/aa7702/out/OnlyPaymaster.sol/OnlyPaymaster.json`);
const wait = async (hash: Hex) => pub.waitForTransactionReceipt({ hash });
const deploy = async (a: { abi: Abi; bytecode: { object: Hex } }, args: unknown[] = []) => (await wait(await tank.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress!;

const epAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getUserOpHash(PackedUserOperation op) view returns (bytes32)",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function depositTo(address account) payable",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
]);
const accountAbi = parseAbi(["struct Call { address target; uint256 value; bytes data; }", "function executeBatch(Call[] calls)"]);

// 1. Delegation: the throwaway key signs the authorization, the tank pays the type-4 transaction.
const code = await pub.getCode({ address: wallet });
if (code?.toLowerCase() !== `0xef0100${ACCOUNT_IMPL.slice(2).toLowerCase()}`) {
  const authorization = await owner.signAuthorization({ address: ACCOUNT_IMPL, chainId: 84532, nonce: await pub.getTransactionCount({ address: wallet }) });
  await wait(await tank.sendTransaction({ to: tankAcc.address, value: 0n, authorizationList: [authorization] }));
}
step("wallet", wallet, "code", await pub.getCode({ address: wallet }), "ETH", Number(await pub.getBalance({ address: wallet })) / 1e18);

// 2. Paymaster for this wallet only, funded in the EntryPoint by the tank; a test market.
const paymaster = await deploy(pm, [EP, wallet]);
await wait(await tank.writeContract({ address: EP, abi: epAbi, functionName: "depositTo", args: [paymaster], value: 200_000_000_000_000n }));
const [tokenIn, tokenOut, routerAddress] = [await deploy(erc20), await deploy(erc20), await deploy(router)];
await wait(await tank.writeContract({ address: tokenIn, abi: erc20.abi, functionName: "mint", args: [wallet, 100_000_000n] }));
await wait(await tank.writeContract({ address: tokenOut, abi: erc20.abi, functionName: "mint", args: [routerAddress, 1_000_000_000n] }));
step("paymaster", paymaster, "market", { tokenIn, tokenOut, router: routerAddress });

const u128 = (a: bigint, b: bigint) => concat([pad(toHex(a), { size: 16 }), pad(toHex(b), { size: 16 })]);
const approve = (amount: bigint) => encodeFunctionData({ abi: erc20.abi, functionName: "approve", args: [routerAddress, amount] });
const swapBatch = (amountIn: bigint, minOut: bigint) => encodeFunctionData({ abi: accountAbi, functionName: "executeBatch", args: [[
  { target: tokenIn, value: 0n, data: approve(amountIn) },
  { target: routerAddress, value: 0n, data: encodeFunctionData({ abi: router.abi, functionName: "swap", args: [tokenIn, tokenOut, amountIn, minOut] }) },
  { target: tokenIn, value: 0n, data: approve(0n) },
]] });
const fees = await pub.estimateFeesPerGas();
async function userOp(nonce: bigint, callData: Hex) {
  const op = {
    sender: wallet, nonce, initCode: "0x" as Hex, callData,
    accountGasLimits: u128(150_000n, 300_000n), preVerificationGas: 60_000n,
    gasFees: u128(fees.maxPriorityFeePerGas! * 2n, fees.maxFeePerGas! * 3n),
    paymasterAndData: concat([paymaster, pad(toHex(80_000n), { size: 16 }), pad(toHex(10_000n), { size: 16 })]),
    signature: "0x" as Hex,
  };
  const hash = await pub.readContract({ address: EP, abi: epAbi, functionName: "getUserOpHash", args: [op] });
  return { ...op, signature: await owner.sign({ hash }) };
}
async function bundle(ops: Awaited<ReturnType<typeof userOp>>[]) {
  const receipt = await wait(await tank.writeContract({ address: EP, abi: epAbi, functionName: "handleOps", args: [ops, tankAcc.address], gas: 1_500_000n }));
  const events = receipt.logs.flatMap((log) => { try { return [decodeEventLog({ abi: epAbi, ...log })]; } catch { return []; } });
  return { hash: receipt.transactionHash, status: receipt.status, events: events.map((e) => ({ name: e.eventName, ...(e.args as Record<string, unknown>) })) };
}
const read = async (fn: "balanceOf" | "allowance", token: Hex, args: Hex[]) => Number(await pub.readContract({ address: token, abi: erc20.abi, functionName: fn, args }) as bigint) / 1e6;
const state = async () => ({ in: await read("balanceOf", tokenIn, [wallet]), out: await read("balanceOf", tokenOut, [wallet]), allowance: await read("allowance", tokenIn, [wallet, routerAddress]), walletETH: Number(await pub.getBalance({ address: wallet })) / 1e18, nonce: (await pub.readContract({ address: EP, abi: epAbi, functionName: "getNonce", args: [wallet, 0n] })).toString() });
const show = (r: Awaited<ReturnType<typeof bundle>>) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// T1: approve + swap + revoke, paid by the paymaster.
let nonce = await pub.readContract({ address: EP, abi: epAbi, functionName: "getNonce", args: [wallet, 0n] });
step("T1 batch", show(await bundle([await userOp(nonce, swapBatch(4_000_000n, 8_000_000n))])), JSON.stringify(await state()));

// T2: no deadline: an op signed now still runs later.
nonce += 1n;
const late = await userOp(nonce, swapBatch(1_000_000n, 2_000_000n));
step("T2 signed, waiting 3 min…");
await sleep(180_000);
step("T2 still runs after 3 min", show(await bundle([late])), JSON.stringify(await state()));

// T3: a failing swap: the bundle succeeds, UserOperationEvent.success = false, the nonce is used.
nonce += 1n;
step("T3 failing swap", show(await bundle([await userOp(nonce, swapBatch(1_000_000n, 9_000_000n))])), JSON.stringify(await state()));

// T4: cancel by burning the nonce: an empty op with the same nonce goes first; the signed swap then fails AA25.
nonce += 1n;
const toCancel = await userOp(nonce, swapBatch(1_000_000n, 2_000_000n));
step("T4 burn", show(await bundle([await userOp(nonce, "0x")])), JSON.stringify(await state()));
const replay = await bundle([toCancel]).catch((e: Error) => ({ status: "refused", error: e.message.slice(0, 120) }));
step("T4 the cancelled op:", JSON.stringify(replay.status), JSON.stringify(await state()));
