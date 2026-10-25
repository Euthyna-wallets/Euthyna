import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { chainView } from "../../lib/chain-view.js";
import { formatUnits } from "viem";

import { companyProfile, REGISTRY_ID, treasuryOf, type DirectoryEntry } from "../../lib/directory.js";

const NAVY = "#0F2A5C";
const INK = "#0F1E3D";
const MUTED = "#44557A";
const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', sans-serif";
const card: CSSProperties = { background: "#FFFFFF", color: INK, borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "16px" };
const chip = (bg: string, fg: string): CSSProperties => ({ background: bg, color: fg, borderRadius: "999px", padding: "5px 11px", fontSize: "12px", fontFamily: mono });

function Section({ title, tag, children }: { title: string; tag?: string | undefined; children: ReactNode }) {
  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontFamily: mono, fontSize: "22px", color: NAVY }}>{title}</h2>
        {tag ? <span style={{ fontFamily: mono, fontSize: "12px", color: MUTED }}>{tag}</span> : null}
      </div>
      {children}
    </section>
  );
}

const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 100 ? 2 : 0 });
const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 6 : 2 });

export function CompanyPublicPage() {
  const { dao = "" } = useParams();
  const entry = useQuery({
    queryKey: ["directory", dao],
    queryFn: () => chainView<DirectoryEntry | null>(REGISTRY_ID, "get_company", { dao_id: dao }),
  });
  const profile = useQuery({
    queryKey: ["company-profile", dao],
    queryFn: () => companyProfile(entry.data!),
    enabled: Boolean(entry.data),
  });
  const company = profile.data;
  const treasury = useQuery({
    queryKey: ["company-treasury", dao],
    queryFn: () => treasuryOf(company!),
    enabled: Boolean(company),
    refetchInterval: 60_000,
  });

  return (
    <div style={{ fontFamily: mono, color: "#F2F6FC", background: NAVY, minHeight: "100vh" }}>
      <header style={{ maxWidth: "1240px", margin: "0 auto", padding: "18px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: "10px", textDecoration: "none", color: "#F2F6FC" }}>
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M4 26V8l11-5 11 5v18" stroke="#4FD1E8" strokeWidth="2.2" strokeLinejoin="round" /><path d="M10 26v-9l5 4 5-4v9" stroke="#F2B544" strokeWidth="2.2" strokeLinejoin="round" /></svg>
          <span style={{ fontWeight: 700, fontSize: "18px" }}>MandateOS</span>
        </Link>
        <nav aria-label="Breadcrumb" style={{ fontSize: "14px", color: "#C9D6EE" }}><Link to="/#companies" style={{ color: "#4FD1E8" }}>AI companies</Link> / <span style={{ color: "#F2F6FC" }}>{entry.data?.name ?? dao}</span></nav>
        <a href="/overview" style={{ background: "#4FD1E8", color: INK, textDecoration: "none", fontSize: "14px", fontWeight: 600, padding: "12px 20px", borderRadius: "10px" }}>Open App</a>
      </header>

      <main style={{ maxWidth: "1240px", margin: "0 auto", padding: "8px 24px 64px", display: "flex", flexDirection: "column", gap: "24px" }}>
        {entry.isLoading ? <p>Reading {REGISTRY_ID}…</p> : null}
        {entry.data === null ? <p>This company is not in the public directory.</p> : null}
        {entry.error ? <p style={{ color: "#F7A99D" }}>{entry.error.message}</p> : null}
        {entry.data ? (
          <section style={{ ...card, background: "#16376F", color: "#F2F6FC", border: "1px solid rgba(201,214,238,.3)", flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: "1 1 520px", minWidth: 0 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {company ? <span style={chip(company.vaultKeys === 0 ? "#DDF4F8" : "#FBE3D6", company.vaultKeys === 0 ? "#0B5E73" : "#8A2E12")}>{company.vaultKeys === 0 ? "vault: no one holds the keys" : `vault has ${company.vaultKeys} access keys`}</span> : null}
                {company?.paused ? <span style={chip("#FBE3D6", "#8A2E12")}>paused by the council</span> : null}
                <span style={chip("rgba(255,255,255,.12)", "#C9D6EE")}>NEAR testnet</span>
              </div>
              <h1 style={{ margin: 0, fontSize: "48px", lineHeight: 1.05, letterSpacing: "-0.02em" }}>{entry.data.name}</h1>
              <p style={{ margin: 0, fontFamily: sans, fontSize: "18px", color: "#D3DEF2" }}>{entry.data.description || "No description yet."}</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px", flex: "0 1 420px", minWidth: "260px" }}>
              {[
                ["TREASURY", treasury.data?.totalUsd != null ? usd(treasury.data.totalUsd) : "…", "#F2B544"],
                ["PAID TO OWNERS", company ? (company.shares ? company.shares.distributedNear : "not yet") : "…", "#4FD1E8"],
              ].map(([label, value, color]) => (
                <div key={label} style={{ background: NAVY, borderRadius: "14px", padding: "14px 16px" }}>
                  <div style={{ fontSize: "11px", color: "#A9BCE0" }}>{label}</div>
                  <div style={{ fontSize: "20px", fontWeight: 600, marginTop: "4px", color }}>{value}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {profile.isLoading ? <p>Reading the company on NEAR…</p> : null}
        {profile.error ? <p style={{ color: "#F7A99D" }}>{profile.error.message}</p> : null}
        {company ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "24px", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 520px", minWidth: 0 }}>
              <Section title="Treasury" tag={treasury.data?.pricedAt ? "USD at market prices" : undefined}>
                {treasury.isLoading ? <p style={{ margin: 0, fontFamily: sans, color: MUTED }}>Reading balances on NEAR, Base and Ethereum…</p> : null}
                {treasury.data ? (
                  <>
                    <div style={{ fontSize: "40px", fontWeight: 700, color: NAVY }}>{treasury.data.totalUsd != null ? usd(treasury.data.totalUsd) : "price unavailable"}</div>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {treasury.data.holdings.length === 0 ? <p style={{ margin: 0, fontFamily: sans, color: MUTED }}>Nothing yet.</p> : null}
                      {treasury.data.holdings.map((holding) => (
                        <div key={`${holding.symbol}-${holding.place}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "12px 0", borderTop: "1px solid #E4EAF4" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span style={{ fontSize: "16px", fontWeight: 600 }}>{amount(holding.amount)} {holding.symbol}</span>
                            <span style={{ fontFamily: sans, fontSize: "13px", color: MUTED }}>{holding.place}</span>
                          </div>
                          <span style={{ fontSize: "15px", color: MUTED }}>{holding.usd != null ? usd(holding.usd) : ""}</span>
                        </div>
                      ))}
                    </div>
                    <p style={{ margin: 0, fontFamily: sans, fontSize: "12px", color: MUTED }}>Testnet tokens valued at mainnet prices (CoinGecko), for reference.</p>
                  </>
                ) : null}
              </Section>
            </div>
            <div style={{ flex: "1 1 420px", minWidth: 0 }}>
              <Section title="Revenue" tag={company.shares ? `shared every ${company.shares.epochHours} h` : undefined}>
                {company.shares ? (
                  <>
                    <p style={{ margin: 0, fontFamily: sans, fontSize: "15px", lineHeight: 1.6, color: MUTED }}>Paid so far to the owners who voted.</p>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderTop: "1px solid #E4EAF4" }}><span>NEAR</span><strong>{amount(Number(formatUnits(BigInt(company.shares.distributedNearRaw), 24)))}</strong></div>
                      {company.shares.revenueToken ? <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderTop: "1px solid #E4EAF4" }}><span>ETH (bridged from Base)</span><strong>{amount(Number(formatUnits(BigInt(company.shares.distributedToken), 18)))}</strong></div> : null}
                    </div>
                    <a href="/shares" style={{ textAlign: "center", background: NAVY, color: "#F2F6FC", textDecoration: "none", fontWeight: 600, padding: "14px", borderRadius: "999px" }}>Buy shares · {company.shares.priceNear}</a>
                  </>
                ) : <p style={{ margin: 0, fontFamily: sans, fontSize: "15px", lineHeight: 1.6, color: MUTED }}>This company has not issued shares yet, so it shares no revenue.</p>}
              </Section>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
