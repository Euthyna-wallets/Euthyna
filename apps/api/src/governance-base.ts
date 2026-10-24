import { rolesAbi } from "@mandateos/deployer";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  decodeEventLog,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
  type Log,
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const delayAbi = [
  { type: "function", name: "txNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "queueNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txExpiration", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txCreatedAt", stateMutability: "view", inputs: [{ name: "nonce", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "txHash", stateMutability: "view", inputs: [{ name: "nonce", type: "uint256" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "executeNextTx",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
const txNonceSetEvent = {
  type: "event",
  name: "TxNonceSet",
  inputs: [{ name: "nonce", type: "uint256", indexed: false }],
} as const;
const executionFromModuleSuccessEvent = {
  type: "event",
  name: "ExecutionFromModuleSuccess",
  inputs: [{ name: "module", type: "address", indexed: true }],
} as const;


export interface GovernanceReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: Log[];
}

export interface DelayState {
  txNonce: bigint;
  queueNonce: bigint;
  cooldown: bigint;
  expiration: bigint;
  createdAt: bigint;
  entryHash: Hex;
  currentTimestamp: bigint;
}

export interface PreparedDelayExecution {
  hash: Hex;
  rawTransaction: Hex;
}
export interface DelayExecutionEvidence {
  transactionHash: Hex;
  blockNumber: bigint;
  receipt: GovernanceReceipt;
}

export interface DelayVetoEvidence {
  transactionHash: Hex;
  blockNumber: bigint;
}


export interface RolesVerification {
  memberEnabled: boolean;
  allowance: {
    refill: bigint;
    maxRefill: bigint;
    period: bigint;
    balance: bigint;
    timestamp: bigint;
  };
  events: string[];
}

export interface GovernanceBaseGateway {
  rawTransactionHash(rawTransaction: number[] | null): Hex;
  broadcastRaw(rawTransaction: Hex | number[] | null): Promise<Hex>;
  receipt(hash: Hex): Promise<GovernanceReceipt | null>;
  blockNumber(): Promise<bigint>;
  delayState(delay: Address, entryNonce: bigint): Promise<DelayState>;
  expectedDelayHash(input: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }): Hex;
  findExecution(input: {
    safe: Address;
    delay: Address;
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0 | 1;
    fromBlock: bigint;
  }): Promise<DelayExecutionEvidence | null>;
  findVeto(delay: Address, entryNonce: bigint, fromBlock: bigint): Promise<DelayVetoEvidence | null>;
  prepareExecuteNextTx(input: {
    delay: Address;
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0 | 1;
  }): Promise<PreparedDelayExecution>;
  verifyRoles(input: {
    roles: Address;
    member: Address;
    allowanceKey: Hex;
    receipt?: GovernanceReceipt | null;
  }): Promise<RolesVerification>;
  gasWalletAddress(): Address;
  gasWalletBalance(): Promise<bigint>;
}

export class BaseGovernanceGateway implements GovernanceBaseGateway {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;
  constructor(rpcUrl: string, privateKey: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("invalid Base gas wallet private key");
    const validatedPrivateKey = privateKey as Hex;
    this.account = privateKeyToAccount(validatedPrivateKey);
    const transport = http(rpcUrl);
    this.publicClient = createPublicClient({ chain: baseSepolia, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: baseSepolia, transport });
  }

  rawTransactionHash(rawTransaction: number[] | null): Hex {
    if (!rawTransaction) throw new Error("relay operation has no signed transaction");
    return keccak256(bytesToHex(Uint8Array.from(rawTransaction)));
  }

  async broadcastRaw(rawTransaction: Hex | number[] | null): Promise<Hex> {
    if (!rawTransaction) throw new Error("raw transaction missing");
    const raw = typeof rawTransaction === "string"
      ? rawTransaction
      : bytesToHex(Uint8Array.from(rawTransaction));
    const localHash = keccak256(raw);
    try {
      const hash = await this.publicClient.sendRawTransaction({ serializedTransaction: raw });
      if (hash !== localHash) throw new Error("Base RPC returned a different governance transaction hash");
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (!message.includes("already known") && !message.includes("already imported")) throw error;
    }
    return localHash;
  }

  async receipt(hash: Hex): Promise<GovernanceReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      return { status: receipt.status, blockNumber: receipt.blockNumber, logs: [...receipt.logs] };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }

  async blockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async delayState(delay: Address, entryNonce: bigint): Promise<DelayState> {
    const [txNonce, queueNonce, cooldown, expiration, createdAt, entryHash, block] = await Promise.all([
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txNonce" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "queueNonce" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txCooldown" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txExpiration" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txCreatedAt", args: [entryNonce] }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txHash", args: [entryNonce] }),
      this.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    return { txNonce, queueNonce, cooldown, expiration, createdAt, entryHash, currentTimestamp: block.timestamp };
  }

  expectedDelayHash(input: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }): Hex {
    return keccak256(encodePacked(
      ["address", "uint256", "bytes", "uint8"],
      [input.to, input.value, input.data, input.operation],
    ));
  }

  async findExecution(input: {
    safe: Address;
    delay: Address;
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0 | 1;
    fromBlock: bigint;
  }): Promise<DelayExecutionEvidence | null> {
    const latest = await this.publicClient.getBlockNumber();
    for (let fromBlock = input.fromBlock; fromBlock <= latest;) {
      const toBlock = fromBlock + 199n < latest ? fromBlock + 199n : latest;
      const events = await this.publicClient.getLogs({
        address: input.safe,
        event: executionFromModuleSuccessEvent,
        args: { module: input.delay },
        fromBlock,
        toBlock,
      });
      for (const event of events) {
        if (event.transactionHash === null || event.blockNumber === null) continue;
        const transaction = await this.publicClient.getTransaction({ hash: event.transactionHash });
        if (transaction.to === null || getAddress(transaction.to) !== input.delay) continue;
        try {
          const decoded = decodeFunctionData({ abi: delayAbi, data: transaction.input });
          if (
            decoded.functionName !== "executeNextTx" ||
            getAddress(decoded.args[0]) !== input.to ||
            decoded.args[1] !== input.value ||
            decoded.args[2].toLowerCase() !== input.data.toLowerCase() ||
            decoded.args[3] !== input.operation
          ) {
            continue;
          }
        } catch {
          continue;
        }
        const receipt = await this.receipt(event.transactionHash);
        if (receipt?.status === "success") {
          return { transactionHash: event.transactionHash, blockNumber: event.blockNumber, receipt };
        }
      }
      fromBlock = toBlock + 1n;
    }
    return null;
  }

  async findVeto(delay: Address, entryNonce: bigint, initialBlock: bigint): Promise<DelayVetoEvidence | null> {
    const latest = await this.publicClient.getBlockNumber();
    for (let fromBlock = initialBlock; fromBlock <= latest;) {
      const toBlock = fromBlock + 199n < latest ? fromBlock + 199n : latest;
      const events = await this.publicClient.getLogs({
        address: delay,
        event: txNonceSetEvent,
        fromBlock,
        toBlock,
      });
      for (const event of events) {
        if (
          event.args.nonce === undefined ||
          event.args.nonce <= entryNonce ||
          event.transactionHash === null ||
          event.blockNumber === null ||
          event.blockNumber === 0n
        ) {
          continue;
        }
        const priorNonce = await this.publicClient.readContract({
          address: delay,
          abi: delayAbi,
          functionName: "txNonce",
          blockNumber: event.blockNumber - 1n,
        });
        if (priorNonce <= entryNonce) {
          return {
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
          };
        }
      }
      fromBlock = toBlock + 1n;
    }
    return null;
  }

  async prepareExecuteNextTx(input: {
    delay: Address;
    to: Address;
    value: bigint;
    data: Hex;
    operation: 0 | 1;
  }): Promise<PreparedDelayExecution> {
    const data = encodeFunctionData({
      abi: delayAbi,
      functionName: "executeNextTx",
      args: [input.to, input.value, input.data, input.operation],
    });
    const request = await this.walletClient.prepareTransactionRequest({
      account: this.account,
      to: input.delay,
      data,
      value: 0n,
    });
    const rawTransaction = await this.walletClient.signTransaction(request);
    return { rawTransaction, hash: keccak256(rawTransaction) };
  }

  async verifyRoles(input: {
    roles: Address;
    member: Address;
    allowanceKey: Hex;
    receipt?: GovernanceReceipt | null;
  }): Promise<RolesVerification> {
    const [memberEnabled, allowance] = await Promise.all([
      this.publicClient.readContract({
        address: input.roles,
        abi: rolesAbi,
        functionName: "isModuleEnabled",
        args: [input.member],
      }),
      this.publicClient.readContract({
        address: input.roles,
        abi: rolesAbi,
        functionName: "allowances",
        args: [input.allowanceKey],
      }),
    ]);
    const events: string[] = [];
    for (const log of input.receipt?.logs ?? []) {
      if (log.address.toLowerCase() !== input.roles.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: rolesAbi, data: log.data, topics: log.topics, strict: false });
        if (["AssignRoles", "ScopeTarget", "ScopeFunction", "SetAllowance"].includes(decoded.eventName)) {
          events.push(decoded.eventName);
        }
      } catch {
        // Ignore unrelated Roles logs.
      }
    }
    return {
      memberEnabled,
      allowance: {
        refill: allowance[0],
        maxRefill: allowance[1],
        period: allowance[2],
        balance: allowance[3],
        timestamp: allowance[4],
      },
      events,
    };
  }

  gasWalletAddress(): Address {
    return getAddress(this.account.address);
  }

  async gasWalletBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }
}
