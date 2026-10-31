import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api.js";
import { Card, Status } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { checkEmailProof, proveEmailFile, recoverySubject, type EmailEvidence } from "../lib/email-proof.js";
import type { ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

type Recovery = { id: string; lostAccountId: string; newAccountId: string; state: "waiting" | "cancelled" | "proposed" | "done"; notBefore: string; method: string; createdAt: string };
type RecoveryView = { cancelWindowSeconds: number; enrollments: Array<{ nearAccountId: string; method: string; enrolledAt: string }>; recoveries: Recovery[] };

const recoveryApi = {
  list: () => api<RecoveryView>("/v1/console/recovery"),
  enroll: (evidence: EmailEvidence) => api<{ enrolled: string; method: string }>("/v1/console/recovery/enroll", { method: "POST", body: JSON.stringify({ evidence }) }),
  cancel: (id: string) => api<Recovery>(`/v1/console/recovery/${id}/cancel`, { method: "POST", body: "{}" }),
  proposals: (id: string) => api<{ proposals: ProposalDraft[] }>(`/v1/console/recovery/${id}/proposals`, { method: "POST", body: "{}" }),
  evidence: (id: string) => api<{ recoveryEvidence: EmailEvidence; enrollmentEvidence: EmailEvidence | null }>(`/v1/console/recovery/${id}/evidence`),
};

/** "48 hours", "5 minutes". */
function windowText(seconds: number): string {
  if (seconds >= 7200) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

/** How to make the email, and where to give it: its source pasted, or the .eml file. Proved in the browser. */
export function EmailProofStep({ subject, busy, onFile }: { subject: string; busy: boolean; onFile: (email: File | string) => void }) {
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState("");
  return (
    <ol className="stack small">
      <li>
        From the mailbox you will recover with (Gmail, Outlook, iCloud…), send an email to yourself with exactly this subject:{" "}
        <code className="mono">{subject}</code>{" "}
        <button className="btn-line" style={{ padding: "6px 12px" }} onClick={() => void navigator.clipboard.writeText(subject).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </li>
      <li>
        Open it and copy its source. Gmail: ⋮ → <b>Show original</b> → <b>Copy to clipboard</b>. Outlook: … → View → <b>View message source</b>.
        Apple Mail: View → Message → <b>Raw Source</b>.
      </li>
      <li>
        Paste it here. Your browser proves your provider signed it; the email itself is never uploaded.
        <textarea aria-label="Original message" rows={4} value={source} disabled={busy} onChange={(event) => setSource(event.target.value)}
          placeholder="Delivered-To: …&#10;Received: …&#10;DKIM-Signature: …" style={{ width: "100%", font: "12px var(--font-mono, monospace)" }} />
        <button className="btn-ori" style={{ padding: "8px 14px" }} disabled={busy || !source.trim()} onClick={() => onFile(source)}>Prove</button>{" "}
        <span className="small">or a downloaded <span className="mono">.eml</span> file:</span>{" "}
        <input type="file" accept=".eml,message/rfc822" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onFile(file); }} />
      </li>
    </ol>
  );
}

/** Founders enroll their mailbox once; a lost seat comes back by a vote, never by itself. */
export function RecoveryCard() {
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const view = useQuery({ queryKey: ["recovery"], queryFn: recoveryApi.list, refetchInterval: 20_000 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const me = wallets.nearAccountId;
  const enrolled = view.data?.enrollments.find((item) => item.nearAccountId === me);

  const run = (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    void action().then((text) => { if (text) setMessage(text); }, (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => { setBusy(false); void queryClient.invalidateQueries({ queryKey: ["recovery"] }); });
  };

  return (
    <Card title="Seat recovery" action={<Status value={enrolled ? "active" : "pending"} />}>
      <p className="muted">
        Lost your NEAR account? Enroll your mailbox once, with a zero-knowledge proof of an email you send yourself
        (ZK Email). A new account that proves the same mailbox can ask for your seat: you can cancel for {windowText(view.data?.cancelWindowSeconds ?? 172_800)},
        then the other founders vote. Only a hash of your address is kept, never the address.
      </p>
      {enrolled ? <p className="small">Enrolled with a mailbox at <strong>{enrolled.method.replace(/^email:/, "")}</strong>. Enroll again to change it.</p> : null}
      {me ? (
        <EmailProofStep subject={recoverySubject("enroll", me)} busy={busy} onFile={(file) => run(async () => {
          const { evidence, domain } = await proveEmailFile(file, setMessage);
          setMessage("Checking the proof…");
          await recoveryApi.enroll(evidence);
          return `Enrolled: a mailbox at ${domain} can recover your seat.`;
        })} />
      ) : <p className="small">Connect your NEAR wallet to enroll.</p>}
      {view.data?.enrollments.length ? <p className="small">Founders enrolled: {view.data.enrollments.map((item) => item.nearAccountId).join(", ")}</p> : null}
      {(view.data?.recoveries ?? []).map((recovery) => <RecoveryRow key={recovery.id} recovery={recovery} me={me} busy={busy} run={run} />)}
      {message ? <p className="small" role="status">{message}</p> : null}
      <p className="small">A founder who lost their account asks from <a href="/recover">/recover</a>, signed in with the new account.</p>
    </Card>
  );
}

function RecoveryRow({ recovery, me, busy, run }: { recovery: Recovery; me: string; busy: boolean; run: (action: () => Promise<string | void>) => void }) {
  const ready = new Date(recovery.notBefore).getTime() <= Date.now();
  return (
    <div className="explain">
      <div>
        <span className="eyebrow">Recovery · {recovery.state}</span>
        <strong className="small">{recovery.lostAccountId} → {recovery.newAccountId}</strong>
        <span className="small"> {recovery.state === "waiting" ? (ready ? "Waiting period over: the members can vote." : `Cancelable until ${new Date(recovery.notBefore).toLocaleString()}.`) : null}</span>
      </div>
      <div className="row">
        <button className="btn-line" style={{ padding: "6px 12px" }} disabled={busy} onClick={() => run(async () => {
          const { recoveryEvidence, enrollmentEvidence } = await recoveryApi.evidence(recovery.id);
          const asked = await checkEmailProof(recoveryEvidence);
          const enrolledProof = enrollmentEvidence ? await checkEmailProof(enrollmentEvidence) : null;
          const same = Boolean(enrolledProof?.valid) && enrolledProof!.addressHash === asked.addressHash;
          return `Checked in your browser: proof ${asked.valid ? "valid" : "INVALID"}, email from ${asked.domain}, subject "${asked.subject}", ${same ? "same mailbox as the enrolled one" : "NOT the enrolled mailbox"}.`;
        })}>Check the proofs in my browser</button>
        {me === recovery.lostAccountId && (recovery.state === "waiting" || recovery.state === "proposed") ? (
          <button className="btn-line" style={{ padding: "6px 12px" }} disabled={busy} onClick={() => run(async () => { await recoveryApi.cancel(recovery.id); return "Recovery cancelled: your seat stays yours."; })}>This is not me: cancel</button>
        ) : null}
        {ready && recovery.state === "waiting" && me ? (
          <button className="btn-ori" style={{ padding: "8px 14px" }} disabled={busy} onClick={() => run(async () => {
            const { proposals } = await recoveryApi.proposals(recovery.id);
            const ids: number[] = [];
            for (const draft of proposals) ids.push((await signDaoProposal(me, draft)).proposalId);
            return `Votes #${ids.join(", #")} submitted: approve them in Votes.`;
          })}>Submit the vote</button>
        ) : null}
      </div>
    </div>
  );
}
