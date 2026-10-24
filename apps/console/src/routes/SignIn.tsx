import { useEffect, useState } from "react";

import { API_BASE } from "../api.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { connectNearWallet, nearAccounts, signNearMessage } from "../wallets.js";

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
      </aside>
      <div className="auth-card">
        <div className="brand">MandateOS</div>
        <h1>Sign in with NEAR</h1>
        <p className="muted">
          Use the NEAR account you vote with. Signing a message proves it is yours; it costs nothing and sends no transaction.
        </p>
        {demoWalletsEnabled() ? <div className="alert error">UAT DEMO MODE — test-only private keys are stored in this browser.</div> : null}
        {error ? <div className="alert error">{error}</div> : null}
        {account ? (
          <>
            <div className="notice">Wallet connected: <strong className="mono">{account}</strong></div>
            <button className="primary" disabled={busy} onClick={() => void signIn(account)}>
              {busy ? "Waiting for the wallet signature…" : `Sign in as ${account}`}
            </button>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void connectNearWallet().catch((cause: unknown) => setError(String(cause)))}>
            Connect NEAR wallet
          </button>
        )}
        <p className="small muted">
          New company? Sign in, then create it. Joining one? Ask the founder to add your NEAR account, then sign in here.
        </p>
      </div>
    </div>
  );
}
