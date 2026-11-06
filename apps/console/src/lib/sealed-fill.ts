/**
 * "Execute now": a member who reads an order's terms fills it from their browser when the market meets
 * the hidden limit. The proof is made here (the terms never leave the browser), the member's wallet
 * sends `fill`, and the swap the vault signed is posted to Base.
 */
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_UNISWAP as U, type SealedOrder } from "@euthyna/sdk/sealed-orders";
import { proveSealedFill, type SealedCircuit } from "@euthyna/sdk/sealed-proof";
import { fillOutcome, tick, type Tick } from "@euthyna/sdk/sealed-watcher";
import circuitUrl from "@euthyna/sdk/circuits/sealed_order.json?url";

import { nearRpcMethod, signContractCall, viewContract } from "../wallets.js";
import { sendSealedApprovals } from "./sealed-approval.js";

const base = createPublicClient({ chain: baseSepolia, transport: http(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org") });
const quoter = parseAbi(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);

let circuit: Promise<SealedCircuit> | null = null;
const loadCircuit = () => (circuit ??= fetch(circuitUrl).then((response) => response.json() as Promise<SealedCircuit>));

type OnChainOrder = { filled: string; fills: number; cancelled: boolean; wallet: string };
type Outcome = { receipts_outcome: Array<{ outcome: { logs: string[] } }> };

export const baseGasPrice = () => base.getGasPrice();

export type FillResult = Tick & { baseTransaction?: Hex };

export async function fillNow(input: { me: string; sealedId: string; id: number; order: SealedOrder; chunk?: bigint }): Promise<FillResult> {
  const { me, sealedId, id, order } = input;
  const state = () => viewContract<OnChainOrder | null>(sealedId, "order", { vault: order.vaultId, id });
  const first = await state();
  if (!first) return { status: "missing" };
  const wallet = getAddress(first.wallet);
  let fillTransaction = "";
  const result = await tick(order, {
    now: () => Math.floor(Date.now() / 1000),
    orderState: async () => {
      const current = await state();
      return current ? { filled: BigInt(current.filled), fills: current.fills, cancelled: current.cancelled } : null;
    },
    quote: async (amountIn) => {
      const { result: quoted } = await base.simulateContract({ address: U.quoter, abi: quoter, functionName: "quoteExactInputSingle", args: [[order.tokenIn, order.tokenOut, amountIn, order.fee, 0n]] });
      return quoted[0];
    },
    allowance: () => base.readContract({ address: U.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, U.router] }),
    prove: async (fill) => proveSealedFill(await loadCircuit(), order, fill),
    fill: async (proved) => {
      const gasPrice = await base.getGasPrice();
      fillTransaction = await signContractCall(me, sealedId, "fill", {
        vault: order.vaultId, id, router: U.router, token_in: order.tokenIn, token_out: order.tokenOut, fee: order.fee,
        amount_in: proved.amountIn.toString(), rate: proved.rate.toString(), now_s: String(proved.now), proof: proved.proof,
        gas_limit: "250000", max_fee_per_gas: (gasPrice * 3n + 1_000_000n).toString(), max_priority_fee_per_gas: "1000000",
      }, { gas: "300000000000000" });
      const outcome = await nearRpcMethod<Outcome>("tx", { tx_hash: fillTransaction, sender_account_id: me, wait_until: "FINAL" });
      const logs = outcome.receipts_outcome.flatMap((receipt) => receipt.outcome.logs);
      return { transaction: fillTransaction, ...fillOutcome(logs) };
    },
  }, input.chunk);
  if (result.status !== "filled") return result;
  const [baseTransaction] = await sendSealedApprovals(fillTransaction, me, order.vaultId);
  return baseTransaction ? { ...result, baseTransaction } : result;
}
