import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Card } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

/** Which vault version runs, and a vote to move to a newer one published on Nomos. */
export function VersionCard() {
  const wallets = useWallets();
  const me = wallets.nearAccountId;
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const versions = useQuery({ queryKey: ["omni-versions"], queryFn: omni.versions, enabled: Boolean(status.data?.treasury) });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  if (!status.data?.treasury) return null;
  const data = versions.data;
  const current = data?.versions.find((version) => version.current);
  const latest = data?.versions[0];
  const behind = Boolean(data?.upgradable && latest && !latest.current);

  async function propose(codeHash: string) {
    if (!me) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await signDaoProposal(me, await omni.upgradeProposal(codeHash));
      setMessage({ kind: "success", text: `Proposal #${result.proposalId} submitted. Once approved, the upgrade applies after the veto window.` });
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Vault version">
      {versions.isLoading ? <p className="muted">Loading…</p> : versions.error ? <p className="muted">Could not read the versions.</p> : data ? (
        <div className="stack">
          <p className="small muted">
            The vault has no key: its code changes only when members vote an upgrade to a version published on <code>{data.nomosId}</code>,
            and the council can veto it during the veto window. The vault checks the code against the voted hash.
          </p>
          <div className="small">
            Running: {current ? <strong>version {current.index}</strong> : <strong>an unlisted version</strong>} <span className="mono muted">{data.current.slice(0, 10)}…</span>
          </div>
          {!data.upgradable ? (
            <div className="state">This vault was created before Nomos: it cannot be upgraded.</div>
          ) : behind && latest ? (
            <div className="decision">
              <header><div><span className="eyebrow">Newer version available</span><h3>Version {latest.index}{latest.notes ? ` · ${latest.notes}` : ""}</h3></div></header>
              <p className="small muted">Published {new Date(latest.publishedAt).toLocaleDateString()} · {Math.round(latest.size / 1024)} KB · <span className="mono">{latest.codeHash}</span></p>
              <footer className="row">
                <div className="spacer" />
                <button className="primary" disabled={!me || busy} onClick={() => void propose(latest.codeHash)}>{busy ? "Preparing…" : "Propose the upgrade"}</button>
              </footer>
            </div>
          ) : <p className="small">Up to date.</p>}
          {message ? <div className={`alert ${message.kind}`}>{message.text}{message.kind === "success" ? <> <Link to="/governance">Open Decisions</Link></> : null}</div> : null}
          {data.versions.length > 1 ? (
            <details>
              <summary className="small">All published versions</summary>
              <ul className="plain small">
                {data.versions.map((version) => (
                  <li key={version.codeHash}>Version {version.index}{version.current ? " (running)" : ""} · {new Date(version.publishedAt).toLocaleDateString()} · <span className="mono">{version.codeHash}</span>{version.notes ? ` · ${version.notes}` : ""}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
