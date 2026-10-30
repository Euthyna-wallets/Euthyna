/**
 * The whole buyer path against the real euthyna-signer binary: MarketBuyer
 * asks the signer's card to sign, and the gateway's own cheque verification
 * accepts the result (signature, canonical args, key). EUTHYNA_SIGNER_BIN
 * points at a built signer (cargo build in euthyna-signer).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarketBuyer, SignerCard, SignerSocket } from "@mandateos/sdk";
import { utils } from "near-api-js";
import { afterAll, describe, expect, it } from "vitest";

import { parsePaymentHeader, verifyCheque, type PaymentRequirement } from "./cheque.js";

const bin = process.env.EUTHYNA_SIGNER_BIN;
const AGENT = "larry-09d0b2-agent.mandateos.testnet";
const CARD = "larry-09d0b2-card.mandateos.testnet";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const VAULT = "megaai.nomos.euthyna.testnet";

describe.skipIf(!bin)("market buyer with the real euthyna-signer", () => {
  let daemon: ChildProcess | null = null;
  // The signer reads the chain height before signing; a stand-in NEAR RPC at height 1000.
  const chain = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { header: { height: 1_000 } } })));
  afterAll(() => { daemon?.kill(); chain.close(); });

  it("signs a cheque the gateway accepts, and refuses one above the card's cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "signer-"));
    const state = join(dir, "state");
    mkdirSync(join(state, "agents"), { recursive: true, mode: 0o700 });
    const seed = () => utils.serialize.base_encode(crypto.getRandomValues(new Uint8Array(32)));
    const cardSeed = seed();
    const record = join(state, "agents", `${AGENT}.json`);
    writeFileSync(record, JSON.stringify({
      account_id: AGENT, network_id: "testnet", vault_id: VAULT, allowed_methods: ["prepare"], max_gas: 300000000000000, max_deposit_yocto: "1",
      secret_seed: seed(), card: { account_id: CARD, token: USDC, max_per_payment: "5000000", secret_seed: cardSeed },
    }));
    chmodSync(record, 0o600);
    const socketPath = join(dir, "signer.sock");
    const config = join(dir, "config.json");
    await new Promise<void>((resolve) => chain.listen(0, "127.0.0.1", resolve));
    const nearRpcUrl = `http://127.0.0.1:${(chain.address() as AddressInfo).port}`;
    writeFileSync(config, JSON.stringify({ socket_path: socketPath, allowed_uids: [process.getuid!()], state_dir: state, audit_log: join(dir, "audit.log"), rate_per_minute: 100, near_rpc_url: nearRpcUrl }));
    daemon = spawn(bin!, ["--config", config, "serve"], { stdio: "ignore" });
    const socket = new SignerSocket(socketPath);
    for (let i = 0; i < 50; i += 1) {
      if (await socket.request({ op: "status" }).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const card = new SignerCard(socket, AGENT);
    const info = await card.info();
    expect(info).toMatchObject({ card: CARD, token: USDC, maxPerPayment: 5_000_000n });
    expect(info.publicKey).toMatch(/^ed25519:/);

    const requirement = (amount: string): PaymentRequirement => ({ scheme: "exact", network: "near:testnet", asset: USDC, amount, payTo: VAULT, maxTimeoutSeconds: 2400 });
    let lastPayment: string | null = null;
    let price = "2000000";
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      const payment = (init?.headers as Record<string, string> | undefined)?.["x-payment"];
      if (!payment) return new Response(JSON.stringify({ x402Version: 2, error: "x-payment header is required", accepts: [requirement(price)] }), { status: 402 });
      lastPayment = payment;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t", status: { state: "TASK_STATE_SUBMITTED" }, artifacts: [] } }), { status: 200 });
    }) as typeof fetch;
    const rpc = async <T>(method: string): Promise<T> => (method === "block" ? { header: { height: 1_000 } } : { nonce: 41 }) as T;
    const buyer = new MarketBuyer("https://market.example", card, rpc, fetcher);

    await expect(buyer.hire({ handle: "defi-due-diligence", task: "aave-v3", maxPriceAtomic: 1_000_000n })).resolves.toMatchObject({ outcome: "refused" });
    const hired = await buyer.hire({ handle: "defi-due-diligence", task: "aave-v3", maxPriceAtomic: 3_000_000n });
    expect(hired.outcome).toBe("hired");

    const cheque = await verifyCheque(parsePaymentHeader(lastPayment!), requirement(price), {
      accessKey: async (account, key) => (account === CARD && key === info.publicKey ? { nonce: 41n, permission: "FullAccess" } : null),
      blockHeight: async () => 1_000n,
      ftBalance: async () => 10_000_000n,
    }, async () => false);
    expect(cheque).toMatchObject({ senderId: CARD, receiverId: USDC, nonce: 42n, signatureValid: true });

    // Above the card's cap: the buyer refuses before asking, and the signer would refuse anyway.
    // A seller's 402 with a broken timeout or price is not signed at all.
    for (const broken of [{ maxTimeoutSeconds: 1e9 }, { maxTimeoutSeconds: 2.5 }, { amount: "0" }, { amount: "1e6" }]) {
      const bad = (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [{ ...requirement("2000000"), ...broken }] }), { status: 402 })) as typeof fetch;
      await expect(new MarketBuyer("https://market.example", card, rpc, bad).hire({ handle: "defi-due-diligence", task: "a", maxPriceAtomic: 3_000_000n })).rejects.toThrow(/valid/);
    }

    price = "6000000";
    await expect(buyer.hire({ handle: "defi-due-diligence", task: "aave-v3", maxPriceAtomic: 10_000_000n })).resolves.toMatchObject({ outcome: "refused", reason: expect.stringMatching(/cap/) });
  }, 30_000);
});
