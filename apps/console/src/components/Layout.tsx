/**
 * The console shell: night sidebar with the company, the navigation in roman
 * numerals, the security council block and the user; a marble ground for the
 * screens. Visual reference: design-handoff/app/source/01-hq.html (sidebar and
 * header) and screens/12-hq-mobile.png for the narrow layout.
 *
 * Behaviour is unchanged from main: organization switch, pending votes badge,
 * pause notice, signing inbox, wallet bar, sign out.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { authClient } from "../auth.js";
import { omni } from "../omniroles-api.js";
import { SigningInbox } from "./SigningInbox.js";
import { WalletBar } from "./WalletBar.js";
import { Kicker, NightPanel } from "./design.js";
import { WalletProvider } from "../lib/wallet-context.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";
import { disconnectNearWallet } from "../wallets.js";

type Organization = { id: string; name: string };

const NEW_COMPANY = "__new__";

const SECTIONS: Array<{ to: string; numeral: string; label: string; end?: boolean }> = [
  { to: "/overview", numeral: "I", label: "HQ", end: true },
  { to: "/agents", numeral: "II", label: "Agents" },
  { to: "/roles", numeral: "III", label: "Rules" },
  { to: "/activity", numeral: "IV", label: "Activity" },
  { to: "/wallet", numeral: "V", label: "Treasury" },
  { to: "/governance", numeral: "VI", label: "Votes" },
  { to: "/shares", numeral: "VII", label: "Owners" },
  { to: "/selling", numeral: "VIII", label: "Market" },
  { to: "/settings", numeral: "IX", label: "Settings" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => (await authClient.organization.list()).data as Organization[],
  });
  const activeOrganizationId = session.data?.session.activeOrganizationId;
  const active = organizations.data?.find((organization) => organization.id === activeOrganizationId) ?? organizations.data?.[0] ?? null;
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
  const [halting, setHalting] = useState(false);
  const [haltError, setHaltError] = useState<string | null>(null);

  useEffect(() => {
    setDemoWalletScope(session.data?.user.id ?? null);
  }, [session.data?.user.id]);

  useEffect(() => {
    if (active && !activeOrganizationId) {
      void authClient.organization.setActive({ organizationId: active.id });
    }
  }, [active?.id, activeOrganizationId]);

  async function haltAll() {
    setHaltError(null);
    setHalting(true);
    try {
      await omni.pauseProposal(true);
      await queryClient.invalidateQueries();
      navigate("/governance");
    } catch (cause) {
      setHaltError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHalting(false);
    }
  }

  return (
    <WalletProvider>
      <div className="app-shell">
        <aside className="side">
          <NavLink to="/overview" className="brand">
            <svg width="24" height="24" viewBox="0 0 1024 1024" aria-hidden="true">
              <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
              <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
              <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
              <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
            </svg>
            EUTHYNA
          </NavLink>

          {active ? (
            <div className="side-company">
              <span className="ori-panel mark">{initials(active.name)}</span>
              <span style={{ minWidth: 0 }}>
                <select
                  aria-label="Company"
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
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                  <option value={NEW_COMPANY}>+ New company</option>
                </select>
                <small style={{ display: "block" }}>{status.data?.treasury ? "On Atlantis · testnet" : "Setting up · testnet"}</small>
              </span>
            </div>
          ) : null}

          <nav className="nav" aria-label="Console">
            {SECTIONS.map((section) => (
              <NavLink key={section.to} to={section.to} end={section.end ?? false} className={({ isActive }) => (isActive ? "active" : "")}>
                <b>{section.numeral}</b>
                {section.label}
                {section.to === "/governance" && toVote ? <span className="nav-badge" title="Waiting for your vote">{toVote}</span> : null}
              </NavLink>
            ))}
            {setupRequired ? <NavLink to="/onboarding">Finish setup</NavLink> : null}
          </nav>

          <NightPanel className="council" style={{ marginTop: "auto", boxShadow: "none" }}>
            <Kicker color="#F4A28C">Security council</Kicker>
            <p>{paused ? "Agents are halted. Only an owners' vote resumes them." : "One click stops every agent. Only an owners' vote resumes them."}</p>
            <button type="button" onClick={() => void haltAll()} disabled={halting || paused} title={paused ? "Already paused" : "Propose pausing every agent"}>
              {paused ? "AGENTS HALTED" : halting ? "PROPOSING…" : "HALT ALL AGENTS"}
            </button>
            {haltError ? <span style={{ fontSize: 12, color: "#F4C9BC" }}>{haltError}</span> : null}
          </NightPanel>

          <div className="side-user">
            <span className="avatar">{initials(session.data?.user.name ?? "?")}</span>
            <span style={{ minWidth: 0 }}>
              <b>{session.data?.user.name ?? "member"}</b>
              <br />
              <small>Owner · council</small>
            </span>
          </div>
          <button
            className="signout"
            type="button"
            title="Sign out, then sign in with another member's wallet"
            onClick={() => void authClient.signOut().then(disconnectNearWallet).then(() => navigate("/"))}
          >
            SIGN OUT
          </button>
        </aside>

        <div className="ground">
          <header className="app-topbar">
            <h1 className="company-name">{active?.name ?? "EUTHYNA"}</h1>
            {status.data?.treasury ? (
              <span className={`state-pill${paused ? " paused" : ""}`}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: paused ? "var(--terra-ink)" : "var(--aegean-ink)" }} />
                {paused ? "Agents paused" : "Agents at work"}
              </span>
            ) : status.data ? (
              <span className="state-pill paused">Setting up</span>
            ) : null}
            <span className="tesnet-pill">Testnet</span>
            <SigningInbox />
            <WalletBar />
            <span className="who">
              <span className="avatar">{initials(session.data?.user.name ?? "?")}</span>
              {myAccount || session.data?.user.name || "member"}
            </span>
          </header>
          <main style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            {paused ? (
              <NightPanel style={{ padding: "14px 18px", borderLeft: "3px solid var(--terra)", fontSize: 14, color: "#F4C9BC" }}>
                <b style={{ color: "#fff" }}>Operations are paused.</b> No money can move until members vote to resume.
              </NightPanel>
            ) : null}
            <Outlet />
          </main>
        </div>
      </div>
    </WalletProvider>
  );
}
