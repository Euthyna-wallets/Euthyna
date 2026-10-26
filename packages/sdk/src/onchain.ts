import { bytesToHex, encodeFunctionData, erc20Abi, hexToBytes, type Hex } from "viem";
import { omniRolesPaymentRequest, operationIdBytes, operationIdHex, type NearVaultGateway, type PaymentRequest, type InvoiceContext, type CallRequest, type OperationCheckResult } from "./index.js";

export interface DirectVault {
  identity(): { member: string; role: string; chain_id: number };
  prepareRequest: NearVaultGateway["prepareRequest"];
  authorize: NearVaultGateway["authorize"];
  cancelNonce: NearVaultGateway["cancelNonce"];
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  action(method: string, args: Record<string, unknown>): Promise<string>;
}
export interface DirectOperation extends Record<string, unknown> {
  state: string; signed_transaction: number[] | null;
  cancellation: { signed_transaction: number[] | null } | null;
  possibly_signed_at_ns: string | null;
}
export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
export function publicRpc(url: string): Rpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`EVM RPC HTTP ${response.status}`);
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
}
/** Direct NEAR authorization, public RPC broadcast and MPC settlement. No API credentials. */
export class OnchainAgentClient {
  constructor(private readonly vault: DirectVault, private readonly rpc: Rpc, private readonly advisory?: { preflightInvoice: (request: import("./index.js").OmniRolesOperationRequest, invoice?: InvoiceContext) => Promise<void>; shareRevenue?: (amountWei: string) => Promise<import("./index.js").ShareRevenueOperation> }) {}
  async mandate(): Promise<Record<string, unknown>> {
    const { role, chain_id, member } = this.vault.identity();
    const [config, membership, suppliers, wallet] = await Promise.all([
      this.vault.view("get_role", { role }), this.vault.view("get_membership", { role, member }),
      this.vault.view("get_address_list", { list: "suppliers" }), this.vault.view("get_wallet", { chain_id }),
    ]);
    const permissions = (config as { config?: { permissions?: Array<{ conditions: Array<{ operator: number; compValue: Hex }> }> } } | null)?.config?.permissions ?? [];
    const keys = [...new Set(permissions.flatMap((p) => p.conditions.filter((c) => c.operator === 28 || c.operator === 30).map((c) => c.compValue)))];
    const allowances = await Promise.all(keys.map(async (key) => ({ key, allowance: await this.vault.view("get_allowance", { key: Array.from(hexToBytes(key)) }) })));
    return { config, membership, suppliers, wallet, allowances };
  }
  async pay(intent: PaymentRequest, _invoice?: InvoiceContext) {
    const { chain_id } = this.vault.identity();
    const network = await this.rpc<Hex>("eth_chainId", []);
    if (Number(BigInt(network)) !== chain_id) throw new Error("RPC chain does not match the vault wallet");
    const wallet = await this.vault.view<{ address: number[] | null }>("get_wallet", { chain_id });
    if (!wallet.address) throw new Error("Wallet not derived");
    const to = bytesToHex(Uint8Array.from(intent.token));
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bytesToHex(Uint8Array.from(intent.recipient)), BigInt(intent.amount)] });
    const gas = intent.gas_limit ?? BigInt(await this.rpc<Hex>("eth_estimateGas", [{ from: bytesToHex(Uint8Array.from(wallet.address)), to, data }])).toString();
    const fee = intent.max_fee_per_gas ?? (2n * BigInt(await this.rpc<Hex>("eth_gasPrice", []))).toString();
    const tip = intent.max_priority_fee_per_gas ?? BigInt(await this.rpc<Hex>("eth_maxPriorityFeePerGas", [])).toString();
    const request = omniRolesPaymentRequest({ ...intent, gas_limit: gas, max_fee_per_gas: fee, max_priority_fee_per_gas: tip }, chain_id);
    await this.advisory?.preflightInvoice(request, _invoice);
    const prepared = await this.vault.prepareRequest(request);
    const nearTransactionHash = await this.vault.authorize(prepared.op_id, null);
    const opId = operationIdHex(prepared.op_id);
    const operation = await this.status(opId);
    // Delayed operations remain queued; the caller can resume through status.
    return { outcome: "authorized" as const, opId, nearTransactionHash, state: operation.state };
  }
  async check(input: PaymentRequest | CallRequest, chainId = this.vault.identity().chain_id): Promise<OperationCheckResult> {
    const { role, member } = this.vault.identity();
    const request = "token" in input ? omniRolesPaymentRequest({ ...input, gas_limit: "0", max_fee_per_gas: "0", max_priority_fee_per_gas: "0" }, chainId)
      : { chain_id: input.chainId, target: Array.from(hexToBytes(input.to)), value: input.value ?? "0", calldata: Array.from(hexToBytes(input.data ?? "0x")), allowance_amount: input.allowanceAmount ?? "0", reference: input.reference, gas_limit: "0", max_fee_per_gas: "0", max_priority_fee_per_gas: "0" };
    const result = await this.vault.view<OperationCheckResult>("check_operation", { role, member, request });
    return { ...result, refusedBy: result.allowed ? null : "vault" };
  }
  async status(id: Hex): Promise<Record<string, unknown>> {
    const op_id = operationIdBytes(id);
    let op = await this.vault.view<DirectOperation>("get_operation", { op_id });
    if (op.state === "Queued") {
      // A premature resume is harmless and leaves the queued operation intact.
      try { await this.vault.action("execute_queued_operation", { op_id }); } catch { return op; }
      op = await this.vault.view<DirectOperation>("get_operation", { op_id });
    }
    if (op.state !== "PossiblySigned") return op;
    const config = await this.vault.view<{ cancel_after_ns: string; unconfirmed_after_ns: string }>("get_settlement_config");
    const age = BigInt(Date.now()) * 1_000_000n - BigInt(op.possibly_signed_at_ns ?? "0");
    const candidates = [
      { raw: op.signed_transaction, cancellation: false },
      { raw: op.cancellation?.signed_transaction, cancellation: true },
    ].filter((candidate) => candidate.raw);
    const { keccak256 } = await import("viem");
    const inspected = await Promise.all(candidates.map(async (candidate) => {
      const raw = bytesToHex(Uint8Array.from(candidate.raw!));
      const hash = keccak256(raw);
      const receipt = await this.rpc<{ blockHash: Hex; status: Hex } | null>("eth_getTransactionReceipt", [hash]);
      return { ...candidate, raw, hash, receipt };
    }));
    // The original can win even after a cancellation has been signed.
    for (const candidate of inspected) {
      const receipt = candidate.receipt;
      if (receipt?.status !== "0x1") continue;
      const finalized = await this.rpc<{ number: Hex }>("eth_getBlockByNumber", ["finalized", false]);
      const block = await this.rpc<{ number: Hex }>("eth_getBlockByHash", [receipt.blockHash, false]);
      if (BigInt(finalized.number) >= BigInt(block.number)) {
        await this.vault.action(candidate.cancellation ? "settle_cancellation" : "settle", { op_id, block_hash: Array.from(hexToBytes(receipt.blockHash)) });
        const updated = await this.vault.view<DirectOperation>("get_operation", { op_id });
        if (updated.state !== "PossiblySigned") return updated;
      }
    }
    // Broadcast the cancellation preferentially, but only after inspecting both receipts.
    const pending = inspected.find((candidate) => candidate.cancellation) ?? inspected[0];
    if (pending && !pending.receipt && !inspected.some((candidate) => candidate.receipt)) {
      try { await this.rpc("eth_sendRawTransaction", [pending.raw]); } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (age < BigInt(config.unconfirmed_after_ns) && !message.includes("already known") && !message.includes("already imported")) throw error;
      }
    }
    if (age >= BigInt(config.unconfirmed_after_ns)) await this.vault.action("release_unconfirmed", { op_id });
    return this.vault.view<DirectOperation>("get_operation", { op_id });
  }
  async cancel(id: Hex) {
    await this.vault.cancelNonce(operationIdBytes(id));
    return this.status(id);
  }
  async call(request: import("./index.js").OmniRolesOperationRequest) {
    if (request.chain_id !== this.vault.identity().chain_id || Number(BigInt(await this.rpc<Hex>("eth_chainId", []))) !== request.chain_id) throw new Error("RPC chain does not match the vault wallet");
    const prepared = await this.vault.prepareRequest(request);
    const nearTransactionHash = await this.vault.authorize(prepared.op_id, null);
    const opId = operationIdHex(prepared.op_id);
    const operation = await this.status(opId);
    return { outcome: "authorized" as const, opId, nearTransactionHash, state: operation.state };
  }
  async shareRevenue(amountWei: string, reference: string): Promise<Record<string, unknown>> {
    if (!this.advisory?.shareRevenue) throw new Error("Use execute_call with the bridge calldata when the optional revenue builder API is unavailable");
    const op = await this.advisory.shareRevenue(amountWei);
    const result = await this.call({ chain_id:op.chainId, target:Array.from(hexToBytes(op.to)), calldata:Array.from(hexToBytes(op.data)), value:op.value, allowance_amount:op.allowanceAmount, reference, gas_limit:op.gasLimit, max_fee_per_gas:op.maxFeePerGas, max_priority_fee_per_gas:op.maxPriorityFeePerGas });
    return { ...result, recipient:op.recipient, bridgeFee:op.bridgeFee };
  }
}
