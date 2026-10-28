import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Card, Status } from "../components/ui.js";
import { omni } from "../omniroles-api.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { TreasuryChecks } from "./TreasurySetup.js";
import { DirectoryCard } from "./DirectoryCard.js";
import { VersionCard } from "./VersionCard.js";

export function SettingsPage() {
  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status });
  const treasury = status.data?.treasury;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Company administration</span>
          <h1>Settings</h1>
          <p className="muted">Company setup, security checks, shares and suppliers. Members, rules and pauses are decided in Votes.</p>
        </div>
      </header>
      <div className="settings-grid">
        <Card title="Company">
          <p className="muted">Resume or review the company setup.</p>
          <Link className="text-action" to="/onboarding">Open company setup →</Link>
        </Card>
        {treasury && status.data ? (
          <Card title="Security" action={<Status value={treasury.status === "active" ? "active" : "pending"} />}>
            <p className="muted">On-chain checks of the company: who owns the vault, which code it runs, which keys can act.</p>
            <div className="explain">
              <div><span className="eyebrow">DAO</span><strong className="mono small">{treasury.daoAccountId}</strong></div>
              <div><span className="eyebrow">Vault</span><strong className="mono small">{treasury.vaultAccountId}</strong></div>
            </div>
            <TreasuryChecks status={status.data} />
          </Card>
        ) : null}
        <Card title="Shares">
          <p className="muted">Company shares, revenue distribution and voting power.</p>
          <Link className="text-action" to="/shares">Open shares →</Link>
        </Card>
        <Card title="Suppliers">
          <p className="muted">Approved recipients. Changes need a members' vote.</p>
          <Link className="text-action" to="/suppliers">Manage suppliers →</Link>
        </Card>
        <VersionCard />
        <DirectoryCard />
      </div>
      {demoWalletsEnabled() ? (
        <details className="advanced-settings developer-settings">
          <summary>Developer · UAT demo tools</summary>
          <p>Generated wallets, faucet shortcuts and bridge helpers are test-only.</p>
          <Link className="text-action" to="/onboarding?developer=1">Open UAT tools →</Link>
        </details>
      ) : null}
    </div>
  );
}
