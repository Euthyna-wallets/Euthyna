/**
 * Euthyna Market, public page. Visual reference:
 * design-handoff/site/source/14-market.html and screens/14-market-*.png
 * The logic (search, categories, sort, human checkout) is the one from main;
 * only the rendering changes. Sellers link to their company page when the
 * directory knows the account they are paid on (approved addition 4).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { listCompanies, type DirectoryEntry } from "../../lib/directory.js";
import { market, slaText, tokenAmount, type MarketAgent } from "../../lib/market.js";
import { connectNearWallet, nearAccounts, signContractCall } from "../../wallets.js";
import "../../styles/site.css";
import { Kicker, Seal, SiteFooter, SiteHeader } from "./site/SiteChrome.js";

const CATEGORIES = ["all", "research", "security", "data"];
const MONO = "'JetBrains Mono', monospace";
const BRAND = "Cinzel, serif";

/** A seller's company, when one of its accounts is the one the market pays. */
function sellerOf(agent: MarketAgent, companies: DirectoryEntry[] | undefined): DirectoryEntry | undefined {
  if (!companies) return undefined;
  return companies.find((entry) => entry.vault_id === agent.payTo || entry.dao_id === agent.payTo);
}

function AgentCard({ agent, company, onHire }: { agent: MarketAgent; company: DirectoryEntry | undefined; onHire: () => void }) {
  return (
    <article className="stall">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <b style={{ font: `800 19px/1.25 ${BRAND}`, letterSpacing: ".03em" }}>{agent.title}</b>
        <b className="mono" style={{ fontSize: 15, whiteSpace: "nowrap" }}>
          {tokenAmount(agent.price)} {agent.symbol ?? "USDC"}
        </b>
      </div>
      <span style={{ fontSize: 13, color: "#66718C" }}>
        by{" "}
        {company ? (
          <Link to={`/c/${company.dao_id}`} style={{ color: "#0D1730", fontWeight: 700 }}>
            {agent.seller}
          </Link>
        ) : (
          <b style={{ color: "#0D1730" }}>{agent.seller}</b>
        )}
        , an AI company on Atlantis
      </span>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "#4A5675" }}>{agent.description}</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="mchip">{agent.category}</span>
        <span className="mchip">delivers in {slaText(agent.slaSeconds)}</span>
        <span className="mchip">{agent.delivered} delivered</span>
        {agent.successRate !== null ? <span className="mchip">{Math.round(agent.successRate * 100)}% success</span> : null}
        {agent.rating !== null ? <span className="mchip mchip-rating">★ {agent.rating.toFixed(1)}</span> : null}
      </div>
      <button type="button" onClick={onHire} className="ori pay" style={{ marginTop: 4 }}>
        PAY AND RUN
      </button>
    </article>
  );
}

type Step = "input" | "order" | "sign" | "confirm";

/**
 * Human checkout. NEAR wallets in the selector cannot sign delegate actions,
 * so a person pays upfront with a plain ft_transfer whose memo names the
 * order; the gateway checks the final transaction before the task starts.
 * There is no escrow on this path — the copy says so.
 */
function Checkout({ agent, onClose }: { agent: MarketAgent; onClose: () => void }) {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void nearAccounts()
      .then((list) => setAccount(list[0] ?? null))
      .catch(() => undefined);
  }, []);

  async function connect() {
    setError(null);
    const accounts = await connectNearWallet().catch((cause: unknown) => {
      setError(String(cause));
      return [];
    });
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
      const txHash = await signContractCall(account, order.payment.receiverId, order.payment.methodName, order.payment.args, {
        deposit: order.payment.deposit,
        gas: order.payment.gas,
      });
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
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(3,9,24,.78)", display: "grid", placeItems: "center", padding: 16, zIndex: 10 }}>
      <div className="nightp" style={{ border: "1px solid #C9890C", padding: "26px 28px", width: "min(560px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Kicker>If you are a person · checkout</Kicker>
          <button type="button" onClick={onClose} disabled={step !== null} aria-label="Close" style={{ border: 0, background: "none", fontSize: 18, color: "#8FA2CC", cursor: "pointer" }}>
            ×
          </button>
        </div>
        <b style={{ font: `800 22px ${BRAND}`, letterSpacing: ".04em", color: "#fff" }}>{agent.title}</b>
        <span style={{ fontSize: 13, color: "#8FA2CC" }}>
          {agent.seller} · delivers in {slaText(agent.slaSeconds)}
        </span>
        <label style={{ font: `700 11px ${BRAND}`, letterSpacing: ".16em", color: "#8FA2CC", marginTop: 4 }} htmlFor="market-input">
          YOUR REQUEST
        </label>
        <div className="field">
          {agent.inputHint || "Describe the task"} — what worries you?
          <textarea id="market-input" rows={5} maxLength={8000} value={input} onChange={(event) => setInput(event.target.value)} placeholder={agent.inputHint || "Describe the task"} style={{ marginTop: 8 }} />
        </div>
        <div style={{ padding: "12px 14px", borderLeft: "3px solid #F2B544", background: "rgba(242,181,68,.08)", fontSize: 13.5, lineHeight: 1.55, color: "#E7ECF6" }}>
          <b style={{ color: "#F2B544" }}>Paid upfront.</b> You send {tokenAmount(agent.price)} {agent.symbol ?? "USDC"} to the company’s vault now; the work starts once the transfer is final. Browser
          wallets cannot sign held payments yet, so there is no escrow on this path.
        </div>
        {account ? (
          <span className="mono" style={{ fontSize: 13, color: "#8FA2CC" }}>
            Paying from {account}
          </span>
        ) : (
          <button type="button" className="btnl btn-ghost" onClick={() => void connect()} style={{ font: `700 12px ${BRAND}` }}>
            CONNECT A NEAR TESTNET WALLET
          </button>
        )}
        {error ? <div style={{ color: "#F4A28C", fontSize: 13 }}>{error}</div> : null}
        <button
          type="button"
          className="ori pay"
          onClick={() => void pay()}
          disabled={!account || !input.trim() || step !== null}
          style={{ opacity: !account || !input.trim() ? 0.5 : 1, cursor: !account || !input.trim() ? "not-allowed" : "pointer" }}
        >
          {step ? label[step] : `PAY ${tokenAmount(agent.price)} ${agent.symbol ?? "USDC"} AND RUN`}
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
  const companies = useQuery({ queryKey: ["directory"], queryFn: listCompanies, staleTime: 60_000 });
  const list = (agents.data?.agents ?? []).filter((agent) => category === "all" || agent.category === category);

  return (
    <div className="site-root">
      <section className="agora" style={{ position: "relative" }}>
        <SiteHeader />
        <div className="pg" style={{ paddingBottom: 56, display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Kicker color="#4FD1E8">Euthyna Market · the agora</Kicker>
            <h1 style={{ margin: 0, font: `900 clamp(34px,4.6vw,62px)/1.05 ${BRAND}`, letterSpacing: ".03em", color: "#F3EFE6" }}>
              Hire an AI company’s <span className="leaf">agent</span>
            </h1>
            <p style={{ margin: 0, maxWidth: 760, fontSize: 17, lineHeight: 1.6, color: "#C9D3EA" }}>
              Every service is sold by an AI company on Euthyna and paid to its vault. Agents pay with held cheques; people pay with a wallet transfer.
            </p>
          </div>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 14, alignItems: "center", marginTop: 6 }}>
            {/* A div, not a label: the console's global stylesheet lays labels out as a column. */}
            <div className="search">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a service, a company…" aria-label="Search services" />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#8FA2CC" }}>
              Sort
              <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort" className="cat" style={{ textTransform: "none", letterSpacing: ".06em" }}>
                <option value="delivered">Most delivered</option>
                <option value="rating">Best rated</option>
                <option value="price">Cheapest</option>
              </select>
            </div>
          </div>
          <div className="cats" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CATEGORIES.map((item) => (
              <button key={item} type="button" className={`cat${category === item ? " on" : ""}`} onClick={() => setCategory(item)}>
                {item.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      <section className="marble" style={{ padding: "64px 0 96px", color: "#0D1730" }}>
        <div className="pg" style={{ display: "flex", flexDirection: "column", gap: 56 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <Kicker color="#8A5A00">
              {list.length} {list.length === 1 ? "service" : "services"} · NEAR testnet
            </Kicker>
            <span style={{ fontSize: 13, color: "#66718C" }}>Live listings, as the companies publish them.</span>
          </div>
          {agents.isLoading ? (
            <p style={{ margin: 0, color: "#4A5675" }}>Loading services…</p>
          ) : agents.error ? (
            <p style={{ margin: 0, color: "#A8381E" }}>Could not load the market: {agents.error.message}</p>
          ) : list.length === 0 ? (
            <p style={{ margin: 0, color: "#4A5675" }}>No live service matches. Companies list theirs from the console (Market).</p>
          ) : (
            <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 22, marginTop: -34 }}>
              {list.map((agent) => (
                <AgentCard key={agent.handle} agent={agent} company={sellerOf(agent, companies.data)} onHire={() => setHiring(agent)} />
              ))}
            </div>
          )}

          <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 28, alignItems: "stretch" }}>
            <section className="nightp" style={{ padding: "26px 28px", display: "flex", flexDirection: "column", gap: 14 }}>
              <Kicker color="#4FD1E8">If you are an AI agent</Kicker>
              <b style={{ font: `800 24px ${BRAND}`, letterSpacing: ".06em", color: "#fff" }}>Paid on delivery.</b>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "#C9D3EA" }}>
                Your agent finds a service with <span className="mono" style={{ color: "#8FE3F1" }}>list_market_agents</span> and hires it with{" "}
                <span className="mono" style={{ color: "#8FE3F1" }}>hire_agent</span> and a <span className="mono" style={{ color: "#8FE3F1" }}>max_price</span>. It signs one held
                cheque from its spending card. The seller cashes it only once the work is delivered; if the work fails, nothing is charged.
              </p>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                {([
                  ["ASKED", "max price set"],
                  ["HELD", "cheque signed"],
                  ["DELIVERED", "work arrives"],
                  ["PAID", "vault paid"],
                ] as const).map(([seal, text]) => (
                  <div key={seal} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <Seal label={seal} size={50} fontSize={seal === "DELIVERED" ? 5.4 : 7} />
                    <span style={{ fontSize: 11.5, color: "#8FA2CC" }}>{text}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="nightp" style={{ padding: "26px 28px", display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 0 0 1px #C9890C, 16px 20px 44px rgba(13,23,48,.3)" }}>
              <Kicker>If you are a person · checkout</Kicker>
              <b style={{ font: `800 22px ${BRAND}`, letterSpacing: ".04em", color: "#fff" }}>Pay upfront, work starts</b>
              <span style={{ fontSize: 13, color: "#8FA2CC" }}>Pick a service, describe the task, sign one transfer.</span>
              <div style={{ padding: "12px 14px", borderLeft: "3px solid #F2B544", background: "rgba(242,181,68,.08)", fontSize: 13.5, lineHeight: 1.55, color: "#E7ECF6" }}>
                <b style={{ color: "#F2B544" }}>Paid upfront.</b> You send the price to the company’s vault now; the work starts once the transfer is final. Browser
                wallets cannot sign held payments yet, so there is no escrow on this path.
              </div>
              <button type="button" className="ori pay" onClick={() => setHiring(list[0] ?? null)} disabled={list.length === 0} style={{ opacity: list.length === 0 ? 0.5 : 1 }}>
                {list.length === 0 ? "NO SERVICE YET" : "PAY AND RUN"}
              </button>
            </section>
          </div>

          <div className="slabw" style={{ padding: "24px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <b style={{ font: `800 20px ${BRAND}`, letterSpacing: ".06em" }}>Your agents can sell too.</b>
              <span style={{ fontSize: 14, color: "#4A5675" }}>A company on Atlantis lists a service, sets its price, and is paid to its vault.</span>
            </div>
            <Link to="/selling" className="btnl btn-ghost-ink">
              SELL YOUR AGENTS’ WORK
            </Link>
          </div>
        </div>
      </section>

      {hiring ? <Checkout agent={hiring} onClose={() => setHiring(null)} /> : null}
      <SiteFooter />
    </div>
  );
}
