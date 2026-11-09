/**
 * Moves an e2e vault's wallet to another executor by vote (the keeper re-delegates), then checks on
 * Base Sepolia that the delegated wallet accepts an ERC-721 safe mint. Run after sponsored-testnet-e2e.mts.
 *
 *   KEYS_DIR=… TAG=… OWNER_KEY=<key json> TANK_KEY=<file> EXECUTOR=0x… NFT_ARTIFACT=<forge out json> tsx scripts/sponsored-nft-e2e.mts
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { pooledAccount, RpcPool } from "../src/rpc-pool.js";
import { GasTank } from "../src/gas-tank.js";
import { BaseRelayer } from "../src/relayer.js";
import { keepDelegated } from "../src/delegation-keeper.js";

const step = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = new RpcPool(["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"]);
const EXECUTOR = process.env.EXECUTOR as Hex;
const vaultId = `eut-sp-${process.env.TAG}.testnet`;
const owner = JSON.parse(fs.readFileSync(process.env.OWNER_KEY!, "utf8"));
const ownerAcc = await pooledAccount(pool, "testnet", owner.account_id, owner.private_key);
const tankKey = fs.readFileSync(process.env.TANK_KEY!, "utf8").trim() as Hex;
const tank = new GasTank(tankKey, "https://sepolia.base.org", 84532, 2_000_000_000_000_000n);
const view = <T>(methodName: string, args: Record<string, unknown> = {}) => ownerAcc.viewFunction({ contractId: vaultId, methodName, args }) as Promise<T>;
const call = async (methodName: string, args: Record<string, unknown>) => {
  const out = await ownerAcc.functionCall({ contractId: vaultId, methodName, args, gas: 300_000_000_000_000n, attachedDeposit: 0n });
  const fail = out.receipts_outcome.find((o) => (o.outcome.status as { Failure?: unknown }).Failure);
  if (fail) throw new Error(`${methodName}: ${JSON.stringify((fail.outcome.status as { Failure: unknown }).Failure).slice(0, 300)}`);
  return out;
};

if ((await view<string | null>("get_evm_executor", { chain_id: 84532 }))?.toLowerCase() !== EXECUTOR.toLowerCase()) {
  const out = await call("queue_rule_change", { change: { SetEvmExecutor: { chain_id: 84532, executor: Array.from(Buffer.from(EXECUTOR.slice(2), "hex")) } } });
  const { queue_id } = JSON.parse(Buffer.from((out.status as { SuccessValue: string }).SuccessValue, "base64").toString());
  await sleep(2500);
  await call("execute_rule_change", { queue_id });
}
step("executor voted", await view("get_evm_executor", { chain_id: 84532 }));

const base = new BaseRelayer("https://sepolia.base.org", {} as never, {} as never, tank);
const near = { viewFunction: <T>(_v: string, m: string, a?: Record<string, unknown>) => view<T>(m, a), delegateWallet: () => call("delegate_wallet", { chain_id: 84532 }).then((o) => o.transaction.hash) };
for (let i = 0; i < 20; i++) {
  const outcome = await keepDelegated(near, base, vaultId, 84532);
  step("delegation:", outcome);
  if (outcome === "delegated") break;
  await sleep(outcome === "submitted" ? 6000 : 3000);
}
const walletView = await view<{ address: number[] }>("get_wallet", { chain_id: 84532 });
const wallet = `0x${Buffer.from(walletView.address).toString("hex")}` as Hex;
step("wallet", wallet, "code", await base.code(wallet as never), "ETH", Number(await base.balance(wallet as never)) / 1e18);

// An ERC-721 that checks onERC721Received like OpenZeppelin's _safeMint; the tank deploys it and mints to the wallet.
const art = JSON.parse(fs.readFileSync(process.env.NFT_ARTIFACT!, "utf8"));
const transport = http("https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const w = createWalletClient({ chain: baseSepolia, transport, account: privateKeyToAccount(tankKey) });
const deployed = await pub.waitForTransactionReceipt({ hash: await w.deployContract({ abi: art.abi, bytecode: art.bytecode.object }) });
const nft = deployed.contractAddress!;
const mint = await w.writeContract({ address: nft, abi: art.abi, functionName: "safeMint", args: [wallet, 1n] });
const minted = await pub.waitForTransactionReceipt({ hash: mint });
step("safeMint", mint, minted.status, "owner of #1", await pub.readContract({ address: nft, abi: art.abi, functionName: "ownerOf", args: [1n] }));
