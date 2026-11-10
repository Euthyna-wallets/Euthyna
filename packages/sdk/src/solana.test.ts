import { describe, expect, it } from "vitest";

import { BASE_SEPOLIA, budgetsOf, compileRole, describeChange, hexOf, type RuleChange } from "./roles.js";
import { base58Decode, base58Encode, isSolanaAddress, solanaAddress, solanaShortfall } from "./solana.js";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("base58", () => {
  it("round-trips Solana addresses, leading zeros included", () => {
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(base58Encode(base58Decode(RECIPIENT))).toBe(RECIPIENT);
    expect(solanaAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").slice(0, 4)).toEqual([6, 221, 246, 225]);
    expect(isSolanaAddress("0xabc")).toBe(false);
  });
});

describe("Solana transfer role", () => {
  const changes = () => compileRole({
    name: "payouts",
    blocks: [
      { kind: "solana-transfer", token: null, recipients: [{ address: RECIPIENT, label: "Vendor" }], budget: { amount: "0.5", periodDays: 1 } },
      { kind: "solana-transfer", token: "USDC", recipients: [{ address: RECIPIENT, label: "Vendor" }], budget: { amount: "100", periodDays: 30 } },
    ],
    members: [],
  }, BASE_SEPOLIA);

  it("budgets in lamports and token units, and lists the recipients", () => {
    const all = changes();
    const budgets = all.filter((change) => "SetAllowance" in change) as Array<Extract<RuleChange, { SetAllowance: unknown }>>;
    expect(budgets.map((budget) => budget.SetAllowance.balance)).toEqual(["500000000", "100000000"]);
    const solana = all.find((change) => "SetSolanaPermissions" in change) as Extract<RuleChange, { SetSolanaPermissions: unknown }>;
    const [sol, usdc] = solana.SetSolanaPermissions.permissions;
    expect(sol!.asset).toBe("Sol");
    expect(usdc!.asset).toEqual({ Spl: { mint: solanaAddress("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") } });
    expect(sol!.recipients).toEqual([solanaAddress(RECIPIENT)]);
    expect(sol!.allowance).toEqual(budgets[0]!.SetAllowance.key);
    expect(Object.keys(budgetsOf(all, BASE_SEPOLIA))).toContain(hexOf(sol!.allowance).toLowerCase());
  });

  it("is only emitted for roles that use Solana", () => {
    const evmOnly = compileRole({ name: "wrapper", blocks: [{ kind: "wrap", budget: { amount: "0.01", periodDays: 1 } }], members: [] }, BASE_SEPOLIA);
    expect(evmOnly.some((change) => "SetSolanaPermissions" in change)).toBe(false);
  });

  it("describes it in plain English", () => {
    const all = changes();
    const text = all.map((change) => describeChange(change, { profile: BASE_SEPOLIA, budgets: budgetsOf(all, BASE_SEPOLIA) })).flatMap((item) => [item.title, ...item.details]).join("\n");
    expect(text).toContain('Let role "payouts" send on Solana');
    expect(text).toContain(`Send USDC on Solana to ${RECIPIENT}`);
  });
});

describe("the wallet can pay a Solana transfer before the vault signs it", () => {
  const SOL = { symbol: "SOL", decimals: 9, mint: null };
  const USDC = { symbol: "USDC", decimals: 6, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };
  it("refuses SOL the wallet does not have, or that would leave it under the rent floor", () => {
    expect(solanaShortfall({ lamports: 0n, tokenBalance: null }, SOL, 10_000_000n)).toMatch(/holds 0 lamports/);
    expect(solanaShortfall({ lamports: 10_100_000n, tokenBalance: null }, SOL, 10_000_000n)).toMatch(/at least 890880/);
    expect(solanaShortfall({ lamports: 10_005_000n, tokenBalance: null }, SOL, 10_000_000n)).toBeNull();
    expect(solanaShortfall({ lamports: 5_000_000_000n, tokenBalance: null }, SOL, 10_000_000n)).toBeNull();
  });
  it("refuses a token the wallet does not hold, or without SOL for the fee and the recipient's account", () => {
    expect(solanaShortfall({ lamports: 1_000_000_000n, tokenBalance: 0n }, USDC, 1_000_000n)).toMatch(/holds 0 of this token/);
    expect(solanaShortfall({ lamports: 1_000n, tokenBalance: 5_000_000n }, USDC, 1_000_000n)).toMatch(/lamports/);
    expect(solanaShortfall({ lamports: 1_000_000_000n, tokenBalance: 5_000_000n }, USDC, 1_000_000n)).toBeNull();
  });
});

describe("systemTransferWire", () => {
  it("is one signature over a legacy SystemProgram transfer", async () => {
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { systemTransferWire, solanaAddressOfSeed } = await import("./solana.js");
    const seed = new Uint8Array(32).fill(7);
    const to = "Aeo7Nbs7U4trXo49Uf1bxVw5D1JWc9hFihv1xSsJkvZr";
    const wire = systemTransferWire(seed, to, 1_234_567n, new Array<number>(32).fill(9));
    expect(wire[0]).toBe(1);
    const signature = Uint8Array.from(wire.slice(1, 65));
    const message = Uint8Array.from(wire.slice(65));
    expect(Array.from(message.slice(0, 4))).toEqual([1, 0, 1, 3]);
    expect(base58Encode(message.slice(4, 36))).toBe(solanaAddressOfSeed(seed));
    expect(base58Encode(message.slice(36, 68))).toBe(to);
    expect(ed25519.verify(signature, message, ed25519.getPublicKey(seed))).toBe(true);
    // Instruction: program 2, accounts [0, 1], transfer (2) of 1 234 567 lamports.
    const instruction = Array.from(message.slice(4 + 96 + 32));
    expect(instruction.slice(0, 6)).toEqual([1, 2, 2, 0, 1, 12]);
    expect(new DataView(Uint8Array.from(instruction.slice(6)).buffer).getBigUint64(4, true)).toBe(1_234_567n);
  });
});
