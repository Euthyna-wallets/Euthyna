import { describe, expect, it } from "vitest";
import { exactInputSingleCalldata, minOut, parseOrder, rateFromPrice, rateOf, RATE_SCALE, serializeOrder, vaultTag } from "./sealed-orders.js";

describe("sealed orders, as contracts/sealed-orders computes them", () => {
  it("takes the same minimum output as the contract's unit test", () => {
    // contracts/sealed-orders: min_out_applies_rate_and_slippage
    const rate = 400_000_000n * RATE_SCALE;
    expect(minOut(1_000_000_000n, rate, 0)).toBe(400_000_000_000_000_000n);
    expect(minOut(1_000_000_000n, rate, 50)).toBe(398_000_000_000_000_000n);
  });

  it("builds the same calldata as the contract's unit test", () => {
    // contracts/sealed-orders: calldata_is_exact_input_single
    const data = exactInputSingleCalldata({
      tokenIn: `0x${"aa".repeat(20)}`, tokenOut: `0x${"bb".repeat(20)}`, fee: 3000,
      recipient: `0x${"cc".repeat(20)}`, amountIn: 5n, amountOutMinimum: 7n,
    });
    const bytes = Buffer.from(data.slice(2), "hex");
    expect(bytes.length).toBe(4 + 7 * 32);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("04e45aaf");
    expect(bytes.subarray(4 + 3 * 32 - 2, 4 + 3 * 32).toString("hex")).toBe("0bb8");
    expect(bytes[4 + 6 * 32 - 1]).toBe(7);
  });

  it("tags a vault as the contract and prove.mjs do", () => {
    // The sandbox test checks the contract against prove.mjs; this pins the shared vector.
    expect(`0x${vaultTag("acme-vault.test.near").toString(16).padStart(64, "0")}`).toBe(
      "0x003c92d1d1219069589de729a3f0da37a2bb0206ac80fcb5e6a95ae8746b4e09",
    );
  });

  it("turns a price into a rate and a quote into a rate", () => {
    // 2500 USDC per WETH: 1 USDC unit (1e-6) buys 4e8 wei.
    expect(rateFromPrice(2500, 6, 18)).toBe(400_000_000n * RATE_SCALE);
    expect(rateOf(1_000_000n, 559_270_439_304_943n)).toBe(559_270_439_304_943n * RATE_SCALE / 1_000_000n);
  });

  it("round-trips an order through its stored form", () => {
    const order = {
      vaultId: "acme.nomos.euthyna.testnet", chainId: 84532,
      tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenOut: "0x4200000000000000000000000000000000000006",
      fee: 3000, limitRate: 3n * 10n ** 26n, cap: 8_000_000n, expiry: 1_800_000_000, salt: 0x1234n,
    } as const;
    expect(parseOrder(serializeOrder(order))).toEqual(order);
  });
});

describe("sealed orders v2: proposals and the members' terms", () => {
  const order = {
    vaultId: "acme.nomos.euthyna.testnet", chainId: 84532,
    tokenIn: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", tokenOut: "0x4200000000000000000000000000000000000006",
    fee: 3000, limitRate: 3n * 10n ** 26n, cap: 8_000_000n, expiry: 1_800_000_000, salt: 0x1234n,
  } as const;

  it("puts the approval before the seal in one DAO proposal, and describes it", async () => {
    const { sealedOrderKind, describeSealedProposal } = await import("./sealed-orders.js");
    const kind = sealedOrderKind("sealed.testnet",
      { vault: "acme.nomos.euthyna.testnet", role: "desk", chainId: 84532, commitment: `0x02${"ab".repeat(31)}`, slippageBps: 50 },
      { vault: "acme.nomos.euthyna.testnet", role: "desk", chainId: 84532, token: order.tokenIn, router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4", amount: 20_000_000n, maxFeePerGas: 3_000_000_000n });
    expect(kind.FunctionCall.actions.map((a) => a.method_name)).toEqual(["approve", "seal"]);
    expect(kind.FunctionCall.actions[1]!.deposit).toBe("20000000000000000000000");
    const described = describeSealedProposal(kind, "sealed.testnet")!;
    expect(described.title).toBe("Seal an order");
    expect(described.details.join(" ")).toContain("20 USDC");
  });

  it("encrypts the terms to each member's key; only they read them", async () => {
    const { decryptTerms, encryptTerms, publicKeyBase64, readerKeyFromSignature } = await import("./sealed-orders.js");
    const alice = readerKeyFromSignature(new Uint8Array(64).fill(1));
    const bob = readerKeyFromSignature(new Uint8Array(64).fill(2));
    const eve = readerKeyFromSignature(new Uint8Array(64).fill(3));
    // Same signature, same key: a member can derive it again on any device.
    expect(readerKeyFromSignature(new Uint8Array(64).fill(1)).publicKey).toEqual(alice.publicKey);
    const blob = await encryptTerms(order, [
      { account: "alice.testnet", publicKey: publicKeyBase64(alice.publicKey) },
      { account: "bob.testnet", publicKey: publicKeyBase64(bob.publicKey) },
    ]);
    expect(blob.length).toBeLessThan(8192);
    expect(await decryptTerms(blob, "alice.testnet", alice.privateKey)).toEqual(order);
    expect(await decryptTerms(blob, "bob.testnet", bob.privateKey)).toEqual(order);
    expect(await decryptTerms(blob, "eve.testnet", eve.privateKey)).toBeNull();
    // Eve claiming Alice's slot without Alice's key fails to decrypt.
    await expect(decryptTerms(blob, "alice.testnet", eve.privateKey)).rejects.toThrow();
  });
});
