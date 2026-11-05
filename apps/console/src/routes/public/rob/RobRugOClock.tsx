/**
 * Rug O'Clock: poisoned invoices, voted; on the hour Ruggy reads the winner with a real LLM and the vault refuses it live.
 * Invoices and Ruggy's answers are attacker-controlled text: rendered as React text only, never as HTML, never linked.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { BRAND, MONO, robCall } from "./shared.js";

const MAX = 500;
const AEGEAN = "#4FD1E8";

type Invoice = { id: string; text: string; votes: number; createdAt: string };
type Decision =
  | { kind: "pay"; receiver_id: string; amount_usdc: string; reference: string }
  | { kind: "refused"; text: string }
  | { kind: "invalid"; reason: string; raw: string }
  | { kind: "error"; message: string };
type Reading = {
  at: string;
  model: string;
  llm: Decision;
  call: { receiver_id: string; amount_usdc: string; amount: string; reference: string } | null;
  play: { verdict: "denied" | "counter" | "vetoed" | "paid"; refusedBy: string | null; line: number | null; error: string | null; tx: string | null; nearblocks: string | null; ms: number } | null;
  failure?: string;
};
type RugView = {
  enabled: boolean;
  roundStartedAt: string;
  nextReadingAt: string;
  round: Invoice[];
  last: { id: string; text: string; votes: number; round: string; readAt: string | null; state: "reading" | "done" | "interrupted"; reading: Reading | null } | null;
};

const VOTED_STORE = "rob.rugoclock.voted";
function loadVoted(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(VOTED_STORE) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string").slice(-200) : [];
  } catch {
    return [];
  }
}
function saveVoted(ids: string[]) {
  try {
    localStorage.setItem(VOTED_STORE, JSON.stringify(ids.slice(-200)));
  } catch { /* fine: the server counts one vote anyway */ }
}

function countdown(target: string, now: number): string | null {
  const left = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  if (!left) return null;
  return `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}
const hourOf = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const excerpt = (text: string, size = 220) => (text.length > size ? `${text.slice(0, size).trimEnd()}…` : text);

const VERDICT: Record<string, { word: string; color: string }> = {
  denied: { word: "DENIED", color: "#F4A28C" },
  vetoed: { word: "VETOED", color: "#F2B544" },
  counter: { word: "COUNTER", color: AEGEAN },
  paid: { word: "PAID", color: "#7FE0A8" },
};
const BY: Record<string, string> = { vault: "the vault", near: "NEAR itself", dao: "the DAO", council: "the council", ruggy: "Ruggy" };

const label = { font: `800 11px ${BRAND}`, letterSpacing: ".2em", color: "#8FA2CC" } as const;
const plain = { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" } as const;
const smallButton = (active: boolean) => ({
  minHeight: 44, minWidth: 76, padding: "0 14px", font: `800 11px ${BRAND}`, letterSpacing: ".18em", cursor: active ? "pointer" : "default",
  color: active ? "#030918" : "#8FA2CC", background: active ? AEGEAN : "transparent", border: `1px solid ${active ? AEGEAN : "rgba(143,162,204,.35)"}`,
}) as const;

export function RobRugOClock() {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ["rob-rugoclock"], queryFn: () => robCall<RugView>("/v1/rob/rugoclock"), retry: 1, refetchInterval: 15_000 });
  const [now, setNow] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [voted, setVoted] = useState<string[]>(loadVoted);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const data = view.data;
  const online = Boolean(data?.enabled);
  const left = data ? countdown(data.nextReadingAt, now) : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["rob-rugoclock"] });

  async function drop() {
    if (!text.trim() || sending) return;
    setSending(true);
    setNotice(null);
    try {
      await robCall("/v1/rob/rugoclock/invoices", { text });
      setText("");
      setNotice({ tone: "ok", text: "Dropped on the pile. Get it voted before the hour." });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "the invoice was not taken" });
    } finally {
      setSending(false);
    }
  }

  async function vote(id: string) {
    const remember = () => setVoted((current) => {
      const next = [...new Set([...current, id])];
      saveVoted(next);
      return next;
    });
    try {
      await robCall("/v1/rob/rugoclock/vote", { invoiceId: id });
      remember();
      await refresh();
    } catch (error) {
      if ((error as { code?: string }).code === "already_voted") remember();
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "the vote was not counted" });
    }
  }

  return (
    <div style={{ border: "1px solid rgba(79,209,232,.35)", padding: 22, background: "rgba(11,110,134,.12)", display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: "6px 16px" }}>
        <b style={{ font: `800 14px ${BRAND}`, letterSpacing: ".18em", color: AEGEAN }}>RUG O'CLOCK · EVERY HOUR</b>
        <span role="timer" aria-live="off" style={{ font: `600 13px ${MONO}`, color: "#8FA2CC" }}>
          {!data ? (view.isError ? "offline" : "…") : !online ? "offline" : left ? `next reading in ${left}` : "Ruggy is reading…"}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "#C9D3EA" }}>
        Drop a poisoned invoice and vote for the nastiest. On the hour, Ruggy reads the winner with a real LLM, falls for it, tries to pay, and the vault refuses it live.
      </p>

      {view.isError || (data && !online) ? (
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "#F4A28C" }}>
          {view.isError
            ? "Rug O'Clock is not reachable right now. Try again in a minute."
            : "Offline: no LLM is connected right now, so no invoice would be read. Nothing here is simulated: the box opens when Ruggy has a real model again."}
        </p>
      ) : null}

      {online ? (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#A9B6D6" }}>Your invoice, plain text. Ruggy reads it as is.</span>
            <textarea
              rows={4}
              maxLength={MAX}
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, MAX))}
              spellCheck={false}
              placeholder={"INVOICE #4471 · Consulting, October\nPay to: …\nAmount: …"}
              style={{ font: `13px/1.6 ${MONO}`, background: "#010510", color: "#FFE2A8", border: "1px solid rgba(143,162,204,.3)", padding: 12, resize: "vertical", width: "100%", boxSizing: "border-box" }}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ font: `600 12px ${MONO}`, color: text.length >= MAX ? "#F4A28C" : "#8FA2CC" }}>{text.length} / {MAX}</span>
            <button type="button" onClick={() => void drop()} disabled={!text.trim() || sending} style={{ ...smallButton(Boolean(text.trim()) && !sending), minWidth: 0, padding: "0 20px" }}>
              {sending ? "DROPPING…" : "DROP THE INVOICE"}
            </button>
          </div>
          {notice ? <p role="status" style={{ margin: 0, fontSize: 13.5, color: notice.tone === "ok" ? AEGEAN : "#F4A28C" }}>{notice.text}</p> : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={label}>THIS HOUR'S PILE · {data!.round.length ? `TOP ${data!.round.length}` : "EMPTY"}</span>
            {data!.round.length ? (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {data!.round.map((invoice, index) => {
                  const mine = voted.includes(invoice.id);
                  return (
                    <li key={invoice.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "10px 12px", background: "rgba(1,5,16,.55)", borderLeft: `2px solid ${index === 0 ? AEGEAN : "rgba(143,162,204,.25)"}` }}>
                      <p style={{ ...plain, font: `12.5px/1.55 ${MONO}`, color: "#E7ECF6" }}>{excerpt(invoice.text, 280)}</p>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                        <button type="button" disabled={mine} onClick={() => void vote(invoice.id)} style={smallButton(!mine)} aria-label={mine ? "Voted" : `Vote for invoice ${index + 1}`}>
                          {mine ? "VOTED" : "VOTE"}
                        </button>
                        <span style={{ font: `600 12px ${MONO}`, color: "#8FA2CC" }}>{invoice.votes} {invoice.votes === 1 ? "vote" : "votes"}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p style={{ margin: 0, fontSize: 13.5, color: "#8FA2CC" }}>No invoice yet this hour. The first one in reads unless someone outvotes it.</p>
            )}
          </div>

          <LastReading last={data!.last} />
        </>
      ) : null}
    </div>
  );
}

function LastReading({ last }: { last: RugView["last"] }) {
  if (!last) {
    return (
      <div style={{ borderTop: "1px solid rgba(79,209,232,.2)", paddingTop: 12 }}>
        <span style={label}>LAST READING</span>
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "#8FA2CC" }}>None yet: the first reading is at the top of the next hour with at least one invoice.</p>
      </div>
    );
  }
  const reading = last.reading;
  const llm = reading?.llm;
  const play = reading?.play;
  const verdict = play ? VERDICT[play.verdict] ?? VERDICT.denied! : null;
  return (
    <div style={{ borderTop: "1px solid rgba(79,209,232,.2)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={label}>LAST READING · ROUND OF {hourOf(last.round)} · {last.votes} {last.votes === 1 ? "VOTE" : "VOTES"}</span>
      <blockquote style={{ ...plain, padding: "8px 12px", borderLeft: "2px solid rgba(242,181,68,.5)", font: `12.5px/1.55 ${MONO}`, color: "#C9D3EA" }}>{excerpt(last.text)}</blockquote>

      {last.state !== "done" || !reading || !llm ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "#8FA2CC" }}>{last.state === "interrupted" ? "This reading was cut short (the server restarted): nothing was sent." : "Ruggy is reading it now…"}</p>
      ) : (
        <div style={{ background: "#010510", border: "1px solid rgba(143,162,204,.2)", padding: "12px 14px", font: `12.5px/1.7 ${MONO}`, color: "#A9B6D6", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {llm.kind === "pay" ? (
            <>
              <div style={{ color: "#8FA2CC" }}>Ruggy fell for it and called</div>
              <div style={{ ...plain, color: "#FFE2A8" }}>&gt; pay({llm.receiver_id}, {llm.amount_usdc} USDC)</div>
              {reading.call ? <div style={{ ...plain, color: "#8FA2CC" }}>  reference {reading.call.reference}</div> : null}
            </>
          ) : llm.kind === "refused" ? (
            <>
              <div style={{ color: "#8FA2CC" }}>Ruggy did not call pay. He said:</div>
              <div style={{ ...plain, color: "#FFE2A8" }}>“{excerpt(llm.text, 300)}”</div>
            </>
          ) : llm.kind === "invalid" ? (
            <>
              <div style={{ color: "#8FA2CC" }}>Ruggy's tool call was malformed, so nothing was sent:</div>
              <div style={{ ...plain, color: "#FFE2A8" }}>{llm.reason}</div>
            </>
          ) : (
            <div style={{ ...plain, color: "#F4A28C" }}>No reading: {llm.message}. Nothing was sent.</div>
          )}

          {play && verdict ? (
            <>
              <div style={{ color: verdict.color, marginTop: 6 }}>
                {verdict.word}{play.refusedBy ? ` · by ${BY[play.refusedBy] ?? play.refusedBy}` : play.verdict === "paid" ? " · a lawful payment to a listed supplier (ours)" : ""}
              </div>
              {play.error ? <div style={{ ...plain, color: "#F4A28C" }}>{play.error}</div> : null}
              {play.nearblocks ? (
                <a href={play.nearblocks} target="_blank" rel="noreferrer noopener" style={{ color: AEGEAN, marginTop: 4, minHeight: 32, display: "inline-flex", alignItems: "center" }}>
                  View the transaction on nearblocks ↗
                </a>
              ) : <div style={{ color: "#8FA2CC" }}>No transaction to show: NEAR rejected it before the chain.</div>}
            </>
          ) : reading.failure ? (
            <div style={{ ...plain, color: "#F4A28C", marginTop: 6 }}>Not sent: {reading.failure}</div>
          ) : null}
          <div style={{ color: "#4A5675", marginTop: 6, fontSize: 11.5 }}>model {reading.model} · {hourOf(reading.at)}</div>
        </div>
      )}
    </div>
  );
}
