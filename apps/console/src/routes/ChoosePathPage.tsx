/**
 * After sign-in, before any company exists: the two paths.
 * Visual reference: design-handoff/app/source/16-choose-your-path.html.
 * No data: the page only writes the path into the onboarding link.
 */
import { Link } from "react-router-dom";

import { authClient } from "../auth.js";
import { Kicker, PageTitle } from "../components/design.js";
import "../styles/app.css";

const EUTHYNA_LINES = [
  "Your team votes the rules; the vault has no key",
  "Hire your agent and vote its role and budget",
  "Plug it into your AI with the MCP server",
];

const ATLANTIS_LINES = [
  "Everything in EUTHYNA",
  "Shares anyone can buy; holders who vote share the revenue",
  "Listed in the city, by a members’ vote",
  "Sell your agents’ work on Euthyna Market",
];

const NUMERALS = ["I", "II", "III", "IV"];

export function ChoosePathPage() {
  const session = authClient.useSession();
  const who = session.data?.user.name ?? "member";
  const initial = who.slice(0, 1).toUpperCase();

  return (
    <div
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-ui)",
        backgroundColor: "#061433",
        color: "#E7ECF6",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "28px clamp(20px, 3.5vw, 56px)", flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 12, font: "700 17px var(--font-brand)", letterSpacing: ".24em", color: "#F3EFE6" }}>
          <svg width="28" height="28" viewBox="0 0 1024 1024" aria-hidden="true">
            <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
            <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
            <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
            <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
          </svg>
          EUTHYNA
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#C9D3EA", minWidth: 0 }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              flex: "0 0 auto",
              background: "var(--gold)",
              color: "#061433",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 11,
            }}
            aria-hidden="true"
          >
            {initial}
          </span>
          <span style={{ font: "600 13px var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>{who}</span>{" · signed in"}
        </span>
      </header>

      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 10, padding: "6px clamp(20px, 3.5vw, 56px) 26px" }}>
        <Kicker color="#F2B544" style={{ display: "inline-block" }}>
          Welcome · testnet
        </Kicker>
        <PageTitle style={{ color: "#F3EFE6", textShadow: "none", fontSize: 44, lineHeight: 1.05 }}>WHAT DO YOU WANT TO DO?</PageTitle>
        <span style={{ fontSize: 15.5, color: "#A9B6D6" }}>
          Same vault, same rules underneath. You can join Atlantis later: issuing shares and listing are votes.
        </span>
      </div>

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
          gap: "clamp(18px, 2vw, 28px)",
          padding: "0 clamp(20px, 3.5vw, 56px) clamp(28px, 4vw, 48px)",
          alignItems: "stretch",
        }}
      >
        <Link
          to="/onboarding?path=euthyna"
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 14,
            padding: "clamp(22px, 2.4vw, 34px) clamp(22px, 2.8vw, 40px)",
            borderRadius: "260px 260px 2px 2px",
            boxShadow: "0 0 0 1px rgba(243,239,230,.5), 26px 30px 70px rgba(0,0,0,.5)",
            textDecoration: "none",
            color: "#0D1730",
            backgroundColor: "#F3EFE7",
            backgroundImage:
              "linear-gradient(180deg, rgba(246,242,235,.2) 0%, rgba(246,242,235,.92) 42%, rgba(246,242,235,.97) 100%), url(/media/renders/R4-vault-door.jpg)",
            backgroundSize: "cover, cover",
            backgroundPosition: "0 0, center 30%",
          }}
        >
          <Kicker color="#8A5A00">Use EUTHYNA · the infrastructure</Kicker>
          <b style={{ color: "#8E8473", textShadow: "0 1px 0 rgba(255,255,255,.95), 0 -1px 0 rgba(60,48,34,.45)", font: "900 clamp(32px, 3.2vw, 46px)/1 var(--font-brand)", letterSpacing: ".08em" }}>
            EUTHYNA
          </b>
          <span style={{ font: "700 21px/1.3 var(--font-ui)" }}>Give your agent a wallet with rules.</span>
          <span style={{ fontSize: 14, color: "#4A5675" }}>For a team or a developer who already has an agent.</span>
          <div style={{ borderTop: "1px solid rgba(13,23,48,.15)", paddingTop: 8 }}>
            {EUTHYNA_LINES.map((line, index) => (
              <div key={line} style={{ display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", gap: 10, fontSize: 14.5, padding: "5px 0" }}>
                <b style={{ font: "700 12px var(--font-brand)", color: "#8A5A00" }}>{NUMERALS[index]}</b>
                <span>{line}</span>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", gap: 10, fontSize: 14.5, padding: "5px 0" }}>
              <b style={{ font: "700 12px var(--font-brand)", color: "#8A5A00" }}>·</b>
              <span>Private: no shares, not listed in the city</span>
            </div>
          </div>
          <span className="btn-ori" style={{ alignSelf: "flex-start", marginTop: 6, padding: "14px 22px", fontSize: 13 }}>
            CREATE YOUR VAULT
          </span>
          <span style={{ fontSize: 12.5, color: "#66718C" }}>7 steps · about 5 minutes on testnet</span>
        </Link>

        <Link
          to="/onboarding?path=atlantis"
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 14,
            padding: "clamp(22px, 2.4vw, 34px) clamp(22px, 2.8vw, 40px)",
            borderRadius: "260px 260px 2px 2px",
            boxShadow: "0 0 0 1px rgba(242,181,68,.4), 26px 30px 70px rgba(0,0,0,.5)",
            textDecoration: "none",
            color: "#E7ECF6",
            backgroundColor: "#030918",
            backgroundImage:
              "linear-gradient(180deg, rgba(3,9,24,.15) 0%, rgba(3,9,24,.9) 42%, rgba(3,9,24,.97) 100%), url(/media/renders/R3-atlantis-aerial.jpg)",
            backgroundSize: "cover, cover",
            backgroundPosition: "0 0, center 40%",
          }}
        >
          <Kicker color="#4FD1E8">Launch on Atlantis · built with EUTHYNA</Kicker>
          <b
            style={{
              font: "900 clamp(32px, 3.2vw, 46px)/1 var(--font-brand)",
              letterSpacing: ".08em",
              backgroundImage: "url(/media/textures/orichalcum.jpg)",
              backgroundSize: "100% 240%",
              backgroundPosition: "0 32%",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            ATLANTIS
          </b>
          <span style={{ font: "700 21px/1.3 var(--font-ui)", color: "#F3EFE6" }}>Start a company whose employees are AI agents.</span>
          <span style={{ fontSize: 14, color: "#A9B6D6" }}>For founders who start from zero and want owners, revenue and a place in the city.</span>
          <div style={{ borderTop: "1px solid rgba(242,181,68,.3)", paddingTop: 8, color: "#C9D3EA" }}>
            {ATLANTIS_LINES.map((line, index) => (
              <div key={line} style={{ display: "grid", gridTemplateColumns: "24px minmax(0, 1fr)", gap: 10, fontSize: 14.5, padding: "5px 0" }}>
                <b style={{ font: "700 12px var(--font-brand)", color: "#F2B544" }}>{NUMERALS[index]}</b>
                <span>{line}</span>
              </div>
            ))}
          </div>
          <span className="btn-ori" style={{ alignSelf: "flex-start", marginTop: 6, padding: "14px 22px", fontSize: 13 }}>
            FOUND A COMPANY
          </span>
          <span style={{ fontSize: 12.5, color: "#8FA2CC" }}>8 steps · the vault, then shares and the city</span>
        </Link>
      </div>
    </div>
  );
}
