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
import { RecoveryAlert } from "../routes/RecoveryCard.js";
import { SigningInbox } from "./SigningInbox.js";
import { WalletBar } from "./WalletBar.js";
import { Kicker, NightPanel } from "./design.js";
import { WalletProvider } from "../lib/wallet-context.js";
import { setupLater } from "../lib/setup-later.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";
import { signVaultCall } from "../wallets.js";

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
  // Listed in the Atlantis directory, or a private vault (the default).
  const directory = useQuery({ queryKey: ["omni-directory"], queryFn: omni.directory, enabled: Boolean(status.data?.treasury), staleTime: 60_000 });
  const members = useQuery({ queryKey: ["omni-members"], queryFn: omni.members, enabled: Boolean(active), staleTime: 60_000 });
  const myAccount = members.data?.me ?? "";
  const toVote = (governance.data?.proposals ?? []).filter((proposal) => proposal.status === "InProgress" && Boolean(myAccount) && !(myAccount in proposal.votes)).length;
  const noRole = roles.isSuccess && roles.data.roles.length === 0;
  // "Skip for now" in setup (past the wallet): no reminder for the roles still to vote.
  const setupRequired = Boolean(status.data) && (!status.data?.wallet || (noRole && !setupLater(active?.id)));
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
      // A council member pauses the vault directly (no vote): prepare refuses every operation
      // until the members vote to resume.
      const vault = status.data?.treasury?.vaultAccountId;
      if (!vault || !myAccount) throw new Error("Connect a council member's NEAR wallet to halt the agents.");
      await signVaultCall(myAccount, vault, "pause", {});
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
                <small style={{ display: "block" }}>
                  {!status.data ? "testnet" : !status.data.treasury ? "Setting up · testnet" : directory.data?.listing ? "On Atlantis · testnet" : "Private vault · testnet"}
                </small>
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
            <button type="button" onClick={() => void haltAll()} disabled={halting || paused} title={paused ? "Already paused" : "Pause the vault now: every agent operation is refused until the members vote to resume"}>
              {paused ? "AGENTS HALTED" : halting ? "HALTING…" : "HALT ALL AGENTS"}
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
            // The wallet stays connected: signing out asks it for nothing, and signing back in is one signature.
            onClick={() => void authClient.signOut().then(() => navigate("/"))}
          >
            SIGN OUT
          </button>
        </aside>

        <div className="ground">
          <header className="app-topbar">
            <h1 className="company-name">{active?.name ?? "EUTHYNA"}</h1>
            {status.data?.treasury && !paused && setupRequired ? (
              // No voted role yet: no agent can work.
              <span className="state-pill paused">Setting up</span>
            ) : status.data?.treasury && !paused && noRole ? (
              // Setup skipped: the company is live, no agent can work until a role is voted.
              <span className="state-pill">No agent at work yet</span>
            ) : status.data?.treasury ? (
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
          </header>
          <main style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
            {paused ? (
              <NightPanel style={{ padding: "14px 18px", borderLeft: "3px solid var(--terra)", fontSize: 14, color: "#F4C9BC" }}>
                <b style={{ color: "#fff" }}>Operations are paused.</b> No money can move until members vote to resume.
              </NightPanel>
            ) : null}
            <RecoveryAlert />
            <Outlet />
          </main>
        </div>
      </div>
    </WalletProvider>
  );
}
