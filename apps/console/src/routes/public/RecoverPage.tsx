import { useState } from "react";

import { API_BASE } from "../../api.js";
import { authClient } from "../../auth.js";
import { proveEmailFile, recoverySubject } from "../../lib/email-proof.js";
import { EmailProofStep } from "../RecoveryCard.js";
import { SignIn } from "../SignIn.js";

/** A founder who lost their NEAR account asks for their seat, signed in with a new one. */
export function RecoverPage() {
  const session = authClient.useSession();
  const [dao, setDao] = useState("");
  const [lost, setLost] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (session.isPending) return <div className="state">Loading session…</div>;
  if (!session.data) return <SignIn />;
  // A NEAR user's email is "<account>@near.mandateos.invalid": the account the API sees.
  const me = session.data.user.email.replace(/@near\.mandateos\.invalid$/, "");

  async function ask(file: File | string) {
    setBusy(true);
    setMessage(null);
    try {
      const { evidence } = await proveEmailFile(file, setMessage);
      setMessage("Checking the proof…");
      const response = await fetch(`${API_BASE}/v1/recovery/requests`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ daoAccountId: dao.trim(), lostAccountId: lost.trim(), evidence }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; notBefore?: string };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      setMessage(`Request recorded. ${lost.trim()} can cancel it until ${new Date(body.notBefore!).toLocaleString()}; after that, the other founders vote to give you the seat.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Seat recovery</span>
          <h1>Recover your founder seat</h1>
          <p className="muted">
            Signed in as <strong className="mono">{me}</strong>, the account that will take the seat. Prove with an email
            that you hold the mailbox the founder enrolled. Nothing changes until the other founders vote.
          </p>
        </div>
      </header>
      <div className="panel stack">
        <label>Company DAO <input value={dao} onChange={(event) => setDao(event.target.value)} placeholder="mycompany.sputnikv2.testnet" /></label>
        <label>Lost founder account <input value={lost} onChange={(event) => setLost(event.target.value)} placeholder="me.testnet" /></label>
        {dao.trim() && lost.trim() ? <EmailProofStep subject={recoverySubject("recovery", me)} busy={busy} onFile={(file) => void ask(file)} /> : null}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </div>
  );
}
