import { describe, expect, it } from "vitest";

import { sealedApprovalsIn } from "./sealed-approval.js";

const VAULT = "acme.nomos.euthyna.testnet";
const op = Array.from({ length: 32 }, (_, i) => i);
const log = (event: unknown) => `EVENT_JSON:${JSON.stringify(event)}`;

describe("router approvals in a vote's logs", () => {
  it("keeps only this vault's sealed-orders approvals and fills", () => {
    expect(sealedApprovalsIn([
      "plain log",
      log({ standard: "euthyna-sealed-orders", version: "1.0.0", event: "approve_requested", data: [{ vault: VAULT }] }),
      log({ standard: "euthyna-sealed-orders", version: "1.0.0", event: "approved", data: [{ vault: VAULT, op_id: op }] }),
      log({ standard: "euthyna-sealed-orders", version: "1.0.0", event: "approved", data: [{ vault: "other.testnet", op_id: op }] }),
      log({ standard: "nep141", event: "approved", data: [{ vault: VAULT, op_id: op }] }),
      log({ standard: "euthyna-sealed-orders", version: "1.0.0", event: "filled", data: [{ vault: VAULT, id: 3, op_id: [...op].reverse() }] }),
      "EVENT_JSON:{broken",
    ], VAULT)).toEqual([op, [...op].reverse()]);
  });
});
