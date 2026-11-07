import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { authClient } from "../../auth.js";
import { Kicker, PageTitle, Slab } from "../../components/design.js";
import { type ContractProof, enrollmentOf, proveEmailFile, RECOVERY_CONTRACT_ID, recoverySubject } from "../../lib/email-proof.js";
import { recoveryErrorText } from "../../lib/recovery-errors.js";
import { disconnectNearWallet, signContractCall, viewContract } from "../../wallets.js";
import { EmailProofStep, type ProvedCall, RECOVERY_DEPOSIT, RECOVERY_GAS, SignProvedStep } from "../RecoveryCard.js";
import { SignIn } from "../SignIn.js";

const EXPLORER = "https://testnet.nearblocks.io";
const NUMERALS = ["I", "II", "III"];

type Seat = { daoId: string; lostId: string; salt: string; domain: string };

/** "10 minutes", "48 hours". */
function waitText(seconds: number | undefined): string {
  if (!seconds) return "the waiting period";
  return seconds >= 7200 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 60)} minutes`;
}

/**
 * A founder who lost their NEAR account asks for their seat, signed in with a new one.
 * Layout of design-handoff/app/screens/00-sign-in: a night render on the left, the form on marble.
 */
export function RecoverPage() {
  const session = authClient.useSession();
  const delay = useQuery({
    queryKey: ["recovery-delay", RECOVERY_CONTRACT_ID],
    queryFn: () => viewContract<string>(RECOVERY_CONTRACT_ID, "delay_seconds", {}).then(Number),
    staleTime: Infinity,
  });
  const [dao, setDao] = useState("");
  const [lost, setLost] = useState("");
  const [seat, setSeat] = useState<Seat | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proved, setProved] = useState<ProvedCall | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (session.isPending) return <div className="state">Loading session…</div>;
  if (!session.data) {
    return (
      <SignIn
        aside={<RecoverAside wait={waitText(delay.data)} />}
        kicker="Seat recovery"
        intro="With your new NEAR account: the one that will take the seat, not the one you lost. You sign a message: it is free and sends no transaction."
        footer="No new account yet? Create one in your NEAR wallet, then come back here. The lost account is not needed."
      />
    );
  }
  // A NEAR user's email is "<account>@near.mandateos.invalid": the account the API sees.
  const me = session.data.user.email.replace(/@near\.mandateos\.invalid$/, "");
  const wait = waitText(delay.data);

  async function step(action: () => Promise<string | void>) {
    setBusy(true);
    setError(null);
    try {
      const text = await action();
      if (text) setMessage(text);
    } catch (cause) {
      setMessage(null);
      setError(recoveryErrorText(cause));
    } finally {
      setBusy(false);
    }
  }

  // Step I: the seat must have an enrolled mailbox, read from the contract before any proof.
  const findSeat = () => step(async () => {
    setSeat(null);
    setProved(null);
    const daoId = dao.trim();
    const lostId = lost.trim();
    if (lostId === me) throw new Error("Sign in with your new account: the lost one cannot ask for its own seat");
    const enrollment = await enrollmentOf(daoId, lostId);
    if (!enrollment) throw new Error(`${lostId} never enrolled a mailbox for ${daoId}`);
    setSeat({ daoId, lostId, salt: enrollment.salt, domain: enrollment.domain });
  });

  // Step II: prove the email with the salt the founder enrolled with.
  const prove = (file: File | string) => step(async () => {
    if (!seat) return;
    setProved(null);
    const { proof } = await proveEmailFile(file, `0x${seat.salt}`, setMessage);
    setProved({ what: `Request for ${seat.lostId}'s seat`, sign: () => send(seat, proof) });
    return "Proof ready. Sign the request: the contract checks the proof.";
  });

  // Step III: the new account signs the request.
  async function send(target: Seat, proof: ContractProof): Promise<string> {
    await signContractCall(me, RECOVERY_CONTRACT_ID, "request", { dao_id: target.daoId, lost_account_id: target.lostId, ...proof }, { deposit: RECOVERY_DEPOSIT, gas: RECOVERY_GAS });
    setProved(null);
    // Views read final blocks: the request shows up a few seconds after the transaction.
    let open: { not_before_ns: string } | null = null;
    for (let attempt = 0; attempt < 6 && !open; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
      open = await viewContract<{ not_before_ns: string } | null>(RECOVERY_CONTRACT_ID, "recovery", { dao_id: target.daoId, lost_account_id: target.lostId }).catch(() => null);
    }
    const until = open ? new Date(Number(BigInt(open.not_before_ns) / 1_000_000n)).toLocaleString() : `the end of the ${wait}`;
    setDone(until);
    setMessage(null);
    return "";
  }

  const current = done ? 3 : proved ? 2 : seat ? 1 : 0;
  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", fontFamily: "var(--font-ui)", color: "var(--ink)" }}>
      <RecoverAside wait={wait} />

      <main
        style={{
          position: "relative",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(64px, 6vw, 80px) clamp(16px, 4vw, 40px) clamp(28px, 4vw, 40px)",
          backgroundColor: "var(--marble)",
          backgroundImage: "linear-gradient(rgba(246,242,235,.86), rgba(246,242,235,.86)), url(/media/textures/marble-white.jpg)",
          backgroundSize: "cover, cover",
        }}
      >
        <span style={{ position: "absolute", top: 34, right: 40, font: "600 11px var(--font-mono)", letterSpacing: ".08em", color: "var(--ink-3)" }}>TESTNET · NOT AUDITED</span>
        <Slab as="div" style={{ width: "min(560px, 100%)", boxSizing: "border-box", padding: "clamp(24px, 4vw, 40px)", display: "flex", flexDirection: "column", gap: 20, boxShadow: "26px 30px 60px rgba(13,23,48,.22), inset 0 0 0 1px rgba(13,23,48,.08)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Kicker>Seat recovery · ZK Email</Kicker>
            <PageTitle style={{ fontSize: "clamp(30px, 4vw, 40px)" }}>Recover your seat</PageTitle>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", background: "rgba(255,255,255,.7)", border: "1px solid rgba(13,23,48,.14)" }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <small style={{ fontSize: 12, color: "var(--ink-3)" }}>Your new account · it takes the seat and signs the request</small>
              <b title={me} style={{ font: "600 14px var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me}</b>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void authClient.signOut().then(disconnectNearWallet).then(() => window.location.reload())}
              style={{ marginLeft: "auto", background: "none", border: 0, padding: 0, font: "600 13px var(--font-ui)", color: "var(--ink-2)", textDecoration: "underline", cursor: "pointer" }}
            >
              Change
            </button>
          </div>

          <Step index={0} current={current} title="The seat" summary={seat ? <>{seat.lostId} in {seat.daoId} · mailbox at <b>{seat.domain}</b></> : null} onEdit={done ? undefined : () => { setSeat(null); setProved(null); setMessage(null); setError(null); }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <div className="field-app">
                <label htmlFor="recover-dao">Company DAO</label>
                <input id="recover-dao" value={dao} onChange={(event) => setDao(event.target.value)} placeholder="mycompany.sputnikv2.testnet" autoComplete="off" />
              </div>
              <div className="field-app">
                <label htmlFor="recover-lost">Lost founder account</label>
                <input id="recover-lost" value={lost} onChange={(event) => setLost(event.target.value)} placeholder="me.testnet" autoComplete="off" />
              </div>
            </div>
            <button type="button" className="btn-ori" style={{ alignSelf: "flex-start" }} disabled={busy || !dao.trim() || !lost.trim()} onClick={() => void findSeat()}>
              {busy ? "READING THE CONTRACT…" : "CONTINUE"}
            </button>
          </Step>

          <Step index={1} current={current} title="The email" summary={proved ? <>Proof made in your browser</> : null}>
            <EmailProofStep subject={recoverySubject("recovery", me)} busy={busy} onFile={(file) => void prove(file)} domain={seat?.domain} />
          </Step>

          <Step index={2} current={current} title="The request" summary={done ? <>Recorded on chain</> : null}>
            {proved ? <SignProvedStep proved={proved} busy={busy} onSign={() => void step(proved.sign)} /> : null}
          </Step>

          {done ? (
            <div role="status" style={{ border: "1px solid rgba(26,127,140,.4)", background: "rgba(26,127,140,.07)", padding: "14px 16px", fontSize: 14, lineHeight: 1.6 }}>
              <b>Request recorded.</b> {seat?.lostId} can cancel it until {done}. After that, the other founders of {seat?.daoId} vote to give you the seat.
            </div>
          ) : null}
          {message ? <p role="status" style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>{message}</p> : null}
          {error ? (
            <div role="alert" style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(217,87,59,.08)", padding: "10px 12px", fontSize: 13, color: "var(--terra-ink)" }}>{error}</div>
          ) : null}

          <p style={{ margin: 0, paddingTop: 16, borderTop: "1px solid rgba(13,23,48,.12)", fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>
            Nothing changes in the company until its founders vote. The contract keeps only a salted hash of the address, never the email.
          </p>
        </Slab>
      </main>
    </div>
  );
}

/** The left half: the broken seal (design-handoff render R7) and what happens, in three lines. */
function RecoverAside({ wait }: { wait: string }) {
  return (
      <aside
        className="r7-aside"
        style={{
          position: "relative",
          overflow: "hidden",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          gap: 48,
          padding: "40px 56px 56px",
          color: "#E7ECF6",
        }}
      >
        <a href="/" style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, font: "700 18px var(--font-brand)", letterSpacing: ".24em", color: "#F3EFE6", textDecoration: "none" }}>
          <svg width="30" height="30" viewBox="0 0 1024 1024" aria-hidden="true">
            <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
            <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
            <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
            <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
          </svg>
          EUTHYNA
        </a>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 22, maxWidth: 560 }}>
          <h2 style={{ margin: 0, font: "900 clamp(32px, 3.4vw, 50px)/1.04 var(--font-brand)", letterSpacing: ".02em" }}>
            <span style={{ backgroundImage: "url(/media/textures/orichalcum.jpg)", backgroundSize: "100% 240%", backgroundPosition: "0 32%", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
              LOST YOUR KEY?
            </span>
            <br />
            <span style={{ color: "#F3EFE6" }}>YOUR SEAT COMES BACK BY VOTE.</span>
          </h2>
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 12, fontSize: 16, color: "#C9D3EA" }}>
            {[
              "You prove the mailbox you enrolled. The address stays private.",
              `The lost account can cancel for ${wait}.`,
              "Then the other founders vote the seat to your new account.",
            ].map((line, index) => (
              <li key={line} style={{ display: "flex", gap: 16 }}>
                <b style={{ font: "700 14px var(--font-brand)", color: "#F2B544", width: 26, flex: "0 0 auto" }}>{NUMERALS[index]}</b>
                {line}
              </li>
            ))}
          </ol>
          <a href={`${EXPLORER}/address/${RECOVERY_CONTRACT_ID}`} target="_blank" rel="noreferrer" style={{ font: "700 13px var(--font-brand)", letterSpacing: ".2em", color: "#8FE3F1", textDecoration: "none" }}>
            THE CONTRACT THAT CHECKS IT →
          </a>
        </div>
      </aside>
  );
}

/** One numbered step: open when current, a one-line summary when done, dimmed when ahead. */
function Step({ index, current, title, summary, onEdit, children }: { index: number; current: number; title: string; summary: ReactNode; onEdit?: (() => void) | undefined; children: ReactNode }) {
  const state = index < current ? "done" : index === current ? "open" : "ahead";
  return (
    <section style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)", gap: 12, opacity: state === "ahead" ? 0.45 : 1 }}>
      <span
        aria-hidden="true"
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          font: "700 12px var(--font-brand)",
          color: state === "open" ? "#2A0D04" : "var(--gold-ink)",
          background: state === "open" ? "#E7A84B" : "transparent",
          border: state === "open" ? "0" : "1px solid rgba(160,110,20,.45)",
        }}
      >
        {state === "done" ? "✓" : NUMERALS[index]}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, paddingTop: 5 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span className="app-kick" style={{ color: "var(--ink)" }}>{title}</span>
          {state === "done" && onEdit ? (
            <button type="button" onClick={onEdit} style={{ marginLeft: "auto", background: "none", border: 0, padding: 0, font: "600 12.5px var(--font-ui)", color: "var(--ink-2)", textDecoration: "underline", cursor: "pointer" }}>Edit</button>
          ) : null}
        </div>
        {state === "done" && summary ? <span style={{ marginTop: -6, fontSize: 13, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{summary}</span> : null}
        {state === "open" ? children : null}
      </div>
    </section>
  );
}
