import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { estimateL1Fee } from "viem/op-stack";

export interface BaseGasCaps {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface BaseGasQuote {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
  l1Fee: bigint;
  senderBalance: bigint;
  requiredBalance: bigint;
  sufficientBalance: boolean;
}

export interface BaseGasQuoteView {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  baseFeePerGas: string;
  l1Fee: string;
  senderBalance: string;
  requiredBalance: string;
  sufficientBalance: boolean;
}

interface GasTransaction {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
}

export interface FeeHistorySnapshot {
  baseFeePerGas: bigint[];
  rewards: bigint[];
}

export interface BaseGasGateway {
  feeHistory(): Promise<FeeHistorySnapshot>;
  estimateGas(transaction: GasTransaction): Promise<bigint>;
  estimateL1Fee(transaction: GasTransaction & {
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<bigint>;
  balance(address: Address): Promise<bigint>;
  currentBaseFee(): Promise<bigint>;
}

class ViemBaseGasGateway implements BaseGasGateway {
  private readonly client;

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  }

  async feeHistory(): Promise<FeeHistorySnapshot> {
    const history = await this.client.getFeeHistory({
      blockCount: 10,
      rewardPercentiles: [50],
      blockTag: "latest",
    });
    return {
      baseFeePerGas: history.baseFeePerGas,
      rewards: (history.reward ?? []).flatMap((reward) => reward[0] === undefined ? [] : [reward[0]]),
    };
  }

  estimateGas(transaction: GasTransaction): Promise<bigint> {
    return this.client.estimateGas({
      account: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
    });
  }

  estimateL1Fee(transaction: GasTransaction & {
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }): Promise<bigint> {
    return estimateL1Fee(this.client, {
      account: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      gas: transaction.gas,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      type: "eip1559",
    });
  }

  balance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address });
  }

  async currentBaseFee(): Promise<bigint> {
    const block = await this.client.getBlock({ blockTag: "latest" });
    if (block.baseFeePerGas === null) throw new Error("Base block has no base fee");
    return block.baseFeePerGas;
  }
}

export class BaseGasEstimationError extends Error {}

export interface BaseGasQuoteOptions {
  baseFeeMultiplier?: bigint;
  maxFeeFloor?: bigint;
}

export interface BaseGasQuoter {
  quote(
    input: { from: string; to: string; data: Hex; value?: bigint },
    options?: BaseGasQuoteOptions,
  ): Promise<BaseGasQuote>;
  currentBaseFee(): Promise<bigint>;
}

export class BaseGasEstimator implements BaseGasQuoter {
  constructor(
    private readonly gateway: BaseGasGateway,
    private readonly caps: BaseGasCaps,
  ) {
    if (caps.maxPriorityFeePerGas > caps.maxFeePerGas) {
      throw new BaseGasEstimationError("max priority fee cap exceeds max fee cap");
    }
  }

  static fromRpc(rpcUrl: string, caps: BaseGasCaps): BaseGasEstimator {
    return new BaseGasEstimator(new ViemBaseGasGateway(rpcUrl), caps);
  }

  async quote(
    input: { from: string; to: string; data: Hex; value?: bigint },
    options: BaseGasQuoteOptions = {},
  ): Promise<BaseGasQuote> {
    const transaction = {
      from: getAddress(input.from),
      to: getAddress(input.to),
      data: input.data,
      value: input.value ?? 0n,
    };
    let history: FeeHistorySnapshot;
    let estimatedGas: bigint;
    try {
      [history, estimatedGas] = await Promise.all([
        this.gateway.feeHistory(),
        this.gateway.estimateGas(transaction),
      ]);
    } catch (error) {
      throw new BaseGasEstimationError(`Base gas estimation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const baseFeePerGas = history.baseFeePerGas.at(-1);
    if (baseFeePerGas === undefined || history.rewards.length === 0) {
      throw new BaseGasEstimationError("eth_feeHistory returned no base fee or p50 priority rewards");
    }
    const rewards = [...history.rewards].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const maxPriorityFeePerGas = rewards[Math.floor(rewards.length / 2)]!;
    const feeMultiplier = options.baseFeeMultiplier ?? 3n;
    const computedMaxFee = feeMultiplier * baseFeePerGas + maxPriorityFeePerGas;
    const maxFeePerGas = options.maxFeeFloor !== undefined && options.maxFeeFloor > computedMaxFee
      ? options.maxFeeFloor
      : computedMaxFee;
    const gasLimit = (estimatedGas * 130n + 99n) / 100n;
    if (gasLimit > this.caps.gasLimit) {
      throw new BaseGasEstimationError(`estimated gas ${gasLimit} exceeds cap ${this.caps.gasLimit}`);
    }
    if (maxPriorityFeePerGas > this.caps.maxPriorityFeePerGas) {
      throw new BaseGasEstimationError(`p50 priority fee ${maxPriorityFeePerGas} exceeds cap ${this.caps.maxPriorityFeePerGas}`);
    }
    if (maxFeePerGas > this.caps.maxFeePerGas) {
      throw new BaseGasEstimationError(`computed max fee ${maxFeePerGas} exceeds cap ${this.caps.maxFeePerGas}`);
    }
    let l1Fee: bigint;
    let senderBalance: bigint;
    try {
      [l1Fee, senderBalance] = await Promise.all([
        this.gateway.estimateL1Fee({
          ...transaction,
          gas: gasLimit,
          maxFeePerGas,
          maxPriorityFeePerGas,
        }),
        this.gateway.balance(transaction.from),
      ]);
    } catch (error) {
      throw new BaseGasEstimationError(`Base L1 fee or balance estimation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const requiredBalance = gasLimit * maxFeePerGas + l1Fee;
    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      baseFeePerGas,
      l1Fee,
      senderBalance,
      requiredBalance,
      sufficientBalance: senderBalance >= requiredBalance,
    };
  }

  currentBaseFee(): Promise<bigint> {
    return this.gateway.currentBaseFee();
  }
}

export function gasQuoteView(quote: BaseGasQuote): BaseGasQuoteView {
  return {
    gasLimit: quote.gasLimit.toString(),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
    baseFeePerGas: quote.baseFeePerGas.toString(),
    l1Fee: quote.l1Fee.toString(),
    senderBalance: quote.senderBalance.toString(),
    requiredBalance: quote.requiredBalance.toString(),
    sufficientBalance: quote.sufficientBalance,
  };
}
