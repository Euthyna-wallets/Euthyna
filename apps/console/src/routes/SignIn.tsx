import { useEffect, useState } from "react";

import { API_BASE } from "../api.js";
import { Kicker, PageTitle, Slab } from "../components/design.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { connectNearWallet, nearAccounts, signNearMessage, switchNearWallet } from "../wallets.js";

async function authPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as { message?: string } & T;
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

const INTRO_LINES = [
  "Members vote the rules in a NEAR DAO",
  "A vault checks every agent request against them",
  "No key on our servers can move company funds",
];

const NUMERALS = ["I", "II", "III"];

/** The console identity is a NEAR account: the one the person votes with in the company DAO. */
export function SignIn() {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const read = async () => {
      const accounts = await nearAccounts().catch(() => []);
      if (!stop) setAccount(accounts[0] ?? null);
    };
    void read();
    const interval = window.setInterval(() => void read(), 1_500);
    return () => {
      stop = true;
      window.clearInterval(interval);
    };
  }, []);

  async function signIn(accountId: string) {
    setBusy(true);
    setError(null);
    try {
      const challenge = await authPost<{ message: string; nonceBase64: string; recipient: string }>("/near/challenge", { accountId });
      const signed = await signNearMessage(challenge);
      if (signed.accountId !== accountId) throw new Error(`The wallet signed as ${signed.accountId}, not ${accountId}`);
      await authPost("/sign-in/near", { accountId, publicKey: signed.publicKey, signature: signed.signature, nonceBase64: challenge.nonceBase64 });
      window.location.assign(window.location.pathname === "/" ? "/onboarding" : window.location.pathname);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const demo = demoWalletsEnabled();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
        fontFamily: "var(--font-ui)",
        color: "var(--ink)",
      }}
    >
      {/* The R8 column is not in this build: the marble column texture carries the light. */}
      <aside
        className="col"
        style={{
          position: "relative",
          overflow: "hidden",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 48,
          padding: "40px 56px 56px",
          boxShadow: "none",
          color: "#E7ECF6",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "linear-gradient(180deg, rgba(3,9,24,.72) 0%, rgba(3,9,24,.45) 30%, rgba(3,9,24,.82) 72%, rgba(3,9,24,.96) 100%), linear-gradient(90deg, rgba(3,9,24,.15) 0%, rgba(3,9,24,0) 40%, rgba(3,9,24,.55) 100%)",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 12,
            font: "700 18px var(--font-brand)",
            letterSpacing: ".24em",
            color: "#F3EFE6",
          }}
        >
          <svg width="30" height="30" viewBox="0 0 1024 1024" aria-hidden="true">
            <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
            <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
            <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
            <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
          </svg>
          EUTHYNA
        </div>

        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 22, maxWidth: 560 }}>
          <h2 style={{ margin: 0, font: "900 clamp(34px, 3.6vw, 52px)/1.02 var(--font-brand)", letterSpacing: ".02em" }}>
            <span
              style={{
                backgroundImage: "url(/media/textures/orichalcum.jpg)",
                backgroundSize: "100% 240%",
                backgroundPosition: "0 32%",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              AI AGENTS MOVE COMPANY FUNDS.
            </span>
            <br />
            <span style={{ color: "#F3EFE6" }}>HUMANS SET THE LIMITS.</span>
          </h2>
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12, fontSize: 16, color: "#C9D3EA" }}>
            {INTRO_LINES.map((line, index) => (
              <li key={line} style={{ display: "flex", gap: 16 }}>
                <b style={{ font: "700 14px var(--font-brand)", color: "#F2B544", width: 26, flex: "0 0 auto" }}>{NUMERALS[index]}</b>
                {line}
              </li>
            ))}
          </ol>
          <a href="/" style={{ font: "700 13px var(--font-brand)", letterSpacing: ".2em", color: "#8FE3F1", textDecoration: "none" }}>
            EXPLORE THE AI COMPANIES →
          </a>
        </div>
      </aside>

      <main
        style={{
          position: "relative",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(28px, 4vw, 40px)",
          backgroundColor: "var(--marble)",
          backgroundImage: "linear-gradient(rgba(246,242,235,.86), rgba(246,242,235,.86)), url(/media/textures/marble-white.jpg)",
          backgroundSize: "cover, cover",
        }}
      >
        <span style={{ position: "absolute", top: 34, right: 40, font: "600 11px var(--font-mono)", letterSpacing: ".08em", color: "var(--ink-3)" }}>
          TESTNET · NOT AUDITED
        </span>

        <Slab
          as="div"
          style={{
            width: "min(440px, 100%)",
            boxSizing: "border-box",
            padding: "44px 44px 36px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
            boxShadow: "26px 30px 60px rgba(13,23,48,.22), inset 0 0 0 1px rgba(13,23,48,.08)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Kicker>Enter the assembly</Kicker>
              {demo ? (
                <span
                  title="UAT demo mode: test-only private keys are stored in this browser."
                  style={{
                    marginLeft: "auto",
                    font: "700 10px var(--font-brand)",
                    letterSpacing: ".14em",
                    border: "1px solid rgba(13,23,48,.2)",
                    padding: "3px 8px",
                    color: "var(--ink-2)",
                  }}
                >
                  TEST MODE
                </span>
              ) : null}
            </div>
            <PageTitle style={{ fontSize: 46 }}>SIGN IN</PageTitle>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--ink-2)" }}>
              With the NEAR account you vote with. You sign a message: it is free and sends no transaction.
            </p>
          </div>

          {account ? (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                  background: "rgba(255,255,255,.7)",
                  border: "1px solid rgba(13,23,48,.14)",
                }}
              >
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: "50%",
                    flex: "0 0 auto",
                    background: accountColor(account),
                    color: "#F3EFE6",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 800,
                  }}
                  aria-hidden="true"
                >
                  {account.slice(0, 1).toUpperCase()}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <small style={{ fontSize: 12, color: "var(--ink-3)" }}>Connected wallet</small>
                  <b title={account} style={{ font: "600 14px var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {shortAccount(account)}
                  </b>
                </span>
                {demo ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAccount(null);
                      void switchNearWallet().catch((cause: unknown) => setError(String(cause)));
                    }}
                    style={{
                      marginLeft: "auto",
                      background: "none",
                      border: 0,
                      padding: 0,
                      font: "600 13px var(--font-ui)",
                      color: "var(--ink-2)",
                      cursor: busy ? "not-allowed" : "pointer",
                    }}
                  >
                    Change
                  </button>
                )}
              </div>
              <button
                type="button"
                className="btn-ori"
                style={{ width: "100%", padding: "17px" }}
                disabled={busy}
                onClick={() => void signIn(account)}
              >
                {busy ? "CONFIRM IN YOUR WALLET…" : "SIGN IN"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-ori"
              style={{ width: "100%", padding: "17px" }}
              disabled={busy}
              onClick={() => void connectNearWallet().catch((cause: unknown) => setError(String(cause)))}
            >
              CONNECT A NEAR WALLET
            </button>
          )}

          {error ? (
            <div style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }} role="alert">
              {error}
            </div>
          ) : null}

          <p style={{ margin: 0, paddingTop: 18, borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-2)" }}>
            New company? Sign in, then create it. Joining one? Ask the founder to add your NEAR account.
          </p>
        </Slab>
      </main>
    </div>
  );
}

/** Implicit accounts are 64 hex characters: keep the ends. Named accounts are cut by CSS. */
function shortAccount(accountId: string): string {
  return /^[0-9a-f]{64}$/.test(accountId) ? `${accountId.slice(0, 6)}…${accountId.slice(-6)}` : accountId;
}

/** A stable colour per account, so a member recognises theirs at a glance. */
function accountColor(accountId: string): string {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 45% 42%)`;
}
