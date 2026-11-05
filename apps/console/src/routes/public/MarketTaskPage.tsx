/**
 * One Market task. Visual reference: design-handoff/site/source/15-market-task.html
 * A timeline of struck seals, the request, the delivered result and the
 * payment panel. The logic (polling, download, explorer link) is main's.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { NEAR_TESTNET_TOKENS } from "@euthyna/sdk/roles";

import { Markdown } from "../../lib/markdown.js";
import { market, tokenAmount, type MarketTaskView } from "../../lib/market.js";
import "../../styles/site.css";
import { Kicker, Seal, SiteFooter, SiteHeader } from "./site/SiteChrome.js";

const NEAR_EXPLORER = "https://testnet.nearblocks.io/txns";
const BRAND = "Cinzel, serif";
const MONO = "'JetBrains Mono', monospace";

type Step = { seal: string; label: string; note: string; done: boolean; failed?: boolean };

/** paid → working → delivered → settled, as far as this task got. */
function timeline(task: MarketTaskView): Step[] {
  const state = task.status.state;
  const payment = task.metadata.payment?.state ?? null;
  const prepaid = payment === "prepaid";
  const finished = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(state);
  return [
    { seal: prepaid ? "PAID" : "HELD", label: prepaid ? "PAID UPFRONT" : "PAYMENT HELD", note: prepaid ? "plain transfer" : "cheque signed", done: payment !== null },
    { seal: "WORKING", label: "WORKING", note: "the seller’s agent", done: state === "TASK_STATE_WORKING" || finished },
    {
      seal: "DELIVERED",
      label: state === "TASK_STATE_FAILED" ? "FAILED" : "DELIVERED",
      note: state === "TASK_STATE_FAILED" ? "not charged on held payments" : "report, JSON",
      done: finished,
      failed: state === "TASK_STATE_FAILED",
    },
    { seal: "PAID", label: task.metadata.unpaid ? "PAYMENT FAILED" : "SETTLED", note: "on NEAR", done: payment === "settled" || (prepaid && state === "TASK_STATE_COMPLETED"), failed: task.metadata.unpaid },
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
  const [firstWord = "", ...rest] = (task?.title ?? "").split(" ");
  const token = task && task.metadata.payment ? NEAR_TESTNET_TOKENS.find((item) => item.accountId === task.metadata.payment!.asset)?.symbol ?? "tokens" : "USDC";
  const steps = task ? timeline(task) : [];
  const state = task?.status.state ?? "";

  return (
    <div className="site-root">
      <section className="agora" style={{ position: "relative" }}>
        <SiteHeader />
        <div className="pg" style={{ paddingTop: 36, paddingBottom: 56, display: "flex", flexDirection: "column", gap: 20 }}>
          <nav aria-label="Breadcrumb" style={{ fontSize: 13.5, color: "#8FA2CC" }}>
            <Link to="/market" style={{ color: "#8FE3F1" }}>
              Market
            </Link>{" "}
            / <span style={{ color: "#F3EFE6" }}>Task {id.slice(0, 8)}…</span>
          </nav>
          {query.isLoading ? (
            <p style={{ margin: 0, color: "#C9D3EA" }}>Loading the task…</p>
          ) : query.error ? (
            <p style={{ margin: 0, color: "#F4A28C" }}>{query.error.message}</p>
          ) : task ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="chipx" style={{ background: state === "TASK_STATE_FAILED" ? "#FBE3D6" : "#DDF4F8", color: state === "TASK_STATE_FAILED" ? "#A8381E" : "#0B4E5E" }}>
                  {state === "TASK_STATE_COMPLETED" ? "✓ Delivered" : state === "TASK_STATE_FAILED" ? "Refused" : state === "TASK_STATE_WORKING" ? "Working" : "Submitted"}
                </span>
                <span className="chipx" style={{ background: "rgba(255,255,255,.1)", color: "#C9D3EA" }}>
                  NEAR testnet
                </span>
              </div>
              <h1 style={{ margin: 0, font: `900 clamp(34px, 4.6vw, 62px)/1.05 ${BRAND}`, letterSpacing: ".03em", color: "#F3EFE6" }}>
                {firstWord} <span className="leaf">{rest.join(" ")}</span>
              </h1>
              <span style={{ fontSize: 15, color: "#C9D3EA" }}>
                Sold by{" "}
                <Link to="/market" style={{ color: "#8FE3F1", fontWeight: 700 }}>
                  {task.handle}
                </Link>{" "}
                · bought by {task.metadata.buyer} ·{" "}
                {task.metadata.payment ? `${tokenAmount(task.metadata.payment.amount)} ${token}` : "no payment"}
              </span>
              <div className="tl" style={{ marginTop: 18 }}>
                <div className="mline" aria-hidden="true" />
                {steps.map((step) => (
                  <div key={step.label} className={`step${step.done ? "" : " dim"}`}>
                    <Seal label={step.seal} size={66} refused={Boolean(step.failed)} fontSize={step.seal === "DELIVERED" ? 6 : 7.5} />
                    <b style={{ color: step.failed ? "#F4A28C" : "#F3EFE6" }}>{step.label}</b>
                    <span>{step.note}</span>
                  </div>
                ))}
              </div>
              {task.status.message ? <p style={{ margin: 0, fontSize: 14, color: "#F4A28C" }}>{task.status.message}</p> : null}
            </>
          ) : null}
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      <section className="marble" style={{ padding: "64px 0 96px", color: "#0D1730" }}>
        {task ? (
          <div className="pg g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.25fr) minmax(0,.75fr)", gap: 28, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <section className="slabw" style={{ padding: "22px 26px", display: "flex", flexDirection: "column", gap: 10 }}>
                <Kicker color="#8A5A00">Your request</Kicker>
                <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{task.input}</p>
              </section>
              <section className="slabw" style={{ padding: "22px 26px", display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                  <Kicker color="#0B6E86">{json !== undefined ? "The result · report.json" : "The result"}</Kicker>
                  {json !== undefined ? (
                    <button type="button" onClick={download} className="btnl btn-ghost-ink" style={{ padding: "10px 16px", fontSize: 11.5 }}>
                      DOWNLOAD JSON
                    </button>
                  ) : null}
                </div>
                {markdown ? (
                  <div style={{ fontSize: 15, lineHeight: 1.6 }}>
                    <Markdown source={markdown} />
                  </div>
                ) : ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(state) ? (
                  <p style={{ margin: 0, fontSize: 15, color: "#4A5675" }}>The seller delivered no text.</p>
                ) : (
                  <p style={{ margin: 0, fontSize: 15, color: "#4A5675" }}>Nothing delivered yet.</p>
                )}
              </section>
            </div>
            <aside style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <section className="slabw" style={{ padding: "22px 24px", display: "flex", flexDirection: "column" }}>
                <Kicker color="#8A5A00" style={{ marginBottom: 8 }}>
                  Payment
                </Kicker>
                {[
                  ["STATE", task.metadata.payment?.state ?? "none"],
                  ["AMOUNT", task.metadata.payment ? `${tokenAmount(task.metadata.payment.amount)} ${token}` : "—"],
                  ["TO", task.metadata.payment?.payTo ?? "—"],
                  ["FROM", task.metadata.buyer],
                ].map(([label, value]) => (
                  <div key={label} className="row1">
                    <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".14em", color: "#66718C" }}>{label}</span>
                    <span className="mono" style={{ fontSize: 13, textAlign: "right", overflowWrap: "anywhere" }}>
                      {value}
                    </span>
                  </div>
                ))}
                {task.metadata.payment?.settleTxHash ? (
                  <div className="row1">
                    <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".14em", color: "#66718C" }}>ON CHAIN</span>
                    <a className="mono" href={`${NEAR_EXPLORER}/${task.metadata.payment.settleTxHash}`} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                      {task.metadata.payment.settleTxHash.slice(0, 10)}… ↗
                    </a>
                  </div>
                ) : null}
                <span style={{ fontSize: 12.5, color: "#66718C", marginTop: 12, lineHeight: 1.5 }}>
                  A held payment is cashed only on delivery. Had the work failed, the buyer would not have been charged.
                </span>
              </section>
              {["TASK_STATE_COMPLETED", "TASK_STATE_FAILED"].includes(state) ? null : (
                <section className="nightp" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <Kicker>While it runs</Kicker>
                  <span style={{ fontSize: 14, color: "#C9D3EA", lineHeight: 1.55 }}>The seller’s agent is on it. This page updates by itself.</span>
                </section>
              )}
              <Link to="/market" className="ori btno" style={{ textAlign: "center" }}>
                BACK TO THE MARKET
              </Link>
            </aside>
          </div>
        ) : null}
      </section>
      <SiteFooter />
    </div>
  );
}
