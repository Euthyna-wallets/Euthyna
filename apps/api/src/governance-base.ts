import { rolesAbi } from "@mandateos/deployer";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
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
  currentTimestamp: bigint;
}

export interface PreparedDelayExecution {
  hash: Hex;
  rawTransaction: Hex;
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
    receipt: GovernanceReceipt;
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
    const [txNonce, queueNonce, cooldown, expiration, createdAt, block] = await Promise.all([
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txNonce" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "queueNonce" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txCooldown" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txExpiration" }),
      this.publicClient.readContract({ address: delay, abi: delayAbi, functionName: "txCreatedAt", args: [entryNonce] }),
      this.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    return { txNonce, queueNonce, cooldown, expiration, createdAt, currentTimestamp: block.timestamp };
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
    receipt: GovernanceReceipt;
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
    for (const log of input.receipt.logs) {
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
