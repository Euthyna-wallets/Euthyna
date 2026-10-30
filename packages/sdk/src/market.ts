/**
 * Buying on the Euthyna Market as an agent: the seller's 402 says what to pay,
 * the agent's spending card (in euthyna-signer) signs one ft_transfer as a
 * NEP-366 delegate action, and the market holds it until the work is
 * delivered. The card's key never leaves the signer.
 */
import { createRequire } from "node:module";

import { transactions, utils } from "near-api-js";

import type { SignerSocket } from "./signer-socket.js";

const nearRequire = createRequire(createRequire(import.meta.url).resolve("near-api-js"));
const nearTx = nearRequire("@near-js/transactions") as {
  SCHEMA: { DelegateAction: unknown };
  buildDelegateAction(input: unknown): unknown;
  encodeSignedDelegate(value: unknown): Uint8Array;
  SignedDelegate: new (input: unknown) => unknown;
  Signature: new (input: unknown) => unknown;
};

export type PaymentRequirement = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number };
export type MarketTask = { id: string; status: { state: string; message?: string }; artifacts: Array<{ parts: Array<{ kind: string; text?: string; data?: unknown }> }>; metadata?: Record<string, unknown> };
export type Card = { card: string; token: string; maxPerPayment: bigint; publicKey: string };

/** Reads a card's public facts and signs its payments, through euthyna-signer. */
export class SignerCard {
  constructor(private readonly socket: SignerSocket, readonly agent: string) {}

  async info(): Promise<Card> {
    const reply = await this.socket.call({ op: "card_info", agent: this.agent });
    return { card: String(reply.card), token: String(reply.token), maxPerPayment: BigInt(String(reply.max_per_payment)), publicKey: String(reply.public_key) };
  }

  /** The signer checks it is one capped ft_transfer of the card's token, then signs. */
  async sign(delegateBorsh: Uint8Array): Promise<{ signature: Uint8Array; publicKey: string }> {
    const reply = await this.socket.call({ op: "sign_delegate", agent: this.agent, delegate_borsh_b64: Buffer.from(delegateBorsh).toString("base64") });
    const signature = utils.serialize.base_decode(String(reply.signature).replace(/^ed25519:/, ""));
    if (signature.length !== 64) throw new Error("euthyna-signer returned a malformed signature");
    return { signature: Uint8Array.from(signature), publicKey: String(reply.public_key) };
  }
}

type NearRpc = <T>(method: string, params: unknown) => Promise<T>;

export function nearRpc(url: string): NearRpc {
  return async <T>(method: string, params: unknown): Promise<T> => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    const body = await response.json() as { result?: T & { error?: string }; error?: { message?: string; data?: unknown } };
    if (body.error) throw new Error(`NEAR RPC ${body.error.message ?? ""} ${JSON.stringify(body.error.data ?? "")}`);
    if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) throw new Error(`NEAR RPC ${body.result.error}`);
    return body.result as T;
  };
}

export class MarketBuyer {
  constructor(
    private readonly marketUrl: string,
    private readonly card: SignerCard,
    private readonly rpc: NearRpc,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.marketUrl.replace(/\/$/, "")}${path}`;
  }

  async agents(query = ""): Promise<unknown[]> {
    const response = await this.fetcher(this.url(`/v1/market/agents?${new URLSearchParams({ q: query })}`), { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`market: HTTP ${response.status}`);
    return ((await response.json()) as { agents: unknown[] }).agents;
  }

  private async send(handle: string, task: string, payment?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.fetcher(this.url(`/a2a/${encodeURIComponent(handle)}/v1`), {
      method: "POST",
      headers: { "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "user", parts: [{ kind: "text", text: task }] } } }),
      signal: AbortSignal.timeout(90_000),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * Hire a listing: read its price from the 402, refuse above `maxPriceAtomic`
   * or what the card may pay, sign the cheque with the card, send the task.
   */
  async hire(input: { handle: string; task: string; maxPriceAtomic: bigint }) {
    const quote = await this.send(input.handle, input.task);
    if (quote.status !== 402) throw new Error(`market: expected a payment request (402), got ${quote.status}: ${JSON.stringify(quote.body).slice(0, 300)}`);
    const requirement = (quote.body.accepts as PaymentRequirement[] | undefined)?.[0];
    if (!requirement || quote.body.x402Version !== 2 || requirement.scheme !== "exact") throw new Error("market: unsupported payment request");
    // A seller's 402 is untrusted: a whole price, a sane timeout (it sets the cheque's life).
    if (typeof requirement.amount !== "string" || !/^[1-9]\d{0,38}$/.test(requirement.amount)) throw new Error("market: the payment request has no valid amount");
    if (!Number.isInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds < 1 || requirement.maxTimeoutSeconds > 90_000) throw new Error("market: the payment request has no valid maxTimeoutSeconds");
    if (typeof requirement.payTo !== "string" || typeof requirement.asset !== "string") throw new Error("market: unsupported payment request");
    const price = BigInt(requirement.amount);
    if (price > input.maxPriceAtomic) return { outcome: "refused" as const, reason: `the price ${requirement.amount} is above max_price ${input.maxPriceAtomic}` };
    const card = await this.card.info();
    if (requirement.asset !== card.token) return { outcome: "refused" as const, reason: `the seller wants ${requirement.asset}; the card pays with ${card.token}` };
    if (price > card.maxPerPayment) return { outcome: "refused" as const, reason: `the price is above the card's cap (${card.maxPerPayment})` };
    const payment = await this.cheque(card, requirement);
    const sent = await this.send(input.handle, input.task, payment);
    if (sent.status === 402) return { outcome: "refused" as const, reason: `market refused the payment: ${String(sent.body.error ?? "")}` };
    if (sent.status !== 200) throw new Error(`market: HTTP ${sent.status}: ${JSON.stringify(sent.body).slice(0, 300)}`);
    return { outcome: "hired" as const, task: (sent.body as { result: MarketTask }).result };
  }

  /** An ft_transfer cheque from the card, alive for twice the timeout in blocks (blocks ~0.6 s). */
  private async cheque(card: Card, requirement: PaymentRequirement): Promise<string> {
    const key = await this.rpc<{ nonce: number }>("query", { request_type: "view_access_key", finality: "final", account_id: card.card, public_key: card.publicKey });
    const block = await this.rpc<{ header: { height: number } }>("block", { finality: "final" });
    const delegateAction = nearTx.buildDelegateAction({
      // Canonical args: receiver_id then amount, nothing else (the market checks the bytes).
      actions: [transactions.functionCall("ft_transfer", { receiver_id: requirement.payTo, amount: requirement.amount }, 30_000_000_000_000n, 1n)],
      maxBlockHeight: BigInt(block.header.height) + BigInt(requirement.maxTimeoutSeconds) * 2n + 120n,
      nonce: BigInt(key.nonce) + 1n,
      publicKey: utils.PublicKey.fromString(card.publicKey),
      receiverId: requirement.asset,
      senderId: card.card,
    });
    const borsh = utils.serialize.serialize(nearTx.SCHEMA.DelegateAction as never, delegateAction);
    const { signature } = await this.card.sign(borsh);
    const signed = new nearTx.SignedDelegate({ delegateAction, signature: new nearTx.Signature({ keyType: 0, data: signature }) });
    const signedDelegateAction = Buffer.from(nearTx.encodeSignedDelegate(signed)).toString("base64");
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: requirement, payload: { signedDelegateAction } })).toString("base64");
  }

  async status(handle: string, taskId: string): Promise<MarketTask> {
    const response = await this.fetcher(this.url(`/a2a/${encodeURIComponent(handle)}/v1`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: taskId } }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json() as { result?: MarketTask; error?: { message: string } };
    if (!body.result) throw new Error(`market: ${body.error?.message ?? `HTTP ${response.status}`}`);
    return body.result;
  }
}
