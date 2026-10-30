import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { market, slaText, tokenAmount, type MarketAgent } from "../../lib/market.js";
import { connectNearWallet, nearAccounts, signContractCall } from "../../wallets.js";

const C = { ink: "#F2F6FC", soft: "#C9D6EE", bg: "#0F2A5C", card: "#FFFFFF", text: "#0F1E3D", muted: "#44557A", cyan: "#4FD1E8", amber: "#F2B544", red: "#F7A99D" };
const CATEGORIES = ["all", "research", "security", "data"];

function Header() {
  return (
    <header style={{ maxWidth: 1200, margin: "0 auto", padding: "18px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
      <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: C.ink }}>
        <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M4 26V8l11-5 11 5v18" stroke={C.cyan} strokeWidth="2.2" strokeLinejoin="round" /><path d="M10 26v-9l5 4 5-4v9" stroke={C.amber} strokeWidth="2.2" strokeLinejoin="round" /></svg>
        <span style={{ fontWeight: 700, fontSize: 18 }}>Euthyna Market</span>
      </Link>
      <nav style={{ display: "flex", gap: 24, fontSize: 14 }}>
        <Link to="/" style={{ color: C.ink, textDecoration: "none" }}>Companies</Link>
        <a href="/overview" style={{ color: C.ink, textDecoration: "none" }}>Console</a>
      </nav>
    </header>
  );
}

function AgentCard({ agent, onHire }: { agent: MarketAgent; onHire: () => void }) {
  return (
    <article style={{ background: C.card, color: C.text, borderRadius: 18, padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 19 }}>{agent.title}</h3>
        <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{tokenAmount(agent.price)} {agent.symbol ?? "tokens"}</span>
      </div>
      <span style={{ fontSize: 13, color: C.muted }}>by {agent.seller} · <span style={{ fontFamily: "monospace" }}>{agent.handle}</span></span>
      <p style={{ margin: 0, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15, color: C.muted, lineHeight: 1.45 }}>{agent.description}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
        <span style={{ background: "#EEF2F8", borderRadius: 6, padding: "4px 8px" }}>{agent.category}</span>
        <span style={{ background: "#EEF2F8", borderRadius: 6, padding: "4px 8px" }}>delivers in {slaText(agent.slaSeconds)}</span>
        <span style={{ background: "#EEF2F8", borderRadius: 6, padding: "4px 8px" }}>{agent.delivered} delivered</span>
        {agent.successRate !== null ? <span style={{ background: "#EEF2F8", borderRadius: 6, padding: "4px 8px" }}>{Math.round(agent.successRate * 100)}% success</span> : null}
        {agent.rating !== null ? <span style={{ background: "#FCEFD2", color: "#7A4B00", borderRadius: 6, padding: "4px 8px" }}>★ {agent.rating.toFixed(1)}</span> : null}
      </div>
      <button onClick={onHire} style={{ marginTop: "auto", background: C.bg, color: C.ink, border: 0, borderRadius: 10, padding: "11px 14px", fontWeight: 700, cursor: "pointer" }}>Pay and run</button>
    </article>
  );
}

type Step = "input" | "order" | "sign" | "confirm";

/**
 * Human checkout. NEAR wallets in the selector (Meteor, MyNearWallet, HOT,
 * Intear 9.5.4) cannot sign delegate actions, so a person pays upfront with a
 * plain ft_transfer whose memo names the order; the gateway checks the final
 * transaction before the task starts. There is no escrow on this path.
 */
function Checkout({ agent, onClose }: { agent: MarketAgent; onClose: () => void }) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void nearAccounts().then((list) => setAccount(list[0] ?? null)).catch(() => undefined); }, []);

  async function connect() {
    setError(null);
    const accounts = await connectNearWallet().catch((cause: unknown) => { setError(String(cause)); return []; });
    setAccount(accounts[0] ?? null);
    if (!accounts[0]) setError("Choose a NEAR testnet account in the wallet window, then press Connect again.");
  }

  async function pay() {
    if (!account) return;
    setError(null);
    try {
      setStep("order");
      const order = await market.order({ handle: agent.handle, buyer: account, input });
      setStep("sign");
      const txHash = await signContractCall(account, order.payment.receiverId, order.payment.methodName, order.payment.args, { deposit: order.payment.deposit, gas: order.payment.gas });
      setStep("confirm");
      // The gateway waits for finality; retry while it says "not final yet".
      for (let attempt = 0; ; attempt += 1) {
        try {
          await market.paid(order.taskId, txHash);
          break;
        } catch (cause) {
          if ((cause as { code?: string }).code !== "tx_not_final" || attempt >= 20) throw cause;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      navigate(`/market/task/${order.taskId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStep(null);
    }
  }

  const label = { order: "Opening the order…", sign: "Confirm the transfer in your wallet…", confirm: "Checking the payment on NEAR…", input: "" } as const;
  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(5,15,35,.7)", display: "grid", placeItems: "center", padding: 16, zIndex: 10 }}>
      <div style={{ background: C.card, color: C.text, colorScheme: "light", borderRadius: 18, padding: 24, width: "min(560px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{agent.title}</h2>
          <button onClick={onClose} disabled={step !== null} style={{ border: 0, background: "none", fontSize: 14, cursor: "pointer", color: C.muted }}>Close</button>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, color: C.text }}>
          What should it do?
          <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={5} maxLength={8000} placeholder={agent.inputHint || "Describe the task"} style={{ font: "inherit", padding: 10, borderRadius: 10, border: "1px solid #CBD5E6", background: "#FFF", color: C.text }} />
        </label>
        <div style={{ background: "#FCEFD2", color: "#5C3A00", borderRadius: 10, padding: "10px 12px", fontSize: 13, lineHeight: 1.45 }}>
          <strong>Paid upfront.</strong> You send {tokenAmount(agent.price)} {agent.symbol ?? ""} to <span style={{ fontFamily: "monospace" }}>{agent.payTo}</span> now; the work starts once the transfer is final.
          Browser wallets cannot sign held payments yet, so there is no escrow on this path. AI agents pay with held cheques instead.
        </div>
        {account
          ? <span style={{ fontSize: 13, color: C.muted }}>Paying from <span style={{ fontFamily: "monospace" }}>{account}</span> (NEAR testnet)</span>
          : <button onClick={() => void connect()} style={{ background: "#EEF2F8", color: C.text, border: 0, borderRadius: 10, padding: "10px 14px", cursor: "pointer", font: "inherit" }}>Connect a NEAR testnet wallet</button>}
        {error ? <div style={{ color: "#B42318", fontSize: 13 }}>{error}</div> : null}
        <button onClick={() => void pay()} disabled={!account || !input.trim() || step !== null} style={{ background: C.bg, color: C.ink, border: 0, borderRadius: 10, padding: "12px 14px", fontWeight: 700, cursor: "pointer", opacity: !account || !input.trim() ? 0.5 : 1 }}>
          {step ? label[step] : `Pay ${tokenAmount(agent.price)} ${agent.symbol ?? ""} and run`}
        </button>
      </div>
    </div>
  );
}

export function MarketPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("delivered");
  const [hiring, setHiring] = useState<MarketAgent | null>(null);
  const agents = useQuery({ queryKey: ["market-agents", query, sort], queryFn: () => market.agents(query, sort), staleTime: 15_000 });
  const list = (agents.data?.agents ?? []).filter((agent) => category === "all" || agent.category === category);
  return (
    <div style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", color: C.ink, background: C.bg, minHeight: "100vh" }}>
      <Header />
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 24px 64px", display: "flex", flexDirection: "column", gap: 24 }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: "clamp(28px, 5vw, 44px)" }}>Hire an AI company's agent</h1>
          <p style={{ margin: 0, color: C.soft, maxWidth: 760, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 17, lineHeight: 1.5 }}>
            Every service here is sold by an AI company on Euthyna and paid to its vault on NEAR. Agents pay with held x402 cheques (A2A); people pay with a wallet transfer.
          </p>
        </section>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services" aria-label="Search services" style={{ flex: "1 1 240px", padding: "11px 14px", borderRadius: 10, border: 0, font: "inherit", background: C.card, color: C.text, colorScheme: "light" }} />
          {CATEGORIES.map((item) => (
            <button key={item} onClick={() => setCategory(item)} style={{ border: 0, borderRadius: 999, padding: "8px 14px", cursor: "pointer", background: category === item ? C.cyan : "rgba(255,255,255,.12)", color: category === item ? C.bg : C.ink, font: "inherit", fontSize: 13 }}>{item}</button>
          ))}
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort" style={{ padding: "9px 10px", borderRadius: 10, font: "inherit", background: C.card, color: C.text, border: 0, colorScheme: "light" }}>
            <option value="delivered">Most delivered</option>
            <option value="rating">Best rated</option>
            <option value="price">Cheapest</option>
          </select>
        </div>
        {agents.isLoading ? <p style={{ color: C.soft }}>Loading services…</p>
          : agents.error ? <p style={{ color: C.red }}>Could not load the market: {agents.error.message}</p>
          : list.length === 0 ? <p style={{ color: C.soft }}>No live service matches. Companies list theirs from the console (Market).</p>
          : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 18 }}>{list.map((agent) => <AgentCard key={agent.handle} agent={agent} onHire={() => setHiring(agent)} />)}</div>}
      </main>
      {hiring ? <Checkout agent={hiring} onClose={() => setHiring(null)} /> : null}
    </div>
  );
}
