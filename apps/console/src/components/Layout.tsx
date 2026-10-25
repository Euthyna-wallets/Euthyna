import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { authClient } from "../auth.js";
import { omni } from "../omniroles-api.js";
import { SigningInbox } from "./SigningInbox.js";
import { WalletBar } from "./WalletBar.js";
import { WalletProvider } from "../lib/wallet-context.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";
import { disconnectNearWallet } from "../wallets.js";

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
  const status = useQuery({
    queryKey: ["omni-status", active?.id],
    queryFn: omni.status,
    enabled: Boolean(active),
    refetchInterval: 30_000,
  });
  const roles = useQuery({
    queryKey: ["omni-roles", active?.id],
    queryFn: omni.roles,
    enabled: Boolean(status.data?.treasury),
  });
  const setupRequired = Boolean(status.data) && (!status.data?.wallet || (roles.isSuccess && roles.data.roles.length === 0));
  const paused = status.data?.paused ?? false;

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
          <div className="small muted">AI company console</div>
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
            <NavLink to="/roles">Roles</NavLink>
            <NavLink to="/agents">Agents</NavLink>
            <NavLink to="/activity">Activity</NavLink>
            <NavLink to="/wallet">Wallet</NavLink>
            <NavLink to="/governance">Decisions</NavLink>
            <NavLink to="/shares">Shares</NavLink>
            <NavLink to="/suppliers">Suppliers</NavLink>
            <NavLink to="/settings">Settings</NavLink>
            {setupRequired ? <NavLink className="setup-link" to="/onboarding">Finish setup</NavLink> : null}
          </nav>
          <div className="spacer" />
          <div className="small muted">{session.data?.user.name}</div>
          <button className="ghost" title="Sign out, then sign in with another member's wallet" onClick={() => void authClient.signOut().then(disconnectNearWallet).then(() => navigate("/"))}>Sign out</button>
        </aside>
        <div className="app-frame">
          <header className="app-topbar">
            <SigningInbox />
            <WalletBar />
          </header>
          <main className="app-main">
            {paused ? <div className="alert error"><strong>Operations are paused by the security council.</strong> Agents cannot move funds until members vote to resume.</div> : null}
            <Outlet />
          </main>
        </div>
      </div>
    </WalletProvider>
  );
}
