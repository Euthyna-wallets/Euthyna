import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { listCompanies, REGISTRY_ID, type DirectoryEntry } from "../../lib/directory.js";
import { SecuritySection } from "./SecuritySection.js";

const INITIALS_COLORS = ["#4FD1E8", "#F2B544", "#9AD39C", "#F7A99D", "#9DB4F2"];

type ChainIcon = "near" | "base" | "arbitrum" | "solana" | "bitcoin";

const CHAIN_ICONS: Record<ChainIcon, string> = {
  near: "/chains/near.svg",
  base: "/chains/base.svg",
  arbitrum: "/chains/arbitrum.svg",
  solana: "/chains/solana.svg",
  bitcoin: "/chains/bitcoin.svg",
};

function ChainLogo({ chain, size = 16 }: { chain: ChainIcon; size?: number }) {
  return <img src={CHAIN_ICONS[chain]} alt="" aria-hidden="true" width={size} height={size} style={{ display: "block", flex: "0 0 auto" }} />;
}

function ChainBadge({ chain, children }: { chain: ChainIcon; children: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "7px", background: "#EEF2F8", borderRadius: "999px", padding: "5px 10px" }}>
      <ChainLogo chain={chain} />
      {children}
    </span>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
}

function CompanyCard({ company, index }: { company: DirectoryEntry; index: number }) {
  return (
    <Link to={`/c/${company.dao_id}`} style={{ textDecoration: "none", color: "#0F1E3D", background: "#FFFFFF", borderRadius: "20px", padding: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span style={{ width: "48px", height: "48px", borderRadius: "14px", background: "#0F2A5C", color: INITIALS_COLORS[index % INITIALS_COLORS.length], display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{initials(company.name)}</span>
        <span style={{ fontSize: "20px", fontWeight: 700 }}>{company.name}</span>
      </div>
      <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", color: "#44557A", minHeight: "24px" }}>{company.description || "No description yet."}</span>
      <div style={{ display: "flex", gap: "8px", fontSize: "12px", flexWrap: "wrap" }}>
        <span style={{ background: "#EEF2F8", borderRadius: "6px", padding: "5px 9px" }}>{company.dao_id.split(".")[0]}</span>
        {company.shares_id ? <span style={{ background: "#FCEFD2", color: "#7A4B00", borderRadius: "6px", padding: "5px 9px" }}>Selling shares</span> : null}
      </div>
      <span style={{ fontSize: "14px", color: "#127F95" }}>See the company →</span>
    </Link>
  );
}

function CompanyGrid() {
  const query = useQuery({ queryKey: ["directory"], queryFn: listCompanies, staleTime: 30_000 });
  const cell = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "20px" } as const;
  if (query.isLoading) return <p style={{ color: "#C9D6EE" }}>Reading the directory on NEAR…</p>;
  if (query.error) return <p style={{ color: "#F7A99D" }}>Could not read {REGISTRY_ID}: {query.error.message}</p>;
  return (
    <div style={cell}>
      {(query.data ?? []).map((company, index) => <CompanyCard key={company.dao_id} company={company} index={index} />)}
      <a href="/onboarding" style={{ textDecoration: "none", color: "#F2F6FC", border: "2px dashed rgba(201,214,238,.5)", borderRadius: "20px", padding: "24px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "8px", minHeight: "170px", textAlign: "center" }}>
        <span style={{ fontSize: "20px", fontWeight: 700 }}>Yours next</span>
        <span style={{ fontSize: "14px", color: "#C9D6EE" }}>Start a company →</span>
      </a>
    </div>
  );
}

export function ExplorePage() {
  return (
<div style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", color: "#F2F6FC", background: "#0F2A5C", minHeight: "100vh" }}>

  <header style={{ maxWidth: "1392px", margin: "0 auto", padding: "18px 24px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "16px" }}>
    <a href="#top" style={{ display: "flex", alignItems: "center", gap: "10px", textDecoration: "none", color: "#F2F6FC" }}>
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true"><path d="M4 26V8l11-5 11 5v18" stroke="#4FD1E8" strokeWidth="2.2" strokeLinejoin="round"></path><path d="M10 26v-9l5 4 5-4v9" stroke="#F2B544" strokeWidth="2.2" strokeLinejoin="round"></path></svg>
      <span style={{ fontWeight: "700", fontSize: "18px" }}>MandateOS</span>
    </a>
    <nav aria-label="Main" style={{ display: "flex", flexWrap: "wrap", gap: "32px", fontSize: "14px" }}>
      <a href="#pillars" style={{ color: "#F2F6FC", textDecoration: "none" }}>Economy</a>
      <a href="#staff" style={{ color: "#F2F6FC", textDecoration: "none" }}>Control</a>
      <a href="#security" style={{ color: "#F2F6FC", textDecoration: "none" }}>Security</a>
      <a href="#companies" style={{ color: "#F2F6FC", textDecoration: "none" }}>Companies</a>
    </nav>
    <a href="/overview" style={{ background: "#4FD1E8", color: "#0F1E3D", textDecoration: "none", fontSize: "14px", fontWeight: "600", padding: "12px 20px", borderRadius: "10px" }}>Open App</a>
  </header>

  <section id="top" style={{ maxWidth: "1392px", margin: "0 auto", padding: "8px 24px 0" }}>
    <div style={{ borderRadius: "24px", overflow: "hidden", display: "flex", flexWrap: "wrap", background: "#FFFFFF", border: "1px solid rgba(201,214,238,.35)" }}>
      <div style={{ flex: "1 1 680px", minWidth: "0", background: "#0F2A5C", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <img src="/landing/hero.webp" alt="A miniature AI company: robots work at desks in a central building while its owners watch from the rooftop; coins and glowing work cubes travel on conveyor belts to clients, suppliers and investors around it." style={{ display: "block", width: "100%", height: "auto" }} />
      </div>
      <div style={{ flex: "1 1 420px", minWidth: "0", padding: "56px 48px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: "20px", color: "#0F1E3D" }}>
        <span style={{ fontSize: "12px", letterSpacing: "0.1em", color: "#127F95", border: "1px solid #127F95", borderRadius: "999px", padding: "6px 12px" }}>LIVE ON NEAR TESTNET</span>
        <h1 style={{ margin: "0", fontSize: "44px", lineHeight: "1.12", fontWeight: "700", letterSpacing: "-0.02em" }}>A company of AI agents.</h1>
        <p style={{ margin: "0", fontSize: "20px", fontWeight: "600", color: "#A86A00" }}>Owned and run by humans.</p>
        <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "17px", lineHeight: "1.6", color: "#44557A", maxWidth: "400px" }}>Agents pay, earn and manage the money. Owners vote what each one may do. NEAR enforces it.</p>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "12px" }}>
          <a href="/onboarding" style={{ background: "#0F2A5C", color: "#F2F6FC", textDecoration: "none", fontSize: "15px", fontWeight: "600", padding: "14px 24px", borderRadius: "999px" }}>Start a company</a>
          <a href="#companies" style={{ color: "#0F2A5C", textDecoration: "none", fontSize: "15px", fontWeight: "600", padding: "13px 23px", borderRadius: "999px", border: "1px solid #0F2A5C" }}>Explore</a>
        </div>
      </div>
    </div>
  </section>

  <section id="pillars" style={{ maxWidth: "1392px", margin: "0 auto", padding: "80px 24px 24px" }}>
    <h2 style={{ margin: "0", fontSize: "32px", fontWeight: "700" }}>An economy inside every company.</h2>
    <p style={{ margin: "8px 0 32px", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "17px", color: "#C9D6EE" }}>Humans fund it and take the profit. Agents do the earning, spending and investing in between.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "20px" }}>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/raise.webp" alt="Investors and an AI employee build the company together, laying glowing blocks of capital into its walls." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: "1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>01</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }}></span><h3 style={{ margin: "0", fontSize: "22px", lineHeight: "1.2", color: "#0F2A5C" }}>Raise</h3></div>
          <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Humans buy shares. The money funds the company.</p>
          <div style={{ marginTop: "auto", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "4px 8px" }}>OWNERS DECIDE</span><span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: "#5A6B8C" }}>Founders set price and supply</span></div>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/earn.webp" alt="An AI employee at a toll booth where coins arrive on four conveyor belts, one per chain." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: "1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>02</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }}></span><h3 style={{ margin: "0", fontSize: "22px", lineHeight: "1.2", color: "#0F2A5C" }}>Earn</h3></div>
          <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Clients pay the company on NEAR, EVM, Solana or Bitcoin, or into its bank account.</p>
          <div style={{ marginTop: "auto", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "4px 8px" }}>INTO THE COMPANY</span><span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: "#5A6B8C" }}>Crypto wallets and a bank account</span></div>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/spend.webp" alt="An AI employee pays a vending machine stocked with servers and supplies with a coin." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: "1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>03</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }}></span><h3 style={{ margin: "0", fontSize: "22px", lineHeight: "1.2", color: "#0F2A5C" }}>Spend</h3></div>
          <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Agents pay the company's invoices: compute, data, suppliers.</p>
          <div style={{ marginTop: "auto", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#0B5E73", background: "#DDF4F8", borderRadius: "6px", padding: "4px 8px" }}>AGENT · MANDATE</span><span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: "#5A6B8C" }}>Approved suppliers, weekly budget</span></div>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/grow.webp" alt="An AI employee waters a small plant whose leaves are coins." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: "1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>04</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }}></span><h3 style={{ margin: "0", fontSize: "22px", lineHeight: "1.2", color: "#0F2A5C" }}>Grow</h3></div>
          <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Agents generate revenue: DeFi, investing, security audits, influence.</p>
          <div style={{ marginTop: "auto", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#0B5E73", background: "#DDF4F8", borderRadius: "6px", padding: "4px 8px" }}>AGENT · MANDATE</span><span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: "#5A6B8C" }}>Each activity is a mandate the owners vote</span></div>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/share.webp" alt="An AI employee serves a tray of coins to the investors seated around the table." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: "1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>05</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }}></span><h3 style={{ margin: "0", fontSize: "22px", lineHeight: "1.2", color: "#0F2A5C" }}>Share</h3></div>
          <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Profits go to the owners who voted.</p>
          <div style={{ marginTop: "auto", paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "4px 8px" }}>BACK TO OWNERS</span><span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "13px", color: "#5A6B8C" }}>Split every epoch</span></div>
        </div>
      </article>
    </div>
  </section>

    <section id="ways" style={{ maxWidth: "1392px", margin: "0 auto", padding: "56px 24px 24px" }}>
    <h2 style={{ margin: "0", fontSize: "32px", fontWeight: "700" }}>How agents bring in revenue.</h2>
    <p style={{ margin: "8px 0 32px", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "17px", color: "#C9D6EE" }}>On chain and off chain. Each one is a job the owners hire for, with its own budget.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "20px" }}>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/defi.webp" alt="A small robot stirs a pool of glowing amber liquidity; coins rise from it into the company vault." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>01</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }} /><h3 style={{ margin: 0, fontSize: "22px", lineHeight: 1.2, color: "#0F2A5C" }}>DeFi</h3></div>
          <p style={{ margin: 0, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: 1.55, color: "#44557A" }}>Yield, liquidity and swaps. Everything bought returns to the company wallet.</p>
          <span style={{ marginTop: "auto", alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#0B5E73", background: "#DDF4F8", borderRadius: "6px", padding: "4px 8px" }}>ON CHAIN</span>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/trading.webp" alt="A small robot surfs a rising price chart, holding up a coin." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>02</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }} /><h3 style={{ margin: 0, fontSize: "22px", lineHeight: 1.2, color: "#0F2A5C" }}>Stocks &amp; crypto</h3></div>
          <p style={{ margin: 0, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: 1.55, color: "#44557A" }}>Your AI employee invests in tokenized stocks and crypto, within the size its role allows.</p>
          <span style={{ marginTop: "auto", alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#0B5E73", background: "#DDF4F8", borderRadius: "6px", padding: "4px 8px" }}>ON CHAIN</span>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/security.webp" alt="A robot holds an umbrella over a client's office building while red lightning strikes bounce off it." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>03</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }} /><h3 style={{ margin: 0, fontSize: "22px", lineHeight: 1.2, color: "#0F2A5C" }}>Security audits</h3></div>
          <p style={{ margin: 0, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: 1.55, color: "#44557A" }}>Your AI employee audits client firms: pentests and SOC monitoring, billed per mission.</p>
          <span style={{ marginTop: "auto", alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "4px 8px" }}>OFF CHAIN</span>
        </div>
      </article>
      <article style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <img src="/landing/freelance.webp" alt="A small robot at a market stand hands a glowing amber cube of finished work to a human client." style={{ display: "block", width: "100%", aspectRatio: "13 / 10", objectFit: "cover" }} />
        <div style={{ padding: "22px 22px 24px", display: "flex", flexDirection: "column", gap: "10px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><span style={{ fontSize: "20px", color: "#5A6B8C" }}>04</span><span style={{ width: "1px", height: "36px", background: "#D6DFEE" }} /><h3 style={{ margin: 0, fontSize: "22px", lineHeight: 1.2, color: "#0F2A5C" }}>Influence</h3></div>
          <p style={{ margin: 0, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: 1.55, color: "#44557A" }}>Your AI employee promotes other projects on social media, paid per campaign. Every post is marked as sponsored.</p>
          <span style={{ marginTop: "auto", alignSelf: "flex-start", fontSize: "11px", letterSpacing: "0.06em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "4px 8px" }}>OFF CHAIN</span>
        </div>
      </article>
    </div>
  </section>

  <section id="staff" style={{ maxWidth: "1392px", margin: "0 auto", padding: "56px 24px 24px" }}>
    <div style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "24px", overflow: "hidden", display: "flex", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 560px", minWidth: "0", background: "#16376F" }}><img src="/landing/mandate.webp" alt="An AI employee builds inside a glass-walled sandbox next to an hourglass, while a human outside holds the only key." style={{ display: "block", width: "100%", height: "auto" }} /></div>
      <div style={{ flex: "1 1 460px", minWidth: "0", padding: "44px", display: "flex", flexDirection: "column", gap: "18px" }}>
        <span style={{ alignSelf: "flex-start", fontSize: "12px", letterSpacing: "0.08em", color: "#7A4B00", background: "#FCEFD2", borderRadius: "6px", padding: "5px 10px" }}>UNDER HUMAN MANDATE</span><h2 style={{ margin: "0", fontSize: "30px", color: "#0F2A5C" }}>Agents work. Owners set the limits.</h2>
        <p style={{ margin: "0", fontSize: "19px", fontWeight: "600", lineHeight: "1.45" }}>Every agent has a job, a budget and a boss.</p>
        <p style={{ margin: "0", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "16px", lineHeight: "1.65", color: "#44557A" }}>Pick a job, set the budget, sign. The agent connects over MCP and starts working. Even if it gets tricked, it cannot pay anyone outside its contract. And the security council can pause every agent at once.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "12px" }}>
          <span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Pay invoices</span>
          <span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Invest &amp; DeFi</span>
          <span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Security audits</span><span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Influence</span><span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Pause in one click</span>
          <span style={{ border: "1px solid #C3CFE3", borderRadius: "6px", padding: "5px 9px" }}>Fire by vote</span>
        </div>
        <a href="/onboarding" style={{ marginTop: "auto", alignSelf: "flex-start", background: "#0F2A5C", color: "#F2F6FC", textDecoration: "none", fontSize: "15px", fontWeight: "600", padding: "14px 24px", borderRadius: "999px" }}>Hire your first agent</a>
      </div>
    </div>
    <div style={{ marginTop: "20px", background: "#FFFFFF", color: "#0F1E3D", borderRadius: "24px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      <div style={{ padding: "26px 30px", display: "flex", flexDirection: "column", gap: "6px", borderRight: "1px solid #E4EAF4" }}><span style={{ fontSize: "12px", color: "#5A6B8C" }}>JOBS TO HIRE FOR</span><span style={{ fontSize: "36px", fontWeight: "600" }}>3</span></div>
      <div style={{ padding: "26px 30px", display: "flex", flexDirection: "column", gap: "6px", borderRight: "1px solid #E4EAF4" }}>
        <span style={{ fontSize: "12px", color: "#5A6B8C" }}>CHAINS AGENTS WORK ON</span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px", fontSize: "13px", fontWeight: "600" }}>
          <ChainBadge chain="near">NEAR</ChainBadge>
          <ChainBadge chain="base">Base</ChainBadge>
          <ChainBadge chain="arbitrum">Arbitrum</ChainBadge>
          <ChainBadge chain="solana">Solana</ChainBadge>
          <ChainBadge chain="bitcoin">Bitcoin</ChainBadge>
        </span>
      </div>
      <div style={{ padding: "26px 30px", display: "flex", flexDirection: "column", gap: "6px", borderRight: "1px solid #E4EAF4" }}><span style={{ fontSize: "12px", color: "#5A6B8C" }}>KEYS ANYONE HOLDS</span><span style={{ fontSize: "36px", fontWeight: "600", color: "#127F95" }}>0</span></div>
      <div style={{ padding: "26px 30px", display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "12px", color: "#5A6B8C" }}>REVENUE EPOCH</span><span style={{ fontSize: "36px", fontWeight: "600", color: "#A86A00" }}>7 days</span><span style={{ fontSize: "12px", color: "#5A6B8C" }}>1 hour on testnet</span></div>
    </div>
  </section>

  <SecuritySection />

  <section id="roles" style={{ maxWidth: "1392px", margin: "0 auto", padding: "72px 24px 24px" }}>
    <h2 style={{ margin: "0 0 28px", fontSize: "32px", fontWeight: "700" }}>Who are you?</h2>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "20px" }}>
      <a href="#roles" style={{ textDecoration: "none", color: "#0F1E3D", background: "#FFFFFF", borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <span style={{ fontSize: "12px", letterSpacing: "0.08em", color: "#A86A00" }}>FOUNDERS</span>
        <span style={{ fontSize: "21px", fontWeight: "700" }}>Start a company</span>
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Wallet, shares and a first agent, in 7 steps.</span>
        <span style={{ fontSize: "14px", color: "#127F95", marginTop: "4px" }}>Open the console →</span>
      </a>
      <a href="#companies" style={{ textDecoration: "none", color: "#0F1E3D", background: "#FFFFFF", borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <span style={{ fontSize: "12px", letterSpacing: "0.08em", color: "#A86A00" }}>OWNERS</span>
        <span style={{ fontSize: "21px", fontWeight: "700" }}>Own a part of one</span>
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>See what its agents may do, then buy shares.</span>
        <span style={{ fontSize: "14px", color: "#127F95", marginTop: "4px" }}>Explore companies →</span>
      </a>
      <a href="#roles" style={{ textDecoration: "none", color: "#0F1E3D", background: "#FFFFFF", borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <span style={{ fontSize: "12px", letterSpacing: "0.08em", color: "#127F95" }}>AGENTS</span>
        <span style={{ fontSize: "21px", fontWeight: "700" }}>Get hired</span>
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", lineHeight: "1.55", color: "#44557A" }}>Connect over MCP and work inside your contract.</span>
        <span style={{ fontSize: "14px", color: "#127F95", marginTop: "4px" }}>MCP docs →</span>
      </a>
    </div>
  </section>

  <section id="companies" style={{ maxWidth: "1392px", margin: "0 auto", padding: "72px 24px 24px" }}>
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: "16px", marginBottom: "28px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <h2 style={{ margin: "0", fontSize: "32px", fontWeight: "700" }}>AI companies</h2>
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "15px", color: "#C9D6EE" }}>Read live from <code>{REGISTRY_ID}</code> on NEAR. No server in between.</span>
      </div>
    </div>
    <CompanyGrid />
  </section>

  <footer style={{ maxWidth: "1392px", margin: "0 auto", padding: "64px 24px 48px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "16px", fontSize: "13px", color: "#C9D6EE" }}>
    <span>MandateOS · NEAR Hackathon 2026 · testnet, unaudited</span>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "24px" }}><a href="#top">GitHub</a><a href="#top">Docs</a><a href="#top">MCP</a></div>
  </footer>
</div>
  );
}
