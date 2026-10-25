import { Link } from "react-router-dom";

import { Card } from "../components/ui.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";
import { DirectoryCard } from "./DirectoryCard.js";

export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Company administration</span>
          <h1>Settings</h1>
          <p className="muted">Company setup and suppliers. Members, roles and pauses are decided in Decisions.</p>
        </div>
      </header>
      <div className="settings-grid">
        <Card title="Company">
          <p className="muted">Resume or review the company setup.</p>
          <Link className="text-action" to="/onboarding">Open company setup →</Link>
        </Card>
        <Card title="Suppliers">
          <p className="muted">Registry changes use four-eyes approval.</p>
          <Link className="text-action" to="/suppliers">Manage suppliers →</Link>
        </Card>
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
