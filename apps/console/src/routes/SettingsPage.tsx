import { Link } from "react-router-dom";

import { Card } from "../components/ui.js";
import { demoWalletsEnabled } from "../lib/wallet-store.js";

export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Company administration</span>
          <h1>Settings</h1>
          <p className="muted">People, suppliers and exceptional recovery actions.</p>
        </div>
      </header>
      <div className="settings-grid">
        <Card title="Company">
          <p className="muted">Manage member proofs and resume treasury setup.</p>
          <Link className="text-action" to="/onboarding">Open company setup →</Link>
        </Card>
        <Card title="Suppliers">
          <p className="muted">Registry changes use four-eyes approval.</p>
          <Link className="text-action" to="/suppliers">Manage suppliers →</Link>
        </Card>
        <Card title="Escalations">
          <p className="muted">Review payments that fall outside an active mandate.</p>
          <Link className="text-action" to="/escalations">Review escalations →</Link>
        </Card>
      </div>
      <details className="advanced-settings">
        <summary>Advanced recovery</summary>
        <p>Safe-owner recovery is exceptional and still requires the normal DAO and Delay path.</p>
        <Link className="text-action" to="/governance?advanced=1">Open recovery controls →</Link>
      </details>
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
