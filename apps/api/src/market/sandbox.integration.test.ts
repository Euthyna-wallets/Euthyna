/**
 * A real cheque on a local NEAR sandbox: verified with the gateway's chain
 * reads, relayed by the market relayer, paid once, refused the second time.
 *
 *   NEAR_SANDBOX_RPC=http://127.0.0.1:3031 NEAR_SANDBOX_KEY_FILE=<home>/validator_key.json pnpm vitest run src/market/sandbox
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { KeyPair, keyStores, Near, transactions } from "near-api-js";
import { describe, expect, it } from "vitest";

import { verifyCheque, type PaymentRequirement } from "./cheque.js";
import { chequeChain, NearChequeRelayer, storageRegistered } from "./near-market.js";

const rpcUrl = process.env.NEAR_SANDBOX_RPC;
const keyFile = process.env.NEAR_SANDBOX_KEY_FILE;
const nearRequire = createRequire(createRequire(import.meta.url).resolve("near-api-js"));
const t = nearRequire("@near-js/transactions") as {
  buildDelegateAction(input: unknown): unknown;
  signDelegateAction(input: unknown): Promise<{ signedDelegateAction: unknown }>;
  encodeSignedDelegate(value: unknown): Uint8Array;
};

describe.skipIf(!rpcUrl || !keyFile)("market cheque on a NEAR sandbox", () => {
  it("verifies, relays once and pays the seller exactly the price", async () => {
    const validator = JSON.parse(readFileSync(keyFile!, "utf8")) as { account_id: string; secret_key?: string; private_key?: string };
    const root = validator.account_id;
    const rootKey = KeyPair.fromString((validator.secret_key ?? validator.private_key) as `ed25519:${string}`);
    const tag = Date.now().toString(36);
    const ids = { ft: `ft-${tag}.${root}`, buyer: `buyer-${tag}.${root}`, seller: `seller-${tag}.${root}`, relayer: `relayer-${tag}.${root}`, fcbuyer: `fcbuyer-${tag}.${root}` };
    const keys = { buyer: KeyPair.fromRandom("ed25519"), relayer: KeyPair.fromRandom("ed25519"), fc: KeyPair.fromRandom("ed25519") };
    const keyStore = new keyStores.InMemoryKeyStore();
    for (const id of [root, ids.ft, ids.seller, ids.fcbuyer]) await keyStore.setKey("sandbox", id, rootKey);
    await keyStore.setKey("sandbox", ids.buyer, keys.buyer);
    const near = new Near({ networkId: "sandbox", nodeUrl: rpcUrl!, keyStore });
    const admin = await near.account(root);
    const NEAR = 10n ** 24n;
    await admin.createAccount(ids.ft, rootKey.getPublicKey(), 10n * NEAR);
    const ft = await near.account(ids.ft);
    await ft.deployContract(readFileSync(resolve(import.meta.dirname, "../../../../contracts/res/test_ft.wasm")));
    await ft.functionCall({ contractId: ids.ft, methodName: "new", args: {} });
    await admin.createAccount(ids.buyer, keys.buyer.getPublicKey(), NEAR);
    await admin.createAccount(ids.seller, rootKey.getPublicKey(), NEAR);
    await admin.createAccount(ids.relayer, keys.relayer.getPublicKey(), 5n * NEAR);
    await admin.createAccount(ids.fcbuyer, rootKey.getPublicKey(), NEAR);
    await ft.functionCall({ contractId: ids.ft, methodName: "mint", args: { account_id: ids.buyer, amount: "5000000" } });
    await ft.functionCall({ contractId: ids.ft, methodName: "mint", args: { account_id: ids.seller, amount: "0" } });
    await ft.functionCall({ contractId: ids.ft, methodName: "mint", args: { account_id: ids.fcbuyer, amount: "5000000" } });
    await (await near.account(ids.fcbuyer)).addKey(keys.fc.getPublicKey(), ids.ft, ["ft_transfer"], NEAR / 4n);

    // Reads use finality "final": let the new accounts and keys settle.
    await new Promise((done) => setTimeout(done, 4_000));
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      const response = await fetch(rpcUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await response.json() as { result?: T; error?: unknown };
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result as T;
    };
    const chain = chequeChain(rpc);
    const requirement: PaymentRequirement = { scheme: "exact", network: "near:sandbox", asset: ids.ft, amount: "2000000", payTo: ids.seller, maxTimeoutSeconds: 600 };
    expect(await storageRegistered(rpc, ids.ft, ids.seller)).toBe(true);

    const sign = async (sender: string, key: KeyPair) => {
      const access = await chain.accessKey(sender, key.getPublicKey().toString());
      const height = await chain.blockHeight();
      const delegateAction = t.buildDelegateAction({
        actions: [transactions.functionCall("ft_transfer", { receiver_id: ids.seller, amount: "2000000" }, 30_000_000_000_000n, 1n)],
        maxBlockHeight: height + 2_000n, nonce: access!.nonce + 1n, publicKey: key.getPublicKey(), receiverId: ids.ft, senderId: sender,
      });
      const { signedDelegateAction } = await t.signDelegateAction({ delegateAction, signer: { sign: async (message: Uint8Array) => key.sign(createHash("sha256").update(message).digest()).signature } });
      return { x402Version: 2, accepted: requirement, payload: { signedDelegateAction: Buffer.from(t.encodeSignedDelegate(signedDelegateAction)).toString("base64") } };
    };

    // A function-call key is refused before anything is relayed.
    await expect(verifyCheque(await sign(ids.fcbuyer, keys.fc), requirement, chain, async () => false)).rejects.toMatchObject({ code: "function_call_key" });

    const payment = await sign(ids.buyer, keys.buyer);
    const cheque = await verifyCheque(payment, requirement, chain, async () => false);
    expect(cheque.signatureValid).toBe(true);

    const relayer = new NearChequeRelayer(ids.relayer, keys.relayer.toString(), "sandbox", rpcUrl!);
    const balance = async (account: string) => BigInt(await ft.viewFunction({ contractId: ids.ft, methodName: "ft_balance_of", args: { account_id: account } }) as string);
    const first = await relayer.relay(cheque.signedDelegateB64, cheque.senderId);
    expect(first).toMatchObject({ ok: true });
    expect(await balance(ids.seller)).toBe(2_000_000n);
    expect(await balance(ids.buyer)).toBe(3_000_000n);
    // The chain refuses the same cheque again (nonce used): no double payment.
    const second = await relayer.relay(cheque.signedDelegateB64, cheque.senderId);
    expect(second.ok).toBe(false);
    expect(await balance(ids.seller)).toBe(2_000_000n);
    // And the gateway would refuse it before relaying: the nonce is now used on chain.
    await expect(verifyCheque(payment, requirement, chain, async () => false)).rejects.toMatchObject({ code: "stale_nonce" });
  }, 180_000);
});
