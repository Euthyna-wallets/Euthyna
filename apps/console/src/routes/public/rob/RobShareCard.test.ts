import { describe, expect, it } from "vitest";

import { shareViewOf, xIntentOf } from "./RobShareCard.js";
import type { Card, Play, Shown } from "./shared.js";

const card = { id: "forge-a-master-key", numeral: "VIII", title: "Forge a Master Key", rarity: "LEGENDARY", line: 5, by: "near", attempt: "", why: "", playable: true, signer: "function-call" } satisfies Card;
const play = (patch: Partial<Play>): Shown => ({
  card,
  state: "done",
  play: { card: card.id, verdict: "denied", refusedBy: "near", line: 5, error: "RequiresFullAccess", tx: null, nearblocks: null, call: "AddKey", signedBy: "you", ms: 200, ...patch },
});

describe("the share card", () => {
  it("is generic before any play", () => {
    const view = shareViewOf(null);
    expect(view.headline).toBe("Can you rob an AI agent?");
    expect(view.tx).toBeNull();
    expect(shareViewOf({ card, state: "sending" }).headline).toBe("Can you rob an AI agent?");
  });

  it("names the card, the line and who said no", () => {
    const view = shareViewOf(play({}));
    expect(view.word).toBe("DENIED");
    expect(view.headline).toBe("I tried to rob an AI agent. NEAR itself said no.");
    expect(view.detail).toBe("Forge a Master Key · line VI");
    expect(shareViewOf(play({ refusedBy: "vault" })).headline).toBe("I tried to rob an AI agent. The law said no.");
    expect(shareViewOf(play({ verdict: "vetoed", refusedBy: "council", tx: "Ha4GGoCYM9bhzboUoo3tScm1AVjHUuRnAW6fyGC2a7Wo" })).headline).toBe("I tried to rob an AI agent. The council said no.");
    expect(shareViewOf(play({ verdict: "counter", refusedBy: "ruggy" })).word).toBe("COUNTER");
    expect(shareViewOf(play({ verdict: "paid", refusedBy: null })).word).toBe("PAID");
  });

  it("posts on X with the card, the verdict, @NEARProtocol and the tags, linking euthyna.io/rob", () => {
    const view = shareViewOf(play({}));
    const url = new URL(xIntentOf(view.post));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("url")).toBe("https://euthyna.io/rob");
    const text = url.searchParams.get("text") ?? "";
    expect(text).toContain("Forge a Master Key");
    expect(text).toContain("DENIED");
    expect(text).toContain("@NEARProtocol");
    expect(text).toContain("#RobTheAgent");
    expect(text).toContain("#NEARHackathon");
    expect(xIntentOf(view.post)).toMatch(/&url=https%3A%2F%2Feuthyna\.io%2Frob$/);
  });
});
