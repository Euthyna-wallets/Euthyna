import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { decodeCheque, parsePaymentHeader, verifyCheque, type ChequeChain, type PaymentPayload, type PaymentRequirement } from "./cheque.js";
import { BUYER, buyerKey, cheque, requirement, USDC, VAULT, type Overrides } from "./test-cheque.js";

const payment = async (o: Overrides = {}, accepted: PaymentRequirement = requirement): Promise<PaymentPayload> =>
  ({ x402Version: 2, accepted, payload: { signedDelegateAction: await cheque(o) } });

function chain(o: { permission?: "FullAccess" | "FunctionCall"; nonce?: bigint; height?: bigint; balance?: bigint; known?: boolean } = {}): ChequeChain {
  return {
    accessKey: async (accountId, publicKey) => (o.known === false || accountId !== BUYER || publicKey !== buyerKey.getPublicKey().toString()) ? null : {
      nonce: o.nonce ?? 100n,
      permission: o.permission === "FunctionCall" ? { FunctionCall: { receiver_id: USDC, method_names: ["ft_transfer"] } } : "FullAccess",
    },
    blockHeight: async () => o.height ?? 7_000n,
    ftBalance: async () => o.balance ?? 5_000_000n,
  };
}
const fresh = async () => false;
const refusal = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));

describe("cheque verification", () => {
  it("accepts an exact, fresh, funded cheque signed by a full-access key", async () => {
    const result = await verifyCheque(await payment(), requirement, chain(), fresh);
    expect(result).toMatchObject({ senderId: BUYER, receiverId: USDC, nonce: 101n, maxBlockHeight: 10_000n, signatureValid: true });
    expect(result.delegateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("1. refuses what does not decode", async () => {
    await expect(refusal(verifyCheque({ x402Version: 2, accepted: requirement, payload: { signedDelegateAction: "AAAA" } }, requirement, chain(), fresh))).resolves.toBe("delegate_malformed");
    expect(() => parsePaymentHeader("not base64 json")).toThrow(/base64 JSON/);
    expect(() => parsePaymentHeader(Buffer.from(JSON.stringify({ x402Version: 1 })).toString("base64"))).toThrow(/x402Version/);
  });

  it("2. refuses a cheque that accepted other terms", async () => {
    for (const accepted of [{ ...requirement, amount: "1" }, { ...requirement, payTo: "attacker.testnet" }, { ...requirement, network: "near:mainnet" }, { ...requirement, asset: "usdc.fakes.testnet" }]) {
      await expect(refusal(verifyCheque(await payment({}, accepted), requirement, chain(), fresh))).resolves.toBe("requirement_mismatch");
    }
  });

  it("3. refuses forged transfers: wrong amount, payee, token, method, deposit, gas or extra actions", async () => {
    const cases: Array<[Overrides, string]> = [
      [{ args: { receiver_id: VAULT, amount: "1" } }, "wrong_transfer"],
      [{ args: { receiver_id: "attacker.testnet", amount: "2000000" } }, "wrong_transfer"],
      [{ args: { receiver_id: VAULT, amount: "2000000", msg: "x" } }, "wrong_transfer"],
      [{ receiver: "usdc.fakes.testnet" }, "wrong_asset"],
      [{ method: "ft_transfer_call" }, "wrong_method"],
      [{ deposit: 0n }, "wrong_deposit"],
      [{ deposit: 2n }, "wrong_deposit"],
      [{ gas: 31_000_000_000_000n }, "too_much_gas"],
      [{ extraAction: true }, "wrong_actions"],
    ];
    for (const [overrides, code] of cases) {
      await expect(refusal(verifyCheque(await payment(overrides), requirement, chain(), fresh))).resolves.toBe(code);
    }
  });

  it("4. refuses a bad signature, a key the sender does not have, and function-call keys", async () => {
    await expect(refusal(verifyCheque(await payment({ signWith: KeyPair.fromRandom("ed25519") }), requirement, chain(), fresh))).resolves.toBe("bad_signature");
    await expect(refusal(verifyCheque(await payment({ key: KeyPair.fromRandom("ed25519") }), requirement, chain(), fresh))).resolves.toBe("unknown_key");
    await expect(refusal(verifyCheque(await payment({ sender: "carol.testnet" }), requirement, chain(), fresh))).resolves.toBe("unknown_key");
    await expect(refusal(verifyCheque(await payment(), requirement, chain({ permission: "FunctionCall" }), fresh))).resolves.toBe("function_call_key");
  });

  it("5. refuses a used nonce and a cheque that expires before the work is due", async () => {
    await expect(refusal(verifyCheque(await payment({ nonce: 100n }), requirement, chain(), fresh))).resolves.toBe("stale_nonce");
    await expect(refusal(verifyCheque(await payment({ maxBlockHeight: 9_399n }), requirement, chain(), fresh))).resolves.toBe("expires_too_soon");
    await expect(refusal(verifyCheque(await payment({ maxBlockHeight: 9_400n }), requirement, chain(), fresh))).resolves.toBe("accepted");
  });

  it("6. refuses a replayed cheque", async () => {
    const first = await payment();
    const hash = decodeCheque(first.payload.signedDelegateAction).delegateHash;
    await expect(refusal(verifyCheque(first, requirement, chain(), async (seen) => seen === hash))).resolves.toBe("replayed");
  });

  it("7. refuses a buyer who cannot cover it", async () => {
    await expect(refusal(verifyCheque(await payment(), requirement, chain({ balance: 1_999_999n }), fresh))).resolves.toBe("insufficient_balance");
  });

  it("hashes the signed message, so the same cheque always has the same replay key", async () => {
    const encoded = await cheque();
    expect(decodeCheque(encoded).delegateHash).toBe(decodeCheque(encoded).delegateHash);
    expect(decodeCheque(await cheque({ nonce: 102n })).delegateHash).not.toBe(decodeCheque(encoded).delegateHash);
  });
});
