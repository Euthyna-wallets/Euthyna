import { describe, expect, it } from "vitest";

import { SolanaFollower, SOLANA_EXPIRED_AFTER_MS } from "./solana-follower.js";

const VAULT = "co.euthyna-nomos.testnet";
const OP = `0x${"ab".repeat(32)}`;
const SIGNED_AT = 1_000_000;

function harness(input: { status?: { confirmationStatus: string; err: unknown } | null; signed?: boolean; tooEarly?: boolean }) {
  let now = SIGNED_AT;
  let state = "PossiblySigned";
  const calls: string[] = [];
  const sent: string[] = [];
  const near = {
    viewFunction: async <T>(_vault: string, method: string) => {
      if (method === "get_settlement_config") return { unconfirmed_after_ns: String(6 * 3_600_000 * 1_000_000) } as T;
      return {
        state,
        signature: input.signed === false ? null : Array(64).fill(1),
        signed_transaction: input.signed === false ? null : [1, 2, 3],
        signed_at_ns: String(SIGNED_AT * 1_000_000),
      } as T;
    },
    callFunction: async (_vault: string, method: string) => {
      if (method === "release_solana_unconfirmed" && input.tooEarly && now < SIGNED_AT + 6 * 3_600_000) throw new Error("Smart contract panicked: ERR_UNCONFIRMED_TOO_EARLY");
      calls.push(method);
      state = method === "settle_solana" ? "Confirmed" : "Unconfirmed";
      return "tx";
    },
  };
  const rpc = (async (method: string) => {
    if (method === "getSignatureStatuses") return { value: [input.status ?? null] };
    if (method === "sendTransaction") { sent.push(method); return "sig"; }
    throw new Error(method);
  }) as never;
  const follower = new SolanaFollower(near, rpc, "http://index", () => {}, () => now, async () => [{ kind: "solana", opId: OP }]);
  return { follower, calls, sent, at: (ms: number) => { now = SIGNED_AT + ms; }, state: () => state };
}

describe("SolanaFollower", () => {
  it("settles a finalized transfer through MPC, then stops following it", async () => {
    const h = harness({ status: { confirmationStatus: "finalized", err: null } });
    h.at(30_000);
    await h.follower.scan(VAULT);
    await h.follower.tick();
    expect(h.calls).toEqual(["settle_solana"]);
    h.at(45_000);
    await h.follower.tick();
    expect(h.follower.size).toBe(0);
  });

  it("broadcasts again while the blockhash may be valid, then frees the role once it expired", async () => {
    const h = harness({ status: null });
    h.at(20_000);
    await h.follower.scan(VAULT);
    await h.follower.tick();
    expect(h.sent).toHaveLength(1);
    h.at(5 * 60_000);
    await h.follower.tick();
    expect(h.calls).toEqual([]);
    h.at(SOLANA_EXPIRED_AFTER_MS);
    await h.follower.tick();
    expect(h.calls).toEqual(["release_solana_unconfirmed"]);
  });

  it("an older vault: retried at its settlement timeout", async () => {
    const h = harness({ status: null, tooEarly: true });
    h.at(SOLANA_EXPIRED_AFTER_MS);
    await h.follower.scan(VAULT);
    await h.follower.tick();
    expect(h.calls).toEqual([]);
    h.at(3 * 3_600_000);
    await h.follower.tick();
    expect(h.calls).toEqual([]);
    h.at(6 * 3_600_000 + 10_000);
    await h.follower.tick();
    expect(h.calls).toEqual(["release_solana_unconfirmed"]);
  });

  it("never signed by MPC: freed once expired; finished operations are not followed", async () => {
    const h = harness({ signed: false });
    h.at(SOLANA_EXPIRED_AFTER_MS + 1);
    await h.follower.scan(VAULT);
    await h.follower.tick();
    expect(h.calls).toEqual(["release_solana_unconfirmed"]);
    const done = harness({ status: null });
    await done.follower.tick();
    expect(done.follower.size).toBe(0);
  });
});
