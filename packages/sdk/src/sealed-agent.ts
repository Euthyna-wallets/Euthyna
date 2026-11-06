/**
 * Sealed orders for whoever acts in a role: an agent (MCP), or a member running the watcher (CLI).
 * Places an order (the router approval when the wallet needs one, then the seal with the terms
 * encrypted for the members' reading keys), and watches it: quote, prove, fill, then broadcast and
 * settle the swap. The hidden terms stay in the order file this returns; keep it private.
 */
import { KeyPair, keyStores, Near, type Account } from "near-api-js";
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, parseUnits, type Hex, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";

import { NearVaultGateway, operationIdHex } from "./index.js";
import { OnchainAgentClient, publicRpc } from "./onchain.js";
import {
  BASE_SEPOLIA_UNISWAP as U,
  approveArgs,
  encryptTerms,
  parseOrder,
  randomSalt,
  rateFromPrice,
  SEALED_DEPOSIT_YOCTO,
  sealArgs,
  serializeOrder,
  type SealedOrder,
} from "./sealed-orders.js";
import { commitmentOf, proveFill } from "./sealed-prover.js";
import { fillOutcome, tick, type Tick } from "./sealed-watcher.js";
import type { AgentNearSigner } from "./signer-socket.js";

export const DEFAULT_SEALED_ACCOUNT = "euthyna-sealed-orders-v2.testnet";
const TGAS = 1_000_000_000_000n;

/** What the order's holder keeps: the terms (secret) and where the order lives. */
export type OrderFile = {
  order: Record<string, string | number>;
  vault: string;
  role: string;
  id: number;
  sealedAccountId: string;
  commitment: string;
};

export type OrderView = {
  id: number; vault: string; role: string; chain_id: number; wallet: string; sealer: string; commitment: string;
  slippage_bps: number; filled: string; fills: number; cancelled: boolean; sealed_at_ns: string; terms: string | null;
};

type Logs = { receipts_outcome: Array<{ outcome: { logs: string[] } }>; transaction_outcome: { id: string } };
const logsOf = (outcome: unknown) => (outcome as Logs).receipts_outcome.flatMap((receipt) => receipt.outcome.logs);
const hashOf = (outcome: unknown) => (outcome as Logs).transaction_outcome.id;

export class SealedAgent {
  private constructor(
    private readonly account: Account,
    private readonly base: PublicClient,
    private readonly sealedId: string,
    private readonly credentials: { networkId: string; rpcUrl: string; accountId: string } & ({ privateKey: string } | { signer: AgentNearSigner }),
    private readonly baseRpc: string,
  ) {}

  static async connect(input: {
    networkId?: string; nearRpc?: string; baseRpc?: string; sealedAccountId?: string; accountId: string;
  } & ({ privateKey: string; signer?: undefined } | { signer: AgentNearSigner; privateKey?: undefined })) {
    const networkId = input.networkId ?? "testnet";
    const rpcUrl = input.nearRpc ?? "https://rpc.testnet.fastnear.com";
    const baseRpc = input.baseRpc ?? "https://sepolia.base.org";
    let near: Near;
    if (input.signer) {
      near = new Near({ networkId, nodeUrl: rpcUrl, signer: input.signer as never });
    } else {
      const keyStore = new keyStores.InMemoryKeyStore();
      await keyStore.setKey(networkId, input.accountId, KeyPair.fromString(input.privateKey as `ed25519:${string}`));
      near = new Near({ networkId, nodeUrl: rpcUrl, keyStore });
    }
    const credentials = input.signer
      ? { networkId, rpcUrl, accountId: input.accountId, signer: input.signer }
      : { networkId, rpcUrl, accountId: input.accountId, privateKey: input.privateKey! };
    return new SealedAgent(await near.account(input.accountId), createPublicClient({ chain: baseSepolia, transport: http(baseRpc) }) as PublicClient,
      input.sealedAccountId ?? DEFAULT_SEALED_ACCOUNT, credentials, baseRpc);
  }

  private view<T>(methodName: string, args: object): Promise<T> {
    return this.account.viewFunction({ contractId: this.sealedId, methodName, args }) as Promise<T>;
  }

  orders(vault: string): Promise<OrderView[]> {
    return this.view("orders", { vault, limit: 50 });
  }

  order(vault: string, id: number): Promise<OrderView | null> {
    return this.view("order", { vault, id });
  }

  /** How much USDC the router may take from the wallet now. */
  async allowance(wallet: Hex): Promise<bigint> {
    return this.base.readContract({ address: U.usdc, abi: erc20Abi, functionName: "allowance", args: [getAddress(wallet), U.router] });
  }

  /**
   * Places an order: buy WETH with USDC on Uniswap when 1 WETH costs at most `maxPriceUsdc`, for at
   * most `capUsdc` in all, within `days`. `approveUsdc` approves the router first (within the role).
   */
  async place(input: {
    vault: string; role: string; maxPriceUsdc: number; capUsdc: string; days: number; fee?: number; slippageBps?: number; approveUsdc?: string;
  }): Promise<{ file: OrderFile; transactions: string[] }> {
    const order: SealedOrder = {
      vaultId: input.vault, chainId: U.chainId, tokenIn: U.usdc, tokenOut: U.weth, fee: input.fee ?? 3000,
      limitRate: rateFromPrice(input.maxPriceUsdc, 6, 18), cap: parseUnits(input.capUsdc, 6),
      expiry: Math.floor(Date.now() / 1000) + Math.round(input.days * 86_400), salt: randomSalt(),
    };
    const transactions: string[] = [];
    if (input.approveUsdc) {
      const gasPrice = await this.base.getGasPrice();
      const outcome = await this.account.functionCall({
        contractId: this.sealedId, methodName: "approve", gas: 300n * TGAS, attachedDeposit: 0n,
        args: approveArgs({ vault: input.vault, role: input.role, chainId: U.chainId, token: U.usdc, router: U.router, amount: parseUnits(input.approveUsdc, 6), maxFeePerGas: gasPrice * 3n + 1_000_000n }),
      });
      transactions.push(hashOf(outcome));
      if (!logsOf(outcome).some((line) => line.includes('"event":"approved"'))) throw new Error(`the router approval was refused: ${logsOf(outcome).join(" ")}`);
    }
    const commitment = await commitmentOf(order);
    const readers = await this.view<Array<{ account: string; public_key: string }>>("readers", { vault: input.vault });
    const terms = readers.length ? await encryptTerms(order, readers.map((reader) => ({ account: reader.account, publicKey: reader.public_key }))) : null;
    const outcome = await this.account.functionCall({
      contractId: this.sealedId, methodName: "seal", gas: 100n * TGAS, attachedDeposit: BigInt(SEALED_DEPOSIT_YOCTO),
      args: sealArgs({ vault: input.vault, role: input.role, chainId: U.chainId, commitment: commitment as Hex, slippageBps: input.slippageBps ?? 50, terms }),
    });
    transactions.push(hashOf(outcome));
    const sealed = logsOf(outcome).map((line) => line.startsWith("EVENT_JSON:") ? JSON.parse(line.slice(11)) as { event: string; data: Array<{ id: number }> } : null).find((event) => event?.event === "sealed");
    if (!sealed) throw new Error(`the seal was refused: ${logsOf(outcome).join(" ")}`);
    return {
      file: { order: serializeOrder(order), vault: input.vault, role: input.role, id: sealed.data[0]!.id, sealedAccountId: this.sealedId, commitment },
      transactions,
    };
  }

  /** One look at the market for an order; fills (prove, then `fill`) when it meets the hidden limit. */
  async tick(file: OrderFile, chunk?: bigint): Promise<Tick> {
    const order = parseOrder(file.order);
    // An order file saved before its vote passed holds a guessed id: find the order by its hash.
    const stored = await this.order(file.vault, file.id);
    if (!stored || stored.commitment !== file.commitment.toLowerCase()) {
      const found = (await this.orders(file.vault)).find((candidate) => candidate.commitment === file.commitment.toLowerCase());
      if (!found) return { status: "missing" };
      file.id = found.id;
    }
    const quoter = parseAbi(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
    return tick(order, {
      now: () => Math.floor(Date.now() / 1000),
      orderState: async () => {
        const state = await this.order(file.vault, file.id);
        return state ? { filled: BigInt(state.filled), fills: state.fills, cancelled: state.cancelled } : null;
      },
      quote: async (amountIn) => {
        const { result } = await this.base.simulateContract({ address: U.quoter, abi: quoter, functionName: "quoteExactInputSingle", args: [[order.tokenIn, order.tokenOut, amountIn, order.fee, 0n]] });
        return result[0];
      },
      prove: (fill) => proveFill(order, fill),
      fill: async (input) => {
        const gasPrice = await this.base.getGasPrice();
        const outcome = await this.account.functionCall({
          contractId: file.sealedAccountId, methodName: "fill", gas: 300n * TGAS, attachedDeposit: 0n,
          args: {
            vault: file.vault, id: file.id, router: U.router, token_in: order.tokenIn, token_out: order.tokenOut, fee: order.fee,
            amount_in: input.amountIn.toString(), rate: input.rate.toString(), now_s: String(input.now), proof: input.proof,
            gas_limit: "250000", max_fee_per_gas: (gasPrice * 3n + 1_000_000n).toString(), max_priority_fee_per_gas: "1000000",
          },
        });
        return { transaction: hashOf(outcome), ...fillOutcome(logsOf(outcome)) };
      },
    }, chunk);
  }

  /** Broadcasts a signed operation to Base and settles it on the vault once its block is final. */
  async settle(vault: string, opId: number[], waitMinutes = 40): Promise<string> {
    const gateway = await NearVaultGateway.connect({ ...this.credentials, vaultAccountId: vault, role: "sealed-orders", chainId: U.chainId } as Parameters<typeof NearVaultGateway.connect>[0]);
    const client = new OnchainAgentClient(gateway, publicRpc(this.baseRpc));
    const id = operationIdHex(opId);
    const deadline = Date.now() + waitMinutes * 60_000;
    let state = String((await client.status(id)).state);
    while (state === "PossiblySigned" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      state = String((await client.status(id)).state);
    }
    return state;
  }
}
