import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";
import { NightPanel } from "../components/design.js";
import { Card, Status } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { newSalt, proveEmailFile, PUBLIC_INBOX_DOMAINS, RECOVERY_CONTRACT_ID, recoverySubject } from "../lib/email-proof.js";
import { recoveryErrorText } from "../lib/recovery-errors.js";
import type { ProposalDraft } from "../omniroles-api.js";
import { signContractCall, signDaoProposal } from "../wallets.js";

type Recovery = { lostAccountId: string; newAccountId: string; domain: string; state: "waiting" | "cancelled" | "done"; ready: boolean; notBefore: string; requestedAt: string };
type RecoveryView = {
  contractId: string; daoAccountId: string; cancelWindowSeconds: number;
  enrollments: Array<{ nearAccountId: string; domain: string; enrolledAt: string }>; recoveries: Recovery[];
};

/** The recovery contract reads what it holds through the API; every change is the person's own transaction. */
const recoveryApi = {
  list: () => api<RecoveryView>("/v1/console/recovery"),
  proposals: (lostAccountId: string) => api<{ proposals: ProposalDraft[] }>("/v1/console/recovery/proposals", { method: "POST", body: JSON.stringify({ lostAccountId }) }),
};

/** Storage for an enrollment or a request (the contract refunds what it does not use), and gas for the proof. */
export const RECOVERY_DEPOSIT = "50000000000000000000000";
export const RECOVERY_GAS = "300000000000000";
const EXPLORER = "https://testnet.nearblocks.io";

/** "48 hours", "5 minutes". */
function windowText(seconds: number): string {
  if (seconds >= 7200) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** How to make the email, and where to give it: its source pasted, or the .eml file. Proved in the browser. */
export function EmailProofStep({ subject, busy, onFile, domain }: { subject: string; busy: boolean; onFile: (email: File | string) => void; domain?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState("");
  const item = { display: "grid", gridTemplateColumns: "22px minmax(0, 1fr)", gap: 8, fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" } as const;
  const num = { font: "700 12px var(--font-brand)", color: "var(--gold-ink)", paddingTop: 2 } as const;
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
      <li style={item}>
        <span style={num}>1</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <span>
            From {domain ? <>your <b>{domain}</b> mailbox</> : <>the mailbox you will recover with (Gmail, Outlook, iCloud…)</>}, send an email to <b>another address you can open</b>, with exactly this subject. Gmail does not sign an email you send to yourself.
          </span>
          <span style={{ display: "flex", alignItems: "stretch", border: "1px solid rgba(13,23,48,.2)", background: "#fff" }}>
            <code style={{ flex: 1, minWidth: 0, padding: "9px 12px", font: "600 13px var(--font-mono)", color: "var(--ink)", overflowWrap: "anywhere" }}>{subject}</code>
            <button type="button" onClick={() => void navigator.clipboard.writeText(subject).then(() => setCopied(true))}
              style={{ border: 0, borderLeft: "1px solid rgba(13,23,48,.2)", background: "rgba(13,23,48,.04)", padding: "0 14px", font: "700 11px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink)", cursor: "pointer" }}>
              {copied ? "COPIED" : "COPY"}
            </button>
          </span>
        </div>
      </li>
      <li style={item}>
        <span style={num}>2</span>
        <span>
          Open it in the mailbox that <b>received</b> it (not in Sent) and copy its source. Gmail: ⋮ → <b>Show original</b> → <b>Copy to clipboard</b>.
          Outlook: … → View → <b>View message source</b>. Apple Mail: View → Message → <b>Raw Source</b>.
        </span>
      </li>
      <li style={item}>
        <span style={num}>3</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <span>Paste it here. Your browser proves that your provider signed it; the email itself is never uploaded.</span>
          <div className="field-app">
            <textarea aria-label="Original message" rows={5} value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}
              placeholder={"Delivered-To: …\nReceived: …\nDKIM-Signature: …"} style={{ font: "12px var(--font-mono)", resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <button type="button" className="btn-ori" disabled={busy || !source.trim()} onClick={() => onFile(source)}>{busy ? "PROVING…" : "PROVE"}</button>
            <label style={{ display: "inline", margin: 0, fontSize: 13, color: "var(--ink-2)", cursor: busy ? "not-allowed" : "pointer" }}>
              or a downloaded <span style={{ fontFamily: "var(--font-mono)" }}>.eml</span> file:{" "}
              <span style={{ textDecoration: "underline" }}>choose</span>
              <input type="file" accept=".eml,message/rfc822" disabled={busy} style={{ display: "none" }}
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file); }} />
            </label>
          </div>
        </div>
      </li>
    </ol>
  );
}

/**
 * Over every console page while a request for a seat is open: the founder it targets has a waiting
 * period to cancel, and must not have to find it in Settings. Everyone sees it; the founder gets
 * the cancel button.
 */
export function RecoveryAlert() {
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const view = useQuery({ queryKey: ["recovery"], queryFn: recoveryApi.list, refetchInterval: 20_000, retry: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const me = wallets.nearAccountId;
  const dao = view.data?.daoAccountId;
  const open = (view.data?.recoveries ?? []).filter((recovery) => recovery.state === "waiting" && !recovery.ready);
  if (!open.length && !message) return null;
  const cancel = () => {
    if (!dao || !me) return;
    setBusy(true);
    setMessage(null);
    void signContractCall(me, RECOVERY_CONTRACT_ID, "cancel", { dao_id: dao })
      .then(() => setMessage("Recovery cancelled on chain: your seat stays yours. Enroll another mailbox in Settings if this one is no longer safe."), (cause: unknown) => setMessage(recoveryErrorText(cause)))
      .finally(() => { setBusy(false); void queryClient.invalidateQueries({ queryKey: ["recovery"] }); });
  };
  return (
    <NightPanel style={{ padding: "14px 18px", borderLeft: "3px solid var(--terra)", fontSize: 14, color: "#F4C9BC", display: "flex", flexDirection: "column", gap: 10 }}>
      {open.map((recovery) => {
        const mine = me === recovery.lostAccountId;
        const until = new Date(recovery.notBefore).toLocaleString();
        return (
          <div key={`${recovery.lostAccountId}-${recovery.requestedAt}`} role="alert" style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 320px" }}>
              <b style={{ color: "#fff" }}>{mine ? "Someone is asking for your seat." : `${recovery.lostAccountId}'s seat is being recovered.`}</b>{" "}
              <span className="mono">{recovery.newAccountId}</span> proved the mailbox at {recovery.domain} that {mine ? "you" : recovery.lostAccountId} enrolled.{" "}
              {mine ? `If this is not you, cancel before ${until}: after that, the members can vote to give it the seat.` : `${recovery.lostAccountId} can cancel until ${until}; then the members vote.`}
            </span>
            {mine && dao ? (
              <button type="button" className="btn-ori" style={{ padding: "8px 14px" }} disabled={busy} onClick={cancel}>{busy ? "Cancelling…" : "This is not me: cancel"}</button>
            ) : (
              <a href="/settings" style={{ color: "#fff", fontWeight: 700 }}>Review in Settings →</a>
            )}
          </div>
        );
      })}
      {message ? <span role="status">{message}</span> : null}
    </NightPanel>
  );
}

/** A proof made in the browser, waiting for its transaction. */
export type ProvedCall = { what: string; sign: () => Promise<string> };

/**
 * The wallet opens on its own click. Proving takes about 40 s, and a browser lets a page open a
 * window only right after a click: a wallet opened at the end of the proof (Meteor, MyNearWallet…)
 * is blocked. The proof stays here, so a closed or blocked window costs a click, not a new proof.
 */
export function SignProvedStep({ proved, busy, onSign }: { proved: ProvedCall; busy: boolean; onSign: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button type="button" className="btn-ori" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={onSign}>{busy ? "CONFIRM IN YOUR WALLET…" : "SIGN WITH MY WALLET"}</button>
      <span style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)" }}>{proved.what}: proof ready. If the wallet window closes, sign again here: no need to prove again.</span>
    </div>
  );
}

/** Founders enroll their mailbox once; a lost seat comes back by a vote, never by itself. */
export function RecoveryCard() {
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const view = useQuery({ queryKey: ["recovery"], queryFn: recoveryApi.list, refetchInterval: 20_000 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proved, setProved] = useState<ProvedCall | null>(null);
  const me = wallets.nearAccountId;
  const dao = view.data?.daoAccountId;
  const enrolled = view.data?.enrollments.find((item) => item.nearAccountId === me);

  const run = (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    void action().then((text) => { if (text) setMessage(text); }, (cause: unknown) => setMessage(recoveryErrorText(cause)))
      .finally(() => { setBusy(false); void queryClient.invalidateQueries({ queryKey: ["recovery"] }); });
  };

  return (
    <Card title="Seat recovery" action={<Status value={enrolled ? "active" : "pending"} />}>
      <p className="muted">
        Lost your NEAR account? Enroll your mailbox once, with a zero-knowledge proof of an email you send from it
        (ZK Email). The recovery contract <a className="mono" href={`${EXPLORER}/address/${RECOVERY_CONTRACT_ID}`} target="_blank" rel="noreferrer">{RECOVERY_CONTRACT_ID}</a> verifies
        the proof on NEAR and keeps only a salted hash of your address. A new account that proves the same mailbox can ask for your seat:
        you can cancel for {windowText(view.data?.cancelWindowSeconds ?? 172_800)}, then the other founders vote.
      </p>
      {enrolled ? <p className="small">Enrolled with a mailbox at <strong>{enrolled.domain}</strong>. Enroll again to change it.</p> : null}
      {me && dao ? (
        <EmailProofStep subject={recoverySubject("enroll", me)} busy={busy} onFile={(file) => run(async () => {
          setProved(null);
          const { proof, domain } = await proveEmailFile(file, newSalt(), setMessage);
          setProved({
            what: `Enrollment of a mailbox at ${domain}`,
            sign: async () => {
              const tx = await signContractCall(me, RECOVERY_CONTRACT_ID, "enroll", { dao_id: dao, ...proof }, { deposit: RECOVERY_DEPOSIT, gas: RECOVERY_GAS });
              setProved(null);
              const warning = PUBLIC_INBOX_DOMAINS.includes(domain)
                ? ` Testnet only: anyone who knows a ${domain} address can open its inbox, so it does not protect your seat. Use a mailbox with a password for real.`
                : "";
              return `Enrolled on chain (${tx.slice(0, 8)}…): a mailbox at ${domain} can recover your seat.${warning}`;
            },
          });
          return "Proof ready. Sign the enrollment in your wallet: the contract checks the proof.";
        })} />
      ) : <p className="small">Connect your NEAR wallet to enroll.</p>}
      {proved ? <SignProvedStep proved={proved} busy={busy} onSign={() => run(proved.sign)} /> : null}
      {view.data?.enrollments.length ? <p className="small">Founders enrolled: {view.data.enrollments.map((item) => item.nearAccountId).join(", ")}</p> : null}
      {(view.data?.recoveries ?? []).map((recovery) => <RecoveryRow key={`${recovery.lostAccountId}-${recovery.requestedAt}`} recovery={recovery} dao={dao} me={me} busy={busy} run={run} />)}
      {message ? <p className="small" role="status">{message}</p> : null}
      <p className="small">A founder who lost their account asks from <a href="/recover">/recover</a>, signed in with the new account.</p>
    </Card>
  );
}

function RecoveryRow({ recovery, dao, me, busy, run }: { recovery: Recovery; dao: string | undefined; me: string; busy: boolean; run: (action: () => Promise<string | void>) => void }) {
  return (
    <div className="explain">
      <div>
        <span className="eyebrow">Recovery · {recovery.state}</span>
        <strong className="small">{recovery.lostAccountId} → {recovery.newAccountId}</strong>
        <span className="small">
          {" "}Proved on chain with a mailbox at {recovery.domain}.{" "}
          {recovery.state === "waiting" ? (recovery.ready ? "Waiting period over: the members can vote." : `Cancelable until ${new Date(recovery.notBefore).toLocaleString()}.`) : null}
        </span>
      </div>
      <div className="row">
        {me === recovery.lostAccountId && recovery.state === "waiting" && dao ? (
          <button className="btn-line" style={{ padding: "6px 12px" }} disabled={busy} onClick={() => run(async () => {
            await signContractCall(me, RECOVERY_CONTRACT_ID, "cancel", { dao_id: dao });
            return "Recovery cancelled on chain: your seat stays yours.";
          })}>This is not me: cancel</button>
        ) : null}
        {recovery.ready && recovery.state === "waiting" && me ? (
          <button className="btn-ori" style={{ padding: "8px 14px" }} disabled={busy} onClick={() => run(async () => {
            const { proposals } = await recoveryApi.proposals(recovery.lostAccountId);
            const ids: number[] = [];
            for (const draft of proposals) ids.push((await signDaoProposal(me, draft)).proposalId);
            return `Votes #${ids.join(", #")} submitted: approve them in Votes.`;
          })}>Submit the vote</button>
        ) : recovery.state === "waiting" && me && me !== recovery.lostAccountId ? (
          // Shown before the delay too, so the next step is visible; the contract and the API refuse it until then.
          <button className="btn-ori" style={{ padding: "8px 14px" }} disabled title="The founder can still cancel">
            Submit the vote · from {new Date(recovery.notBefore).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
