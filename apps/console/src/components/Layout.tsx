import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { authClient } from "../auth.js";
import { api, type TreasuryView } from "../api.js";
import { SigningInbox } from "./SigningInbox.js";
import { WalletBar } from "./WalletBar.js";
import { WalletProvider } from "../lib/wallet-context.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";

type Organization = { id: string; name: string };

export function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => (await authClient.organization.list()).data as Organization[],
  });
  const activeOrganizationId = session.data?.session.activeOrganizationId;
  const active = organizations.data?.find((organization) => organization.id === activeOrganizationId)
    ?? organizations.data?.[0]
    ?? null;
  const treasury = useQuery({
    queryKey: ["treasury", active?.id],
    queryFn: () => api<{ treasury: TreasuryView | null }>("/v1/console/treasury"),
    enabled: Boolean(active),
  });
  const setupRequired = !treasury.data?.treasury || treasury.data.treasury.status !== "active";

  useEffect(() => {
    setDemoWalletScope(session.data?.user.id ?? null);
  }, [session.data?.user.id]);

  useEffect(() => {
    if (active && !activeOrganizationId) {
      void authClient.organization.setActive({ organizationId: active.id });
    }
  }, [active?.id, activeOrganizationId]);

  return (
    <WalletProvider>
      <div className="app-shell">
        <aside className="app-sidebar">
          <div className="brand">MandateOS</div>
          <div className="small muted">Company control plane</div>
          {active ? (
            <label className="org-select">
              <span className="small muted">Organization</span>
              <select
                value={active.id}
                onChange={(event) => {
                  void authClient.organization.setActive({ organizationId: event.target.value }).then(async () => {
                    await organizations.refetch();
                    await queryClient.invalidateQueries();
                  });
                }}
              >
                {(organizations.data ?? []).map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <nav className="app-nav">
            <NavLink to="/" end>Overview</NavLink>
            <NavLink to="/agents">Agents</NavLink>
            <NavLink to="/mandate">Mandates</NavLink>
            <NavLink to="/payments">Payments</NavLink>
            <NavLink to="/governance">Governance</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            {setupRequired ? <NavLink className="setup-link" to="/onboarding">Finish setup</NavLink> : null}
          </nav>
          <div className="spacer" />
          <div className="small muted">{session.data?.user.email}</div>
          <button className="ghost" onClick={() => void authClient.signOut().then(() => navigate("/"))}>Sign out</button>
        </aside>
        <div className="app-frame">
          <header className="app-topbar">
            <SigningInbox />
            <WalletBar />
          </header>
          <main className="app-main">
            <Outlet />
          </main>
        </div>
      </div>
    </WalletProvider>
  );
}
