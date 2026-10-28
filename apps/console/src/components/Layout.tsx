import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { authClient } from "../auth.js";
import { omni } from "../omniroles-api.js";
import { Icon } from "./ops.js";
import { SigningInbox } from "./SigningInbox.js";
import { WalletBar } from "./WalletBar.js";
import { WalletProvider } from "../lib/wallet-context.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";
import { disconnectNearWallet } from "../wallets.js";

type Organization = { id: string; name: string };

const NEW_COMPANY = "__new__";

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
  const governance = useQuery({
    queryKey: ["omni-governance", active?.id],
    queryFn: omni.governance,
    enabled: Boolean(status.data?.treasury),
    refetchInterval: 30_000,
  });
  const members = useQuery({ queryKey: ["omni-members"], queryFn: omni.members, enabled: Boolean(active), staleTime: 60_000 });
  const myAccount = members.data?.me ?? "";
  const toVote = (governance.data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress" && Boolean(myAccount) && !(myAccount in proposal.votes)).length;
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
          <div className="small muted">AI company console · testnet</div>
          {active ? (
            <label className="org-select">
              <span className="small muted">Company (DAO)</span>
              <select
                value={active.id}
                onChange={(event) => {
                  if (event.target.value === NEW_COMPANY) {
                    navigate("/onboarding?new=1");
                    return;
                  }
                  void authClient.organization.setActive({ organizationId: event.target.value }).then(async () => {
                    localStorage.setItem("mandateos.organization", event.target.value);
                    await organizations.refetch();
                    await queryClient.invalidateQueries();
                  });
                }}
              >
                {(organizations.data ?? []).map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
                <option value={NEW_COMPANY}>+ New company</option>
              </select>
              {status.data?.treasury ? (
                <span className="small muted mono" title="The DAO that owns this company's vault">{status.data.treasury.daoAccountId}</span>
              ) : null}
            </label>
          ) : null}
          <nav className="app-nav" aria-label="Console">
            <span className="nav-group">Operate</span>
            <NavLink to="/overview" end><Icon name="overview" />Overview</NavLink>
            <NavLink to="/agents"><Icon name="agents" />Agents</NavLink>
            <NavLink to="/activity"><Icon name="activity" />Activity</NavLink>
            <span className="nav-group">Rules</span>
            <NavLink to="/roles"><Icon name="roles" />Roles</NavLink>
            <NavLink to="/governance"><Icon name="decisions" />Decisions{toVote ? <span className="nav-badge" title="Waiting for your vote">{toVote}</span> : null}</NavLink>
            <span className="nav-group">Money</span>
            <NavLink to="/wallet"><Icon name="wallet" />Wallet</NavLink>
            <NavLink to="/shares"><Icon name="shares" />Shares</NavLink>
            <NavLink to="/suppliers"><Icon name="suppliers" />Suppliers</NavLink>
            <span className="nav-group">Company</span>
            <NavLink to="/settings"><Icon name="settings" />Settings</NavLink>
            {setupRequired ? <NavLink className="setup-link" to="/onboarding"><Icon name="setup" />Finish setup</NavLink> : null}
          </nav>
          <div className="spacer" />
          <div className="small muted">{session.data?.user.name}</div>
          <button className="ghost" title="Sign out, then sign in with another member's wallet" onClick={() => void authClient.signOut().then(disconnectNearWallet).then(() => navigate("/"))}>Sign out</button>
        </aside>
        <div className="app-frame">
          <header className="app-topbar">
            <div className="topbar-company">
              <strong>{active?.name ?? "MandateOS"}</strong>
              {status.data?.treasury ? (
                <span className={`company-state ${paused ? "paused" : "live"}`}>{paused ? "Paused by the security council" : "Agents running"}</span>
              ) : status.data ? <span className="company-state setup">Setting up</span> : null}
            </div>
            <div className="spacer" />
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
