import { useState } from "react";

import { authClient } from "../../auth.js";
import { enrollmentOf, proveEmailFile, RECOVERY_CONTRACT_ID, recoverySubject } from "../../lib/email-proof.js";
import { signContractCall, viewContract } from "../../wallets.js";
import { EmailProofStep, RECOVERY_DEPOSIT, RECOVERY_GAS } from "../RecoveryCard.js";
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
      const daoId = dao.trim();
      const lostId = lost.trim();
      // The recovery proof must use the salt the founder enrolled with: read it from the contract.
      const enrollment = await enrollmentOf(daoId, lostId);
      if (!enrollment) throw new Error(`${lostId} never enrolled a mailbox for this DAO`);
      const { proof } = await proveEmailFile(file, `0x${enrollment.salt}`, setMessage);
      setMessage("Sign the request in your wallet: the contract checks the proof…");
      await signContractCall(me, RECOVERY_CONTRACT_ID, "request", { dao_id: daoId, lost_account_id: lostId, ...proof }, { deposit: RECOVERY_DEPOSIT, gas: RECOVERY_GAS });
      // Views read final blocks: the request shows up a few seconds after the transaction.
      let open: { not_before_ns: string } | null = null;
      for (let attempt = 0; attempt < 6 && !open; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
        open = await viewContract<{ not_before_ns: string } | null>(RECOVERY_CONTRACT_ID, "recovery", { dao_id: daoId, lost_account_id: lostId }).catch(() => null);
      }
      const until = open ? new Date(Number(BigInt(open.not_before_ns) / 1_000_000n)).toLocaleString() : "the end of the waiting period";
      setMessage(`Request recorded on chain. ${lostId} can cancel it until ${until}; after that, the other founders vote to give you the seat.`);
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
            that you hold the mailbox the founder enrolled: the recovery contract on NEAR verifies the proof, and you sign the
            request with this account. Nothing changes until the other founders vote.
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
