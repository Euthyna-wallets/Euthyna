/**
 * Sealed orders from the command line, for the member who holds an order.
 *
 *   pnpm --filter @euthyna/api sealed new --vault <vault> --dao <dao> --price 2000 --cap 50 --days 7 [--fee 3000] > order.json
 *     A new order (USDC → WETH on Base Sepolia, filled at `price` USDC per WETH or better, at most
 *     `cap` USDC): prints the order file (keep it secret) and, on stderr, the commitment to seal.
 *   pnpm --filter @euthyna/api sealed watch order.json --key watcher.json [--chunk 5] [--every 60] [--once]
 *     Watches the market and fills when it meets the hidden limit: proves, sends `fill`, then
 *     broadcasts the signed swap to Base and settles it on the vault. `--key`: a NEAR credentials file
 *     ({account_id, private_key}) for any account with a little NEAR; it only pays gas.
 * Env: NEAR_RPC_URL (testnet default), BASE_SEPOLIA_RPC_URL, SEALED_ORDERS_ACCOUNT_ID.
 */
import { readFileSync } from "node:fs";

import { KeyPair, keyStores, Near } from "near-api-js";
import { createPublicClient, http, parseAbi, parseUnits, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_UNISWAP as U,
  NearVaultGateway,
  OnchainAgentClient,
  operationIdHex,
  parseOrder,
  publicRpc,
  randomSalt,
  rateFromPrice,
  serializeOrder,
  type SealedOrder,
} from "@euthyna/sdk";

import { commitmentOf, proveFill } from "./prover.js";
import { fillOutcome, tick } from "./watcher.js";

const NEAR_RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const SEALED = process.env.SEALED_ORDERS_ACCOUNT_ID ?? "sealed-orders.euthyna.testnet";
const FILL_GAS = "300000000000000";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function required(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

type OrderFile = { order: Record<string, string | number>; dao: string; id: number | null; sealedAccountId: string; commitment: string };

async function newOrder(args: string[]) {
  const order: SealedOrder = {
    vaultId: required(args, "vault"),
    chainId: U.chainId,
    tokenIn: U.usdc,
    tokenOut: U.weth,
    fee: Number(flag(args, "fee") ?? 3000),
    limitRate: rateFromPrice(Number(required(args, "price")), 6, 18),
    cap: parseUnits(required(args, "cap"), 6),
    expiry: Math.floor(Date.now() / 1000) + Math.round(Number(flag(args, "days") ?? 7) * 86_400),
    salt: randomSalt(),
  };
  const commitment = await commitmentOf(order);
  const file: OrderFile = { order: serializeOrder(order), dao: required(args, "dao"), id: null, sealedAccountId: SEALED, commitment };
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  process.stderr.write(`commitment ${commitment}\nseal it: a DAO proposal calling ${SEALED}.seal({"commitment":"${commitment}"}) with 0.01 NEAR; then put the order id in the file.\n`);
}

async function watch(args: string[]) {
  const path = args[0];
  if (!path) throw new Error("usage: sealed watch <order.json> --key <credentials.json>");
  const file = JSON.parse(readFileSync(path, "utf8")) as OrderFile;
  if (file.id === null || file.id === undefined) throw new Error("the order file has no id yet: seal it, then set its id");
  const order = parseOrder(file.order);
  const credentials = JSON.parse(readFileSync(required(args, "key"), "utf8")) as { account_id: string; private_key: string };
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", credentials.account_id, KeyPair.fromString(credentials.private_key as `ed25519:${string}`));
  const near = new Near({ networkId: "testnet", nodeUrl: NEAR_RPC, keyStore });
  const account = await near.account(credentials.account_id);
  const base = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC) });
  const quoter = parseAbi(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
  const vault = await NearVaultGateway.connect({ networkId: "testnet", rpcUrl: NEAR_RPC, accountId: credentials.account_id, privateKey: credentials.private_key, vaultAccountId: order.vaultId, role: "sealed-orders", chainId: order.chainId });
  const client = new OnchainAgentClient(vault, publicRpc(BASE_RPC));
  const chunk = flag(args, "chunk") ? parseUnits(flag(args, "chunk")!, 6) : undefined;
  const every = Number(flag(args, "every") ?? 60) * 1000;

  const deps = {
    now: () => Math.floor(Date.now() / 1000),
    orderState: async () => {
      const state = await account.viewFunction({ contractId: file.sealedAccountId, methodName: "order", args: { dao: file.dao, id: file.id } }) as { filled: string; fills: number; cancelled: boolean } | null;
      return state ? { filled: BigInt(state.filled), fills: state.fills, cancelled: state.cancelled } : null;
    },
    quote: async (amountIn: bigint) => {
      const { result } = await base.simulateContract({ address: U.quoter, abi: quoter, functionName: "quoteExactInputSingle", args: [[order.tokenIn, order.tokenOut, amountIn, order.fee, 0n]] });
      return result[0];
    },
    prove: (fill: Parameters<typeof proveFill>[1]) => proveFill(order, fill),
    fill: async (input: { amountIn: bigint; rate: bigint; now: number; proof: string }) => {
      const gasPrice = await base.getGasPrice();
      const outcome = await account.functionCall({
        contractId: file.sealedAccountId,
        methodName: "fill",
        args: {
          dao: file.dao, id: file.id, token_in: order.tokenIn, token_out: order.tokenOut, fee: order.fee,
          amount_in: input.amountIn.toString(), rate: input.rate.toString(), now_s: String(input.now), proof: input.proof,
          gas_limit: "250000", max_fee_per_gas: (gasPrice * 3n + 1_000_000n).toString(), max_priority_fee_per_gas: "1000000",
        },
        gas: BigInt(FILL_GAS),
        attachedDeposit: 0n,
      });
      const logs = (outcome as { receipts_outcome: Array<{ outcome: { logs: string[] } }> }).receipts_outcome.flatMap((receipt) => receipt.outcome.logs);
      return { transaction: (outcome as { transaction_outcome: { id: string } }).transaction_outcome.id, ...fillOutcome(logs) };
    },
  };

  for (;;) {
    const result = await tick(order, deps, chunk);
    const stamp = new Date().toISOString();
    if (result.status === "filled") {
      const opId = operationIdHex(result.opId) as Hex;
      console.log(`${stamp} filled ${result.amountIn} at rate ${result.rate}: NEAR tx ${result.transaction}, operation ${opId}`);
      // Broadcast the signed swap to Base and settle it on the vault (MPC checks the receipt).
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await client.status(opId);
        if (status.state !== "PossiblySigned") { console.log(`${stamp} operation ${opId}: ${String(status.state)}`); break; }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    } else if (result.status === "waiting") {
      // Printed on this machine only: the limit never leaves it.
      console.log(`${stamp} waiting: market rate ${result.marketRate} under the limit`);
    } else {
      console.log(`${stamp} ${result.status}${"reason" in result ? `: ${result.reason}` : ""}`);
      if (result.status !== "refused") break;
    }
    if (args.includes("--once")) break;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

const [command, ...rest] = process.argv.slice(2);
const run = command === "new" ? newOrder : command === "watch" ? watch : null;
if (!run) {
  console.error("usage: sealed new|watch … (see the top of src/sealed/watch.ts)");
  process.exit(2);
}
await run(rest);
process.exit(0);
