import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { Card, Status } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { checkOnSepolia, PASSPORT_DEV_MODE, requestPassportProof, type PassportEvidence } from "../lib/passport.js";
import type { ProposalDraft } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

type Recovery = { id: string; lostAccountId: string; newAccountId: string; state: "waiting" | "cancelled" | "proposed" | "done"; notBefore: string; devMode: boolean; createdAt: string };
type RecoveryView = { enrollments: Array<{ nearAccountId: string; devMode: boolean; enrolledAt: string }>; recoveries: Recovery[] };

const recoveryApi = {
  list: () => api<RecoveryView>("/v1/console/recovery"),
  enroll: (evidence: PassportEvidence) => api<{ enrolled: string }>("/v1/console/recovery/enroll", { method: "POST", body: JSON.stringify({ evidence }) }),
  cancel: (id: string) => api<Recovery>(`/v1/console/recovery/${id}/cancel`, { method: "POST", body: "{}" }),
  proposals: (id: string) => api<{ proposals: ProposalDraft[] }>(`/v1/console/recovery/${id}/proposals`, { method: "POST", body: "{}" }),
  evidence: (id: string) => api<{ recoveryEvidence: PassportEvidence; enrollmentEvidence: PassportEvidence | null }>(`/v1/console/recovery/${id}/evidence`),
};

/** The QR code the ZKPassport app scans, and what is happening. */
export function PassportQr({ url, scanned }: { url: string | null; scanned: boolean }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => { if (url) void QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setImage); }, [url]);
  if (!url) return null;
  return (
    <div className="stack">
      {scanned ? <p className="small">Scanned. Confirm in the ZKPassport app; the proof takes a minute on the phone.</p> : <p className="small">Scan with the ZKPassport app, or open the link on your phone.</p>}
      {image ? <img src={image} alt="ZKPassport request" width={220} height={220} /> : null}
      <a className="small" href={url}>Open in ZKPassport</a>
    </div>
  );
}

/** Founders enroll their ID once; a lost seat comes back by a vote, never by itself. */
export function RecoveryCard() {
  const queryClient = useQueryClient();
  const wallets = useWallets();
  const view = useQuery({ queryKey: ["recovery"], queryFn: recoveryApi.list, refetchInterval: 20_000 });
  const [url, setUrl] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const me = wallets.nearAccountId;
  const enrolled = view.data?.enrollments.some((item) => item.nearAccountId === me) ?? false;

  const run = (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    void action().then((text) => { if (text) setMessage(text); }, (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => { setBusy(false); setUrl(null); setScanned(false); void queryClient.invalidateQueries({ queryKey: ["recovery"] }); });
  };

  return (
    <Card title="Seat recovery" action={<Status value={enrolled ? "active" : "pending"} />}>
      <p className="muted">
        Lost your NEAR account? Enroll your passport or ID card once. A new account that proves the same ID can ask
        for your seat: you can cancel for 48 hours, then the other founders vote. Only a hash of a ZKPassport identifier
        is kept, never your data.
      </p>
      {PASSPORT_DEV_MODE ? <p className="small">Testnet: ZKPassport's mock IDs (developer mode in the app) are accepted.</p> : null}
      {me ? (
        <button className="primary compact" disabled={busy} onClick={() => run(async () => {
          const evidence = await requestPassportProof(me, "Enroll your ID to recover your founder seat", setUrl, () => setScanned(true));
          await recoveryApi.enroll(evidence);
          return enrolled ? "Your ID was enrolled again." : "Your ID is enrolled for seat recovery.";
        })}>{enrolled ? "Enroll again (renewed ID)" : "Enroll my ID"}</button>
      ) : <p className="small">Connect your NEAR wallet to enroll.</p>}
      <PassportQr url={url} scanned={scanned} />
      {view.data?.enrollments.length ? (
        <p className="small">Enrolled: {view.data.enrollments.map((item) => item.nearAccountId).join(", ")}</p>
      ) : null}
      {(view.data?.recoveries ?? []).map((recovery) => (
        <RecoveryRow key={recovery.id} recovery={recovery} me={me} busy={busy} run={run} />
      ))}
      {message ? <p className="small">{message}</p> : null}
      <p className="small">A founder who lost their account asks from <a href="/recover">euthyna.io/recover</a>, signed in with the new account.</p>
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
        <button className="ghost compact" disabled={busy} onClick={() => run(async () => {
          const { recoveryEvidence, enrollmentEvidence } = await recoveryApi.evidence(recovery.id);
          const asked = await checkOnSepolia(recoveryEvidence);
          const enrolledProof = enrollmentEvidence ? await checkOnSepolia(enrollmentEvidence) : null;
          const same = enrolledProof ? enrolledProof.uniqueIdentifier === asked.uniqueIdentifier : false;
          return `Ethereum Sepolia verifier: proof ${asked.ok ? "valid" : "INVALID"}, bound to ${asked.boundTo ?? "nothing"}, ${same ? "same ID as the enrolled one" : "NOT the enrolled ID"}.`;
        })}>Check the proofs on Ethereum Sepolia</button>
        {me === recovery.lostAccountId && (recovery.state === "waiting" || recovery.state === "proposed") ? (
          <button className="ghost compact" disabled={busy} onClick={() => run(async () => { await recoveryApi.cancel(recovery.id); return "Recovery cancelled: your seat stays yours."; })}>This is not me: cancel</button>
        ) : null}
        {ready && recovery.state === "waiting" && me ? (
          <button className="primary compact" disabled={busy} onClick={() => run(async () => {
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
