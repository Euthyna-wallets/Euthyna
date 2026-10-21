import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { authClient } from "../auth.js";

type Organization = { id: string; name: string };

export function Layout() {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => (await authClient.organization.list()).data as Organization[],
  });
  const active = organizations.data?.[0] ?? null;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand">MandateOS</div>
        <div className="small muted">Security console</div>
        {active ? (
          <label className="org-select">
            <span className="small muted">Organization</span>
            <select
              value={active.id}
              onChange={(event) => {
                void authClient.organization.setActive({ organizationId: event.target.value });
                organizations.refetch();
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
          <NavLink to="/payments">Payments</NavLink>
          <NavLink to="/escalations">Escalations</NavLink>
          <NavLink to="/suppliers">Suppliers</NavLink>
          <NavLink to="/governance">Governance</NavLink>
          <NavLink to="/onboarding">Onboarding</NavLink>
        </nav>
        <div className="spacer" />
        <div className="small muted">{session.data?.user.email}</div>
        <button className="ghost" onClick={() => void authClient.signOut().then(() => navigate("/"))}>Sign out</button>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
