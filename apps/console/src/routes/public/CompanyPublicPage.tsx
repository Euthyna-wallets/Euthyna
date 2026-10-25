import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { chainView } from "../../lib/chain-view.js";
import { companyProfile, REGISTRY_ID, type DirectoryEntry, type Employee } from "../../lib/directory.js";

const NAVY = "#0F2A5C";
const INK = "#0F1E3D";
const MUTED = "#44557A";
const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', sans-serif";
const card: CSSProperties = { background: "#FFFFFF", color: INK, borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "16px" };
const chip = (bg: string, fg: string): CSSProperties => ({ background: bg, color: fg, borderRadius: "999px", padding: "5px 11px", fontSize: "12px", fontFamily: mono });

function Section({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
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

function EmployeeCard({ employee }: { employee: Employee }) {
  return (
    <article style={{ border: "1px solid #DCE5F0", borderRadius: "16px", padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#127F95" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9.5 13h.01M14.5 13h.01" /></svg>
          <h3 style={{ margin: 0, fontFamily: mono, fontSize: "18px" }}>{employee.role}</h3>
        </div>
        <span style={employee.enabled ? chip("#DDF4F8", "#0B5E73") : chip("#EEF2F8", MUTED)}>{employee.enabled ? "on staff" : "suspended"}</span>
      </div>
      <p style={{ margin: 0, fontFamily: sans, fontSize: "15px", fontWeight: 600 }}>{employee.title}</p>
      {employee.details.length ? (
        <ul style={{ margin: 0, paddingLeft: "18px", fontFamily: sans, fontSize: "14px", lineHeight: 1.6, color: MUTED }}>
          {employee.details.slice(0, 6).map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
      ) : null}
      {employee.budgets.map((budget) => {
        const max = Number(budget.max ?? 0);
        const left = Number(budget.available ?? 0);
        const used = max > 0 ? Math.min(100, Math.max(0, ((max - left) / max) * 100)) : 0;
        return (
          <div key={budget.label} style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: mono, fontSize: "12px", color: MUTED }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span>{budget.label}{budget.periodDays ? ` · every ${budget.periodDays} days` : ""}</span>
              <span style={{ color: INK }}>{budget.available ?? "?"} {budget.token ?? ""} left of {budget.max ?? "?"} {budget.token ?? ""}</span>
            </div>
            <div style={{ height: "8px", background: "#E4EAF4", borderRadius: "999px", overflow: "hidden" }}><div style={{ width: `${used}%`, height: "100%", background: "#F2B544" }} /></div>
          </div>
        );
      })}
    </article>
  );
}

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

  return (
    <div style={{ fontFamily: mono, color: "#F2F6FC", background: NAVY, minHeight: "100vh" }}>
      <header style={{ maxWidth: "1240px", margin: "0 auto", padding: "18px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
        <Link to="/explore" style={{ display: "flex", alignItems: "center", gap: "10px", textDecoration: "none", color: "#F2F6FC" }}>
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M4 26V8l11-5 11 5v18" stroke="#4FD1E8" strokeWidth="2.2" strokeLinejoin="round" /><path d="M10 26v-9l5 4 5-4v9" stroke="#F2B544" strokeWidth="2.2" strokeLinejoin="round" /></svg>
          <span style={{ fontWeight: 700, fontSize: "18px" }}>MandateOS</span>
        </Link>
        <nav aria-label="Breadcrumb" style={{ fontSize: "14px", color: "#C9D6EE" }}><Link to="/explore#companies" style={{ color: "#4FD1E8" }}>AI companies</Link> / <span style={{ color: "#F2F6FC" }}>{entry.data?.name ?? dao}</span></nav>
        <a href="/onboarding" style={{ background: "#4FD1E8", color: INK, textDecoration: "none", fontSize: "14px", fontWeight: 600, padding: "12px 20px", borderRadius: "10px" }}>Open App</a>
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
                ["AI EMPLOYEES", company ? String(company.employees.filter((e) => e.enabled).length) : "…", "#4FD1E8"],
                ["SECURITY COUNCIL", company ? String(company.council.length) : "…", "#F2F6FC"],
                ["TREASURY (DAO)", company ? company.daoBalanceNear : "…", "#F2B544"],
                ["SHARE PRICE", company ? (company.shares ? company.shares.priceNear : "no shares") : "…", "#F2F6FC"],
              ].map(([label, value, color]) => (
                <div key={label} style={{ background: NAVY, borderRadius: "14px", padding: "14px 16px" }}>
                  <div style={{ fontSize: "11px", color: "#A9BCE0" }}>{label}</div>
                  <div style={{ fontSize: "20px", fontWeight: 600, marginTop: "4px", color }}>{value}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {profile.isLoading ? <p>Reading the vault, the DAO and the shares on NEAR…</p> : null}
        {profile.error ? <p style={{ color: "#F7A99D" }}>{profile.error.message}</p> : null}
        {company ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "24px", alignItems: "flex-start" }}>
            <div style={{ flex: "999 1 620px", minWidth: 0, display: "flex", flexDirection: "column", gap: "24px" }}>
              <Section title="AI employees" tag="job contracts read from the vault">
                {company.employees.length === 0 ? <p style={{ margin: 0, fontFamily: sans, color: MUTED }}>No AI employee hired yet.</p> : null}
                {company.employees.map((employee) => <EmployeeCard key={employee.role} employee={employee} />)}
              </Section>
              {company.shares ? (
                <Section title="Revenue for voters" tag={`1 epoch = ${company.shares.epochHours} h`}>
                  <p style={{ margin: 0, fontFamily: sans, fontSize: "15px", lineHeight: 1.6, color: MUTED }}>Each epoch, shareholders who voted split what the company shares. Those who did not vote leave their part to those who did.</p>
                  <div style={{ fontSize: "14px" }}>Paid to voters so far: <strong>{company.shares.distributedNear}</strong></div>
                </Section>
              ) : null}
            </div>
            <aside style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: "24px" }}>
              {company.shares ? (
                <Section title={`Shares · ${company.shares.symbol}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}><span style={{ color: MUTED }}>Price</span><span>{company.shares.priceNear}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px" }}><span style={{ color: MUTED }}>Sold</span><span>{company.shares.sold} / {company.shares.total}</span></div>
                  <div style={{ height: "8px", background: "#E4EAF4", borderRadius: "999px", overflow: "hidden" }}><div style={{ width: `${(Number(company.shares.sold) / Number(company.shares.total)) * 100}%`, height: "100%", background: NAVY }} /></div>
                  <a href="/shares" style={{ textAlign: "center", background: NAVY, color: "#F2F6FC", textDecoration: "none", fontWeight: 600, padding: "14px", borderRadius: "999px" }}>Buy and lock to vote</a>
                </Section>
              ) : null}
              <Section title="Security council">
                <p style={{ margin: 0, fontFamily: sans, fontSize: "14px", color: MUTED }}>Votes the mandates. Any member can pause every agent; only a vote resumes them.</p>
                <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", lineHeight: 1.8, wordBreak: "break-all" }}>{company.council.map((member) => <li key={member}>{member}</li>)}</ul>
              </Section>
              <Section title="On chain">
                {[["DAO", company.dao_id], ["Vault", company.vault_id], ...(company.shares_id ? [["Shares", company.shares_id]] : []), ...company.wallets.map((wallet) => [wallet.name, wallet.address])].map(([label, value]) => (
                  <div key={label} style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "13px" }}>
                    <span style={{ color: MUTED }}>{label}</span><span style={{ wordBreak: "break-all" }}>{value}</span>
                  </div>
                ))}
              </Section>
            </aside>
          </div>
        ) : null}
      </main>
    </div>
  );
}
