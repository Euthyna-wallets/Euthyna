import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { approvalsNeeded, omni, type OmniStatus } from "../omniroles-api.js";
import { signDaoAction, signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";

/** Step 3: one click creates the DAO and the vault; the browser shows what was verified on chain. */
export function TreasuryCreate(props: { companyName: string; onCreated: () => Promise<void> }) {
  const plan = useQuery({ queryKey: ["omni-plan", props.companyName], queryFn: () => omni.plan(props.companyName) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Create the company treasury</h2>
      <p className="muted">
        MandateOS creates and pays for two contracts on NEAR. Nobody, not even MandateOS, keeps a key to them afterwards.
      </p>
      {plan.error ? <div className="alert error">{(plan.error as Error).message}</div> : null}
      {plan.data ? (
        <div className="explain">
          <div>
            <span className="eyebrow">DAO · the members</span>
            <strong className="mono">{plan.data.daoAccountId}</strong>
            <p className="small muted">
              {plan.data.council.map((member) => member.name ?? member.nearAccountId).join(", ")} vote on every rule.
              A decision needs {plan.data.threshold} of {plan.data.council.length} approvals.
            </p>
          </div>
          <div>
            <span className="eyebrow">Vault · the rules</span>
            <strong className="mono">{plan.data.vaultAccountId}</strong>
            <p className="small muted">
              Holds the company wallets and checks every agent request against the rules. A voted rule applies after a
              {` ${Math.round(plan.data.ruleDelaySeconds / 60)} min`} veto window.
            </p>
          </div>
        </div>
      ) : null}
      {error ? <div className="alert error">{error}</div> : null}
      <button
        className="primary"
        disabled={!plan.data || busy}
        onClick={() => void (async () => {
          setBusy(true);
          setError(null);
          try {
            await omni.create(props.companyName);
            await props.onCreated();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        })()}
      >
        {busy ? "Creating… (about 20 seconds)" : "Create treasury"}
      </button>
    </section>
  );
}

/** On-chain checks, read by the server and shown to members. */
export function TreasuryChecks({ status }: { status: OmniStatus }) {
  if (!status.treasury) return null;
  const failed = status.checks.filter((check) => !check.ok);
  return (
    <details className="checks" open={failed.length > 0}>
      <summary>
        {failed.length === 0 ? "✓ " : "⚠ "}
        {status.checks.length - failed.length} of {status.checks.length} on-chain checks pass
      </summary>
      <table>
        <tbody>
          {status.checks.map((check) => (
            <tr key={check.label}>
              <td>{check.ok ? "✓" : "✗"}</td>
              <td>{check.label}</td>
              <td className="mono small">{check.ok ? short(check.actual, 14) : `expected ${short(check.expected, 14)}, found ${short(check.actual, 14)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Step 4: the first vote creates the company wallet; then fund it. */
export function WalletSetup({ status, onChanged }: { status: OmniStatus; onChanged: () => Promise<void> }) {
  const wallets = useWallets();
  const queryClient = useQueryClient();
  const governance = useQuery({ queryKey: ["omni-governance"], queryFn: omni.governance, refetchInterval: 8_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = wallets.nearAccountId;
  const data = governance.data;
  const walletProposal = data?.proposals.find((proposal) => proposal.changes.some((change) => change.title.startsWith("Create the company wallet")));
  const needed = data ? approvalsNeeded(data.dao.threshold, data.dao.members.length) : 0;
  const approvals = walletProposal ? Object.values(walletProposal.votes).filter((vote) => vote === "Approve").length : 0;
  const isMember = Boolean(data && me && data.dao.members.includes(me));

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h2>Create the company wallet</h2>
      <p className="muted">
        The wallet is an address on {status.treasury?.chainName} controlled only by the vault. Creating it is the DAO's first decision.
      </p>
      <TreasuryChecks status={status} />
      {error ? <div className="alert error">{error}</div> : null}
      {!me ? <div className="notice">Connect your NEAR wallet (top right) to propose and vote.</div> : null}
      {!walletProposal ? (
        <button
          className="primary"
          disabled={!isMember || Boolean(busy)}
          title={isMember ? "Propose the wallet creation to the members" : "Connect the NEAR wallet of a member"}
          onClick={() => void run("propose", async () => {
            const draft = await omni.walletProposal();
            await signDaoProposal(me, draft);
          })}
        >
          {busy === "propose" ? "Signing…" : "Propose: create the wallet"}
        </button>
      ) : walletProposal.status === "InProgress" ? (
        <div className="decision">
          <header>
            <div><span className="eyebrow">Proposal #{walletProposal.id}</span><h3>{walletProposal.title}</h3></div>
            <div className="votes"><strong>{approvals} / {needed}</strong><span className="small muted">approvals</span></div>
          </header>
          <SentenceList items={walletProposal.changes} />
          <footer className="row wrap">
            <span className="small muted">Each member approves from their own wallet.</span>
            <div className="spacer" />
            {walletProposal.votes[me] ? <span className="small">You voted {walletProposal.votes[me]}</span> : (
              <button
                className="primary"
                disabled={!isMember || Boolean(busy)}
                onClick={() => void run("vote", async () => {
                  await signDaoAction(me, data!.dao.accountId, walletProposal.id, walletProposal.kind, "VoteApprove");
                })}
              >
                {busy === "vote" ? "Signing…" : "Approve"}
              </button>
            )}
          </footer>
        </div>
      ) : walletProposal.status === "Approved" && !status.wallet ? (
        <div className="state">Approved. The wallet address is being derived by the NEAR signing network…</div>
      ) : walletProposal.status !== "Approved" ? (
        <div className="alert error">The wallet proposal was {walletProposal.status.toLowerCase()}. Propose it again.</div>
      ) : null}
    </section>
  );
}

export function FundWallet({ status, showNext = true }: { status: OmniStatus; showNext?: boolean }) {
  if (!status.wallet) return null;
  const usdc = status.wallet.tokens.filter((token) => Number(token.amount) > 0);
  return (
    <section className="card">
      <h2>Fund the company wallet</h2>
      <div className="explain">
        <div>
          <span className="eyebrow">Address on {status.treasury?.chainName}</span>
          <strong className="mono">{status.wallet.address}</strong>
          <p className="small muted">Send the tokens agents will use, and a little ETH for network fees.</p>
        </div>
        <div>
          <span className="eyebrow">Balance</span>
          <strong>{Number(status.wallet.eth).toFixed(5)} ETH</strong>
          <p className="small muted">{usdc.length ? usdc.map((token) => `${Number(token.amount).toLocaleString()} ${token.symbol}`).join(" · ") : "No token yet"}</p>
        </div>
      </div>
      <div className="row wrap">
        <button onClick={() => void navigator.clipboard.writeText(status.wallet!.address)}>Copy address</button>
        <a className="button" href={`https://sepolia.basescan.org/address/${status.wallet.address}`} target="_blank" rel="noreferrer">Open in explorer</a>
        <div className="spacer" />
        {showNext ? <Link className="button primary" to="/roles">Next: create a role →</Link> : null}
      </div>
    </section>
  );
}
