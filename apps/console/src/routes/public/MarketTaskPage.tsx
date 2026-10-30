import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { NEAR_TESTNET_TOKENS } from "@mandateos/sdk/roles";

import { Markdown } from "../../lib/markdown.js";
import { market, tokenAmount, type MarketTaskView } from "../../lib/market.js";

const NEAR_EXPLORER = "https://testnet.nearblocks.io/txns";

/** paid → working → delivered → settled, as far as this task got. */
function timeline(task: MarketTaskView): Array<{ label: string; done: boolean; failed?: boolean }> {
  const state = task.status.state;
  const payment = task.metadata.payment?.state ?? null;
  const prepaid = payment === "prepaid";
  const finished = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(state);
  return [
    { label: prepaid ? "Paid upfront" : "Payment held", done: payment !== null },
    { label: "Working", done: state === "TASK_STATE_WORKING" || finished },
    { label: state === "TASK_STATE_FAILED" ? "Failed (not charged on held payments)" : "Delivered", done: finished, failed: state === "TASK_STATE_FAILED" },
    { label: task.metadata.unpaid ? "Payment failed" : "Settled", done: payment === "settled" || prepaid && state === "TASK_STATE_COMPLETED", failed: task.metadata.unpaid },
  ];
}

export function MarketTaskPage() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["market-task", id],
    queryFn: () => market.task(id),
    refetchInterval: (state) => (["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(state.state.data?.task.status.state ?? "") ? false : 4_000),
  });
  const task = query.data?.task;
  const markdown = task?.artifacts[0]?.parts.find((part) => part.text)?.text ?? null;
  const json = task?.artifacts[0]?.parts.find((part) => part.data !== undefined)?.data;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${task?.handle ?? "result"}-${id.slice(0, 8)}.json` });
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", background: "#F4F7FB", color: "#0F1E3D", colorScheme: "light", minHeight: "100vh" }}>
      <header style={{ background: "#0F2A5C", color: "#F2F6FC", padding: "16px 24px" }}>
        <div style={{ maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <Link to="/market" style={{ color: "#F2F6FC", textDecoration: "none", fontWeight: 700 }}>← Euthyna Market</Link>
          <span style={{ fontSize: 13, color: "#C9D6EE" }}>Task {id.slice(0, 8)}</span>
        </div>
      </header>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 64px", display: "flex", flexDirection: "column", gap: 18 }}>
        {query.isLoading ? <p>Loading the task…</p> : query.error ? <p style={{ color: "#B42318" }}>{query.error.message}</p> : task ? (
          <>
            <section style={{ background: "#FFF", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
              <h1 style={{ margin: 0, fontSize: 24 }}>{task.title}</h1>
              <ol style={{ display: "flex", flexWrap: "wrap", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
                {timeline(task).map((step) => (
                  <li key={step.label} style={{ borderRadius: 999, padding: "6px 12px", fontSize: 13, background: step.failed ? "#FDE2DE" : step.done ? "#DDF4E4" : "#EEF2F8", color: step.failed ? "#8A1C12" : step.done ? "#0E5A2A" : "#44557A" }}>{step.done ? "✓ " : ""}{step.label}</li>
                ))}
              </ol>
              {task.status.message ? <p style={{ margin: 0, fontSize: 14, color: "#8A1C12" }}>{task.status.message}</p> : null}
              {task.metadata.payment ? (
                <p style={{ margin: 0, fontSize: 13, color: "#44557A" }}>
                  {tokenAmount(task.metadata.payment.amount)} {NEAR_TESTNET_TOKENS.find((token) => token.accountId === task.metadata.payment!.asset)?.symbol ?? "tokens"} to <span>{task.metadata.payment.payTo}</span> from {task.metadata.buyer}
                  {task.metadata.payment.settleTxHash ? <> · <a href={`${NEAR_EXPLORER}/${task.metadata.payment.settleTxHash}`} target="_blank" rel="noreferrer">payment on NEAR ↗</a></> : null}
                </p>
              ) : null}
              <details><summary style={{ cursor: "pointer", fontSize: 13 }}>Your request</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{task.input}</pre></details>
            </section>
            {markdown ? (
              <section style={{ background: "#FFF", borderRadius: 16, padding: "8px 24px 24px", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.55 }}>
                {json !== undefined ? <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12 }}><button onClick={download} style={{ border: "1px solid #CBD5E6", background: "#FFF", color: "#0F1E3D", borderRadius: 8, padding: "6px 10px", cursor: "pointer", font: "inherit" }}>Download JSON</button></div> : null}
                <Markdown source={markdown} />
              </section>
            ) : ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(task.status.state) ? null : <p style={{ color: "#44557A" }}>The seller's agent is on it. This page updates by itself.</p>}
          </>
        ) : null}
      </main>
    </div>
  );
}
