import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Kicker, PageTitle, SectionHead, Slab } from "../components/design.js";
import { short } from "../components/ui.js";
import { omni } from "../omniroles-api.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { DirectoryCard } from "./DirectoryCard.js";
import { RecoveryCard } from "./RecoveryCard.js";
import { VersionCard } from "./VersionCard.js";

const LINKS = [
  { to: "/onboarding", kicker: "Company", text: "Resume or review the company setup.", action: "OPEN SETUP →" },
  { to: "/shares", kicker: "Shares", text: "Company shares, revenue distribution and voting power.", action: "OPEN OWNERS →" },
  { to: "/suppliers", kicker: "Suppliers", text: "Approved recipients. Changes need a members' vote.", action: "MANAGE →" },
];

const RECOVERY_FACTORS = [
  { name: "ZK EMAIL", text: "A proof from your inbox. Live on testnet for founder seats.", live: true },
  { name: "PASSKEY", text: "Your phone signs. Next.", live: false },
  { name: "ZKPASSPORT", text: "Proves it’s you, shares nothing. Next.", live: false },
  { name: "TRUSTED CONTACT", text: "Someone you chose signs. Next.", live: false },
];

export function SettingsPage() {
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const treasury = status.data?.treasury;
  const checks = status.data?.checks ?? [];
  const failed = checks.filter((check) => !check.ok).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
        <span style={{ font: "600 12px var(--font-ui)", color: "#66718C" }}>Company administration</span>
        <PageTitle>SETTINGS</PageTitle>
        <p style={{ margin: 0, fontSize: 14, color: "#4A5675", maxWidth: 820 }}>
          Company setup, security checks, shares and suppliers. Members, rules and pauses are decided in Votes.
        </p>
      </header>

      <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            {status.isLoading ? (
              <div className="loading-slab" style={{ minHeight: 320 }} aria-label="Loading security checks" />
            ) : treasury ? (
              <Slab style={{ padding: "18px 22px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                <SectionHead
                  left={<Kicker>Security</Kicker>}
                  right={
                    <span style={{ fontSize: 12, fontWeight: 700, color: treasury.status === "active" ? "var(--aegean-ink)" : "var(--gold-ink)" }}>
                      ● {treasury.status === "active" ? "active" : "pending"}
                    </span>
                  }
                />
                <span style={{ fontSize: 13, color: "#4A5675" }}>On-chain checks of the company: who owns the vault, which code it runs, which keys can act.</span>
                <div className="g2" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10, margin: "4px 0" }}>
                  <div style={{ padding: "10px 12px", background: "rgba(6,20,51,.05)", minWidth: 0 }}>
                    <Kicker color="#66718C" style={{ fontSize: 10 }}>DAO</Kicker>
                    <b style={{ display: "block", marginTop: 4, font: "12px var(--font-mono)", overflowWrap: "anywhere" }}>{treasury.daoAccountId}</b>
                  </div>
                  <div style={{ padding: "10px 12px", background: "rgba(6,20,51,.05)", minWidth: 0 }}>
                    <Kicker color="#66718C" style={{ fontSize: 10 }}>Vault</Kicker>
                    <b style={{ display: "block", marginTop: 4, font: "12px var(--font-mono)", overflowWrap: "anywhere" }}>{treasury.vaultAccountId}</b>
                  </div>
                </div>
                <b style={{ fontSize: 14, color: failed ? "var(--terra-ink)" : "var(--aegean-ink)" }}>
                  {failed ? "⚠" : "✓"} {checks.length - failed} of {checks.length} on-chain checks pass
                </b>
                <div>
                  {checks.map((check) => (
                    <div key={check.label} style={{ display: "grid", gridTemplateColumns: "30px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13.5 }}>
                      <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--seal)", boxShadow: "inset 0 0 0 2px rgba(255,236,196,.28), inset 0 -2px 4px rgba(40,18,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", font: "800 11px var(--font-brand)", color: check.ok ? "#0B4E5E" : "#6E1C0A" }}>
                        {check.ok ? "✓" : "✗"}
                      </span>
                      <span style={{ minWidth: 0 }}>{check.label}</span>
                      <span style={{ font: "11.5px var(--font-mono)", color: "#66718C", textAlign: "right", overflowWrap: "anywhere" }}>
                        {check.ok ? short(check.actual, 14) : `expected ${short(check.expected, 14)}, found ${short(check.actual, 14)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </Slab>
            ) : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <VersionCard />
            <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
              {LINKS.map((link) => (
                <Link key={link.to} to={link.to} className="slab" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 6, textDecoration: "none", color: "var(--ink)" }}>
                  <Kicker>{link.kicker}</Kicker>
                  <span style={{ fontSize: 12.5, color: "#4A5675" }}>{link.text}</span>
                  <b style={{ font: "700 11px var(--font-brand)", letterSpacing: ".16em", marginTop: "auto", color: "var(--ink)" }}>{link.action}</b>
                </Link>
              ))}
            </div>
            <DirectoryCard />
          </div>
        </div>

        <Slab className="g2" style={{ display: "grid", gridTemplateColumns: "170px minmax(0, 1fr)", gap: 22, padding: "18px 22px", border: "1px dashed rgba(201,137,12,.55)", boxShadow: "none", alignItems: "start" }}>
          <div
            role="img"
            aria-label="A broken marble seal rejoined with gold"
            style={{ height: 170, background: "#061433 url(/media/renders/R7-recovery-seal.jpg) center/cover no-repeat", boxShadow: "10px 12px 24px rgba(13,23,48,.25)" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Kicker>Recover your access</Kicker>
              <span style={{ font: "800 10px var(--font-brand)", letterSpacing: ".2em", padding: "4px 9px", background: "var(--gold-bg)", color: "var(--gold-ink)", border: "1px solid rgba(201,137,12,.4)" }}>
                ZK EMAIL · TESTNET
              </span>
            </div>
            <span style={{ fontSize: 13.5, color: "#4A5675", lineHeight: 1.55 }}>
              Company wallets cannot be lost: they have no private key. What you can lose is your own key, and with it your seat. Today a
              founder enrolls their mailbox with ZK Email; a new account that proves the same mailbox asks for the seat, and a NEAR contract
              verifies both proofs. The lost account can cancel during a waiting period (1 minute on testnet, 48 hours on mainnet), then the
              other founders vote. More factors come next.
            </span>
            <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}>
              {RECOVERY_FACTORS.map((factor) => (
                <div key={factor.name} style={{ padding: "12px 14px", border: factor.live ? "1px solid rgba(11,78,94,.45)" : "1px dashed rgba(13,23,48,.28)", display: "flex", flexDirection: "column", gap: 4, background: "rgba(255,255,255,.35)" }}>
                  <b style={{ font: "800 12.5px var(--font-brand)", letterSpacing: ".14em" }}>{factor.name}</b>
                  <span style={{ fontSize: 12, color: "#4A5675" }}>{factor.text}</span>
                </div>
              ))}
            </div>
          </div>
        </Slab>

      {treasury?.status === "active" ? <RecoveryCard /> : null}

      {demoWalletsEnabled() ? (
        <Slab style={{ padding: "14px 18px" }}>
          <details>
            <summary style={{ cursor: "pointer", font: "700 12px var(--font-brand)", letterSpacing: ".12em" }}>Developer · UAT demo tools</summary>
            <p style={{ fontSize: 13, color: "#4A5675" }}>Generated wallets, faucet shortcuts and bridge helpers are test-only.</p>
            <Link to="/onboarding?developer=1" style={{ font: "700 11px var(--font-brand)", letterSpacing: ".16em", color: "var(--ink)" }}>Open UAT tools →</Link>
          </details>
        </Slab>
      ) : null}
    </div>
  );
}
