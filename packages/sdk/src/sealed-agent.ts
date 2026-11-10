/**
 * Sealed orders for whoever acts in a role: an agent (MCP), or a member running the watcher (CLI).
 * Places an order (the router approval when the wallet needs one, then the seal with the terms
 * encrypted for the members' reading keys), and watches it: quote, prove, fill, then broadcast and
 * settle the swap. The hidden terms stay in the order file this returns; keep it private.
 */
import { KeyPair, keyStores, Near, type Account } from "near-api-js";
import { createPublicClient, erc20Abi, getAddress, http, parseAbi, parseUnits, type Hex, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";

import { sealedKeyOf } from "./agent-keys.js";
import { relayedCall, type DelegateRelay } from "./meta-tx.js";
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

export const DEFAULT_SEALED_ACCOUNT = "euthyna-sealed-orders-v3.testnet";
const TGAS = 1_000_000_000_000n;

/** What the order's holder keeps: the terms (secret) and where the order lives. */
export type OrderFile = {
  order: Record<string, string | number>;
  vault: string;
  role: string;
  id: number;
  sealedAccountId: string;
  commitment: string;
  /** Base operations signed for this order but not settled yet (the router approval, then the fills). */
  pending?: number[][];
};

export type OrderView = {
  id: number; vault: string; role: string; chain_id: number; wallet: string; sealer: string; commitment: string;
  slippage_bps: number; filled: string; fills: number; cancelled: boolean; sealed_at_ns: string; terms: string | null;
};

type Logs = { receipts_outcome: Array<{ outcome: { logs: string[] } }>; transaction_outcome: { id: string } };
const logsOf = (outcome: unknown) => (outcome as Logs).receipts_outcome.flatMap((receipt) => receipt.outcome.logs);
const hashOf = (outcome: unknown) => (outcome as Logs).transaction_outcome.id;
const eventOf = (outcome: unknown, name: string) => logsOf(outcome)
  .map((line) => line.startsWith("EVENT_JSON:") ? JSON.parse(line.slice(11)) as { standard?: string; event: string; data: Array<Record<string, unknown>> } : null)
  .find((event) => event?.standard === "euthyna-sealed-orders" && event.event === name)?.data[0];

/** Whether `publicKey` is an access key of `accountId` (final). */
async function hasKey(rpcUrl: string, accountId: string, publicKey: string): Promise<boolean> {
  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "k", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
  });
  const body = await response.json() as { result?: { error?: string; permission?: unknown } };
  return Boolean(body.result && !body.result.error && body.result.permission);
}

export type SealedAgentApi = { gas?(): Promise<void>; announce?(opId: number[]): Promise<void>; relay?: DelegateRelay };

export class SealedAgent {
  private constructor(
    private readonly account: Account,
    private readonly base: PublicClient,
    private readonly sealedId: string,
    private readonly credentials: { networkId: string; rpcUrl: string; accountId: string } & ({ privateKey: string } | { signer: AgentNearSigner }),
    private readonly baseRpc: string,
    /** Signing with the agent's sealed key, a function-call key: no deposit possible. */
    private readonly limitedKey = false,
    /** The agent API, when there is one: gas top-ups, and the relayer told of approvals at once. */
    private readonly api?: SealedAgentApi,
    /** The key this agent signs sealed calls with (key file only): what a relayed delegate is signed with. */
    private readonly keyPair?: KeyPair,
  ) {}

  /** Best effort: the API tops the agent's NEAR for gas up before a 300 Tgas call (when it does not relay). */
  private async fuel(): Promise<void> {
    if (this.api?.relay && this.keyPair) return;
    await this.api?.gas?.().catch(() => undefined);
  }

  /** A call to the sealed-orders contract: relayed (Euthyna pays the gas) when it can be, else sent by the agent. */
  private async call(input: { contractId: string; methodName: string; args: Record<string, unknown>; gas: bigint; attachedDeposit: bigint }) {
    if (this.api?.relay && this.keyPair && input.attachedDeposit === 0n) {
      const outcome = await relayedCall({
        rpcUrl: this.credentials.rpcUrl, senderId: this.credentials.accountId, keyPair: this.keyPair, receiverId: input.contractId,
        methodName: input.methodName, args: input.args, gas: input.gas, relay: this.api.relay,
      });
      if (outcome) return outcome;
    }
    return this.account.functionCall(input);
  }

  static async connect(input: {
    networkId?: string; nearRpc?: string; baseRpc?: string; sealedAccountId?: string; accountId: string; api?: SealedAgentApi;
  } & ({ privateKey: string; signer?: undefined } | { signer: AgentNearSigner; privateKey?: undefined })) {
    const networkId = input.networkId ?? "testnet";
    const rpcUrl = input.nearRpc ?? "https://rpc.testnet.fastnear.com";
    const baseRpc = input.baseRpc ?? "https://sepolia.base.org";
    let near: Near;
    let useSealed = false;
    if (input.signer) {
      near = new Near({ networkId, nodeUrl: rpcUrl, signer: input.signer as never });
    } else {
      // A hired agent's main key only calls the vault: its sealed key (derived from it) calls this
      // contract. A member's full-access key, or an agent hired before, signs with the main key.
      const keyStore = new keyStores.InMemoryKeyStore();
      const sealedKey = sealedKeyOf(input.privateKey);
      useSealed = await hasKey(rpcUrl, input.accountId, sealedKey.getPublicKey().toString());
      await keyStore.setKey(networkId, input.accountId, useSealed ? sealedKey : KeyPair.fromString(input.privateKey as `ed25519:${string}`));
      near = new Near({ networkId, nodeUrl: rpcUrl, keyStore });
    }
    const credentials = input.signer
      ? { networkId, rpcUrl, accountId: input.accountId, signer: input.signer }
      : { networkId, rpcUrl, accountId: input.accountId, privateKey: input.privateKey! };
    return new SealedAgent(await near.account(input.accountId), createPublicClient({ chain: baseSepolia, transport: http(baseRpc) }) as PublicClient,
      input.sealedAccountId ?? DEFAULT_SEALED_ACCOUNT, credentials, baseRpc, useSealed, input.api,
      input.privateKey ? (useSealed ? sealedKeyOf(input.privateKey) : KeyPair.fromString(input.privateKey as `ed25519:${string}`)) : undefined);
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
    const pending: number[][] = [];
    await this.fuel();
    if (input.approveUsdc) {
      const gasPrice = await this.base.getGasPrice();
      const outcome = await this.call({
        contractId: this.sealedId, methodName: "approve", gas: 300n * TGAS, attachedDeposit: 0n,
        args: approveArgs({ vault: input.vault, role: input.role, chainId: U.chainId, token: U.usdc, router: U.router, amount: parseUnits(input.approveUsdc, 6), maxFeePerGas: gasPrice * 3n + 1_000_000n }),
      });
      transactions.push(hashOf(outcome));
      const approved = eventOf(outcome, "approved");
      if (!approved) throw new Error(`the router approval was refused: ${logsOf(outcome).join(" ")}`);
      // Signed by the vault: broadcast it now so the allowance is on Base before the first fill.
      const opId = approved.op_id as number[];
      pending.push(opId);
      await this.settle(input.vault, opId, 0);
    }
    const commitment = await commitmentOf(order);
    const readers = await this.view<Array<{ account: string; public_key: string }>>("readers", { vault: input.vault });
    const terms = readers.length ? await encryptTerms(order, readers.map((reader) => ({ account: reader.account, publicKey: reader.public_key }))) : null;
    // The vault's credit pays the storage when it can: an agent's key cannot attach a deposit.
    const credit = BigInt(await this.view<string>("credit_of", { vault: input.vault }).catch(() => "0"));
    if (this.limitedKey && credit < BigInt(SEALED_DEPOSIT_YOCTO)) {
      throw new Error("the vault's sealed-orders credit is empty: a member adds some from the console (Sealed orders, Add credit); an agent's key cannot attach the 0.02 NEAR deposit itself");
    }
    const outcome = await this.call({
      contractId: this.sealedId, methodName: "seal", gas: 100n * TGAS, attachedDeposit: credit >= BigInt(SEALED_DEPOSIT_YOCTO) ? 0n : BigInt(SEALED_DEPOSIT_YOCTO),
      args: sealArgs({ vault: input.vault, role: input.role, chainId: U.chainId, commitment: commitment as Hex, slippageBps: input.slippageBps ?? 50, terms }),
    });
    transactions.push(hashOf(outcome));
    const sealed = eventOf(outcome, "sealed");
    if (!sealed) throw new Error(`the seal was refused: ${logsOf(outcome).join(" ")}`);
    return {
      file: { order: serializeOrder(order), vault: input.vault, role: input.role, id: sealed.id as number, sealedAccountId: this.sealedId, commitment, ...(pending.length ? { pending } : {}) },
      transactions,
    };
  }

  /** One look at the market for an order; fills (prove, then `fill`) when it meets the hidden limit. */
  async tick(file: OrderFile, chunk?: bigint): Promise<Tick> {
    const order = parseOrder(file.order);
    // An order file saved before its vote passed holds a guessed id: find the order by its hash.
    let stored = Number.isInteger(file.id) && file.id >= 0 ? await this.order(file.vault, file.id) : null;
    if (!stored || stored.commitment !== file.commitment.toLowerCase()) {
      stored = (await this.orders(file.vault)).find((candidate) => candidate.commitment === file.commitment.toLowerCase()) ?? null;
      if (!stored) return { status: "missing" };
      file.id = stored.id;
    }
    const wallet = stored.wallet as Hex;
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
      allowance: () => this.allowance(wallet),
      balance: () => this.base.readContract({ address: order.tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(wallet)] }),
      prove: (fill) => proveFill(order, fill),
      fill: async (input) => {
        await this.fuel();
        const gasPrice = await this.base.getGasPrice();
        const outcome = await this.call({
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
    const gateway = await NearVaultGateway.connect({ ...this.credentials, vaultAccountId: vault, role: "sealed-orders", chainId: U.chainId, relay: this.api?.relay } as Parameters<typeof NearVaultGateway.connect>[0]);
    // With the API, a sponsored approval or swap is announced to the relayer now, not at its next round.
    const client = new OnchainAgentClient(gateway, publicRpc(this.baseRpc), this.api?.announce ? { preflightInvoice: async () => undefined, announce: (op) => this.api!.announce!(op) } : undefined);
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
