/**
 * « Can't rob him? Hire him. »: buy Ruggy's real service on the Euthyna Market for 1 TestUSDC, from the same
 * throwaway key. Handoff: rob-the-agent.html, section HIRE HIM.
 *
 * The browser does what any buyer agent does (x402 + NEP-366): reads the 402 from the A2A endpoint, signs one
 * ft_transfer as a delegate action with the throwaway key (`@euthyna/sdk/cheque`, the builder the API tests
 * against its own cheque checks), and sends the task with the cheque. The gateway holds it; the API delivers
 * Ruggy's check; the market relayer cashes the cheque. The receipt shows the task's and the hold's real states.
 * API: /v1/rob/hire/* (apps/api/src/rob/hire.ts), /a2a/<handle>/v1, /v1/market/tasks/<id>.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { signCheque, type ChequeRequirement } from "@euthyna/sdk/cheque";

import { API_BASE } from "../../../api.js";
import { Markdown } from "../../../lib/markdown.js";
import { market, tokenAmount, type MarketTaskView } from "../../../lib/market.js";
import { attackerOf, BRAND, type Deck, keyPairOf, MONO, robCall, type Throwaway } from "./shared.js";

/** The most the player agreed to pay: the button says 1 TestUSDC. */
const CAP_ATOMIC = 1_000_000n;
const TASK_STORE = "rob.hire.task";
/** A transaction to check: an unlimited USDC approval on Base Sepolia, the classic drainer step. */
const SAMPLE = JSON.stringify({
  chainId: 84532,
  to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  data: "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  value: "0",
}, null, 2);

type Terms = { handle: string; a2a: string; account: string; vault: string; token: string; price: string; nonce: string | null; blockHeight: string; balance: string; toppedUp: boolean };
type StepState = "todo" | "active" | "done" | "failed";
type Receipt = { rule: StepState; held: StepState; delivered: StepState; paid: StepState };
const IDLE: Receipt = { rule: "todo", held: "todo", delivered: "todo", paid: "todo" };

/** The four steps, from the task's and the hold's states as the gateway reports them. */
function receiptOf(task: MarketTaskView): Receipt {
  const state = task.status.state;
  const hold = task.metadata.payment?.state ?? null;
  const failed = state === "TASK_STATE_FAILED";
  // The gateway stores the result before it claims the hold: settling or later means delivered.
  const delivered = state === "TASK_STATE_COMPLETED" || hold === "settling" || hold === "settled";
  return {
    rule: "done",
    held: hold ? "done" : "active",
    delivered: failed ? "failed" : delivered ? "done" : "active",
    paid: hold === "settled" ? "done" : task.metadata.unpaid || hold === "failed" || failed ? "failed" : delivered ? "active" : "todo",
  };
}

function saveTask(publicKey: string, taskId: string) {
  try {
    localStorage.setItem(TASK_STORE, JSON.stringify({ publicKey, taskId }));
  } catch { /* fine */ }
}
function savedTask(publicKey: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(TASK_STORE) ?? "null") as { publicKey: string; taskId: string } | null;
    return saved?.publicKey === publicKey ? saved.taskId : null;
  } catch {
    return null;
  }
}

async function a2a(path: string, body: unknown, payment?: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(payment ? { "x-payment": payment } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const sendMessage = (text: string) => ({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "user", parts: [{ kind: "text", text }] } } });

export function RobHire({ throwaway, deck }: { throwaway: Throwaway | null; deck: Deck | null }) {
  const [input, setInput] = useState(SAMPLE);
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const [steps, setSteps] = useState<Receipt>(IDLE);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  // A purchase made earlier with this key: show its receipt again.
  useEffect(() => {
    if (!throwaway || taskId) return;
    const saved = savedTask(throwaway.publicKey);
    if (saved) setTaskId(saved);
  }, [throwaway, taskId]);

  const task = useQuery({
    queryKey: ["rob-hire-task", taskId],
    queryFn: () => market.task(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const view = query.state.data?.task;
      if (!view) return 2_000;
      const finished = view.status.state === "TASK_STATE_FAILED" || (view.status.state === "TASK_STATE_COMPLETED" && view.metadata.payment?.state !== "settling");
      return finished ? false : 2_000;
    },
  });
  const view = task.data?.task ?? null;
  useEffect(() => {
    if (!view) return;
    setHandle(view.handle);
    setSteps(receiptOf(view));
    if (view.status.state === "TASK_STATE_FAILED") {
      setPhase("error");
      setNote(view.status.message ? `Ruggy could not check it: ${view.status.message}. Nothing was charged.` : "The task failed. Nothing was charged.");
    } else if (view.status.state === "TASK_STATE_COMPLETED") {
      setPhase("done");
      setNote(view.metadata.unpaid ? "Delivered, but the cheque could not be cashed: the report is withheld." : null);
    }
  }, [view]);

  const seller = useQuery({
    queryKey: ["rob-hire-seller", handle],
    queryFn: () => market.agents(handle!),
    enabled: Boolean(handle),
    staleTime: 300_000,
    select: (data) => data.agents.find((agent) => agent.handle === handle)?.seller ?? null,
  });

  async function hire() {
    if (!throwaway || phase === "busy") return;
    setPhase("busy");
    setNote(null);
    setSteps({ ...IDLE, rule: "active" });
    setTaskId(null);
    const fail = (message: string, at: Partial<Receipt> = {}) => {
      setPhase("error");
      setNote(message);
      setSteps((current) => ({ ...current, ...at }));
    };
    try {
      const publicKey = throwaway.publicKey;
      // 1. Test USDC on the throwaway key's own account (once per player), then its nonce.
      let terms = await robCall<Terms>("/v1/rob/hire/terms", { publicKey });
      setHandle(terms.handle);
      if (BigInt(terms.balance) < BigInt(terms.price)) {
        if (terms.toppedUp) return fail("Your test USDC is already spent: one top-up per player.", { rule: "failed" });
        setNote("Topping up your throwaway key with 1 test USDC…");
        await robCall("/v1/rob/hire/topup", { publicKey });
        terms = await robCall<Terms>("/v1/rob/hire/terms", { publicKey });
      }
      // A new account, and its test USDC, take a block or two to be final: the market reads the balance there.
      for (let attempt = 0; terms.nonce === null || BigInt(terms.balance) < BigInt(terms.price); attempt += 1) {
        if (attempt >= 10) throw new Error("your account is not visible on NEAR yet: try again in a few seconds");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        terms = await robCall<Terms>("/v1/rob/hire/terms", { publicKey });
      }
      // 2. The price, from the seller's 402, checked against what you agreed to before anything is signed.
      setNote("Reading Ruggy's price…");
      const quote = await a2a(terms.a2a, sendMessage(input));
      const requirement = (quote.body.accepts as ChequeRequirement[] | undefined)?.[0];
      if (quote.status !== 402 || !requirement) {
        const message = (quote.body.error as { message?: string } | undefined)?.message;
        return fail(message ? `The market answered: ${message}` : `The market did not ask for a payment (HTTP ${quote.status}).`, { rule: "failed" });
      }
      const vault = deck?.vault ?? terms.vault;
      const token = deck?.token ?? terms.token;
      if (requirement.asset !== token || requirement.payTo !== vault || !/^\d+$/.test(requirement.amount) || BigInt(requirement.amount) > CAP_ATOMIC) {
        return fail(`Refused before signing: Ruggy asks ${requirement.amount} of ${requirement.asset} to ${requirement.payTo}; you agreed to at most 1 TestUSDC to ${vault}.`, { rule: "failed" });
      }
      setSteps({ ...IDLE, rule: "done", held: "active" });
      // 3. The cheque: one ft_transfer to the vault, signed in this browser, held by the market.
      setNote("Signing the cheque with your throwaway key…");
      const pair = keyPairOf(throwaway);
      const cheque = await signCheque({
        requirement, senderId: attackerOf(publicKey), publicKey, accessKeyNonce: terms.nonce!, blockHeight: terms.blockHeight,
        sign: (hash) => pair.sign(hash).signature,
      });
      setNote("Cheque sent. Ruggy is checking your transaction…");
      const sent = await a2a(terms.a2a, sendMessage(input), cheque.header);
      if (sent.status === 402) return fail(`The market refused the cheque: ${String(sent.body.error ?? "")}`, { held: "failed" });
      const result = sent.body.result as { id?: string } | undefined;
      if (sent.status !== 200 || !result?.id) {
        const message = (sent.body.error as { message?: string } | undefined)?.message;
        return fail(message ? `The market answered: ${message}` : `The market answered HTTP ${sent.status}.`, { held: "failed" });
      }
      if (cancelled.current) return;
      saveTask(publicKey, result.id);
      setTaskId(result.id);
      setNote(null);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      setSteps((current) => ({ ...current, ...(current.rule === "active" ? { rule: "failed" as const } : {}) }));
    }
  }

  const payment = view?.metadata.payment ?? null;
  const report = view?.artifacts[0]?.parts.find((part) => part.text)?.text ?? null;
  const paidAmount = payment ? `${Number(tokenAmount(payment.amount)).toFixed(2)} TestUSDC` : "1.00 TestUSDC";
  const settled = payment?.settleTxHash ?? null;
  const finished = view !== null && (view.status.state === "TASK_STATE_FAILED" || (view.status.state === "TASK_STATE_COMPLETED" && payment?.state !== "settling"));
  const busy = phase === "busy" || (Boolean(taskId) && !finished);
  // Paid: the top-up is spent (one per player). Failed or refused: the test USDC is still there, try again.
  const hired = payment?.state === "settled";

  return (
    <section id="hire" className="marblelit" style={{ padding: "80px 0", color: "#0D1730" }}>
      <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, .9fr) minmax(0, 1.1fr)", gap: 56, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <span className="kick" style={{ color: "#8A5A00" }}>Euthyna Market · under 2 minutes</span>
          <h2 className="carved" style={{ margin: 0, font: `900 clamp(34px,4.2vw,58px)/1.02 ${BRAND}`, letterSpacing: ".04em" }}>
            CAN'T ROB HIM?
            <br />
            HIRE HIM.
          </h2>
          <p style={{ margin: 0, fontSize: 17, lineHeight: 1.6, color: "#4A5675" }}>
            Ruggy sells one service: he checks a transaction before you sign it. Pay 1 TestUSDC from the same throwaway key. Your cheque is
            held, and released only when the work is delivered.
          </p>
          <details style={{ borderTop: "1px solid rgba(13,23,48,.14)", paddingTop: 8 }}>
            <summary style={{ cursor: "pointer", font: `800 12px ${BRAND}`, letterSpacing: ".2em", color: "#4A5675", minHeight: 44, display: "flex", alignItems: "center" }}>
              THE TRANSACTION TO CHECK
            </summary>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: 13, color: "#4A5675" }}>Any EVM call, as JSON: chainId, to, data, value. This one is an unlimited USDC approval on Base Sepolia.</span>
              <textarea
                rows={7}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                spellCheck={false}
                style={{ font: `12.5px/1.6 ${MONO}`, background: "#FBF9F4", color: "#0D1730", border: "1px solid rgba(13,23,48,.2)", padding: 12, resize: "vertical", width: "100%", boxSizing: "border-box" }}
              />
            </label>
          </details>
          <button type="button" className="rbtn ori" style={{ alignSelf: "flex-start" }} onClick={() => void hire()} disabled={!throwaway || busy || hired}>
            {busy ? "HIRING RUGGY…" : hired ? "RUGGY HIRED · PAID ON DELIVERY" : "HIRE RUGGY · 1 TESTUSDC"}
          </button>
          <small style={{ color: "#4A5675" }}>We top up your throwaway key with test USDC. One top-up per player.</small>
          {note ? (
            <p role="status" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: phase === "error" ? "#A8381E" : "#4A5675" }}>{note}</p>
          ) : null}
        </div>

        <div aria-live="polite" style={{ background: "#FBF9F4", border: "1px solid rgba(13,23,48,.14)", boxShadow: "24px 30px 60px rgba(13,23,48,.22)", padding: "26px 28px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <b style={{ font: `800 15px ${BRAND}`, letterSpacing: ".2em" }}>RECEIPT</b>
            <span style={{ font: `600 12px ${MONO}`, color: "#4A5675" }}>task · {taskId ? taskId.slice(0, 8) : "tx-check"}</span>
          </div>
          <div className="g4 steps4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            <Step n="1 · RULE" text="Price fits your law" state={steps.rule} />
            <Step n="2 · HELD" text="Cheque signed, not cashed" state={steps.held} />
            <Step n="3 · DELIVERED" text="Ruggy returns the check" state={steps.delivered} />
            <Step n="4 · PAID" text="Cheque cashed on delivery" state={steps.paid} />
          </div>
          <div style={{ font: `13px/1.8 ${MONO}`, color: "#4A5675", borderTop: "1px dashed rgba(13,23,48,.25)", paddingTop: 12 }}>
            <Row label="Seller"><b style={{ color: "#0D1730" }}>ruggy · {seller.data ?? "Rob the Agent Co."}</b></Row>
            <Row label="Paid"><b style={{ color: "#0D1730" }}>{payment?.state === "settled" ? paidAmount : steps.held === "done" ? `${paidAmount} held` : "—"}</b></Row>
            <Row label="Gas paid by you"><b style={{ color: "#0D1730" }}>0</b></Row>
            <Row label="Settlement">
              {settled ? (
                <a href={`https://testnet.nearblocks.io/txns/${settled}`} target="_blank" rel="noreferrer" style={{ color: "#0B6E86", fontWeight: 700 }}>nearblocks →</a>
              ) : (
                <b style={{ color: "#0D1730" }}>{steps.paid === "failed" ? "not cashed" : "—"}</b>
              )}
            </Row>
          </div>
          {report && payment?.state === "settled" ? (
            <details open style={{ borderTop: "1px dashed rgba(13,23,48,.25)", paddingTop: 10 }}>
              <summary style={{ cursor: "pointer", font: `800 12px ${BRAND}`, letterSpacing: ".2em", minHeight: 36, display: "flex", alignItems: "center" }}>RUGGY'S REPORT</summary>
              <div style={{ fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere", maxHeight: 360, overflowY: "auto" }}>
                <Markdown source={report} />
              </div>
              {taskId ? <a href={`/market/task/${taskId}`} style={{ fontSize: 13, color: "#0B6E86", fontWeight: 700 }}>Open the task on the Market →</a> : null}
            </details>
          ) : null}
          <p style={{ margin: 0, padding: "12px 14px", background: "#FCF0D4", fontSize: 14, color: "#8A5A00" }}>
            <b>Too pricey?</b> Ask for less. Ruggy answers with a counter-offer inside his law, valid 60 seconds.{" "}
            <a href="#arena" style={{ color: "#8A5A00", fontWeight: 700 }}>Play the Bribe Ruggy card →</a>
          </p>
        </div>
      </div>
    </section>
  );
}

const TONE: Record<StepState, { border: string; label: string; text: string }> = {
  todo: { border: "rgba(13,23,48,.2)", label: "#8E8473", text: "#8E8473" },
  active: { border: "#C9890C", label: "#8A5A00", text: "#0D1730" },
  done: { border: "#0B6E86", label: "#0B6E86", text: "#0D1730" },
  failed: { border: "#A8381E", label: "#A8381E", text: "#A8381E" },
};

function Step({ n, text, state }: { n: string; text: string; state: StepState }) {
  const tone = TONE[state];
  return (
    <div data-state={state} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "18px 18px 18px 0", borderTop: `2px solid ${tone.border}`, minWidth: 0 }}>
      <b style={{ font: `800 11px ${BRAND}`, letterSpacing: ".16em", color: tone.label }}>{n}{state === "active" ? " …" : state === "failed" ? " ✕" : ""}</b>
      <span style={{ fontSize: 13.5, color: tone.text }}>{text}</span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span>{label}</span>
      {children}
    </div>
  );
}
