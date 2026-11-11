import { base58Encode, broadcast, latestBlockhash, SOLANA_DEVNET, signatureStatus, solanaAddress, solanaAsset, solanaHoldings, solanaRpc, solanaShortfall, solanaTokenOf, type SolanaProfile, token2022Decimals } from "./solana.js";
import { bytesToHex, encodeFunctionData, erc20Abi, getAddress, hexToBytes, type Hex } from "viem";
import { NEAR_TESTNET_TOKENS, Operator, type BankConfig, type BankPayout, type BankPermission, type SealedBeneficiary } from "./roles.js";
import { omniRolesPaymentRequest, operationIdBytes, operationIdHex, type NearVaultGateway, type PaymentRequest, type InvoiceContext, type CallRequest, type OperationCheckResult } from "./index.js";

export interface DirectVault {
  identity(): { member: string; role: string; chain_id: number };
  prepareRequest: NearVaultGateway["prepareRequest"];
  authorize: NearVaultGateway["authorize"];
  cancelNonce: NearVaultGateway["cancelNonce"];
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  action(method: string, args: Record<string, unknown>, gas?: string): Promise<string>;
}
export interface DirectOperation extends Record<string, unknown> {
  state: string; signed_transaction: number[] | null;
  cancellation: { signed_transaction: number[] | null } | null;
  possibly_signed_at_ns: string | null;
}
export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
type NearPermissionView = { token: string; receivers: string[]; allowance: number[]; min_per_transfer: string; max_per_transfer: string };
type NearOperationView = { op_id: number[]; state: string; created_at_ns: string; request: { token: string; receiver_id: string; amount: string; memo: string | null; reference: string } };
/** execute_near: 30 Tgas for ft_transfer, 10 for the callback, 10 for itself, plus margin. */
const NEAR_TRANSFER_GAS = "100000000000000";
/** OutLayer run (120 Tgas) + callback (40) + the vault's own checks. */
const BANK_PAYOUT_GAS = "200000000000000";
type SolanaOperationView = { op_id: number[]; state: string; signature: number[] | null; signed_transaction: number[] | null };
export function publicRpc(url: string): Rpc {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`EVM RPC HTTP ${response.status}`);
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
}
const TRANSFER_SELECTOR = "a9059cbb";
/**
 * Who each ERC-20 transfer permission may pay: the addresses the role names itself (EqualTo on the recipient), and
 * whether it also accepts the vault's on-chain "suppliers" list. A role voted with one supplier names it inline, so
 * `suppliers` alone can be empty.
 */
function payeesOf(config: unknown) {
  const permissions = (config as { config?: { permissions?: Array<{ chain_id: number; target: number[]; selector: number[]; conditions: Array<{ operator: number; compValue: Hex }> }> } } | null)?.config?.permissions ?? [];
  return permissions
    .filter((permission) => bytesToHex(Uint8Array.from(permission.selector)).slice(2) === TRANSFER_SELECTOR)
    .map((permission) => ({
      chainId: permission.chain_id,
      token: getAddress(bytesToHex(Uint8Array.from(permission.target))),
      recipients: permission.conditions
        .filter((condition) => condition.operator === Operator.EqualTo && /^0x0{24}[0-9a-fA-F]{40}$/.test(condition.compValue))
        .map((condition) => getAddress(`0x${condition.compValue.slice(26)}`)),
      anySupplier: permission.conditions.some((condition) => condition.operator === Operator.InAddressList && condition.compValue.toLowerCase() === bytesToHex(new TextEncoder().encode("suppliers"))),
    }));
}

/** Direct NEAR authorization, public RPC broadcast and MPC settlement. No API credentials. */
export class OnchainAgentClient {
  constructor(private readonly vault: DirectVault, private readonly rpc: Rpc, private readonly advisory?: { preflightInvoice: (request: import("./index.js").OmniRolesOperationRequest, invoice?: InvoiceContext) => Promise<void>; check?: (request: import("./index.js").OmniRolesOperationRequest) => Promise<OperationCheckResult>; shareRevenue?: (amountWei: string) => Promise<import("./index.js").ShareRevenueOperation>; announce?: (opId: number[]) => Promise<void>; wake?: () => Promise<void>; solanaFuel?: () => Promise<{ status: string; signature?: string }> }) {}
  /**
   * This agent just acted on its vault without the API. When it has an API key, it says so: the
   * company's background jobs read the vault now instead of on their next round. Best effort.
   */
  private wake(): void {
    void this.advisory?.wake?.().catch(() => undefined);
  }
  private readonly announced = new Set<string>();
  async mandate(): Promise<Record<string, unknown>> {
    const { role, chain_id, member } = this.vault.identity();
    const [config, membership, suppliers, wallet, solanaWallet, solanaPermissions, nearPermissions, bankPermission, bankBeneficiaries, bankConfig] = await Promise.all([
      this.vault.view("get_role", { role }), this.vault.view("get_membership", { role, member }),
      this.vault.view("get_address_list", { list: "suppliers" }), this.vault.view("get_wallet", { chain_id }),
      // Vaults older than the Solana version do not have these views.
      this.vault.view<{ address: number[] | null } | null>("get_solana_wallet").catch(() => null),
      this.vault.view<Array<{ asset: unknown; recipients: number[][]; allowance: number[] }>>("get_solana_permissions", { role }).catch(() => []),
      // Vaults older than the NEAR-transfer version do not have this view.
      this.vault.view<NearPermissionView[]>("get_near_permissions", { role }).catch(() => []),
      // Vaults older than the euro-payout version do not have these views.
      this.vault.view<BankPermission | null>("get_bank_permission", { role }).catch(() => null),
      this.vault.view<SealedBeneficiary[]>("list_bank_beneficiaries").catch(() => []),
      this.vault.view<BankConfig | null>("get_bank_config").catch(() => null),
    ]);
    const permissions = (config as { config?: { permissions?: Array<{ conditions: Array<{ operator: number; compValue: Hex }> }> } } | null)?.config?.permissions ?? [];
    const keys = [...new Set(permissions.flatMap((p) => p.conditions.filter((c) => c.operator === 28 || c.operator === 30).map((c) => c.compValue)))];
    const allowances = await Promise.all(keys.map(async (key) => ({ key, allowance: await this.vault.view("get_allowance", { key: Array.from(hexToBytes(key)) }) })));
    const solanaAllowances = await Promise.all(solanaPermissions.map(async (permission) => ({ key: bytesToHex(Uint8Array.from(permission.allowance)), allowance: await this.vault.view("get_allowance", { key: permission.allowance }) })));
    const solana = solanaWallet?.address ? {
      wallet: base58Encode(solanaWallet.address),
      network: SOLANA_DEVNET.name,
      permissions: solanaPermissions.map((permission) => ({
        token: permission.asset === "Sol" ? "SOL" : base58Encode((permission.asset as { Spl: { mint: number[] } }).Spl.mint),
        recipients: permission.recipients.map((recipient) => base58Encode(recipient)),
        budget: bytesToHex(Uint8Array.from(permission.allowance)),
      })),
    } : null;
    const nearAllowances = await Promise.all(nearPermissions.map(async (permission) => ({ key: bytesToHex(Uint8Array.from(permission.allowance)), allowance: await this.vault.view("get_allowance", { key: permission.allowance }) })));
    const near = nearPermissions.length ? {
      permissions: nearPermissions.map((permission) => ({
        token: permission.token,
        symbol: NEAR_TESTNET_TOKENS.find((item) => item.accountId === permission.token)?.symbol ?? null,
        receivers: permission.receivers,
        minPerTransfer: permission.min_per_transfer,
        maxPerTransfer: permission.max_per_transfer,
        budget: bytesToHex(Uint8Array.from(permission.allowance)),
      })),
    } : null;
    const bankAllowance = bankPermission && bankConfig ? [{ key: bytesToHex(Uint8Array.from(bankPermission.allowance)), allowance: await this.vault.view("get_allowance", { key: bankPermission.allowance }) }] : [];
    const bank = bankPermission && bankConfig ? {
      currency: "EUR",
      settlesAs: bankConfig.crypto,
      decimals: bankConfig.decimals,
      maxPerPayout: bankPermission.max_per_payout,
      budget: bytesToHex(Uint8Array.from(bankPermission.allowance)),
      // The IBANs are sealed: the agent pays a beneficiary by its number, and never sees the IBAN.
      beneficiaries: bankBeneficiaries.map((entry) => ({ id: entry.id, label: entry.label })),
    } : null;
    return { config, membership, suppliers, payees: payeesOf(config), wallet, allowances: [...allowances, ...solanaAllowances, ...nearAllowances, ...bankAllowance], solana, near, bank };
  }

  /**
   * Pay a voted beneficiary in euros, by its number, under the role's bank permission. The vault
   * checks the beneficiary, the amount and the budget, and forwards the members' sealed envelope to
   * the bank signer (an OutLayer enclave), which opens it, checks it against the voted commitment
   * and asks the partner for a single-use rule; then the vault queues the EURC transfer it signs
   * itself. The IBAN never leaves the enclave. Amount in base units (1 EUR = 1000000).
   */
  async bankPayout(input: { beneficiary: number; amount: string; reference: string }) {
    const { role, member } = this.vault.identity();
    const beneficiary = input.beneficiary;
    const check = await this.vault.view<{ allowed: boolean; reason: string | null }>("check_bank_payout", { role, member, beneficiary, amount: input.amount, reference: input.reference }).catch((error: unknown) => {
      if (/MethodNotFound|MethodResolveError/.test(String(error))) return { allowed: false, reason: "the vault does not support euro payouts yet (upgrade by vote)" };
      throw error;
    });
    if (!check.allowed) return { outcome: "refused" as const, reason: await this.payoutRefusal(check.reason, role, beneficiary, input.amount), refusedBy: "vault" as const };
    if (await this.vault.view("get_bank_payout_by_reference", { role, reference: input.reference })) {
      return { outcome: "refused" as const, reason: "ERR_REFERENCE_ALREADY_USED", refusedBy: "vault" as const };
    }
    // The transaction ends only when the bank signer (an enclave) has answered the vault, which can
    // take a minute or more; an MCP client gives up on a tool call before that. So the answer comes
    // as soon as the vault holds the payout; the transaction finishes in the background.
    const sending = this.vault.action("request_bank_payout", { role, beneficiary, amount: input.amount, reference: input.reference }, BANK_PAYOUT_GAS)
      .then((hash) => ({ hash }), (error: unknown) => ({ error }));
    const recorded = (async () => {
      const deadline = Date.now() + this.payoutWaitMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, this.payoutPollMs));
        if (await this.vault.view("get_bank_payout_by_reference", { role, reference: input.reference }).catch(() => null)) return { recorded: true as const };
      }
      return { recorded: false as const };
    })();
    const first = await Promise.race([sending, recorded]);
    const settled = "recorded" in first ? (first.recorded ? null : await sending) : first;
    if (settled && "error" in settled) {
      if (/MethodNameMismatch|method_name/i.test(String(settled.error))) {
        return { outcome: "refused" as const, reason: "this agent's key predates euro payouts: pair the agent again", refusedBy: "key" as const };
      }
      throw settled.error;
    }
    this.wake();
    return {
      outcome: "sent" as const,
      ...(settled ? { nearTransactionHash: settled.hash } : { note: "the vault holds the payout; the bank signer answers within a few minutes: follow it with bank_status" }),
      ...(await this.bankStatus(input.reference)),
    };
  }
  /**
   * The vault refuses any payout while one is pending, before it looks at the beneficiary or the
   * amount. A payout it would refuse anyway gets that reason instead (read from the same vault, in
   * the vault's order): waiting would not change it.
   */
  private async payoutRefusal(reason: string | null, role: string, beneficiary: number, amount: string): Promise<string | null> {
    if (reason !== "ERR_BANK_PAYOUT_PENDING") return reason;
    const [beneficiaries, permission] = await Promise.all([
      this.vault.view<Array<{ id: number }>>("list_bank_beneficiaries", {}).catch(() => null),
      this.vault.view<{ max_per_payout: string } | null>("get_bank_permission", { role }).catch(() => null),
    ]);
    if (beneficiaries && !beneficiaries.some((item) => item.id === beneficiary)) return "BeneficiaryNotAllowed";
    if (permission && BigInt(amount) > BigInt(permission.max_per_payout)) return "ERR_MAX_PER_PAYOUT";
    return reason;
  }
  /** How long `bankPayout` waits for the vault to hold the payout, and how often it looks. */
  payoutWaitMs = 45_000;
  payoutPollMs = 2_000;

  /** Where a euro payout stands: the signer's answer, then the EURC transfer's state. */
  async bankStatus(reference: string): Promise<{ state: string; opId?: Hex; beneficiary?: number; amount?: string; fiatAmount?: string | null; transfer?: { opId: Hex; state: string } | null; error?: string | null }> {
    const { role } = this.vault.identity();
    const payout = await this.vault.view<BankPayout | null>("get_bank_payout_by_reference", { role, reference });
    if (!payout) return { state: "unknown" };
    const transfer = payout.transfer_op_id
      ? await this.vault.view<{ state: string } | null>("get_operation", { op_id: payout.transfer_op_id }).then((op) => (op ? { opId: bytesToHex(Uint8Array.from(payout.transfer_op_id!)), state: op.state } : null)).catch(() => null)
      : null;
    return { state: payout.state, opId: bytesToHex(Uint8Array.from(payout.op_id)), beneficiary: payout.beneficiary_id, amount: payout.amount, fiatAmount: payout.fiat_amount, transfer, error: payout.error };
  }
  async pay(intent: PaymentRequest, _invoice?: InvoiceContext) {
    const { chain_id } = this.vault.identity();
    const network = await this.rpc<Hex>("eth_chainId", []);
    if (Number(BigInt(network)) !== chain_id) throw new Error("RPC chain does not match the vault wallet");
    const wallet = await this.vault.view<{ address: number[] | null }>("get_wallet", { chain_id });
    if (!wallet.address) throw new Error("Wallet not derived");
    // The vault's rules first (the same check prepare runs): a forbidden payment is refused for that
    // reason, before any fee is estimated from the company wallet (which may hold nothing yet).
    const early = await this.refusal(omniRolesPaymentRequest({ ...intent, gas_limit: "0", max_fee_per_gas: "0", max_priority_fee_per_gas: "0" }, chain_id));
    if (early) return early;
    const to = bytesToHex(Uint8Array.from(intent.token));
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bytesToHex(Uint8Array.from(intent.recipient)), BigInt(intent.amount)] });
    const gas = intent.gas_limit ?? BigInt(await this.rpc<Hex>("eth_estimateGas", [{ from: bytesToHex(Uint8Array.from(wallet.address)), to, data }])).toString();
    const fee = intent.max_fee_per_gas ?? (2n * BigInt(await this.rpc<Hex>("eth_gasPrice", []))).toString();
    const tip = intent.max_priority_fee_per_gas ?? BigInt(await this.rpc<Hex>("eth_maxPriorityFeePerGas", [])).toString();
    const request = omniRolesPaymentRequest({ ...intent, gas_limit: gas, max_fee_per_gas: fee, max_priority_fee_per_gas: tip }, chain_id);
    await this.advisory?.preflightInvoice(request, _invoice);
    const refused = await this.refusal(request);
    if (refused) return refused;
    const prepared = await this.vault.prepareRequest(request);
    const nearTransactionHash = await this.vault.authorize(prepared.op_id, null);
    this.wake();
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
    if (!result.allowed) await this.reportRefusal(request);
    return { ...result, refusedBy: result.allowed ? null : "vault" };
  }
  /**
   * The vault refuses on chain without telling the API. When this agent has an
   * API key, the API's own check runs the same vault check and logs the refusal,
   * so the members see it in Activity. Best effort: a refusal stays a refusal.
   */
  private async reportRefusal(request: import("./index.js").OmniRolesOperationRequest): Promise<void> {
    try { await this.advisory?.check?.(request); } catch { /* the API is optional here */ }
  }
  /** Refused before anything is reserved: the vault's verdict, reported to the API. */
  private async refusal(request: import("./index.js").OmniRolesOperationRequest) {
    const { role, member } = this.vault.identity();
    const result = await this.vault.view<OperationCheckResult>("check_operation", { role, member, request });
    if (result.allowed) return null;
    await this.reportRefusal(request);
    return { outcome: "refused" as const, reason: result.reason, refusedBy: "vault" as const };
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
    // Sponsored (EIP-7702): what the vault signed is the wallet's `execute` call, not a transaction.
    // Euthyna's relayer sends it and pays the gas; the worker settles it on the Executed log.
    const sponsored = await this.vault.view<{ deadline: number } | null>("get_sponsored_operation", { op_id }).catch(() => null);
    if (sponsored) {
      // Without this the relayer only finds the operation on its next discovery round (ten minutes).
      // Best effort: the API is optional here, and discovery still picks it up.
      if (this.advisory?.announce && !this.announced.has(id)) {
        try { await this.advisory.announce(op_id); this.announced.add(id); } catch { /* discovery will find it */ }
      }
      return { ...op, sponsored: true, relayedBy: "euthyna" };
    }
    const config = await this.vault.view<{ cancel_after_ns: string; unconfirmed_after_ns: string; mainnet?: boolean }>("get_settlement_config");
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
      // The block the vault's attestation asks for: `safe` on testnet, `finalized` on mainnet.
      const finalized = await this.rpc<{ number: Hex }>("eth_getBlockByNumber", [config.mainnet ? "finalized" : "safe", false]);
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
    this.wake();
    return this.status(id);
  }
  async call(request: import("./index.js").OmniRolesOperationRequest, approval?: import("./index.js").TokenApproval) {
    if (request.chain_id !== this.vault.identity().chain_id || Number(BigInt(await this.rpc<Hex>("eth_chainId", []))) !== request.chain_id) throw new Error("RPC chain does not match the vault wallet");
    const refused = await this.refusal(request);
    if (refused) return refused;
    const prepared = await this.vault.prepareRequest(request, approval);
    const nearTransactionHash = await this.vault.authorize(prepared.op_id, null);
    this.wake();
    const opId = operationIdHex(prepared.op_id);
    const operation = await this.status(opId);
    return { outcome: "authorized" as const, opId, nearTransactionHash, state: operation.state };
  }
  /**
   * Send SOL or an SPL token from the company's Solana wallet. The vault checks
   * the role, charges the budget and signs; this broadcasts, waits for
   * finality and asks MPC to attest it (settle_solana). Amount in base units.
   */
  async solanaTransfer(input: { token: string | null; to: string; amount: string; reference: string }, profile: SolanaProfile = SOLANA_DEVNET) {
    const { role } = this.vault.identity();
    const rpc = solanaRpc(profile.rpcUrl);
    const token = solanaTokenOf(profile, input.token);
    const request = { asset: solanaAsset(token), to: solanaAddress(input.to), amount: input.amount, recent_blockhash: await latestBlockhash(rpc), reference: input.reference };
    const check = await this.vault.view<{ allowed: boolean; reason: string | null }>("check_solana", { role, member: this.vault.identity().member, request });
    if (!check.allowed) return { outcome: "refused" as const, reason: check.reason, refusedBy: "vault" as const };
    // The vault cannot see the wallet's balance on Solana. Signed and never landed, a transfer
    // keeps the role reserved until its blockhash expires (no rule change on it): check first.
    const wallet = await this.vault.view<{ address: number[] | null } | null>("get_solana_wallet", {});
    if (wallet?.address) {
      const owner = base58Encode(wallet.address);
      let holdings = await solanaHoldings(rpc, owner, token);
      let shortfall = solanaShortfall(holdings, token, BigInt(input.amount));
      // Only the SOL for the fee is missing (a token transfer): Euthyna's tank pays it, so the
      // company never has to hold SOL. A SOL transfer needs the company's own SOL.
      const feeOnly = token.mint !== null && (holdings.tokenBalance ?? 0n) >= BigInt(input.amount);
      if (shortfall && feeOnly && this.advisory?.solanaFuel) {
        const fuel = await this.advisory.solanaFuel().catch(() => null);
        if (fuel?.status === "funded" || fuel?.status === "enough") {
          for (let attempt = 0; attempt < 20 && shortfall; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            holdings = await solanaHoldings(rpc, owner, token);
            shortfall = solanaShortfall(holdings, token, BigInt(input.amount));
          }
        } else if (fuel) {
          shortfall = `${shortfall}; Euthyna's SOL tank did not top it up (${fuel.status})`;
        }
      }
      if (shortfall) return { outcome: "refused" as const, reason: "WALLET_UNDERFUNDED", detail: shortfall, refusedBy: "wallet" as const };
    }
    // Builds the transaction (two PDA derivations for SPL) and asks MPC to sign.
    const token2022 = token.mint ? await token2022Decimals(rpc, token.mint) : null;
    const nearTransactionHash = await this.vault.action("execute_solana", { role, request, ...(token2022 !== null ? { token_2022_decimals: token2022 } : {}) }, "150000000000000");
    this.wake();
    let op: SolanaOperationView | null = null;
    for (let attempt = 0; attempt < 20 && !op?.signed_transaction; attempt += 1) {
      op = await this.vault.view<SolanaOperationView | null>("get_solana_operation_by_reference", { role, reference: input.reference });
      if (!op?.signed_transaction) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!op?.signed_transaction || !op.signature) throw new Error("the MPC signature did not come back; the budget stays reserved until release_solana_unconfirmed");
    const signature = base58Encode(op.signature);
    await broadcast(rpc, op.signed_transaction).catch((error: unknown) => {
      if (!/already been processed/i.test(String(error))) throw error;
    });
    return { outcome: "sent" as const, token: token.symbol, signature, explorer: profile.explorer.replace("{tx}", signature), nearTransactionHash, ...(await this.solanaStatus(input.reference, profile)) };
  }

  /** Settles a Solana operation once finalized (MPC attestation). Safe to call again. */
  async solanaStatus(reference: string, profile: SolanaProfile = SOLANA_DEVNET, waitMs = 60_000) {
    const { role } = this.vault.identity();
    const rpc = solanaRpc(profile.rpcUrl);
    const op = await this.vault.view<SolanaOperationView | null>("get_solana_operation_by_reference", { role, reference });
    if (!op?.signature) return { state: op?.state ?? "unknown" };
    if (op.state !== "PossiblySigned") return { state: op.state };
    const signature = base58Encode(op.signature);
    const deadline = Date.now() + waitMs;
    let status = await signatureStatus(rpc, signature);
    while (!status?.finalized && !status?.failed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      status = await signatureStatus(rpc, signature);
    }
    if (status?.failed) return { state: "PossiblySigned", solana: "failed", error: status.err };
    if (!status?.finalized) return { state: "PossiblySigned", solana: status ? "confirmed, not finalized yet" : "not seen yet" };
    await this.vault.action("settle_solana", { op_id: op.op_id }, "100000000000000");
    const settled = await this.vault.view<SolanaOperationView | null>("get_solana_operation_by_reference", { role, reference });
    return { state: settled?.state ?? "unknown", solana: "finalized" };
  }

  /**
   * Send a NEP-141 token held by the vault account to a listed NEAR account
   * (a spending card, a supplier). The vault checks the role, charges the
   * budget and calls `ft_transfer`; its callback confirms or releases the
   * budget in the same NEAR transaction. Amount in base units.
   */
  async nearTransfer(input: { token: string; receiverId: string; amount: string; memo?: string; reference: string }) {
    const { role, member } = this.vault.identity();
    const request = { token: input.token, receiver_id: input.receiverId, amount: input.amount, memo: input.memo ?? null, reference: input.reference };
    // Older vaults do not have NEAR transfers; any other error is not a refusal.
    const check = await this.vault.view<{ allowed: boolean; reason: string | null }>("check_near", { role, member, request }).catch((error: unknown) => {
      if (/MethodNotFound|MethodResolveError/.test(String(error))) return { allowed: false, reason: "the vault does not support NEAR transfers yet (upgrade by vote)" };
      throw error;
    });
    if (!check.allowed) return { outcome: "refused" as const, reason: check.reason, refusedBy: "vault" as const };
    // check_near does not look at references: a reused one would panic in execute_near.
    if (await this.vault.view("get_near_operation_by_reference", { role, reference: input.reference })) {
      return { outcome: "refused" as const, reason: "ERR_REFERENCE_ALREADY_USED", refusedBy: "vault" as const };
    }
    let nearTransactionHash: string;
    try {
      nearTransactionHash = await this.vault.action("execute_near", { role, request }, NEAR_TRANSFER_GAS);
    } catch (error) {
      // Agent keys made before NEAR transfers cannot call execute_near.
      if (/MethodNameMismatch|method_name/i.test(String(error))) {
        return { outcome: "refused" as const, reason: "this agent's NEAR key predates NEAR transfers: pair the agent again", refusedBy: "key" as const };
      }
      throw error;
    }
    this.wake();
    return { outcome: "sent" as const, nearTransactionHash, ...(await this.nearStatus(input.reference)) };
  }

  /** State of a NEAR token transfer; frees a stuck one after the unconfirmed timeout. */
  async nearStatus(reference: string): Promise<{ state: string; opId?: Hex; receiverId?: string; amount?: string }> {
    const { role } = this.vault.identity();
    const read = () => this.vault.view<NearOperationView | null>("get_near_operation_by_reference", { role, reference });
    let op = await read();
    if (!op) return { state: "unknown" };
    if (op.state === "Pending") {
      const config = await this.vault.view<{ unconfirmed_after_ns: string }>("get_settlement_config");
      if (BigInt(Date.now()) * 1_000_000n - BigInt(op.created_at_ns) >= BigInt(config.unconfirmed_after_ns)) {
        // Our clock may run ahead of the chain's: too early is not an error, just not yet.
        await this.vault.action("release_near_unconfirmed", { op_id: op.op_id }).catch((error: unknown) => {
          if (!/ERR_UNCONFIRMED_TOO_EARLY|ERR_NOT_PENDING/.test(String(error))) throw error;
        });
        op = (await read()) ?? op;
      }
    }
    return { state: op.state, opId: bytesToHex(Uint8Array.from(op.op_id)), receiverId: op.request.receiver_id, amount: op.request.amount };
  }

  async shareRevenue(amountWei: string, reference: string): Promise<Record<string, unknown>> {
    if (!this.advisory?.shareRevenue) throw new Error("Use execute_call with the bridge calldata when the optional revenue builder API is unavailable");
    const op = await this.advisory.shareRevenue(amountWei);
    const result = await this.call({ chain_id:op.chainId, target:Array.from(hexToBytes(op.to)), calldata:Array.from(hexToBytes(op.data)), value:op.value, allowance_amount:op.allowanceAmount, reference, gas_limit:op.gasLimit, max_fee_per_gas:op.maxFeePerGas, max_priority_fee_per_gas:op.maxPriorityFeePerGas });
    return { ...result, recipient:op.recipient, bridgeFee:op.bridgeFee };
  }
}
