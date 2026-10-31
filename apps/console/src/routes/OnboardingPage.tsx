/**
 * Company setup: one path for everyone (decided on 31 October with Alex and Koplo; two doors confused
 * people since both ended in the same place). Company, founders, DAO and vault, wallet, first hire and
 * its role; the vault is private. The last step offers Atlantis: issue shares and list the company in
 * the directory, by the council's votes, or stay private. Visual reference: design-handoff/app 17.
 * Data, queries and handlers are main's.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";

import { api, type AgentRow } from "../api.js";
import { authClient } from "../auth.js";
import { Kicker, Niche, PageTitle, Slab } from "../components/design.js";
import { short } from "../components/ui.js";
import { SigningInbox } from "../components/SigningInbox.js";
import { WalletBar } from "../components/WalletBar.js";
import { JOBS, rememberJob, rememberedJob, type Job } from "../lib/jobs.js";
import { useWallets, WalletProvider } from "../lib/wallet-context.js";
import { setDemoWalletScope } from "../lib/wallet-store.js";
import { omni, type CouncilMember } from "../omniroles-api.js";
import { NewAgent, RunYourAgent, type AgentReady } from "./AgentSetup.js";
import { FundWallet, TreasuryCreate, WalletSetup } from "./TreasurySetup.js";

type Organization = { id: string; name: string; slug: string };
type Stage = "company" | "members" | "treasury" | "wallet" | "shares" | "agent" | "role" | "done";
type Path = "euthyna" | "atlantis";
type StepView = { id: string; label: string };

const STEPS: Array<{ id: Exclude<Stage, "done">; label: string }> = [
  { id: "company", label: "Company" },
  { id: "members", label: "Founders" },
  { id: "treasury", label: "Incorporate" },
  { id: "wallet", label: "Wallet" },
  { id: "shares", label: "Shares" },
  { id: "agent", label: "First hire" },
  { id: "role", label: "Role" },
];

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** Shares are not a setup step any more: they come with Atlantis, offered at the end. */
const SETUP_STEPS: StepView[] = [...STEPS.filter((step) => step.id !== "shares"), { id: "atlantis", label: "Atlantis" }];

const TITLES: Record<Stage, string> = {
  company: "Name your AI company",
  members: "Who votes on the rules?",
  treasury: "Incorporate on NEAR",
  wallet: "Open the company wallet",
  shares: "Open the company to shareholders?",
  agent: "What should your first agent do?",
  role: "Write its role",
  done: "Your AI company is live",
};

const JOB_ORDER = ["payments", "treasury", "revenue"];

const confirmedKey = (organizationId: string) => `mandateos.members-confirmed.${organizationId}`;
const sharesSkippedKey = (organizationId: string) => `mandateos.shares-skipped.${organizationId}`;
const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (key: string, value: boolean) => {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // A convenience only.
  }
};

export function OnboardingPage() {
  const queryClient = useQueryClient();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => ((await authClient.organization.list()).data ?? []) as Organization[],
  });
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem("mandateos.organization"));
  const active = organizations.data?.find((organization) => organization.id === activeId) ?? organizations.data?.[0] ?? null;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState<AgentReady | null>(null);
  const [membersConfirmed, setMembersConfirmed] = useState(false);
  const [sharesSkipped, setSharesSkipped] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  // "+ New company" in the sidebar: one user can found several companies, each with its own DAO.
  const [searchParams, setSearchParams] = useSearchParams();
  const creating = searchParams.has("new");

  // One path: the vault is private during setup; Atlantis is offered at the end.
  const path: Path = "euthyna";

  useEffect(() => {
    if (!active) return;
    setReady(false);
    localStorage.setItem("mandateos.organization", active.id);
    setMembersConfirmed(localStorage.getItem(confirmedKey(active.id)) === "1");
    setSharesSkipped(readFlag(sharesSkippedKey(active.id)));
    setJob(rememberedJob(active.id));
    void authClient.organization.setActive({ organizationId: active.id }).finally(() => {
      setReady(true);
      void queryClient.invalidateQueries();
    });
  }, [active?.id]);

  // EUTHYNA stays private: no shares, not listed. The choice is remembered for this company.
  useEffect(() => {
    if (path !== "euthyna" || !active) return;
    writeFlag(sharesSkippedKey(active.id), true);
    setSharesSkipped(true);
  }, [path, active?.id]);

  const status = useQuery({ queryKey: ["omni-status"], queryFn: omni.status, enabled: ready, refetchInterval: 8_000 });
  const members = useQuery({ queryKey: ["omni-members"], queryFn: omni.members, enabled: ready });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: AgentRow[] }>("/v1/console/agents"), enabled: Boolean(status.data?.wallet) });
  const roles = useQuery({ queryKey: ["omni-roles"], queryFn: omni.roles, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });
  const shares = useQuery({ queryKey: ["omni-shares"], queryFn: omni.shares, enabled: Boolean(status.data?.wallet), refetchInterval: 15_000 });

  const treasury = status.data?.treasury ?? null;
  const memberCount = members.data?.members.filter((member) => member.nearAccountId).length ?? 0;
  const activeAgents = (agents.data?.agents ?? []).filter((agent) => agent.active);
  const stage: Stage = !active || creating
    ? "company"
    : !treasury
      ? (memberCount < 3 || !membersConfirmed ? "members" : "treasury")
      : !status.data?.wallet
        ? "wallet"
        : !shares.data?.deployed && !sharesSkipped && path !== "euthyna"
          ? "shares"
          : newAgent || activeAgents.length === 0
          ? "agent"
          : (roles.data?.roles.length ?? 0) === 0
            ? "role"
            : "done";
  const loading = organizations.isLoading || (Boolean(active) && !creating && (!ready || status.isLoading || members.isLoading || (Boolean(status.data?.wallet) && shares.isLoading)));
  // A member whose company is already set up has nothing to do here (OPEN APP, a site button, a bookmark):
  // the first stage read decides. Reaching "done" during this visit still shows the closing screen.
  // On Atlantis, a company that already works (agents with a role) but never issued shares counts as set up too.
  const firstStage = useRef<Stage | null>(null);
  if (!loading && firstStage.current === null) {
    const working = activeAgents.length > 0 && (roles.data?.roles.length ?? 0) > 0;
    firstStage.current = stage === "shares" && working ? "done" : stage;
  }
  const firstAgent = activeAgents[0];
  const contractJob = JOBS.find((item) => item.role === firstAgent?.role) ?? job;

  const steps = SETUP_STEPS;
  // On Atlantis the last step is the city: listing is a members' vote, still to come once the company is live.
  const currentIndex = stage === "done"
    ? (shares.data?.deployed ? steps.length : steps.findIndex((step) => step.id === "atlantis"))
    : steps.findIndex((step) => step.id === stage);

  const waitingFor: Record<Stage, string> = {
    company: "It names the DAO and the vault on NEAR",
    members: `${memberCount} of 3 founders · the NEAR accounts that vote on the rules`,
    treasury: "Two contracts: the DAO for the members, the vault for the rules",
    wallet: "Founders vote to open the company wallet",
    shares: "Open the company to shareholders, or skip",
    agent: "Hire the first agent",
    role: "What it may do, and its budget. The founders vote on it",
    done: "Set up. One step left, only if you want it: Atlantis",
  };

  if (firstStage.current === "done" && !creating) return <Navigate to="/overview" replace />;

  return (
    <div
      className={`onb onb-${path}`}
      style={{
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "clamp(18px, 2.4vw, 30px)",
        padding: "clamp(22px, 2.8vw, 34px) clamp(20px, 3.5vw, 56px) clamp(30px, 4vw, 56px)",
        backgroundColor: path === "euthyna" ? "#F3EFE7" : "#030918",
        // Atlantis path: the city. EUTHYNA path: the stele of the law, no city (the vault stays private).
        backgroundImage:
          path === "euthyna"
            ? "linear-gradient(rgba(246,242,235,.84), rgba(246,242,235,.84)), url(/media/textures/marble-white.jpg)"
            : "radial-gradient(60% 70% at 78% 40%, rgba(3,9,24,0) 0%, rgba(3,9,24,.6) 60%, rgba(3,9,24,.96) 100%), linear-gradient(90deg, rgba(3,9,24,.96) 0%, rgba(3,9,24,.85) 45%, rgba(3,9,24,.55) 100%), url(/media/renders/R3-atlantis-aerial.jpg)",
        backgroundSize: path === "euthyna" ? "cover, cover" : "cover, cover, 1100px auto",
        backgroundPosition: path === "euthyna" ? "0 0, 0 0" : "0 0, 0 0, right -180px center",
        // A full screen of its own, outside the console shell.
        minHeight: "100vh",
        backgroundRepeat: "no-repeat",
        color: "var(--onb-text)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <Link to={organizations.data?.length ? "/overview" : "/"} className="onb-brand" aria-label="EUTHYNA, back to the console">
          <svg width="24" height="24" viewBox="0 0 1024 1024" aria-hidden="true">
            <circle cx="512" cy="512" r="307" fill="none" stroke="currentColor" strokeWidth="102" />
            <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
            <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
            <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
          </svg>
          EUTHYNA
        </Link>
        <Kicker color={path === "euthyna" ? "var(--gold-ink)" : "#4FD1E8"}>
          · Set up your company
        </Kicker>
        <span style={{ marginLeft: "auto", font: "600 11px var(--font-mono)", letterSpacing: ".08em", color: "var(--onb-mute)" }}>
          TESTNET · NOT AUDITED
        </span>
        <SigningInbox />
        <WalletBar />
      </header>

      {error ? (
        <div
          role="alert"
          style={{ border: "1px solid rgba(217,87,59,.55)", background: "rgba(74,26,16,.65)", padding: "12px 16px", fontSize: 13.5, color: "#F4C9BC" }}
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-busy="true">
          <div className="loading-slab" style={{ height: 46, maxWidth: 1000 }} />
          <div className="loading-slab" style={{ height: 64, maxWidth: 720 }} />
          <div className="loading-slab" style={{ height: 120 }} />
        </div>
      ) : (
        <>
          <SetupProgress steps={steps} current={currentIndex} skipped={sharesSkipped && !shares.data?.deployed ? ["shares"] : []} />

          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
            <Kicker color="var(--onb-gold)">
              {active?.name ?? "Your AI company"} · private vault
            </Kicker>
            <PageTitle style={{ color: "var(--onb-title)", textShadow: "var(--onb-title-shadow)", fontSize: 44, lineHeight: 1.05 }}>
              {TITLES[stage]}
            </PageTitle>
            <p style={{ margin: 0, fontSize: 15.5, color: "var(--onb-soft)" }}>{waitingFor[stage]}</p>
          </div>

          {stage === "company" ? (
            <CompanyStep
              organizations={organizations.data ?? []}
              onCreated={async (organization) => {
                setActiveId(organization.id);
                setSearchParams({});
                await organizations.refetch();
              }}
              onError={setError}
            />
          ) : null}

          {stage === "members" && members.data ? (
            <MembersStep
              members={members.data.members}
              onChanged={async () => { await members.refetch(); }}
              onContinue={() => {
                if (active) localStorage.setItem(confirmedKey(active.id), "1");
                setMembersConfirmed(true);
              }}
              onError={setError}
            />
          ) : null}

          {stage === "treasury" && active ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 960 }}>
              <TreasuryCreate companyName={active.name} onCreated={async () => { await status.refetch(); }} />
              <div>
                <button className={`btn-line${path === "euthyna" ? "" : " on-dark"}`} onClick={() => setMembersConfirmed(false)}>← CHANGE MEMBERS</button>
              </div>
            </div>
          ) : null}

          {stage === "wallet" && status.data ? <WalletSetup status={status.data} onChanged={async () => { await status.refetch(); }} /> : null}

          {stage === "shares" && active ? (
            <Slab style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Kicker>Shares</Kicker>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" }}>
                  Anyone with a NEAR wallet can then buy shares. Locked shares vote on company decisions, and the revenue
                  the company shares goes to the holders who vote. Founders keep their vote and their veto.
                </p>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link className="btn-ori" style={{ textDecoration: "none", display: "inline-block" }} to="/shares">ISSUE SHARES</Link>
                <button className="btn-line" onClick={() => { writeFlag(sharesSkippedKey(active.id), true); setSharesSkipped(true); }}>
                  SKIP FOR NOW
                </button>
              </div>
            </Slab>
          ) : null}

          {stage === "agent" && treasury && !newAgent && !job ? (
            <JobPicker
              hasShares={Boolean(shares.data?.deployed)}
              onPick={(picked) => {
                if (active) rememberJob(active.id, picked.id);
                setJob(picked);
              }}
            />
          ) : null}

          {stage === "agent" && treasury && (newAgent || job) ? (
            newAgent ? (
              <RunYourAgent
                agent={newAgent}
                vaultAccountId={treasury.vaultAccountId}
                // The next setup step is the role, not the HQ.
                doneLabel={(roles.data?.roles.length ?? 0) === 0 ? "NEXT · WRITE ITS ROLE" : "DONE · GO TO YOUR HQ"}
                onDone={() => {
                  setNewAgent(null);
                  void agents.refetch();
                }}
              />
            ) : (
              <Slab style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 960 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Kicker>First hire · {job!.title}</Kicker>
                  <b style={{ font: "800 24px var(--font-brand)", letterSpacing: ".04em" }}>HIRE THE {job!.agentName.toUpperCase()}</b>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" }}>
                    The agent gets its own NEAR account. It can only ask the vault for operations, and only those its voted
                    role allows.
                  </p>
                </div>
                <NewAgent vaultAccountId={treasury.vaultAccountId} defaultName={job!.agentName} defaultRole={job!.role} onReady={setNewAgent} />
                <div>
                  <button className="btn-line" onClick={() => setJob(null)}>← ANOTHER ROLE</button>
                </div>
              </Slab>
            )
          ) : null}

          {stage === "role" ? (
            <Slab style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Kicker>Role</Kicker>
                <b style={{ font: "800 24px var(--font-brand)", letterSpacing: ".04em" }}>WHAT {firstAgent?.name ?? "THE AGENT"} MAY DO</b>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" }}>
                  {contractJob ? `${contractJob.allows}. ` : ""}Everything else is refused by the vault. You set the budget;
                  the founders vote on it.
                </p>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", display: "flex", flexDirection: "column", gap: 6 }}>
                  <li>The role <span style={{ font: "500 12.5px var(--font-mono)", color: "var(--ink)" }}>{firstAgent?.role ?? "treasury"}</span> opens with {contractJob ? `"${contractJob.title}"` : "nothing"} already added: set the budget{contractJob?.id === "payments" ? " and pick the suppliers" : ""}.</li>
                  <li>Preview, then submit it to the founders' vote.</li>
                  <li>They approve it in Decisions; it applies after the veto window, and the agent can start.</li>
                </ol>
              </div>
              <Link
                className="btn-ori"
                style={{ textDecoration: "none", display: "inline-block", alignSelf: "flex-start" }}
                to={`/roles?new=1&role=${encodeURIComponent(firstAgent?.role ?? "treasury")}${contractJob ? `&job=${contractJob.id}` : ""}`}
              >
                WRITE THE ROLE
              </Link>
            </Slab>
          ) : null}

          {(stage === "agent" || stage === "role") && status.data ? <FundWallet status={status.data} showNext={false} /> : null}

          {stage === "done" ? (
            <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)", gap: 22, maxWidth: 1100, alignItems: "stretch" }}>
              <Slab style={{ padding: "26px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
                <Kicker>Live · private vault</Kicker>
                <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "var(--ink-2)" }}>
                  Founders and {shares.data?.deployed ? "shareholders" : "members"} set the rules, {activeAgents.length} agent{activeAgents.length > 1 ? "s" : ""} work
                  inside them, and every operation is checked by the vault on NEAR before the company wallet signs.
                </p>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: "auto" }}>
                  <Link className="btn-ori" style={{ textDecoration: "none", display: "inline-block" }} to="/overview">GO TO HQ</Link>
                  <Link className="btn-line" style={{ textDecoration: "none", display: "inline-block" }} to="/activity">WHAT THE AGENTS DID</Link>
                </div>
              </Slab>
              <section
                className="night-panel"
                style={{
                  padding: "26px 28px", display: "flex", flexDirection: "column", gap: 14,
                  backgroundImage: "linear-gradient(90deg, rgba(3,9,24,.97) 0%, rgba(3,9,24,.88) 55%, rgba(3,9,24,.55) 100%), url(/media/renders/R3-atlantis-aerial.jpg)",
                  backgroundSize: "cover, 760px auto", backgroundPosition: "0 0, right -160px center", backgroundRepeat: "no-repeat",
                }}
              >
                <Kicker color="#4FD1E8">Optional · Atlantis</Kicker>
                <b style={{ font: "800 24px/1.2 var(--font-brand)", letterSpacing: ".04em", color: "#F3EFE6" }}>Open the company to the city?</b>
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#C9D3EA" }}>
                  Issue shares: anyone can buy them, and the holders who vote share the revenue. Then list the company in the Atlantis directory.
                  Each is a vote of your council. Until then the vault stays private.
                </p>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: "auto" }}>
                  {shares.data?.deployed ? (
                    <Link className="btn-ori" style={{ textDecoration: "none", display: "inline-block" }} to="/settings">LIST IN THE DIRECTORY</Link>
                  ) : (
                    <Link className="btn-ori" style={{ textDecoration: "none", display: "inline-block" }} to="/shares">ISSUE SHARES</Link>
                  )}
                  <Link className="btn-line on-dark" style={{ textDecoration: "none", display: "inline-block" }} to="/overview">STAY PRIVATE</Link>
                </div>
              </section>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The eight (or seven) seals: done, current, still to come, and the steps a private vault skips. */
function SetupProgress({ steps, current, skipped }: { steps: StepView[]; current: number; skipped: string[] }) {
  const progress = steps.length > 1 ? Math.min(1, Math.max(0, current / (steps.length - 1))) : 0;
  return (
    <div style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`, gap: 4, maxWidth: 1000 }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "6%",
          right: "6%",
          top: 20,
          height: 2,
          background: `linear-gradient(90deg, #C9890C 0%, #C9890C ${(progress * 100).toFixed(1)}%, var(--onb-rail) ${(progress * 100).toFixed(1)}%)`,
        }}
      />
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const skippedHere = done && skipped.includes(step.id);
        return (
          <div
            key={step.id}
            style={{
              position: "relative",
              zIndex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              textAlign: "center",
              font: "700 11px var(--font-brand)",
              letterSpacing: ".16em",
              color: active ? "var(--onb-gold)" : done ? "var(--onb-soft)" : "var(--onb-mute)",
            }}
          >
            {done ? (
              <span className="app-seal" style={{ width: 40, height: 40 }}>
                <span style={{ fontSize: 15, color: "#4A2C06" }}>{skippedHere ? "–" : "✓"}</span>
              </span>
            ) : (
              <span
                style={{
                  width: active ? 46 : 40,
                  height: active ? 46 : 40,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--onb-disc)",
                  boxShadow: active ? "0 0 0 2px #F2B544, 0 0 26px rgba(242,181,68,.55)" : "inset 0 0 0 1.5px var(--onb-rail)",
                  font: `${active ? 800 : 700} ${active ? 14 : 13}px var(--font-brand)`,
                  color: active ? "var(--onb-gold)" : "var(--onb-mute)",
                }}
              >
                {NUMERALS[index] ?? String(index + 1)}
              </span>
            )}
            <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {step.label}
              {skippedHere ? " (skipped)" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function JobPicker(props: { hasShares: boolean; onPick: (job: Job) => void }) {
  const [selected, setSelected] = useState<Job | null>(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 26, alignItems: "start", maxWidth: 1200 }}>
      {JOB_ORDER.map((id) => JOBS.find((item) => item.id === id))
        .filter((item): item is Job => Boolean(item))
        .map((item) => {
          const blocked = item.needsShares && !props.hasShares;
          const on = selected?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={blocked}
              onClick={() => setSelected(item)}
              className="slab"
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                padding: 0,
                border: 0,
                borderRadius: 2,
                textAlign: "left",
                whiteSpace: "normal",
                color: "var(--ink)",
                cursor: blocked ? "not-allowed" : "pointer",
                opacity: blocked ? 0.6 : 1,
                boxShadow: on
                  ? "0 0 0 3px #F2B544, 0 0 40px rgba(242,181,68,.35), 24px 30px 60px rgba(0,0,0,.45)"
                  : "24px 30px 60px rgba(0,0,0,.45), inset 0 0 0 1px rgba(13,23,48,.08)",
              }}
            >
              {on ? (
                <span
                  style={{
                    position: "absolute",
                    top: 30,
                    left: "50%",
                    transform: "translateX(-50%)",
                    padding: "5px 12px",
                    background: "#F2B544",
                    color: "#061433",
                    font: "800 10px var(--font-brand)",
                    letterSpacing: ".18em",
                    whiteSpace: "nowrap",
                  }}
                >
                  SELECTED
                </span>
              ) : null}
              <div style={{ margin: "18px 18px 0", borderRadius: "150px 150px 2px 2px", overflow: "hidden" }}>
                <Niche role={item.role} height={240} />
              </div>
              <div style={{ padding: "18px 22px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
                <Kicker>{item.agentName}</Kicker>
                <b style={{ font: "800 20px var(--font-brand)", letterSpacing: ".06em" }}>{item.title}</b>
                <span style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>{item.pitch}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)", borderTop: "1px solid rgba(13,23,48,.12)", paddingTop: 8, lineHeight: 1.5 }}>
                  <b style={{ color: "var(--ink)" }}>Allows:</b>{" "}
                  {blocked ? "Needs company shares: issue them after setup, from Owners." : `${item.allows}. Everything else is refused.`}
                </span>
              </div>
            </button>
          );
        })}

      <div
        className="night-panel"
        style={{ alignSelf: "end", display: "flex", flexDirection: "column", gap: 14, padding: 22, border: "1px solid rgba(242,181,68,.35)" }}
      >
        <Kicker color="#F2B544">Next · {NUMERALS[SETUP_STEPS.findIndex((step) => step.id === "role")]} · Role</Kicker>
        <span style={{ fontSize: 14, color: "#C9D3EA" }}>
          Name the agent and set its budget. The founders vote on it before it can ask the vault for anything.
        </span>
        <button
          type="button"
          className="btn-ori"
          disabled={!selected}
          onClick={() => {
            if (selected) props.onPick(selected);
          }}
        >
          {selected ? `HIRE THE ${selected.agentName.toUpperCase()}` : "PICK A ROLE"}
        </button>
      </div>
    </div>
  );
}

function CompanyStep(props: { organizations: Organization[]; onCreated: (organization: Organization) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const created = await authClient.organization.create({ name: name.trim(), slug });
      if (created.error || !created.data) throw new Error(created.error?.message ?? "Could not create the company");
      await props.onCreated(created.data as Organization);
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Slab style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Kicker>Company</Kicker>
        <b style={{ font: "800 24px var(--font-brand)", letterSpacing: ".04em" }}>CREATE YOUR COMPANY</b>
        <span style={{ fontSize: 14, color: "var(--ink-2)" }}>The name is also used for the DAO and vault accounts on NEAR.</span>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field-app" style={{ flex: "1 1 280px", maxWidth: 420 }}>
          <label htmlFor="company-name">Company name</label>
          <input id="company-name" placeholder="Company name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <button className="btn-ori" disabled={busy || name.trim().length < 2} onClick={() => void create()}>
          CREATE COMPANY
        </button>
      </div>
    </Slab>
  );
}

function MembersStep(props: {
  members: CouncilMember[];
  onChanged: () => Promise<void>;
  onContinue: () => void;
  onError: (message: string) => void;
}) {
  const wallets = useWallets();
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const count = props.members.filter((member) => member.nearAccountId).length;
  const threshold = Math.ceil((2 * Math.max(count, 3)) / 3);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    props.onError("");
    try {
      await action();
      await props.onChanged();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Slab style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 960 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Kicker>Founders</Kicker>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ink-2)" }}>
          Add the NEAR accounts of the people who will vote. No invitation is sent: each person signs in here with that wallet.
          They become the DAO members when the treasury is created.
        </p>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ minWidth: 520 }}>
          <thead>
            <tr>
              <th>NEAR account</th>
              <th>Name</th>
              <th>Signed in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.members.map((member) => (
              <tr key={member.id}>
                <td style={{ font: "500 13px var(--font-mono)" }} title={member.nearAccountId ?? undefined}>
                  {member.nearAccountId ? short(member.nearAccountId, 14) : <span style={{ color: "var(--ink-3)" }}>—</span>}
                  {member.nearAccountId === wallets.nearAccountId ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}> (you)</span> : null}
                </td>
                <td>{member.name ?? <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                <td style={{ fontSize: 13 }}>{member.signedIn ? "yes" : <span style={{ color: "var(--ink-3)" }}>not yet</span>}</td>
                <td>
                  {member.role !== "owner" ? (
                    <button className="btn" disabled={busy} onClick={() => void run(() => omni.removeMember(member.id))}>Remove</button>
                  ) : <span style={{ fontSize: 12, color: "var(--ink-3)" }}>founder</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await omni.addMember({ nearAccountId: account.trim().toLowerCase(), ...(name.trim() ? { name: name.trim() } : {}) });
            setAccount("");
            setName("");
          });
        }}
      >
        <div className="field-app" style={{ flex: "1 1 220px", maxWidth: 320 }}>
          <label htmlFor="member-account">NEAR account</label>
          <input id="member-account" placeholder="bob.testnet" value={account} onChange={(event) => setAccount(event.target.value)} />
        </div>
        <div className="field-app" style={{ flex: "1 1 180px", maxWidth: 260 }}>
          <label htmlFor="member-name">Name (optional)</label>
          <input id="member-name" placeholder="Bob" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <button className="btn-ori" type="submit" disabled={busy || account.trim().length < 2}>{busy ? "CHECKING ON NEAR…" : "ADD MEMBER"}</button>
      </form>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)" }}>
        The account must exist on NEAR testnet. Each member needs about 0.3 NEAR to pay for votes.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid rgba(13,23,48,.12)", paddingTop: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {count < 3 ? `Add at least ${3 - count} more member${3 - count > 1 ? "s" : ""}.` : `${count} members · a decision will need ${threshold} of ${count} approvals.`}
        </span>
        <button className="btn-ori" style={{ marginLeft: "auto" }} disabled={count < 3} onClick={props.onContinue}>CONTINUE</button>
      </div>
    </Slab>
  );
}

/** The setup screen with what the console shell used to provide: the signing wallet and its demo scope. */
export function OnboardingScreen() {
  const session = authClient.useSession();
  useEffect(() => {
    setDemoWalletScope(session.data?.user.id ?? null);
  }, [session.data?.user.id]);
  return (
    <WalletProvider>
      <OnboardingPage />
    </WalletProvider>
  );
}
