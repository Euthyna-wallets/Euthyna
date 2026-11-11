import { describe, expect, it } from "vitest";

import { roleDraftSchema } from "./app.js";

const draft = (token: string | null) => ({ draft: {
  name: "payments",
  members: [],
  blocks: [{ kind: "solana-transfer", token, recipients: [{ address: "BD5xp8AcoNcMm81bjKw99PYAFFoEAkiJd7fBiPYq8VSC", label: "Supplier" }], budget: { amount: "5", periodDays: 1 } }],
} });

describe("a role's Solana transfers", () => {
  it("take SOL, USDC and Noah's EURC; refuse an unknown token", () => {
    for (const token of [null, "USDC", "EURC"]) expect(roleDraftSchema.safeParse(draft(token)).success, String(token)).toBe(true);
    expect(roleDraftSchema.safeParse(draft("DOGE")).success).toBe(false);
  });
});
