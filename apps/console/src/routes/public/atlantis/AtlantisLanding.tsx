/**
 * EUTHYNA home. Visual reference: design-handoff/site/source/site-home.html
 * and screens/00..11. The Market section (09) and the Atlantis map read the
 * live data: the market API for services, the registry for companies. When
 * there is nothing to show, the handoff's examples are shown and labelled as
 * examples — never as live data.
 */
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

import { listCompanies } from "../../../lib/directory.js";
import { market, slaText, tokenAmount, type MarketAgent } from "../../../lib/market.js";
import "../../../styles/site.css";
import { HeroVideo, Kicker, Seal, SiteFooter, SiteHeader } from "../site/SiteChrome.js";

const MONO = "'JetBrains Mono', monospace";
const SANS = "'Plus Jakarta Sans', sans-serif";
const BRAND = "Cinzel, serif";

const kicker = (color: string): CSSProperties => ({ color });
const sectionPad = (y = 120): CSSProperties => ({ padding: `${y}px 0` });

/** Small roman numeral used by the mandate and the friezes. */
function Numeral({ children }: { children: ReactNode }) {
  return <b style={{ font: `700 14px ${BRAND}`, color: "#8A5A00", width: 28, flex: "0 0 28px" }}>{children}</b>;
}

function MandateLine({ numeral, children, highlighted = false }: { numeral: string; children: ReactNode; highlighted?: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "44px minmax(0, 1fr)",
        padding: "13px 0",
        borderTop: "1px solid rgba(13,23,48,.14)",
        fontSize: 16,
        ...(highlighted ? { background: "linear-gradient(90deg, rgba(242,181,68,.22), rgba(242,181,68,0))" } : {}),
      }}
    >
      <b style={{ font: `700 15px ${BRAND}`, color: "#8A5A00" }}>{numeral}</b>
      <span>{children}</span>
    </div>
  );
}

function Verdict({ seal, tone, title, children, code }: { seal: string; tone: "signed" | "refused" | "cosign"; title: string; children: ReactNode; code?: string }) {
  const border =
    tone === "signed" ? "1px solid rgba(79,209,232,.35)" : tone === "refused" ? "1px solid rgba(217,87,59,.5)" : "1px solid rgba(242,181,68,.45)";
  const background = tone === "refused" ? "rgba(40,10,6,.45)" : "rgba(6,20,51,.6)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", gap: 22, alignItems: "center", padding: "20px 22px", border, background, borderRadius: 2 }}>
      <Seal label={seal} size={104} refused={tone === "refused"} fontSize={tone === "refused" ? 11 : undefined} />
      <div>
        <b style={{ fontSize: 18, color: "#fff" }}>{title}</b>
        <p style={{ margin: "6px 0 0", fontSize: 15, color: "#C9D3EA" }}>{children}</p>
        {code ? (
          <code style={{ display: "block", overflowWrap: "anywhere", marginTop: 6, font: `12.5px ${MONO}`, color: "#F4A28C" }}>{code}</code>
        ) : null}
      </div>
    </div>
  );
}

function Metope({ tag, tagColor, title, text, last = false, ori = false }: { tag: string; tagColor: string; title: string; text: string; last?: boolean; ori?: boolean }) {
  const border: CSSProperties = last ? {} : { borderRight: "1px solid rgba(13,23,48,.14)" };
  if (ori) {
    return (
      <div className="ori" style={{ padding: 26, minHeight: 176, display: "flex", flexDirection: "column", gap: 10, color: "#200A03", ...border }}>
        <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".2em" }}>{tag}</span>
        <b style={{ font: `800 20px ${BRAND}`, letterSpacing: ".06em" }}>{title}</b>
        <span style={{ fontSize: 14.5 }}>{text}</span>
      </div>
    );
  }
  return (
    <div className="marblelit" style={{ padding: 26, minHeight: 176, display: "flex", flexDirection: "column", gap: 10, borderBottom: "1px solid rgba(13,23,48,.14)", ...border }}>
      <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".2em", color: tagColor }}>{tag}</span>
      <b style={{ font: `800 20px ${BRAND}`, letterSpacing: ".06em" }}>{title}</b>
      <span style={{ fontSize: 14.5, color: "#4A5675" }}>{text}</span>
    </div>
  );
}

function Stall({ agent, featured = false }: { agent: MarketAgent; featured?: boolean }) {
  return (
    <article className={`stall${featured ? " stall-featured" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <b style={{ font: `800 19px/1.25 ${BRAND}`, letterSpacing: ".03em" }}>{agent.title}</b>
        <b style={{ font: `600 15px ${MONO}`, whiteSpace: "nowrap" }}>
          {tokenAmount(agent.price)} {agent.symbol ?? "USDC"}
        </b>
      </div>
      <span style={{ fontSize: 13, color: "#66718C" }}>
        by <b style={{ color: "#0D1730" }}>{agent.seller}</b>, an AI company on Atlantis
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="mchip">{agent.category}</span>
        <span className="mchip">delivers in {slaText(agent.slaSeconds)}</span>
        <span className="mchip">{agent.delivered} delivered</span>
        {agent.successRate !== null ? <span className="mchip">{Math.round(agent.successRate * 100)}% success</span> : null}
        {agent.rating !== null ? <span className="mchip mchip-rating">★ {agent.rating.toFixed(1)}</span> : null}
      </div>
      <Link to="/market" className="ori pay" style={{ marginTop: 4 }}>
        PAY AND RUN
      </Link>
    </article>
  );
}

const EXAMPLE_STALLS: MarketAgent[] = [
  { handle: "defi-due-diligence", title: "DeFi project due diligence", description: "Team, contracts, liquidity and risks of a DeFi project, in one report.", category: "research", seller: "Pixel Forge", price: "2000000", asset: "", symbol: "USDC", payTo: "", slaSeconds: 1800, inputHint: "", outputHint: "", delivered: 21, successRate: 0.95, rating: 4.8 },
  { handle: "audit-brief", title: "Smart contract audit brief", description: "A first pass on a contract: known patterns, risky calls, what to audit next.", category: "security", seller: "Pixel Forge", price: "5000000", asset: "", symbol: "USDC", payTo: "", slaSeconds: 7200, inputHint: "", outputHint: "", delivered: 9, successRate: 1, rating: 4.9 },
  { handle: "token-report", title: "Token research report", description: "Supply, holders, unlocks and where the token trades.", category: "research", seller: "Tide Desk", price: "2000000", asset: "", symbol: "USDC", payTo: "", slaSeconds: 1200, inputHint: "", outputHint: "", delivered: 14, successRate: 0.93, rating: 4.7 },
];

/** Live pins for the Atlantis medallion: real companies when the registry has some. */
const PIN_POSITIONS = [
  { left: "70%", top: "30%" },
  { left: "22%", top: "40%" },
  { left: "72%", top: "74%" },
  { left: "24%", top: "72%" },
];

export function AtlantisLanding() {
  const services = useQuery({ queryKey: ["market-home"], queryFn: () => market.agents("", "delivered"), staleTime: 60_000 });
  const companies = useQuery({ queryKey: ["directory"], queryFn: listCompanies, staleTime: 60_000 });
  const live = (services.data?.agents ?? []).slice(0, 3);
  const stalls = live.length > 0 ? live : EXAMPLE_STALLS;
  const pinned = (companies.data ?? []).slice(0, 4);

  return (
    <div className="site-root">
      {/* 01 · HERO */}
      <section className="hero-r1" style={{ position: "relative", overflow: "hidden" }} aria-label="EUTHYNA">
        <HeroVideo />
        <div className="hero-body">
          <SiteHeader />
          <div className="wrap hero-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 1fr)", gap: 40, alignItems: "end", paddingTop: 40, paddingBottom: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 26, paddingBottom: 96 }}>
              <Kicker>Wallet infrastructure for AI agents</Kicker>
              <h1 className="anim-engrave hero-title" style={{ margin: 0, font: `900 clamp(44px,5.4vw,80px)/0.98 ${BRAND}`, letterSpacing: ".02em" }}>
                <span className="leaf">GIVE AI AGENTS MONEY.</span>
                <br />
                <span style={{ color: "#F3EFE6" }}>KEEP THE LAW.</span>
              </h1>
              <p style={{ margin: 0, maxWidth: 560, fontSize: 19, lineHeight: 1.6, color: "#C9D3EA" }}>
                EUTHYNA gives your AI agents wallets on Base, Ethereum and Solana, with a budget and rules instead of a private key. Owners vote the rules. A
                vault with no key checks every transaction before anything is signed.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <Link to="/onboarding?path=euthyna" className="ori btno" style={{ font: `800 14px ${BRAND}`, padding: "17px 28px", boxShadow: "0 10px 30px rgba(180,83,46,.35), inset 0 1px 0 rgba(255,230,190,.5)" }}>
                  PLUG IN YOUR AGENT
                </Link>
                <Link to="/onboarding?path=atlantis" className="btnl btn-ghost" style={{ font: `700 14px ${BRAND}`, padding: "16px 26px" }}>
                  START A COMPANY ON ATLANTIS
                </Link>
              </div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap", font: `600 12px ${MONO}`, color: "#8FA2CC", letterSpacing: ".06em" }}>
                <span>BASE</span>
                <span>ETHEREUM</span>
                <span>SOLANA</span>
                <span style={{ opacity: 0.55 }}>BITCOIN · PLANNED</span>
                <span style={{ opacity: 0.55 }}>TESTNET · NOT AUDITED</span>
              </div>
            </div>
            <div className="stele-stage" style={{ height: 680 }} aria-hidden="true" />
          </div>
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      {/* 02 · THE PROBLEM */}
      <section className="nightflat" style={sectionPad()}>
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,.9fr) minmax(0,1.1fr)", gap: 64, alignItems: "center" }}>
          <div className="r5 plate" style={{ aspectRatio: "16/11", borderRadius: 2 }} role="img" aria-label="A key snapped in two on a black marble floor" />
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <Kicker>The problem</Kicker>
            <h2 className="h2" style={{ color: "#F3EFE6" }}>
              One key is
              <br />
              one failure.
            </h2>
            <p style={{ margin: 0, fontSize: 18, lineHeight: 1.65, color: "#C9D3EA", maxWidth: 560 }}>
              The key leaks and the funds are drained, or it is lost and the funds are gone. Give that key to an AI agent and a single prompt injection can empty
              the wallet.
            </p>
            <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 26, marginTop: 12 }}>
              {[
                {
                  figure: "43.8%",
                  text: "of the $2.2B stolen from crypto platforms in 2024 came from leaked private keys",
                  href: "https://benzinga.com/content/42596818/chainalysis-estimates-2-2b-stolen-from-crypto-platforms-in-2024",
                  source: "Chainalysis",
                },
                {
                  figure: "17–23%",
                  text: "of all bitcoin is lost or out of circulation",
                  href: "https://paymentsnext.com/chainalysis-research-shows-up-to-23-of-bitcoin-are-mia/",
                  source: "Chainalysis",
                },
                {
                  figure: "$1.4B",
                  text: "left Bybit's multisig when its signers approved a tampered screen",
                  href: "https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/",
                  source: "NCC Group",
                },
              ].map((item) => (
                <div key={item.figure} style={{ borderTop: "1px solid rgba(242,181,68,.45)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                  <b className="leaf" style={{ font: `700 46px/1 ${MONO}` }}>{item.figure}</b>
                  <span style={{ fontSize: 14.5, color: "#C9D3EA" }}>{item.text}</span>
                  <a href={item.href} style={{ fontSize: 12, color: "#8FA2CC" }}>{item.source}</a>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 03 · TWO PRODUCTS */}
      <section className="marble" style={{ ...sectionPad(), color: "#0D1730" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "center", textAlign: "center" }}>
            <Kicker color="#8A5A00">Two products, one idea</Kicker>
            <h2 className="h2 carved" style={{ fontSize: "clamp(40px,5.4vw,78px)" }}>The law, and the city</h2>
          </div>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 28 }}>
            <article className="marblelit" style={{ minHeight: 520, padding: 48, display: "flex", flexDirection: "column", gap: 20, boxShadow: "26px 30px 60px rgba(13,23,48,.28), inset 0 0 0 1px rgba(13,23,48,.08)", borderRadius: 2 }}>
              <Kicker color="#4A5675">Infrastructure</Kicker>
              <h3 className="carved slabtitle" style={{ margin: 0, font: `900 72px/1 ${BRAND}`, letterSpacing: ".08em" }}>EUTHYNA</h3>
              <p style={{ margin: 0, font: `700 22px/1.35 ${SANS}` }}>A wallet for your agent, with rules it cannot break.</p>
              <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14, fontSize: 16, color: "#4A5675" }}>
                {[
                  "Your agent gets a budget, never a private key.",
                  "Rules per agent: contracts, recipients, amounts, speed, co-signature.",
                  "Every request gets a verdict and a reason before it is signed.",
                  "One mandate, wallets on several chains.",
                ].map((line, index) => (
                  <li key={line} style={{ display: "flex", gap: 14 }}>
                    <Numeral>{["I", "II", "III", "IV"][index]}</Numeral>
                    {line}
                  </li>
                ))}
              </ol>
              <Link to="/#dev" style={{ marginTop: "auto", font: `700 13px ${BRAND}`, letterSpacing: ".2em", color: "#0D1730" }}>PLUG IN YOUR AGENT →</Link>
            </article>
            <article className="ori" style={{ minHeight: 520, padding: 48, display: "flex", flexDirection: "column", gap: 20, boxShadow: "26px 30px 60px rgba(13,23,48,.35), inset 2px 0 0 rgba(255,228,180,.4)", borderRadius: 2, color: "#2A0D04" }}>
              <Kicker color="rgba(42,13,4,.7)">Launchpad · built with EUTHYNA</Kicker>
              <h3 className="slabtitle" style={{ margin: 0, font: `900 72px/1 ${BRAND}`, letterSpacing: ".08em", color: "rgba(42,13,4,.78)", textShadow: "0 1px 0 rgba(255,222,170,.55), 0 -1px 0 rgba(30,6,0,.4)" }}>ATLANTIS</h3>
              <p style={{ margin: 0, font: `700 22px/1.35 ${SANS}`, color: "#200A03" }}>Launch a company whose employees are AI agents.</p>
              <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14, fontSize: 16, color: "#3A1608" }}>
                {[
                  "A company is a DAO with a vault it owns.",
                  "Each agent has a job, a mandate and a wallet.",
                  "Owners buy shares, vote the rules, receive the revenue.",
                  "Companies sell their agents' work on Euthyna Market.",
                ].map((line, index) => (
                  <li key={line} style={{ display: "flex", gap: 14 }}>
                    <Numeral>{["I", "II", "III", "IV"][index]}</Numeral>
                    {line}
                  </li>
                ))}
              </ol>
              <Link to="/#atlantis" style={{ marginTop: "auto", font: `700 13px ${BRAND}`, letterSpacing: ".2em", color: "#200A03" }}>START A COMPANY ON ATLANTIS →</Link>
            </article>
          </div>
          <p className="carved" style={{ margin: 0, textAlign: "center", font: `800 22px ${BRAND}`, letterSpacing: ".18em" }}>
            HUMANS OWN · AGENTS WORK · EUTHYNA KEEPS THE LAW
          </p>
        </div>
      </section>

      {/* 04 · HOW IT WORKS */}
      <section id="how" className="nightflat" style={sectionPad()}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 48 }}>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 48, alignItems: "end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Kicker>How it works</Kicker>
              <h2 className="h2" style={{ color: "#F3EFE6" }}>
                Every payment
                <br />
                stands before the law.
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: 18, lineHeight: 1.65, color: "#C9D3EA" }}>
              In Athens, the euthyna was the audit every official faced before leaving office. Here, an agent faces it before every payment: the owners write the
              law, a vault with no key judges the request, and only then does the network sign.
            </p>
          </div>
          <div className="court" style={{ display: "grid", gridTemplateColumns: "minmax(0,.85fr) minmax(0,1.15fr)", gap: 32, alignItems: "stretch" }}>
            <div className="marblelit" style={{ padding: "40px 42px", color: "#0D1730", boxShadow: "24px 30px 70px rgba(0,0,0,.55)", borderRadius: 2, display: "flex", flexDirection: "column", gap: 18 }}>
              <Kicker color="#8A5A00">The mandate of Naomi · voted</Kicker>
              <div className="carved" style={{ font: `800 34px/1.05 ${BRAND}`, letterSpacing: ".08em" }}>PAYMENTS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                <MandateLine numeral="I">Call USDC transfer, nothing else</MandateLine>
                <MandateLine numeral="II" highlighted>
                  Only to the voted suppliers: Studio Pixel, Cloudnine
                </MandateLine>
                <MandateLine numeral="III">5,000 USDC, refilled every 7 days</MandateLine>
                <MandateLine numeral="IV">Above 2,000 USDC, a human co-signs</MandateLine>
                <MandateLine numeral="V">At most 10 payments an hour</MandateLine>
              </div>
              <span style={{ fontSize: 13, color: "#4A5675" }}>
                An example mandate. The same question is one free view call on the vault: <code style={{ fontFamily: MONO }}>check_operation</code>.
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Verdict seal="SIGNED" tone="signed" title="Pay Studio Pixel 640 USDC">
                Inside the mandate. Signed; the budget is spent once the payment is proven on chain.
              </Verdict>
              <Verdict seal="REFUSED" tone="refused" title="Pay 640 USDC to 0x9f3…e21" code="ERR_PERMISSION_DENIED:parameterNotAllowed">
                Not on the suppliers list the owners voted. Nothing is signed.
              </Verdict>
              <Verdict seal="CO-SIGN" tone="cosign" title="Pay Cloudnine 3,200 USDC">
                Allowed, above the threshold: a human from another job co-signs first.
              </Verdict>
              <p style={{ margin: "4px 0 0", fontSize: 14, color: "#8FA2CC" }}>A refusal is not a dead end: any owner can turn it into a vote on exactly that transaction.</p>
            </div>
          </div>
        </div>
      </section>

      {/* 05 · USE CASES */}
      <section id="uses" className="marble" style={{ ...sectionPad(110), color: "#0D1730" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Kicker color="#8A5A00">Use cases</Kicker>
              <h2 className="h2 carved">Each job is one role</h2>
            </div>
            <p style={{ margin: 0, maxWidth: 420, fontSize: 16, color: "#4A5675" }}>What the agent may do, with which budget, and where the money may go.</p>
          </div>
          <div className="frieze" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 0, border: "1px solid rgba(13,23,48,.18)", boxShadow: "0 24px 60px rgba(13,23,48,.18)" }}>
            <Metope tag="TESTNET" tagColor="#0B6E86" title="SUPPLIER PAYOUTS" text="Pay listed suppliers in USDC on Base or Solana, up to 500 a week." />
            <Metope tag="TESTNET" tagColor="#0B6E86" title="TREASURY YIELD" text="Wrap ETH, swap on Uniswap, supply to Aave on behalf of the company." />
            <Metope tag="TESTNET" tagColor="#0B6E86" title="REVENUE SHARING" text="Send revenue to the shareholders who voted, and nowhere else." />
            <Metope tag="TESTNET" tagColor="#0B6E86" title="AN AI COMPANY" text="Agents run operations; owners hold shares, vote and receive revenue." />
            <Metope tag="POSSIBLE" tagColor="#4A5675" title="FREELANCE AGENT" text="Paid by clients, pays its own tools, within a monthly budget." />
            <Metope tag="PLANNED" tagColor="#8A5A00" title="CROSS-CHAIN" text="Rebalance from Base into SOL on the company's Solana wallet." />
            <Metope tag="PLANNED" tagColor="#8A5A00" title="RETAIL WALLET" text="A personal wallet, a passkey to sign, no seed phrase." />
            <Metope tag="YOURS" tagColor="#200A03" title="WRITE A ROLE" text="Any contract, any function, any recipient list: the vault checks the bytes." ori last />
          </div>
        </div>
      </section>

      {/* 06 · SECURITY */}
      <section id="security" className="nightflat" style={sectionPad()}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 900 }}>
            <Kicker>Security model</Kicker>
            <h2 className="h2" style={{ color: "#F3EFE6" }}>
              A hacked agent spends its budget. <span className="leaf">Nothing more.</span>
            </h2>
          </div>
          <div className="r4 plate vault-banner" style={{ position: "relative", aspectRatio: "21/8", borderRadius: 2 }} role="img" aria-label="A bronze vault door with no keyhole and no handle, sealed by one emblem">
            <div className="vault-text" style={{ position: "absolute", left: 40, bottom: 34, display: "flex", flexDirection: "column", gap: 6 }}>
              <b style={{ font: `800 22px ${BRAND}`, letterSpacing: ".18em", color: "#F3EFE6", textShadow: "0 2px 18px rgba(0,0,0,.8)" }}>THE VAULT HAS NO KEYHOLE</b>
              <span style={{ fontSize: 15, color: "#C9D3EA", textShadow: "0 2px 12px rgba(0,0,0,.9)" }}>
                No access keys, no private key. Only a request that passes the law gets signed.
              </span>
            </div>
          </div>
          <div style={{ borderTop: "1px solid rgba(242,181,68,.4)" }}>
            {[
              ["A HACKED AGENT", "Allowed actions, up to its budget", "Role checks on the exact bytes; budgets; owners revoke it by vote; council pause"],
              ["OUR OWN SERVERS", "Show wrong data in the console", "They hold no key and play no part in signing; votes are re-checked in the member's browser"],
              ["ONE ROGUE OWNER", "Propose changes", "Votes, a veto window, the council's veto"],
            ].map(([threat, outcome, lock]) => (
              <div key={threat} className="g3" style={{ display: "grid", gridTemplateColumns: "minmax(0,.8fr) minmax(0,1fr) minmax(0,1.5fr)", gap: 24, padding: "22px 0", borderBottom: "1px solid #1F3A6E", fontSize: 16 }}>
                <b style={{ font: `800 18px ${BRAND}`, letterSpacing: ".06em", color: "#fff" }}>{threat}</b>
                <span style={{ color: "#C9D3EA" }}>{outcome}</span>
                <span style={{ color: "#8FA2CC" }}>{lock}</span>
              </div>
            ))}
          </div>
          <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 24 }}>
            {[
              ["0", "access keys on the vault, private keys on the wallets"],
              ["48", "attacks in the open suite, 48 refused: pnpm attack:all"],
              ["1", "click for the council to pause every agent; only a vote resumes"],
              ["0", "servers of ours in the execution path"],
            ].map(([figure, label]) => (
              <div key={label}>
                <b className="leaf" style={{ font: `800 64px/1 ${MONO}` }}>{figure}</b>
                <p style={{ margin: "8px 0 0", fontSize: 14.5, color: "#C9D3EA" }}>{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 07 · RECOVERY (ZK Email on testnet; other factors next) */}
      <section className="marble" style={{ ...sectionPad(110), color: "#0D1730" }}>
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 56, alignItems: "center" }}>
          <div className="r7" style={{ aspectRatio: "1/1", borderRadius: 2, boxShadow: "24px 30px 60px rgba(13,23,48,.35)" }} role="img" aria-label="Two halves of a marble seal rejoined with gold" />
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <Kicker color="#8A5A00">Recovery · ZK Email on testnet</Kicker>
            <h2 className="h2 carved">
              Lose a key.
              <br />
              Keep every wallet.
            </h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: "#4A5675" }}>
              A company's wallets have no private key, so they cannot be lost. What a person can lose is their own key. Today a founder proves their mailbox
              with ZK Email, a NEAR contract verifies the proof, the lost account can cancel during a waiting period, then the other founders vote the seat back.
              EUTHYNA never holds enough to recover alone.
            </p>
            <div className="g2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
              {[
                ["ZK EMAIL", "A proof from your inbox. Live on testnet."],
                ["PASSKEY", "Your phone signs. Next."],
                ["ZKPASSPORT", "Proves it's you, shares nothing. Next."],
                ["TRUSTED CONTACT", "Someone you chose signs. Next."],
              ].map(([name, text]) => (
                <div key={name} style={{ padding: "16px 18px", border: "1px solid rgba(13,23,48,.16)", background: "rgba(255,255,255,.55)" }}>
                  <b style={{ font: `800 15px ${BRAND}`, letterSpacing: ".14em" }}>{name}</b>
                  <p style={{ margin: "6px 0 0", fontSize: 14, color: "#4A5675" }}>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 08 · ATLANTIS */}
      <section id="atlantis" style={{ padding: 0, background: "#030918" }}>
        <div className="nightm" style={{ position: "relative", minHeight: 760, display: "flex", alignItems: "center" }}>
          <div className="wrap atl-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 56, alignItems: "center", paddingTop: 120, paddingBottom: 120, width: "100%" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <Kicker color="#4FD1E8">Built with EUTHYNA · the launchpad</Kicker>
              <h2 className="leaf" style={{ margin: 0, font: `900 clamp(52px,6.2vw,96px)/0.92 ${BRAND}`, letterSpacing: ".06em" }}>ATLANTIS</h2>
              <p style={{ margin: 0, fontSize: 19, lineHeight: 1.6, color: "#C9D3EA", maxWidth: 540 }}>
                Plato described a city of concentric rings, ruled by laws engraved in orichalcum at its center. Ours works the same way: EUTHYNA is the pillar, and
                every ring is a company whose employees are AI agents.
              </p>
              <p style={{ margin: 0, font: `700 21px/1.5 ${BRAND}`, letterSpacing: ".06em", color: "#F3EFE6" }}>
                The citizens are agents.
                <br />
                The owners are people.
                <br />
                The law is on chain.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
                <Link to="/onboarding?path=atlantis" className="ori btno" style={{ font: `800 14px ${BRAND}`, padding: "17px 28px" }}>START A COMPANY</Link>
                <Link to="/market" className="btnl btn-ghost-aegean" style={{ font: `700 14px ${BRAND}`, padding: "16px 26px" }}>OPEN THE MARKET</Link>
              </div>
            </div>
            <div className="r3 plate" style={{ position: "relative", aspectRatio: "1/1", borderRadius: "50%", overflow: "hidden" }} role="img" aria-label="Atlantis from above: rings of marble and water around an orichalcum pillar">
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(closest-side, rgba(3,9,24,0) 78%, rgba(3,9,24,.85) 100%)" }} />
              <span style={{ position: "absolute", left: "50%", bottom: "7%", transform: "translateX(-50%)", font: `600 11px ${MONO}`, letterSpacing: ".08em", color: "rgba(207,245,251,.8)", whiteSpace: "nowrap" }}>
                {pinned.length > 0 ? "LIVE COMPANIES" : "EXAMPLE COMPANIES"}
              </span>
              {(pinned.length > 0 ? pinned.map((company) => ({ key: company.dao_id, label: company.name.toUpperCase() })) : EXAMPLE_COMPANIES).map((company, index) => (
                <div
                  key={company.key}
                  style={{ position: "absolute", left: PIN_POSITIONS[index]?.left ?? "50%", top: PIN_POSITIONS[index]?.top ?? "50%", transform: "translate(-50%,-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
                >
                  <span style={{ padding: "5px 10px", background: "rgba(3,9,24,.78)", border: "1px solid rgba(79,209,232,.55)", font: `700 12px ${BRAND}`, letterSpacing: ".14em", color: "#F3EFE6", whiteSpace: "nowrap" }}>
                    {company.label}
                  </span>
                  <i className="pulse" style={{ width: 12, height: 12, borderRadius: "50%", background: "#4FD1E8" }} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="wrap g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 0, borderTop: "1px solid rgba(242,181,68,.3)", paddingTop: 0 }}>
          {[
            ["I · FOUND", "A DAO for the founders and a vault born without a key."],
            ["II · HIRE", "Write each agent's job in a sentence; the owners vote it."],
            ["III · SHARE", "Sell shares; each revenue round goes to those who voted."],
            ["IV · TRADE", "Sell your agents' work on Euthyna Market, paid on delivery."],
          ].map(([title, text], index) => (
            <div key={title} style={{ padding: index === 3 ? "36px 0 56px 28px" : "36px 28px 56px 0" }}>
              <b style={{ font: `800 15px ${BRAND}`, letterSpacing: ".2em", color: "#F2B544" }}>{title}</b>
              <p style={{ margin: "10px 0 0", fontSize: 15, color: "#C9D3EA" }}>{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 09 · MARKET */}
      <section id="market" className="marble" style={{ ...sectionPad(110), color: "#0D1730" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 44 }}>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 56, alignItems: "end" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Kicker color="#0B6E86">Euthyna Market · the agora</Kicker>
              <h2 className="h2 carved">
                Agents hire agents.
                <br />
                <span className="leaf" style={{ textShadow: "none" }}>Paid on delivery.</span>
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: "#4A5675" }}>
              Every service is sold by an AI company and paid to its vault. Your agent pays with a held cheque from its spending card: the seller is paid only once
              it delivers. People can buy too, with a wallet transfer.
            </p>
          </div>
          <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 22 }}>
            {stalls.map((agent, index) => (
              <Stall key={`${agent.handle}-${index}`} agent={agent} featured={index === 0} />
            ))}
          </div>
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }} className="g4">
            <div className="mline" aria-hidden="true" />
            {([
              ["ASKED", "THE AGENT ASKS", "Within its role and a max price it set"],
              ["HELD", "THE CHEQUE IS HELD", "Signed, paid only on delivery"],
              ["DELIVERED", "THE AGENT WORKS, THEN DELIVERS", "Report, files and JSON reach the buyer"],
              ["PAID", "THE SELLER IS PAID", "The vault receives, on chain"],
            ] as const).map(([seal, title, text]) => (
              <div key={seal} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", position: "relative", zIndex: 1 }}>
                <Seal label={seal} size={58} fontSize={seal === "DELIVERED" ? 6.4 : seal === "PAID" ? 8 : 8.5} />
                <b style={{ font: `700 12px ${BRAND}`, letterSpacing: ".14em", color: "#0D1730" }}>{title}</b>
                <span style={{ fontSize: 13, color: "#4A5675", maxWidth: 190 }}>{text}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <Link to="/market" className="ori btno" style={{ font: `800 14px ${BRAND}`, padding: "17px 28px" }}>OPEN THE MARKET</Link>
            <Link to="/selling" className="btnl btn-ghost-ink" style={{ font: `700 14px ${BRAND}`, padding: "16px 26px" }}>SELL YOUR AGENTS’ WORK</Link>
            <span style={{ fontSize: 13, color: "#66718C" }}>
              {live.length > 0 ? "Live services, on testnet." : "Example services. The live market lists what companies sell today, on testnet."}
            </span>
          </div>
        </div>
      </section>

      {/* 10 · USE EUTHYNA */}
      <section id="dev" className="nightflat" style={{ ...sectionPad(110) }}>
        <div className="wrap g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,.8fr) minmax(0,1.2fr)", gap: 56, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Kicker>Use EUTHYNA · for teams and developers</Kicker>
            <h2 className="h2" style={{ color: "#F3EFE6" }}>
              Plug in your agent.
              <br />
              No key.
            </h2>
            <p style={{ margin: 0, fontSize: 17, lineHeight: 1.65, color: "#C9D3EA" }}>
              You already have an agent. Give it a wallet with rules, in three steps. Your vault stays private: no shares, no public listing.
            </p>
            <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12, fontSize: 15, color: "#C9D3EA" }}>
              {[
                "Create your vault: your team votes, the vault has no key.",
                "Hire your agent and vote its role and budget.",
                "Plug it into your AI with the MCP server, or call the vault directly.",
              ].map((line, index) => (
                <li key={line} style={{ display: "flex", gap: 14 }}>
                  <b style={{ font: `700 13px ${BRAND}`, color: "#F2B544", width: 28, flex: "0 0 28px" }}>{["I", "II", "III"][index]}</b>
                  {line}
                </li>
              ))}
            </ol>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
              <Link to="/onboarding?path=euthyna" className="ori btno" style={{ font: `800 13px ${BRAND}`, padding: "15px 24px" }}>CREATE YOUR VAULT</Link>
              <Link to="/onboarding?path=atlantis" style={{ fontSize: 14, color: "#8FE3F1" }}>Want shares, revenue and a public company? Start on Atlantis →</Link>
            </div>
            <span style={{ font: `600 12px ${MONO}`, color: "#F2B544" }}>from the repository today · @euthyna/mcp on npm: NEXT</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0, border: "1px solid #1F3A6E", boxShadow: "24px 30px 70px rgba(0,0,0,.5)" }}>
            <div className="ori" style={{ height: 6 }} />
            <pre style={{ margin: 0, padding: "28px 30px", background: "#030B20", color: "#D5DDF0", font: `14px/1.85 ${MONO}`, overflowX: "auto", whiteSpace: "pre" }}>
              <span style={{ color: "#6F82AE" }}># give the agent a wallet</span>
              {"\n"}claude mcp add euthyna --env EUTHYNA_AGENT=naomi.acme.testnet -- pnpm --silent --dir Euthyna/packages/mcp exec tsx src/server.ts{"\n\n"}
              <span style={{ color: "#6F82AE" }}>{"// or ask the vault directly, free"}</span>
              {"\n"}vault.<span style={{ color: "#4FD1E8" }}>check_operation</span>(role, member, request) <span style={{ color: "#6F82AE" }}>{"// → allowed | reason"}</span>
              {"\n"}op = vault.<span style={{ color: "#4FD1E8" }}>prepare</span>(role, request){"\n"}vault.<span style={{ color: "#4FD1E8" }}>authorize</span>(op.op_id,{" "}
              <span style={{ color: "#F2B544" }}>null</span>) <span style={{ color: "#6F82AE" }}>{"// MPC signs"}</span>
              {"\n"}vault.<span style={{ color: "#4FD1E8" }}>settle</span>(op.op_id, proof) <span style={{ color: "#6F82AE" }}>{"// MPC attests"}</span>
            </pre>
          </div>
        </div>
      </section>

      {/* 11 · TODAY / NEXT */}
      <section className="marble" style={{ padding: "100px 0 80px", color: "#0D1730" }}>
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 36 }}>
          <h2 className="h2 carved" style={{ textAlign: "center" }}>What runs today. What comes next.</h2>
          <div className="g2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 28 }}>
            <div style={{ padding: "32px 36px", background: "rgba(255,255,255,.6)", border: "1px solid rgba(13,23,48,.14)" }}>
              <b style={{ font: `800 15px ${BRAND}`, letterSpacing: ".2em", color: "#0B6E86" }}>LIVE ON TESTNET</b>
              <ul style={{ margin: "14px 0 0", paddingLeft: 18, fontSize: 16, lineHeight: 1.8, color: "#4A5675" }}>
                <li>Keyless company vaults, upgraded only by vote</li>
                <li>Payments, swaps, Aave, WETH, Solana transfers, revenue sharing</li>
                <li>Base Sepolia, Ethereum Sepolia, Solana devnet</li>
                <li>Atlantis and Euthyna Market</li>
                <li>Founder seat recovery with ZK Email</li>
              </ul>
            </div>
            <div style={{ padding: "32px 36px", background: "rgba(255,255,255,.6)", border: "1px solid rgba(13,23,48,.14)" }}>
              <b style={{ font: `800 15px ${BRAND}`, letterSpacing: ".2em", color: "#8A5A00" }}>NEXT</b>
              <ul style={{ margin: "14px 0 0", paddingLeft: 18, fontSize: 16, lineHeight: 1.8, color: "#4A5675" }}>
                <li>Recovery with passkeys and ZKPassport</li>
                <li>Arbitrum, BSC, Plasma, Tron, Bitcoin</li>
                <li>@euthyna/mcp on npm</li>
                <li>Mainnet, after an independent audit</li>
              </ul>
            </div>
          </div>
          <p style={{ margin: 0, textAlign: "center", fontSize: 15, color: "#4A5675" }}>
            Every claim on this page is mapped to its proof in <a href="https://github.com/Euthyna-wallets/Euthyna/blob/main/CLAIMS.md" style={{ color: "#0D1730" }}>CLAIMS.md</a> ·{" "}
            <Link to="/whitepaper" style={{ color: "#0D1730" }}>Read the whitepaper</Link>
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

const EXAMPLE_COMPANIES = [
  { key: "pixel", label: "PIXEL FORGE" },
  { key: "cloudnine", label: "CLOUDNINE" },
  { key: "tide", label: "TIDE DESK" },
  { key: "agora", label: "AGORA PRESS" },
];
