import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AGENT_FUNCTION_CALL_METHODS } from "./index.js";

// The signer (signer/, Rust) signs only these vault methods for an agent: the same list as the
// function-call keys the console creates, or an agent paired through the signer loses a method.
describe("euthyna-signer methods", () => {
  it("match AGENT_FUNCTION_CALL_METHODS", () => {
    const store = readFileSync(fileURLToPath(new URL("../../../signer/src/store.rs", import.meta.url)), "utf8");
    const block = /pub const DEFAULT_METHODS: &\[&str\] = &\[([^\]]*)\];/.exec(store)?.[1] ?? "";
    const signer = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(signer.length).toBeGreaterThan(0);
    expect([...signer].sort()).toEqual([...AGENT_FUNCTION_CALL_METHODS].sort());
  });
});
