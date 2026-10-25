import { useEffect, useState } from "react";

import { API_BASE } from "../api.js";
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
    <div className="auth">
      <aside className="auth-intro">
        <div className="brand">MandateOS</div>
        <h2>AI agents move company funds. Humans set the limits.</h2>
        <ul>
          <li>Members vote the rules in a NEAR DAO</li>
          <li>A vault checks every agent request against them</li>
          <li>No key on our servers can move company funds</li>
        </ul>
        <a className="text-action" href="/explore">Explore the AI companies →</a>
      </aside>
      <div className="auth-card">
        <div className="auth-head">
          <span className="brand">MandateOS</span>
          {demo ? <span className="test-pill" title="UAT demo mode: test-only private keys are stored in this browser.">Test mode</span> : null}
        </div>
        <h1>Sign in</h1>
        <p className="muted">With the NEAR account you vote with. You sign a message: it is free and sends no transaction.</p>
        {account ? (
          <>
            <div className="account-chip" title={account}>
              <span className="account-avatar" style={{ background: accountColor(account) }} aria-hidden="true">{account.slice(0, 1).toUpperCase()}</span>
              <span className="account-text">
                <span className="account-label">Connected wallet</span>
                <span className="account-id mono">{shortAccount(account)}</span>
              </span>
              {demo ? null : (
                <button className="link-button" type="button" disabled={busy} onClick={() => { setAccount(null); void switchNearWallet().catch((cause: unknown) => setError(String(cause))); }}>Change</button>
              )}
            </div>
            <button className="primary block" disabled={busy} onClick={() => void signIn(account)}>
              {busy ? "Confirm in your wallet…" : "Sign in"}
            </button>
          </>
        ) : (
          <button className="primary block" disabled={busy} onClick={() => void connectNearWallet().catch((cause: unknown) => setError(String(cause)))}>
            Connect a NEAR wallet
          </button>
        )}
        {error ? <div className="alert error auth-error">{error}</div> : null}
        <p className="auth-foot">
          New company? Sign in, then create it. Joining one? Ask the founder to add your NEAR account.
        </p>
      </div>
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
