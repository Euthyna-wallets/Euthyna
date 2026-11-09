/**
 * Testnet gas sponsoring: a company wallet has no private key and starts with no ETH, so a judge
 * or a new company cannot pay a network fee. Just before a signed transaction is broadcast, the
 * tank sends the wallet what that transaction needs (its gas limit times its max fee, plus its
 * value and a margin for the L1 fee), within a cap per wallet per day.
 *
 * Testnet only (Base Sepolia, Ethereum Sepolia). The tank's key moves only the tank's own test ETH:
 * it can neither sign for a company wallet nor touch a vault.
 */
import { createPublicClient, createWalletClient, http, parseTransaction, recoverTransactionAddress, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

const TESTNETS: Record<number, Chain> = { [baseSepolia.id]: baseSepolia, [sepolia.id]: sepolia };
/** L1 data fee and price moves between quote and inclusion. */
const MARGIN_WEI = 20_000_000_000_000n; // 0.00002 ETH

export type TankTopUp = { wallet: Address; sentWei: bigint; txHash: Hex } | null;

/** An EIP-7702 authorization of a company wallet, signed by NEAR MPC. */
export type WalletAuthorization = { chainId: number; address: Address; nonce: number; r: Hex; s: Hex; yParity: number };

export class GasTank {
  private readonly account;
  private readonly client;
  private readonly wallet;
  private readonly chain: Chain;
  /** Wei sent per wallet and UTC day (memory: a restart only resets the day's count). */
  private readonly sent = new Map<string, bigint>();
  /** The tank's next nonce as this process counts it, and the queue that hands nonces out one at a time. */
  private localNonce: number | null = null;
  private sending: Promise<unknown> = Promise.resolve();

  constructor(
    privateKey: Hex,
    rpcUrl: string,
    chainId: number,
    private readonly perWalletPerDayWei: bigint,
    private readonly now: () => Date = () => new Date(),
  ) {
    const chain = TESTNETS[chainId];
    if (!chain) throw new Error(`the gas tank runs on testnets only, not chain ${chainId}`);
    this.chain = chain;
    this.account = privateKeyToAccount(privateKey);
    this.client = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = createWalletClient({ chain, transport: http(rpcUrl), account: this.account });
  }

  get address(): Address {
    return this.account.address;
  }

  /**
   * One send at a time, each with its own nonce: the chain's pending count, or the next one this
   * process handed out when the RPC has not seen the previous transaction yet (two sends in a row
   * would otherwise get the same nonce and the second be refused).
   */
  private send(request: Record<string, unknown>): Promise<Hex> {
    const run = this.sending.then(async () => {
      const pending = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
      const nonce = Math.max(pending, this.localNonce ?? 0);
      try {
        const hash = await this.wallet.sendTransaction({ ...request, nonce, chain: this.chain, account: this.account } as Parameters<typeof this.wallet.sendTransaction>[0]);
        this.localNonce = nonce + 1;
        return hash;
      } catch (error) {
        this.localNonce = null; // ask the chain again next time
        throw error;
      }
    });
    this.sending = run.catch(() => undefined);
    return run;
  }

  /**
   * Sponsored execution (EIP-7702): sends the wallet's signed `execute(...)` call from the tank,
   * which pays the gas. The call itself carries the vault's signature; the tank adds nothing to it.
   */
  /** With `authorization`, the wallet's EIP-7702 delegation goes in the same (type-4) transaction, before the call runs. */
  async relay(wallet: Address, data: Hex, authorization?: WalletAuthorization): Promise<Hex> {
    return this.send({ to: wallet, data, value: 0n, ...(authorization ? { authorizationList: [authorization] } : {}) });
  }

  /** Submits the wallet's EIP-7702 authorization (signed by NEAR MPC) in a type-4 transaction the tank pays for. */
  async delegate(authorization: WalletAuthorization): Promise<Hex> {
    return this.send({ to: this.account.address, value: 0n, authorizationList: [authorization] });
  }

  /** Sends the transaction's sender what it lacks to pay for it; null when it already has enough. */
  async topUpFor(serializedTransaction: Hex): Promise<TankTopUp> {
    const tx = parseTransaction(serializedTransaction);
    if (tx.chainId !== undefined && tx.chainId !== this.chain.id) return null;
    const sender = await recoverTransactionAddress({ serializedTransaction: serializedTransaction as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] });
    const maxFee = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    const need = (tx.gas ?? 0n) * maxFee + (tx.value ?? 0n) + MARGIN_WEI;
    const balance = await this.client.getBalance({ address: sender });
    if (balance >= need) return null;
    const amount = need - balance;
    const key = `${this.now().toISOString().slice(0, 10)}:${sender.toLowerCase()}`;
    const already = this.sent.get(key) ?? 0n;
    if (already + amount > this.perWalletPerDayWei) {
      console.warn(JSON.stringify({ event: "gas_tank.cap_reached", wallet: sender, needWei: amount.toString(), sentTodayWei: already.toString() }));
      return null;
    }
    const txHash = await this.send({ to: sender, value: amount });
    await this.client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    this.sent.set(key, already + amount);
    console.info(JSON.stringify({ event: "gas_tank.sponsored", wallet: sender, sentWei: amount.toString(), txHash }));
    return { wallet: sender, sentWei: amount, txHash };
  }
}
