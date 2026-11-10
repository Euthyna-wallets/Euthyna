import { describe, expect, it } from "vitest";
import { RpcUsage } from "./rpc-usage.js";

describe("the per-minute RPC usage log", () => {
  it("counts by caller, endpoint and what was asked, and logs the top of the window", () => {
    const logged: Array<Record<string, unknown>> = [];
    let lane = "foreground";
    const usage = new RpcUsage((event) => logged.push(event), () => lane);
    for (let i = 0; i < 3; i += 1) usage.record(0, "query", { request_type: "call_function", account_id: "acme.vault.testnet", method_name: "list_roles" });
    usage.record(1, "query", { request_type: "view_account", account_id: "acme.vault.testnet" });
    lane = "background";
    usage.record(0, "query", { request_type: "call_function", account_id: "b.vault.testnet", method_name: "list_rule_changes" });
    usage.record(0, "block", { finality: "final" });
    usage.flush(60);
    expect(logged).toEqual([{
      event: "near.rpc_usage",
      windowSeconds: 60,
      total: 6,
      byLane: { foreground: 4, background: 2 },
      byEndpoint: { "#0": 5, "#1": 1 },
      top: [
        "3 foreground #0 query call_function list_roles",
        "1 foreground #1 query view_account",
        "1 background #0 query call_function list_rule_changes",
        "1 background #0 block",
      ],
    }]);
    // No account and no URL in the log.
    expect(JSON.stringify(logged)).not.toMatch(/testnet|http/);
  });

  it("logs nothing for a window without requests", () => {
    const logged: unknown[] = [];
    const usage = new RpcUsage((event) => logged.push(event), () => "foreground");
    usage.flush(60);
    usage.record(0, "block", {});
    usage.flush(60);
    usage.flush(60);
    expect(logged).toHaveLength(1);
  });
});
