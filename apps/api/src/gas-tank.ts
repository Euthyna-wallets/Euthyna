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

export class GasTank {
  private readonly account;
  private readonly client;
  private readonly wallet;
  private readonly chain: Chain;
  /** Wei sent per wallet and UTC day (memory: a restart only resets the day's count). */
  private readonly sent = new Map<string, bigint>();

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
    const txHash = await this.wallet.sendTransaction({ to: sender, value: amount, chain: this.chain, account: this.account });
    await this.client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    this.sent.set(key, already + amount);
    console.info(JSON.stringify({ event: "gas_tank.sponsored", wallet: sender, sentWei: amount.toString(), txHash }));
    return { wallet: sender, sentWei: amount, txHash };
  }
}
