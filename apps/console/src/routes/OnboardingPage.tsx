import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { KeyPair } from "near-api-js";

import { API_BASE, api, explorerBase, explorerNear, type BudgetTokenPlan, type BudgetTokenStatus, type MandatePreview, type MandateProposal, type TreasuryPlan, type TreasuryView } from "../api.js";
import { demoWalletsEnabled, generatedNearPublicKey, selectDemoWalletScopeForAccounts, selectDemoWalletScopeForEvmAddress, setDemoWalletScope, setGeneratedNearAccountId } from "../lib/wallet-store.js";
import { formatToken } from "../lib/format.js";
import { useWallets } from "../lib/wallet-context.js";
import { proposalDecision } from "../lib/governance-view.js";
import {
  buildSafeBatch,
  executeSafeBatch,
  signSafeBatch,
  type SafeBatch,
  type SafeBatchSignature,
} from "../safe.js";
import { authClient } from "../auth.js";
import {
  bridgeSepoliaEthToBase,
  createDao,
  disableFactoryAutoUpdate,
  findDaoProposalsRpc,
  readAgentAccessKeyRpc,
  readDaoPolicyRpc,
  readDaoProposalRpc,
  readBaseDeploymentRpc,
  readNearDeploymentRpc,
  sendEvmTransaction,
  signDaoProposal,
  signDaoVote,
  signNearFunctionCalls,
  signNearTransactions,
  signWalletProofChallenge,
  waitForEvmTransaction,
  type DaoPolicyRpc,
  type DaoProposalRpc,
  type AgentAccessKeyRpcAttestation,
  type NearDeploymentRpcAttestation,
  type WalletProofChallenge,
} from "../wallets.js";

type Organization = { id: string; name: string; slug: string };
type Member = {
  id: string;
  userId: string;
  role: string;
  nearAccountId: string | null;
  evmAddress: string | null;
  email: string | null;
  name: string | null;
  walletProofClaimable: boolean;
  walletProofVerifiedAt: string | null;
  walletProofApprovedAt: string | null;
  walletProofApprovedBy: string | null;
};

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

const YOCTO_PER_NEAR = 10n ** 24n;

function transferDeposit(actions: TreasuryPlan["vault"]["actions"]): bigint {
  const transfer = actions.find((action) => action.type === "Transfer");
  return BigInt(transfer?.type === "Transfer" ? transfer.depositYocto : "0");
}

function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const milli = (yocto % YOCTO_PER_NEAR) / 10n ** 21n;
  const fraction = milli.toString().padStart(3, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

export function OnboardingPage() {
  const session = authClient.useSession();
  const wallets = useWallets();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganization, setActiveOrganization] = useState<Organization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [plan, setPlan] = useState<TreasuryPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [mandate, setMandate] = useState<MandatePreview | null>(null);
  const [setupOverview, setSetupOverview] = useState<{
    treasury: TreasuryView | null;
    safeBalance: string | null;
    agents: { total: number; active: number };
    roleBudgets: Array<{ role: string }>;
  } | null>(null);
  const [founderNear, setFounderNear] = useState("");
  const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);
  const claimMemberId = new URLSearchParams(window.location.search).get("member");

  const signedIn = Boolean(session.data?.user);
  const approvedMemberCount = members.filter((member) => member.walletProofApprovedAt).length;
  const setupStage = !activeOrganization
    ? "company"
    : approvedMemberCount < 3
      ? "members"
      : !treasury || treasury.status !== "active"
        ? "treasury"
        : (setupOverview?.agents.total ?? 0) === 0
          ? "agent"
          : (setupOverview?.roleBudgets.length ?? 0) === 0
            ? "mandate"
            : "done";
  const waitingFor = setupStage === "members"
    ? `${approvedMemberCount} of 3 done · waiting for invited members and an admin review`
    : setupStage === "treasury"
      ? "Council members approve the Treasury deployment"
      : setupStage === "agent"
        ? "Company admin registers the AI agent"
        : setupStage === "mandate"
          ? "Council members approve the first spending permission"
          : setupStage === "done"
            ? "Setup complete"
            : "Company founder creates the workspace";

  async function refreshOrganizations() {
    const result = await authClient.organization.list();
    const list = (result.data ?? []) as Organization[];
    setOrganizations(list);
    const stored = localStorage.getItem("mandateos.organization");
    const selected = list.find((organization) => organization.id === stored) ?? list[0] ?? null;
    setActiveOrganization(selected);
    if (selected) localStorage.setItem("mandateos.organization", selected.id);
  }

  async function refreshMembers(organizationId: string) {
    const result = await api<{ members: Member[] }>(`/v1/console/members?organizationId=${organizationId}`);
    setMembers(result.members);
  }

  async function refreshTreasury() {
    const result = await api<{ treasury: TreasuryView | null }>("/v1/console/treasury");
    setTreasury(result.treasury);
  }

  async function refreshSetupOverview() {
    setSetupOverview(await api("/v1/console/overview"));
  }

  useEffect(() => {
    setDemoWalletScope(session.data?.user.id ?? null);
  }, [session.data?.user.id]);

  useEffect(() => {
    if (!signedIn) {
      setPasskeyReady(null);
      return;
    }
    if (import.meta.env.VITE_E2E === "1") {
      setPasskeyReady(true);
      return;
    }
    void authClient.passkey.listUserPasskeys()
      .then((result) => {
        if (result.error) throw new Error(result.error.message ?? "Could not read passkeys");
        setPasskeyReady((result.data?.length ?? 0) > 0);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || passkeyReady !== true) return;
    refreshOrganizations().catch((cause: unknown) => setError(String(cause)));
    if (wallets.nearAccountId) setFounderNear(wallets.nearAccountId);
  }, [signedIn, passkeyReady, wallets.nearAccountId]);

  useEffect(() => {
    if (!activeOrganization) return;
    void (async () => {
      await authClient.organization.setActive({ organizationId: activeOrganization.id }).catch(() => undefined);
      await refreshMembers(activeOrganization.id).catch((cause: unknown) => setError(String(cause)));
      await refreshTreasury().catch((cause: unknown) => setError(String(cause)));
      await refreshSetupOverview().catch(() => undefined);
    })();
  }, [activeOrganization?.id]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!signedIn) {
    return <SignIn />;
  }
  if (passkeyReady === null) {
    return <div className="auth"><div className="auth-card"><p>Checking passkey enrollment…</p></div></div>;
  }
  if (!passkeyReady) {
    return (
      <PasskeyEnrollment
        email={session.data?.user.email ?? ""}
        onComplete={() => setPasskeyReady(true)}
      />
    );
  }
  if (claimMemberId && session.data?.user.emailVerified !== true) {
    return (
      <EmailVerification
        email={session.data?.user.email ?? ""}
        onVerified={async () => {
          await session.refetch();
        }}
      />
    );
  }
  if (claimMemberId) {
    return (
      <WalletProofPanel
        memberId={claimMemberId}
        onVerified={async () => {
          window.history.replaceState({}, "", "/onboarding");
          await refreshOrganizations();
        }}
        onError={setError}
      />
    );
  }

  return (
    <div className="page onboarding-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Guided company setup</span>
          <h1>{activeOrganization?.name ?? "Create your company"}</h1>
          <p className="muted">Resume at any time. Every signature stays in the connected member wallet.</p>
          <p className="setup-actor">{waitingFor}</p>
        </div>
        <div className="row wrap">
          <div className="pill">Base Sepolia · NEAR testnet</div>
          {activeOrganization ? <a className="pill" href="/">Overview →</a> : null}
        </div>
      </header>
        {demoWalletsEnabled() ? (
          <div className="alert error">
            UAT DEMO MODE — generated NEAR and EVM private keys are stored in this browser's
            localStorage. Use testnet assets only. This mode is disabled by default.
          </div>
        ) : null}

        {error ? <div className="alert error">{error}</div> : null}
        {notice ? <div className="alert success">{notice}</div> : null}

        <SetupProgress
          companyReady={Boolean(activeOrganization)}
          membersReady={approvedMemberCount >= 3}
          treasuryReady={treasury?.status === "active"}
          agentReady={(setupOverview?.agents.total ?? 0) > 0}
          mandateReady={(setupOverview?.roleBudgets.length ?? 0) > 0}
        />
        {apiKey ? (
          <section className="card secret">
            <span className="eyebrow">Agent API key · shown once</span>
            <p>Save this key in your agent environment. It cannot be displayed again.</p>
            <pre>{apiKey}</pre>
            <div className="row">
              <button
                className="primary"
                onClick={() => void navigator.clipboard.writeText(apiKey).then(() => setApiKeyCopied(true))}
              >
                {apiKeyCopied ? "Copied" : "Copy API key"}
              </button>
              <button className="ghost" onClick={() => setApiKey(null)}>I saved it</button>
            </div>
          </section>
        ) : null}
        {setupStage === "company" ? <section id="onboarding" className="card">
          <h2>Create your company</h2>
          <OrganizationPanel
            mode="company"
            organizations={organizations}
            active={activeOrganization}
            onChanged={async () => {
              await refreshOrganizations();
            }}
            onSelect={(organization) => {
              setActiveOrganization(organization);
              localStorage.setItem("mandateos.organization", organization.id);
            }}
            members={members}
            onError={setError}
            onMembersChanged={async () => {
              if (activeOrganization) await refreshMembers(activeOrganization.id);
            }}
          />
        </section> : null}

        {setupStage === "members" && activeOrganization ? (
          <section id="wallets" className="card">
            <h2>Invite and verify members</h2>
            <OrganizationPanel
              mode="members"
              organizations={organizations}
              active={activeOrganization}
              onChanged={refreshOrganizations}
              onSelect={(organization) => {
                setActiveOrganization(organization);
                localStorage.setItem("mandateos.organization", organization.id);
              }}
              members={members}
              onError={setError}
              onMembersChanged={async () => refreshMembers(activeOrganization.id)}
            />
            <p className="muted">
              Each member proves the NEAR account that signs DAO proposals and the EVM address
              that becomes a Safe owner. The server stores public addresses and signed proofs.
            </p>
            <MemberWallets
              members={members}
              currentUserId={session.data?.user.id ?? ""}
              onSaved={async () => refreshMembers(activeOrganization.id)}
              onError={setError}
            />
          </section>
        ) : null}

        {setupStage === "treasury" && activeOrganization && !treasury ? (
          <section id="treasury" className="card">
            <h2>Deploy your Treasury</h2>
            <p className="muted">
              The server prepares unsigned council and Treasury transactions.
              Every change is signed in member wallets.
            </p>
            <div className="wallet-signing-context">
              <span>Founder NEAR wallet</span>
              <strong>{founderNear || "Connect NEAR in the global wallet bar"}</strong>
            </div>
            <button
              className="primary"
              disabled={Boolean(busy) || founderNear.length < 2}
              title={busy ? "Wait for the current setup action" : founderNear.length < 2 ? "Connect the founder's NEAR wallet first" : "Build the unsigned Treasury plan"}
              onClick={() =>
                run("plan", async () => {
                  const result = await api<TreasuryPlan>("/v1/console/treasury/plan", {
                    method: "POST",
                    body: JSON.stringify({
                      environment: "uat",
                      daoName: activeOrganization.name,
                      founderNearAccountId: founderNear,
                    }),
                  });
                  setPlan(result);
                  setNotice("Plan ready. Sign the three steps below.");
                })
              }
            >
              {busy === "plan" ? "Building plan…" : "Build plan"}
            </button>
          </section>
        ) : null}

        {setupStage === "treasury" && plan ? (
          <TreasuryWizard
            plan={plan}
            busy={busy}
            run={run}
            onError={setError}
            onRegistered={async (registered) => {
              setTreasury(registered);
              setPlan(null);
              setNotice("Treasury verified on-chain and registered.");
              setActiveOrganization((current) => current);
            }}
          />
        ) : null}

        {setupStage === "treasury" && treasury ? <Summary treasury={treasury} /> : null}
        {setupStage === "treasury" && treasury && demoWalletsEnabled() ? (
          <section className="card">
            <h2>Base governance gas (UAT)</h2>
            <button
              className="ghost"
              disabled={Boolean(busy)}
              title={busy ? "Wait for the current setup action" : "Send Base Sepolia gas to the governance signer"}
              onClick={() => void run("fund-gov", async () => {
                const founder = members.find((member) => member.role === "owner" && member.evmAddress);
                if (
                  !founder?.evmAddress ||
                  !selectDemoWalletScopeForEvmAddress(founder.evmAddress)
                ) {
                  throw new Error("Founding council demo wallet is unavailable");
                }
                const hash = await sendEvmTransaction({
                  to: treasury.govAddress,
                  value: "2000000000000000",
                  data: "0x",
                });
                await waitForEvmTransaction(hash);
                setNotice(`0xGOV funded: ${hash}`);
              })}
            >
              Fund 0xGOV with 0.002 ETH
            </button>
          </section>
        ) : null}


        {treasury && (setupStage === "agent" || (setupStage === "treasury" && treasury.status !== "active")) ? (
          <section id="agents" className="card">
            <h2>{treasury.status === "active" ? "Register an agent" : "Finish Treasury verification"}</h2>
            {treasury.status === "active" ? (
              <>
                <AgentForm
                  treasury={treasury}
                  onCreated={(createdKey) => {
                    setApiKey(createdKey);
                    setNotice("Agent created. The API key is shown once.");
                    void refreshSetupOverview();
                  }}
                  onError={setError}
                />
                <AgentList key={apiKey ?? "agents"} treasury={treasury} onError={setError} />
              </>
            ) : (
              <>
              <div className="alert error">
                Treasury status: {treasury.status}. Agent registration is blocked until the
                on-chain controls and waiting period are verified.
              </div>
              <button
                className="primary"
                disabled={Boolean(busy)}
                title={busy ? "Wait for the current verification" : "Re-read Treasury controls on-chain"}
                onClick={() =>
                  run("refresh", async () => {
                    const refreshed = await api<TreasuryView>("/v1/console/treasury/refresh", {
                      method: "POST",
                      body: JSON.stringify({ environment: treasury.environment }),
                    });
                    setTreasury(refreshed);
                    setNotice(
                      refreshed.status === "active"
                        ? "DAO hardening verified. Agent registration is enabled."
                        : "DAO auto-update is still enabled; treasury remains pending.",
                    );
                  })
                }
              >
                {busy === "refresh" ? "Re-verifying…" : "Re-run verification"}
              </button>
              </>
            )}
          </section>
        ) : null}

        {setupStage === "mandate" && treasury?.status === "active" ? (
          <section id="mandates" className="card">
            <h2>Create the first spending permission</h2>
            <MandatePanel treasury={treasury} preview={mandate} onPreview={setMandate} onError={setError} />
          </section>
        ) : null}
        {setupStage === "done" ? (
          <section className="card empty-action">
            <h2>Company setup complete</h2>
            <p>Your Treasury and first spending permission are ready.</p>
            <a className="button primary" href="/">Go to Overview</a>
          </section>
        ) : null}
    </div>
  );
}

function SetupProgress(props: {
  companyReady: boolean;
  membersReady: boolean;
  treasuryReady: boolean;
  agentReady: boolean;
  mandateReady: boolean;
}) {
  const steps = [
    { label: "Company", ready: props.companyReady },
    { label: "Members", ready: props.membersReady },
    { label: "Treasury", ready: props.treasuryReady },
    { label: "Agent", ready: props.agentReady },
    { label: "Spending permission", ready: props.mandateReady },
  ];
  const current = steps.findIndex((step) => !step.ready);
  return (
    <nav className="setup-progress" aria-label="Company setup progress">
      {steps.map((step, index) => (
        <div
          key={step.label}
          className={`${step.ready ? "done" : ""} ${index === current ? "current" : ""}`}
        >
          <span>{step.ready ? "✓" : index + 1}</span>
          {step.label}
        </div>
      ))}
    </nav>
  );
}

function EmailVerification(props: { email: string; onVerified: () => Promise<void> }) {
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: props.email,
        type: "email-verification",
      });
      if (result.error) throw new Error(result.error.message ?? "Could not send verification code");
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.verifyEmail({ email: props.email, otp });
      if (result.error) throw new Error(result.error.message ?? "Invalid verification code");
      await props.onVerified();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page invitation-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Invitation security</span>
          <h1>Verify your invited email</h1>
          <p className="muted">The invitation is locked to <strong>{props.email}</strong>.</p>
        </div>
      </header>
      <section className="panel stack">
        {error ? <div className="alert error">{error}</div> : null}
        {!sent ? (
          <button className="primary" disabled={busy} title={busy ? "Wait for email delivery" : "Send a verification code to the invited email"} onClick={() => void send()}>
            {busy ? "Sending…" : "Send verification code"}
          </button>
        ) : (
          <>
            <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} /></label>
            <button className="primary" disabled={busy || otp.length < 6} title={busy ? "Verification is in progress" : otp.length < 6 ? "Enter the six-digit code" : "Verify the invited email"} onClick={() => void verify()}>
              {busy ? "Verifying…" : "Verify email"}
            </button>
            <button className="secondary" disabled={busy} title={busy ? "Verification is in progress" : "Send a fresh code"} onClick={() => void send()}>Send again</button>
          </>
        )}
      </section>
    </div>
  );
}

function PasskeyEnrollment(props: { email: string; onComplete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enroll() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.passkey.addPasskey({ name: `MandateOS ${props.email}` });
      if (result.error) throw new Error(result.error.message ?? "Could not create passkey");
      props.onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">MandateOS</div>
        <h1>Create your passkey</h1>
        <p className="muted">
          Profile <strong>{props.email}</strong> must enroll a passkey before accessing the company console.
        </p>
        {error ? <div className="alert error">{error}</div> : null}
        <button className="primary" disabled={busy} title={busy ? "Wait for your authenticator" : "Create a passkey for this profile"} onClick={() => void enroll()}>
          {busy ? "Waiting for your authenticator…" : "Create passkey"}
        </button>
        <button className="ghost" disabled={busy} title={busy ? "Finish or cancel the authenticator prompt first" : "Sign out"} onClick={() => void authClient.signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function SignIn() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signInWithPasskey() {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) setError(result.error.message ?? "Passkey sign-in failed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }


  async function register(email: string, name: string) {
    setBusy(true);
    setError(null);
    try {
      const nearPublicKey = demoWalletsEnabled() ? generatedNearPublicKey() : undefined;
      const response = await fetch(`${API_BASE}/api/register/passkey-start`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ email, name, ...(nearPublicKey ? { nearPublicKey } : {}) }),
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error("Too many registration attempts. Try again later.");
        throw new Error((await response.json().catch(() => ({}))).message ?? "Registration failed");
      }
      const payload = (await response.json().catch(() => ({}))) as {
        context?: string;
        nearAccountId?: string;
      };
      if (!payload.context) throw new Error("Registration context missing");
      if (demoWalletsEnabled() && payload.nearAccountId) setGeneratedNearAccountId(payload.nearAccountId);
      const passkey = await authClient.passkey.addPasskey({
        name: `${name} — ${email}`,
        context: payload.context,
        createSession: true,
      });
      if (passkey.error) throw new Error(passkey.error.message ?? "Could not create passkey");
      window.location.assign("/onboarding");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth-intro">
        <div className="brand">MandateOS</div>
        <h2>AI agents move company funds. Humans keep the keys and the limits.</h2>
        <ul>
          <li>One-time approval bound to the exact payment</li>
          <li>Agent role, budget and supplier limits</li>
          <li>Two-of-three human control of the Treasury</li>
        </ul>
        <p className="small muted">Non-custodial by design. The server never holds a key that can move funds.</p>
      </aside>
      <div className="auth-card">
        <div className="brand">MandateOS</div>
        <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
        <p className="muted">
          {mode === "login"
            ? "Sign in with your passkey. No email challenge and no password."
            : "Enter an email identifier, then create the passkey that secures your profile and organizations."}
        </p>
        {demoWalletsEnabled() ? (
          <div className="alert error">
            UAT DEMO MODE — test-only private keys will be stored in localStorage.
          </div>
        ) : null}
        {error ? <div className="alert error">{error}</div> : null}
        <div className="tabs">
          <button className={mode === "login" ? "tab active" : "tab"} onClick={() => { setMode("login"); setError(null); }}>Sign in</button>
          <button className={mode === "register" ? "tab active" : "tab"} onClick={() => { setMode("register"); setError(null); }}>Create account</button>
        </div>
        {mode === "login" ? (
          <button className="primary" disabled={busy} title={busy ? "Wait for your authenticator" : "Sign in with a saved passkey"} onClick={() => void signInWithPasskey()}>
            {busy ? "Waiting for your authenticator…" : "Continue with passkey"}
          </button>
        ) : (
          <>
            <label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Work email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <button className="primary" disabled={busy || !email || !name} title={busy ? "Wait for your authenticator" : !email || !name ? "Enter your name and work email" : "Create your passkey profile"} onClick={() => void register(email, name)}>
              {busy ? "Creating passkey…" : "Create account with passkey"}
            </button>
            <p className="muted small">
              The email is an unverified profile identifier. Organization membership is accepted
              by proving the admin-declared NEAR and EVM wallets, not by email.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function OrganizationPanel(props: {
  mode: "company" | "members";
  organizations: Organization[];
  active: Organization | null;
  onChanged: () => Promise<void>;
  onSelect: (organization: Organization) => void;
  onError: (message: string) => void;
  members: Member[];
  onMembersChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberNear, setMemberNear] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberEvm, setMemberEvm] = useState("");

  return (
    <div className="stack">
      {props.mode === "company" && props.organizations.length ? (
        <div className="row wrap">
          {props.organizations.map((organization) => (
            <button
              key={organization.id}
              className={props.active?.id === organization.id ? "chip active" : "chip"}
              onClick={() => props.onSelect(organization)}
            >
              {organization.name}
            </button>
          ))}
        </div>
      ) : null}
      {props.mode === "company" ? (
        <div className="row">
          <input placeholder="Company name" value={name} onChange={(event) => setName(event.target.value)} />
          <button
            className="primary"
            disabled={name.trim().length < 2}
            title={name.trim().length < 2 ? "Enter a company name" : "Create this company"}
            onClick={() =>
              void (async () => {
                try {
                  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                  const created = await authClient.organization.create({ name, slug });
                  if (created.error) throw new Error(created.error.message);
                  await props.onChanged();
                } catch (cause) {
                  props.onError(cause instanceof Error ? cause.message : String(cause));
                }
              })()
            }
          >
            Create company
          </button>
        </div>
      ) : null}
      {props.mode === "members" && props.active ? (
        <div className="stack">
          <div className="muted small">
            Invite a new member by email. They sign in with their own passkey, connect both wallets
            once in the global wallet bar, and prove control from their signing inbox.
          </div>
          <div className="row wrap">
            <select
              value={selectedMemberId}
              onChange={(event) => {
                const id = event.target.value;
                setSelectedMemberId(id);
                const member = props.members.find((item) => item.id === id);
                setMemberName(member ? member.name ?? member.email ?? "" : "");
                setMemberNear(member?.nearAccountId ?? "");
                setMemberEvm(member?.evmAddress ?? "");
              }}
            >
              <option value="">New member</option>
              {props.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name ?? member.email ?? member.userId} ({member.role})
                </option>
              ))}
            </select>
            <input
              placeholder="Member name"
              value={memberName}
              disabled={Boolean(selectedMemberId)}
              onChange={(event) => setMemberName(event.target.value)}
            />
            {!selectedMemberId ? (
              <input
                type="email"
                placeholder="Member email"
                value={memberEmail}
                onChange={(event) => setMemberEmail(event.target.value)}
              />
            ) : null}
            {selectedMemberId ? (
              <>
                <input placeholder="near.testnet" value={memberNear} onChange={(event) => setMemberNear(event.target.value)} />
                <input placeholder="0x EVM address" value={memberEvm} onChange={(event) => setMemberEvm(event.target.value)} />
              </>
            ) : null}
            <button
              className="ghost"
              disabled={selectedMemberId ? !memberNear || !memberEvm : !memberName || !memberEmail}
              title={selectedMemberId ? (!memberNear || !memberEvm ? "Enter both wallet addresses" : "Save these declared wallets") : (!memberName || !memberEmail ? "Enter the member name and email" : "Create and copy the invitation")}
              onClick={() =>
                void (async () => {
                  try {
                    if (selectedMemberId) {
                      await api(`/v1/console/members/${selectedMemberId}/wallets`, {
                        method: "PATCH",
                        body: JSON.stringify({ nearAccountId: memberNear, evmAddress: memberEvm }),
                      });
                    } else {
                      await api("/v1/console/members", {
                        method: "POST",
                        body: JSON.stringify({ name: memberName, email: memberEmail }),
                      });
                    }
                    setSelectedMemberId("");
                    setMemberName("");
                    setMemberEmail("");
                    setMemberNear("");
                    setMemberEvm("");
                    await props.onMembersChanged();
                  } catch (cause) {
                    props.onError(cause instanceof Error ? cause.message : String(cause));
                  }
                })()
              }
            >
              {selectedMemberId ? "Save member wallets" : "Invite member"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WalletProofForm(props: {
  memberId: string;
  initialNear?: string;
  initialEvm?: string;
  onVerified: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const wallets = useWallets();
  const [nearAccountId, setNearAccountId] = useState(props.initialNear ?? wallets.nearAccountId);
  const [evmAddress, setEvmAddress] = useState(props.initialEvm ?? wallets.evmAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (wallets.nearAccountId) setNearAccountId(wallets.nearAccountId);
    if (wallets.evmAddress) setEvmAddress(wallets.evmAddress);
  }, [wallets.nearAccountId, wallets.evmAddress]);

  return (
    <div className="stack">
      {error ? <div className="alert error">{error}</div> : null}
      <div className="wallet-proof-grid">
        <div className={wallets.nearConnected ? "wallet-proof connected" : "wallet-proof"}>
          <span>NEAR signer</span>
          <strong>{nearAccountId || "Connect in the wallet bar"}</strong>
        </div>
        <div className={wallets.evmConnected ? "wallet-proof connected" : "wallet-proof"}>
          <span>Base owner</span>
          <strong>{evmAddress ? short(evmAddress) : "Connect in the wallet bar"}</strong>
        </div>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !nearAccountId || !evmAddress || !wallets.nearConnected || !wallets.evmConnected}
          title={busy ? "Wallet verification is in progress" : !nearAccountId || !evmAddress ? "Connect both wallets" : !wallets.nearConnected || !wallets.evmConnected ? "Connect the displayed wallets in the global wallet bar" : "Sign both wallet proofs"}
          onClick={() => void (async () => {
            setBusy(true);
            setError(null);
            try {
              const challenge = await api<WalletProofChallenge>("/v1/profile/wallet-proof/challenge", {
                method: "POST",
                body: JSON.stringify({ memberId: props.memberId, nearAccountId, evmAddress }),
              });
              const proof = await signWalletProofChallenge(challenge);
              await api("/v1/profile/wallet-proof/verify", {
                method: "POST",
                body: JSON.stringify(proof),
              });
              await props.onVerified();
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              setError(message);
              props.onError(message);
            } finally {
              setBusy(false);
            }
          })()}
        >
          {busy ? "Waiting for both signatures…" : "Sign NEP-413 + EIP-191 proofs"}
        </button>
      </div>
      <div className="muted small">
        This one-time challenge is scoped to this member, company and both wallets for ten minutes.
        MandateOS verifies both wallet signatures.
      </div>
    </div>
  );
}

function WalletProofPanel(props: {
  memberId: string;
  onVerified: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [invitation, setInvitation] = useState<{
    memberName: string;
    organizationName: string;
    role: string;
  } | null>(null);
  useEffect(() => {
    void api<{
      memberName: string;
      organizationName: string;
      role: string;
    }>(`/v1/profile/invitations/${props.memberId}`)
      .then(setInvitation)
      .catch((cause: unknown) => props.onError(cause instanceof Error ? cause.message : String(cause)));
  }, [props.memberId]);

  if (!invitation) return <div className="state">Loading invitation…</div>;
  return (
    <div className="page invitation-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Member invitation</span>
          <h1>You've been invited to {invitation.organizationName} as {invitation.memberName}</h1>
          <p className="muted">Role: {invitation.role}. The invited email is verified. Now prove control of both connected wallets.</p>
        </div>
      </header>
      <section className="panel"><WalletProofForm {...props} /></section>
    </div>
  );
}

function MemberWallets(props: {
  members: Member[];
  currentUserId: string;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const self = props.members.find((member) => member.userId === props.currentUserId);
  const [provisioningCouncil, setProvisioningCouncil] = useState(false);
  const [decidingMemberId, setDecidingMemberId] = useState<string | null>(null);
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null);

  function invitationUrl(memberId: string): string {
    return `${window.location.origin}/onboarding?member=${encodeURIComponent(memberId)}`;
  }
  const canApproveWallets = self?.role === "admin" || self?.role === "owner";

  async function provisionDemoCouncilAccounts() {
    setProvisioningCouncil(true);
    try {
      for (const member of props.members) {
        if (
          member.userId === props.currentUserId ||
          !member.walletProofVerifiedAt ||
          !member.nearAccountId ||
          !member.evmAddress
        ) {
          continue;
        }
        if (!selectDemoWalletScopeForAccounts(member.nearAccountId, member.evmAddress)) {
          throw new Error(`No generated demo wallet matches ${member.name ?? member.id}`);
        }
        await api("/v1/console/treasury/sponsor-founder-wallet", {
          method: "POST",
          body: JSON.stringify({
            nearAccountId: member.nearAccountId,
            nearPublicKey: generatedNearPublicKey(),
          }),
        });
      }
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDemoWalletScope(props.currentUserId);
      setProvisioningCouncil(false);
    }
  }


  return (
    <div className="stack">
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>NEAR</th><th>EVM</th><th>Proof</th></tr></thead>
        <tbody>
          {props.members.map((member) => (
            <tr key={member.id}>
              <td>{member.name ?? member.email ?? short(member.userId)}</td>
              <td>{member.role}</td>
              <td>{member.nearAccountId ?? "—"}</td>
              <td>{member.evmAddress ? short(member.evmAddress) : "—"}</td>
              <td>
                {member.walletProofApprovedAt
                  ? "Approved"
                  : member.walletProofVerifiedAt
                    ? "Waiting for another admin"
                    : member.walletProofClaimable
                      ? "Invitation pending"
                      : "Signature required"}
                {member.walletProofClaimable ? (
                  <span className="row wrap">
                    <button
                      className="secondary"
                      onClick={() => void navigator.clipboard.writeText(invitationUrl(member.id)).then(() => setCopiedInvitationId(member.id))}
                    >
                      {copiedInvitationId === member.id ? "Link copied" : "Copy invitation link"}
                    </button>
                    {member.email ? (
                      <a
                        className="button"
                        href={`mailto:${encodeURIComponent(member.email)}?subject=${encodeURIComponent("Your MandateOS invitation")}&body=${encodeURIComponent(`You've been invited. Open ${invitationUrl(member.id)}`)}`}
                      >
                        Send again
                      </a>
                    ) : null}
                  </span>
                ) : null}
                {canApproveWallets && member.walletProofVerifiedAt && member.nearAccountId && member.evmAddress && !member.walletProofApprovedAt && member.userId !== props.currentUserId ? (
                  <span className="row wrap">
                    <button
                      className="secondary"
                      disabled={decidingMemberId !== null}
                      title={decidingMemberId !== null ? "Wait for the current wallet review" : "Approve this member's proven wallets"}
                      onClick={() => {
                        setDecidingMemberId(member.id);
                        void api(`/v1/console/members/${member.id}/wallet-proof-decision`, {
                          method: "POST",
                          body: JSON.stringify({
                            decision: "approve",
                            nearAccountId: member.nearAccountId,
                            evmAddress: member.evmAddress,
                            walletProofVerifiedAt: member.walletProofVerifiedAt,
                          }),
                        }).then(props.onSaved).catch((cause: unknown) => props.onError(String(cause))).finally(() => setDecidingMemberId(null));
                      }}
                    >
                      Approve wallets
                    </button>
                    <button
                      className="secondary"
                      disabled={decidingMemberId !== null}
                      title={decidingMemberId !== null ? "Wait for the current wallet review" : "Reject and clear these wallet proofs"}
                      onClick={() => {
                        setDecidingMemberId(member.id);
                        void api(`/v1/console/members/${member.id}/wallet-proof-decision`, {
                          method: "POST",
                          body: JSON.stringify({ decision: "reject" }),
                        }).then(props.onSaved).catch((cause: unknown) => props.onError(String(cause))).finally(() => setDecidingMemberId(null));
                      }}
                    >
                      Reject
                    </button>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {demoWalletsEnabled() ? (
        <button
          className="ghost"
          disabled={provisioningCouncil}
          title={provisioningCouncil ? "Demo account provisioning is in progress" : "Provision the generated UAT council accounts"}
          onClick={() => void provisionDemoCouncilAccounts()}
        >
          {provisioningCouncil ? "Provisioning council accounts…" : "Provision generated council NEAR accounts (UAT)"}
        </button>
      ) : null}
      {self && !self.walletProofVerifiedAt ? (
        <>
          <h3>Verify my wallets</h3>
          <WalletProofForm
            memberId={self.id}
            initialNear={self.nearAccountId ?? ""}
            initialEvm={self.evmAddress ?? ""}
            onVerified={props.onSaved}
            onError={props.onError}
          />
        </>
      ) : self?.walletProofApprovedAt ? (
        <div className="alert success">Your wallets are verified and approved.</div>
      ) : self?.walletProofVerifiedAt ? (
        <div className="alert warning">Your signatures are verified. Another admin must approve the wallet addresses before you join the council.</div>
      ) : (
        <div className="alert error">This passkey profile is not a member of the active organization.</div>
      )}
      <div className="muted small">
        Unverified or unapproved wallet declarations remain pending and are excluded from the council.
      </div>
    </div>
  );
}

function TreasuryWizard(props: {
  plan: TreasuryPlan;
  busy: string | null;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  onError: (message: string) => void;
  onRegistered: (treasury: TreasuryView) => Promise<void>;
}) {
  const wallets = useWallets();
  const [signerId, setSignerId] = useState("");
  const [safeBatch, setSafeBatch] = useState<SafeBatch | null>(null);
  const [signatures, setSignatures] = useState<SafeBatchSignature[]>([]);
  const [transactionHashes, setTransactionHashes] = useState<string[]>([]);
  const [baseDeploymentHashes, setBaseDeploymentHashes] = useState<string[]>([]);
  const [baseDeploymentObserved, setBaseDeploymentObserved] = useState(false);
  const [nearAttestation, setNearAttestation] = useState<NearDeploymentRpcAttestation | null>(null);
  const [deploymentConfirmations, setDeploymentConfirmations] = useState<{
    digest: string;
    confirmedMemberIds: string[];
    requiredMemberIds: string[];
  } | null>(null);
  const [daoCreated, setDaoCreated] = useState<string | null>(null);
  const [sponsor, setSponsor] = useState<{ accountId: string; balanceYocto: string } | null>(null);
  const [creationPolicyConfirmed, setCreationPolicyConfirmed] = useState(false);
  const [observedPolicy, setObservedPolicy] = useState<DaoPolicyRpc | null>(null);
  const [confirmedMembers, setConfirmedMembers] = useState<string[]>([]);
  const [thresholdConfirmed, setThresholdConfirmed] = useState(false);

  useEffect(() => {
    setSignerId(wallets.nearAccountId);
  }, [wallets.nearAccountId]);

  async function verifyDaoPolicy() {
    const policy = await readDaoPolicyRpc(props.plan.daoAccountId);
    setObservedPolicy(policy);
    setConfirmedMembers([]);
    setThresholdConfirmed(false);
  }

  function toggleMemberConfirmation(accountId: string) {
    setConfirmedMembers((current) =>
      current.includes(accountId)
        ? current.filter((member) => member !== accountId)
        : [...current, accountId],
    );
  }

  async function refreshSponsor() {
    setSponsor(await api<{ accountId: string; balanceYocto: string }>("/v1/console/treasury/sponsor-status"));
  }

  function nearDeploymentInput() {
    return {
      environment: props.plan.environment,
      daoAccountId: props.plan.daoAccountId,
      vaultAccountId: props.plan.vault.accountId,
      relayAccountId: props.plan.relay.accountId,
      delayAddress: props.plan.base.delayAddress,
      govAddress: props.plan.govAddress,
    };
  }

  async function verifyNearDeploymentAndConfirm() {
    const attestation = await readNearDeploymentRpc(props.plan);
    setNearAttestation(attestation);
    if (!attestation.valid) throw new Error("Vault/relay RPC attestation contains a mismatch");
    setDeploymentConfirmations(await api(
      "/v1/console/treasury/deployment-confirmations/confirm",
      { method: "POST", body: JSON.stringify(nearDeploymentInput()) },
    ));
  }

  async function refreshDeploymentConfirmations() {
    setDeploymentConfirmations(await api(
      "/v1/console/treasury/deployment-confirmations/status",
      { method: "POST", body: JSON.stringify(nearDeploymentInput()) },
    ));
  }

  useEffect(() => {
    void refreshSponsor().catch((cause: unknown) => props.onError(String(cause)));
  }, []);

  useEffect(() => {
    setCreationPolicyConfirmed(false);
    setObservedPolicy(null);
    setConfirmedMembers([]);
    setThresholdConfirmed(false);
    setNearAttestation(null);
    setDeploymentConfirmations(null);
    setBaseDeploymentHashes([]);
    setBaseDeploymentObserved(false);
    void readBaseDeploymentRpc(props.plan)
      .then(setBaseDeploymentObserved)
      .catch((cause: unknown) => props.onError(String(cause)));
  }, [props.plan.daoAccountId]);

  async function deployBase() {
    for (const transaction of [
      props.plan.base.safeDeployment,
      props.plan.base.rolesDeployment,
      props.plan.base.delayDeployment,
    ]) {
      const hash = await sendEvmTransaction(transaction);
      await waitForEvmTransaction(hash);
      setBaseDeploymentHashes((current) => [...current, hash]);
      setTransactionHashes((current) => [...current, hash]);
    }
  }

  async function collectSafeSignature(owner?: string) {
    const batch = safeBatch ?? (await buildSafeBatch(props.plan));
    setSafeBatch(batch);
    const signature = await signSafeBatch(batch, owner);
    setSignatures((current) => {
      if (current.some((item) => item.owner.toLowerCase() === signature.owner.toLowerCase())) {
        throw new Error(`${signature.owner} already signed`);
      }
      return [...current, signature];
    });
  }

  async function executeBatch() {
    if (!safeBatch) throw new Error("Prepare the Safe batch first");
    const hash = await executeSafeBatch(
      safeBatch,
      signatures,
      demoWalletsEnabled() ? props.plan.council[0]!.evmAddress : undefined,
    );
    await waitForEvmTransaction(hash);
    setTransactionHashes((current) => [...current, hash]);
  }

  const baseDeployed = baseDeploymentObserved || baseDeploymentHashes.length >= 3;
  const daoDeposit = BigInt(props.plan.daoCreate.depositYocto);
  const vaultDeposit = transferDeposit(props.plan.vault.actions);
  const relayDeposit = transferDeposit(props.plan.relay.actions);
  const setupDeposit = daoDeposit + vaultDeposit + relayDeposit;
  const contractsDeposit = vaultDeposit + relayDeposit;
  const contractsAffordable = sponsor === null || BigInt(sponsor.balanceYocto) >= contractsDeposit;
  const expectedCouncil = props.plan.council.map((member) => member.nearAccountId).sort();
  const observedMembersMatch =
    observedPolicy !== null &&
    observedPolicy.council.length === expectedCouncil.length &&
    observedPolicy.council.every((member, index) => member === expectedCouncil[index]);
  const observedThresholdMatches = observedPolicy?.threshold === String(props.plan.threshold);
  const policyConfirmed =
    observedMembersMatch &&
    observedThresholdMatches &&
    expectedCouncil.every((member) => confirmedMembers.includes(member)) &&
    thresholdConfirmed;
  const deploymentConfirmed =
    deploymentConfirmations !== null &&
    deploymentConfirmations.requiredMemberIds.length === props.plan.council.length &&
    deploymentConfirmations.requiredMemberIds.every((memberId) =>
      deploymentConfirmations.confirmedMemberIds.includes(memberId)
    );

  return (
    <section className="card">
      <h2>Treasury transactions</h2>
      <div className="alert">
        One-time NEAR setup: <strong>{formatNear(setupDeposit)} NEAR</strong>. Most of this balance is locked for contract storage, not spent per payment.
        <details>
          <summary>Advanced cost breakdown</summary>
          Council {formatNear(daoDeposit)} + Vault {formatNear(vaultDeposit)} + relay {formatNear(relayDeposit)}.
          The observed 14.288 Tgas payment authorization costs about 0.00143 NEAR at the current testnet gas price.
        </details>
      </div>
      {sponsor ? (
        <div className="muted small">
          MandateOS sponsor <code>{sponsor.accountId}</code>: {formatNear(BigInt(sponsor.balanceYocto))} NEAR.
          The generated founder wallet is pre-funded by MandateOS; the founder remains the caller
          and signs the exact DAO policy below. A full payment treasury adds {formatNear(contractsDeposit)} NEAR.
        </div>
      ) : null}
      <div className="steps">
        <div className="step">
          <h3>a. Treasury council</h3>
          <p className="muted">{props.plan.daoAccountId} · threshold {props.plan.threshold}</p>
          <div className="stack">
            <strong>Exact initial policy signed by the founder</strong>
            {expectedCouncil.map((accountId) => <code key={accountId}>{accountId}</code>)}
            <code>absolute threshold: {props.plan.threshold}</code>
            <label>
              <input
                type="checkbox"
                checked={creationPolicyConfirmed}
                onChange={(event) => setCreationPolicyConfirmed(event.target.checked)}
              />{" "}
              I confirm this exact council and threshold before signing.
            </label>
          </div>
          <div className="wallet-signing-context">
            <span>Founder signature</span>
            <strong>{signerId || "Connect NEAR in the global wallet bar"}</strong>
          </div>
          <div className="row wrap">
            <button
              className="primary"
              disabled={
                Boolean(props.busy) ||
                !creationPolicyConfirmed ||
                signerId !== props.plan.founderNearAccountId
              }
              title={props.busy ? "Wait for the current setup action" : !creationPolicyConfirmed ? "Confirm the displayed council and threshold" : signerId !== props.plan.founderNearAccountId ? `Connect ${props.plan.founderNearAccountId}` : "Sign and create the Treasury council"}
              onClick={() => props.run("dao", async () => {
                if (demoWalletsEnabled()) {
                  await api("/v1/console/treasury/sponsor-founder-wallet", {
                    method: "POST",
                    body: JSON.stringify({
                      nearAccountId: signerId,
                      nearPublicKey: generatedNearPublicKey(),
                    }),
                  });
                }
                const hashes = await createDao(props.plan, signerId);
                setTransactionHashes((current) => [...current, ...hashes]);
                setDaoCreated(props.plan.daoAccountId);
                await verifyDaoPolicy();
              })}
            >
              Sign and create DAO ({formatNear(daoDeposit)} NEAR)
            </button>
            <button
              className="ghost"
              disabled={
                Boolean(props.busy) ||
                !signerId ||
                !props.plan.council.some((member) => member.nearAccountId === signerId)
              }
              title={props.busy ? "Wait for the current setup action" : !signerId ? "Connect a council NEAR wallet" : !props.plan.council.some((member) => member.nearAccountId === signerId) ? "The connected account is not in the council" : "Prepare the optional update-policy decision"}
              onClick={() => props.run("auto-update", async () => {
                const hashes = await disableFactoryAutoUpdate(props.plan, signerId);
                setTransactionHashes((current) => [...current, ...hashes]);
              })}
            >
              Propose auto_update=false (optional)
            </button>
          </div>
          {signerId && signerId !== props.plan.founderNearAccountId ? (
            <div className="alert error">
              Founder signature required: connect <code>{props.plan.founderNearAccountId}</code>.
            </div>
          ) : null}
          {daoCreated ? (
            <div className="alert success">
              DAO deployed on-chain: <code>{daoCreated}</code>{" "}
              <a href={`https://testnet.nearblocks.io/address/${daoCreated}`} target="_blank" rel="noreferrer">
                explorer
              </a>
            </div>
          ) : null}
          <button
            className="ghost"
            disabled={Boolean(props.busy)}
            title={props.busy ? "Wait for the current setup action" : "Read the council policy directly from NEAR RPC"}
            onClick={() => props.run("dao-policy-rpc", verifyDaoPolicy)}
          >
            Read get_policy directly from NEAR RPC
          </button>
          {observedPolicy ? (
            <div className="stack">
              <strong>On-chain policy confirmation</strong>
              {expectedCouncil.map((accountId) => {
                const present = observedPolicy.council.includes(accountId);
                return (
                  <label key={accountId}>
                    <input
                      type="checkbox"
                      disabled={!present}
                      checked={confirmedMembers.includes(accountId)}
                      onChange={() => toggleMemberConfirmation(accountId)}
                    />{" "}
                    {present ? "Observed" : "Missing"}: <code>{accountId}</code>
                  </label>
                );
              })}
              {!observedMembersMatch ? (
                <div className="alert error">
                  Observed council differs: <code>{observedPolicy.council.join(", ")}</code>
                </div>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  disabled={!observedThresholdMatches}
                  checked={thresholdConfirmed}
                  onChange={(event) => setThresholdConfirmed(event.target.checked)}
                />{" "}
                Observed absolute threshold: <code>{observedPolicy.threshold}</code>
              </label>
              {observedPolicy.autoUpdate === true ? (
                <div className="alert">
                  Warning only: DAO reports <code>auto_update=true</code>. The immutable global hash
                  cannot be changed by the keyless MandateOS factory, which exposes no update method.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="step">
          <h3>b. NEAR Treasury controls</h3>
          <p className="muted">Deploy the keyless controls that enforce spending permissions and council decisions.</p>
          <details><summary>Advanced deployment shape</summary>
            Two accounts use CreateAccount + Transfer + DeployContract + new(). No AddKey action is emitted.
          </details>
          <div className="row">
            <button
              className="primary"
              disabled={Boolean(props.busy) || !contractsAffordable || !policyConfirmed}
              title={props.busy ? "Wait for the current setup action" : !contractsAffordable ? "The sponsor balance is too low" : !policyConfirmed ? "Confirm the on-chain council policy first" : "Deploy the NEAR Treasury controls"}
              onClick={() => props.run("near-deploy", async () => {
                const deployed = await api<{ vaultTxHash: string; relayTxHash: string }>(
                  "/v1/console/treasury/deploy-contracts",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      environment: props.plan.environment,
                      daoName: props.plan.daoName,
                      founderNearAccountId: props.plan.founderNearAccountId,
                    }),
                  },
                );
                setTransactionHashes((current) => [...current, deployed.vaultTxHash, deployed.relayTxHash]);
                setNearAttestation(null);
                setDeploymentConfirmations(null);
                await refreshSponsor();
              })}
            >
              Deploy NEAR controls (MandateOS pays)
            </button>
          </div>
          <div className="row wrap">
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              title={props.busy ? "Wait for the current setup action" : "Read the deployed contracts directly from NEAR RPC"}
              onClick={() => props.run("near-rpc-attestation", verifyNearDeploymentAndConfirm)}
            >
              Verify by direct RPC and confirm as this member
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              title={props.busy ? "Wait for the current setup action" : "Refresh council confirmations"}
              onClick={() => props.run("near-confirmations", refreshDeploymentConfirmations)}
            >
              Refresh member confirmations
            </button>
          </div>
          <details>
            <summary>Advanced deployment evidence</summary>
            <div className="muted small">Signed by the MandateOS relayer; contracts remain owned by the council.</div>
            <div className="muted small">Vault wasm {short(props.plan.vault.wasmSha256)} · relay wasm {short(props.plan.relay.wasmSha256)}</div>
          </details>
          {nearAttestation ? (
            <table>
              <thead><tr><th>Direct NEAR RPC check</th><th>Expected</th><th>Observed</th><th>Status</th></tr></thead>
              <tbody>
                {nearAttestation.checks.map((check) => (
                  <tr key={check.label}>
                    <td>{check.label}</td>
                    <td><code>{short(check.expected)}</code></td>
                    <td><code>{short(check.actual)}</code></td>
                    <td>{check.ok ? "match" : "MISMATCH"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {deploymentConfirmations ? (
            <div className={deploymentConfirmed ? "alert success" : "alert"}>
              Deployment digest <code>{short(deploymentConfirmations.digest)}</code>:{" "}
              {deploymentConfirmations.confirmedMemberIds.length}/{deploymentConfirmations.requiredMemberIds.length} proven members confirmed.
            </div>
          ) : null}
          {!contractsAffordable && sponsor ? (
            <div className="muted small">
              Full treasury unavailable: needs {formatNear(contractsDeposit)} NEAR; sponsor has{" "}
              {formatNear(BigInt(sponsor.balanceYocto))} NEAR. The Company and DAO remain usable.
            </div>
          ) : null}
          {!policyConfirmed ? (
            <div className="muted small">
              Read the council policy from NEAR RPC and confirm every council member and the threshold
              before deploying the NEAR controls.
            </div>
          ) : null}
        </div>

        <div className="step">
          <h3>c. Base Treasury and waiting period</h3>
          <details>
            <summary>Advanced addresses</summary>
            Safe {short(props.plan.base.safeAddress)} · Roles {short(props.plan.base.rolesAddress)} · Delay{" "}
            {short(props.plan.base.delayAddress)} · 0xGOV {short(props.plan.govAddress)}
          </details>
          {!demoWalletsEnabled() ? (
            <div className="notice">
              Before deployment, fund the connected Base owner for deployment gas and send at least
              0.002 Base Sepolia ETH to <code>{props.plan.govAddress}</code>. Use the official
              <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer"> Base Sepolia faucet</a>.
              Balances are checked again before each proposal.
            </div>
          ) : null}
          <div className="row wrap">
            {demoWalletsEnabled() ? (
              <>
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              title={props.busy ? "Wait for the current setup action" : "Bridge demo gas to Base Sepolia"}
              onClick={() => props.run("base-bridge", async () => {
                const hash = await bridgeSepoliaEthToBase(20_000_000_000_000_000n);
                setTransactionHashes((current) => [...current, hash]);
              })}
            >
              Bridge 0.02 ETH Sepolia → Base Sepolia
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              title={props.busy ? "Wait for the current setup action" : "Fund the demo governance signer"}
              onClick={() => props.run("fund-gov", async () => {
                if (
                  demoWalletsEnabled() &&
                  !selectDemoWalletScopeForEvmAddress(props.plan.council[0]!.evmAddress)
                ) {
                  throw new Error("Founding council demo wallet is unavailable");
                }
                const hash = await sendEvmTransaction({
                  to: props.plan.govAddress,
                  value: "2000000000000000",
                  data: "0x",
                });
                await waitForEvmTransaction(hash);
                setTransactionHashes((current) => [...current, hash]);
              })}
            >
              Fund 0xGOV with 0.002 ETH
            </button>
              </>
            ) : null}
            <button
              className="primary"
              disabled={Boolean(props.busy) || baseDeployed || !deploymentConfirmed}
              title={props.busy ? "Wait for the current setup action" : baseDeployed ? "The Base Treasury is already deployed" : !deploymentConfirmed ? "Every council member must confirm the NEAR controls first" : "Deploy the Base Treasury"}
              onClick={() => props.run("base-deploy", deployBase)}
            >
              Deploy Base Treasury
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy) || !baseDeployed}
              title={props.busy ? "Wait for the current setup action" : !baseDeployed ? "Deploy the Base Treasury first" : "Prepare the owner configuration"}
              onClick={() => props.run("safe-prepare", async () => {
                setSafeBatch(await buildSafeBatch(props.plan));
                setSignatures([]);
              })}
            >
              Prepare owner setup
            </button>
            {demoWalletsEnabled() ? props.plan.council.map((member) => (
              <button
                key={member.evmAddress}
                className="ghost"
                disabled={Boolean(props.busy) || !baseDeployed}
                title={props.busy ? "Wait for the current setup action" : !baseDeployed ? "Deploy the Base Treasury first" : `Sign as ${short(member.evmAddress)}`}
                onClick={() => props.run(`safe-sign-${member.memberId}`, () => collectSafeSignature(member.evmAddress))}
              >
                Sign as {short(member.evmAddress)} ({signatures.length}/{props.plan.threshold})
              </button>
            )) : (
              <button
                className="ghost"
                disabled={Boolean(props.busy) || !baseDeployed}
                title={props.busy ? "Wait for the current setup action" : !baseDeployed ? "Deploy the Base Treasury first" : "Sign with the connected owner wallet"}
                onClick={() => props.run("safe-sign", () => collectSafeSignature())}
              >
                Sign as owner ({signatures.length}/{props.plan.threshold})
              </button>
            )}
            <button
              className="ghost"
              disabled={Boolean(props.busy) || signatures.length < props.plan.threshold}
              title={props.busy ? "Wait for the current setup action" : signatures.length < props.plan.threshold ? `${props.plan.threshold - signatures.length} more signature(s) required` : "Execute the owner configuration"}
              onClick={() => props.run("safe-execute", executeBatch)}
            >
              Execute owner setup
            </button>
          </div>
          {!deploymentConfirmed ? (
            <div className="alert">
              Base Treasury deployment remains blocked until every proven council member independently reads
              the NEAR controls from RPC and confirms the same deployment digest.
            </div>
          ) : null}
        </div>
      </div>

      <div className="row">
        <button
          className="primary"
          disabled={Boolean(props.busy) || !baseDeployed || signatures.length < props.plan.threshold}
          title={props.busy ? "Wait for the current setup action" : !baseDeployed ? "Deploy the Base Treasury first" : signatures.length < props.plan.threshold ? "Complete the council owner signatures first" : "Register the verified Treasury"}
          onClick={() => props.run("register", async () => {
            const registered = await api<TreasuryView>("/v1/console/treasury/register", {
              method: "POST",
              body: JSON.stringify({
                environment: "uat",
                daoAccountId: props.plan.daoAccountId,
                vaultAccountId: props.plan.vault.accountId,
                relayAccountId: props.plan.relay.accountId,
                safeAddress: props.plan.base.safeAddress,
                rolesAddress: props.plan.base.rolesAddress,
                delayAddress: props.plan.base.delayAddress,
                govAddress: props.plan.govAddress,
              }),
            });
            await props.onRegistered(registered);
          })}
        >
          Verify and register treasury
        </button>
      </div>
      {transactionHashes.length ? (
        <details>
          <summary>{transactionHashes.length} transaction(s) signed</summary>
          <pre>{transactionHashes.join("\n")}</pre>
        </details>
      ) : null}
    </section>
  );
}

function Summary({ treasury }: { treasury: TreasuryView }) {
  return (
    <section className="card">
      <h2>Treasury</h2>
      <p className="muted">
        {treasury.status === "active"
          ? "Verified on-chain. No access key exists on the NEAR accounts."
          : `Status ${treasury.status}: re-run verification after the DAO hardening proposal executes.`}
      </p>
      <table>
        <tbody>
          <tr><td>Treasury council</td><td><a href={explorerNear(treasury.daoAccountId)} target="_blank" rel="noreferrer">{treasury.daoAccountId}</a></td></tr>
          <tr><td>Base account</td><td><a href={explorerBase(treasury.safeAddress)} target="_blank" rel="noreferrer">{treasury.safeAddress}</a></td></tr>
        </tbody>
      </table>
      <details>
        <summary>Advanced</summary>
        <table><tbody>
          <tr><td>Vault</td><td><a href={explorerNear(treasury.vaultAccountId)} target="_blank" rel="noreferrer">{treasury.vaultAccountId}</a></td></tr>
          <tr><td>Relay</td><td><a href={explorerNear(treasury.relayAccountId)} target="_blank" rel="noreferrer">{treasury.relayAccountId}</a></td></tr>
          <tr><td>Roles</td><td><a href={explorerBase(treasury.rolesAddress)} target="_blank" rel="noreferrer">{treasury.rolesAddress}</a></td></tr>
          <tr><td>Delay</td><td><a href={explorerBase(treasury.delayAddress)} target="_blank" rel="noreferrer">{treasury.delayAddress}</a></td></tr>
          <tr><td>0xGOV</td><td><a href={explorerBase(treasury.govAddress)} target="_blank" rel="noreferrer">{treasury.govAddress}</a></td></tr>
        </tbody></table>
      </details>
    </section>
  );
}

function AgentForm(props: {
  treasury: TreasuryView;
  onCreated: (apiKey: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [nearPublicKey, setNearPublicKey] = useState("");
  const [role, setRole] = useState("researcher");

  function generateAgentKey() {
    const keyPair = KeyPair.fromRandom("ed25519");
    const publicKey = keyPair.getPublicKey().toString();
    setNearPublicKey(publicKey);
    const file = {
      networkId: "testnet",
      accountId: "assigned-after-registration",
      publicKey,
      privateKey: keyPair.toString(),
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "mandateos-agent"}-key.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <label>Agent name<input placeholder="Invoice agent" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Agent public key<input placeholder="ed25519:…" value={nearPublicKey} onChange={(event) => setNearPublicKey(event.target.value)} /></label>
        <label>Role<input placeholder="purchasing" value={role} onChange={(event) => setRole(event.target.value)} /></label>
        <button className="secondary" type="button" onClick={generateAgentKey}>Generate & download key</button>
        <button
          className="primary"
          disabled={!name.trim() || !nearPublicKey.trim() || !role.trim()}
          title={!name.trim() || !nearPublicKey.trim() || !role.trim() ? "Enter the agent name, public key and role" : "Create the agent and show its one-time API key"}
          onClick={() =>
            void (async () => {
              try {
                const result = await api<{ apiKey: string }>("/v1/console/agents", {
                  method: "POST",
                  body: JSON.stringify({
                    name,
                    role,
                    nearPublicKey,
                    vaultAccountId: props.treasury.vaultAccountId,
                    mpcPath: `agents/${role}/base`,
                  }),
                });
                props.onCreated(result.apiKey);
              } catch (cause) {
                props.onError(cause instanceof Error ? cause.message : String(cause));
              }
            })()
          }
        >
          Create agent
        </button>
      </div>
      <div className="muted small">
        Generate the key in this browser or run <code>mandateos agent init --name "{name || "Compta Bot"}"</code>.
        Only the public key is sent to MandateOS. Keep the downloaded private key file offline and never upload it.
      </div>
    </div>
  );
}


function orderedMandateProposals(preview: MandatePreview): MandateProposal[] {
  return [
    preview.proposals.vaultSetRole,
    preview.proposals.vaultRegisterAgent,
    preview.proposals.funding,
    preview.proposals.relayDerive,
    preview.proposals.zodiacRelay,
  ].filter((proposal): proposal is MandateProposal => proposal !== null);
}

function onChainProposalDescription(proposal: MandateProposal): string {
  const value = (proposal.args.proposal as { description?: unknown } | undefined)?.description;
  if (typeof value !== "string") throw new Error("DAO proposal description missing");
  return value;
}

function onChainProposalKind(proposal: MandateProposal): unknown {
  const body = proposal.args.proposal;
  if (!body || typeof body !== "object" || !("kind" in body)) throw new Error("DAO proposal kind missing");
  return body.kind;
}

type MandateRegistry = {
  suppliers: Array<{
    id: string;
    name: string;
    wallets: Array<{ chainId: number; address: string }>;
  }>;
  contracts?: Array<{ supplierId: string; token: string; maxAmount: string; periodicity: string }>;
};

type ProposalRun = DaoProposalRpc & { transactionHash?: string };

export function MandatePanel(props: {
  treasury: TreasuryView;
  preview: MandatePreview | null;
  onPreview: (preview: MandatePreview) => void;
  onError: (message: string) => void;
}) {
  const wallets = useWallets();
  const [role, setRole] = useState("researcher");
  const [maxPerTx, setMaxPerTx] = useState("500");
  const [budget, setBudget] = useState("5000");
  const [periodDays, setPeriodDays] = useState("30");
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>([]);
  const [agentAccount, setAgentAccount] = useState("");
  const [signerId, setSignerId] = useState("");
  const [proposalHashes, setProposalHashes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [budgetTokenStatus, setBudgetTokenStatus] = useState<BudgetTokenStatus | null>(null);
  const [budgetTokenHashes, setBudgetTokenHashes] = useState<string[]>([]);
  const [proposalRuns, setProposalRuns] = useState<Record<string, ProposalRun>>({});

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [registry, setRegistry] = useState<MandateRegistry>({ suppliers: [], contracts: [] });
  const budgetTokenAddress = registry.contracts?.[0]?.token ?? "";
  useEffect(() => {
    void Promise.all([
      api<{ agents: AgentRow[] }>("/v1/console/agents"),
      api<MandateRegistry>("/v1/console/registry"),
    ])
      .then(([agentResult, registryResult]) => {
        setAgents(agentResult.agents);
        setRegistry(registryResult);
        const firstAgent = agentResult.agents[0];
        if (firstAgent) {
          setAgentAccount((current) => current || firstAgent.nearAccountId);
          setRole(firstAgent.role);
        }
      })
      .catch((cause: unknown) => props.onError(String(cause)));
  }, []);
  useEffect(() => {
    setSignerId(wallets.nearAccountId);
  }, [wallets.nearAccountId]);
  async function refreshBudgetToken() {
    setBudgetTokenStatus(await api<BudgetTokenStatus>("/v1/console/treasury/budget-token"));
  }

  useEffect(() => {
    if (!props.preview) {
      setProposalRuns({});
      return undefined;
    }
    let cancelled = false;
    const descriptions = orderedMandateProposals(props.preview).map(onChainProposalDescription);
    const refresh = async () => {
      const runs = await findDaoProposalsRpc(props.treasury.daoAccountId, descriptions);
      if (!cancelled) setProposalRuns(runs);
    };
    void refresh().catch((cause: unknown) => props.onError(String(cause)));
    const interval = window.setInterval(() => {
      void refresh().catch((cause: unknown) => props.onError(String(cause)));
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [props.preview, props.treasury.daoAccountId]);
  function mandateInput() {
    const selectedSuppliers = registry.suppliers.filter((supplier) => selectedSupplierIds.includes(supplier.id));
    const recipients = selectedSuppliers.flatMap((supplier) =>
      supplier.wallets.filter((wallet) => wallet.chainId === 84532).map((wallet) => wallet.address)
    );
    return {
      role,
      operations: ["pay"],
      maxPerTx: parseUnits(maxPerTx || "0", 6).toString(),
      budget: parseUnits(budget || "0", 6).toString(),
      periodDays: Number(periodDays),
      recipients,
      token: budgetTokenAddress,
      ...(agentAccount
        ? {
            agent: {
              nearAccountId: agentAccount,
              mpcPath: `agents/${role}/base`,
            },
          }
        : {}),
    };
  }




  return (
    <div className="stack">
      <p className="muted">
        Define the agent's spending permission. Amounts use six-decimal USDC values.
      </p>
      <div className="business-form">
        <label>
          Agent
          <select
            value={agentAccount}
            onChange={(event) => {
              const accountId = event.target.value;
              setAgentAccount(accountId);
              const selected = agents.find((agent) => agent.nearAccountId === accountId);
              if (selected) setRole(selected.role);
            }}
          >
            {agents.length === 0 ? <option value="">Create an agent first</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.nearAccountId}>
                {agent.name} · {agent.evmAddress ?? "Base account pending"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role name
          <input aria-label="Role name" value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <label>
          Maximum per payment (USDC)
          <input aria-label="Maximum per payment in USDC" inputMode="decimal" value={maxPerTx} onChange={(event) => setMaxPerTx(event.target.value)} />
        </label>
        <label>
          Budget per period (USDC)
          <input aria-label="Budget per period in USDC" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
        </label>
        <label>
          Period
          <select value={periodDays} onChange={(event) => setPeriodDays(event.target.value)}>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
      </div>
      <fieldset className="supplier-picker">
        <legend>Allowed suppliers</legend>
        {registry.suppliers.map((supplier) => {
          const payable = supplier.wallets.some((wallet) => wallet.chainId === 84532);
          return (
            <label key={supplier.id} className={!payable ? "disabled" : ""}>
              <input
                type="checkbox"
                disabled={!payable}
                checked={selectedSupplierIds.includes(supplier.id)}
                onChange={(event) => setSelectedSupplierIds((current) =>
                  event.target.checked
                    ? [...current, supplier.id]
                    : current.filter((id) => id !== supplier.id)
                )}
              />
              <span><strong>{supplier.name}</strong><small>{payable ? "Base wallet registered" : "No Base wallet"}</small></span>
            </label>
          );
        })}
        {registry.suppliers.length === 0 ? <div className="state">No approved suppliers. <a href="/settings">Add a supplier</a>.</div> : null}
      </fieldset>
      <div className="mandate-summary">
        <strong>Spending permission summary</strong>
        <p>
          {agents.find((agent) => agent.nearAccountId === agentAccount)?.name ?? "The selected agent"} can pay {registry.suppliers
            .filter((supplier) => selectedSupplierIds.includes(supplier.id))
            .map((supplier) => supplier.name)
            .join(", ") || "selected suppliers"} up to {maxPerTx || "0"} USDC per payment and {budget || "0"} USDC every {periodDays} days.
        </p>
      </div>
      <div className="wallet-signing-context">
        <span>Council signatures</span>
        <strong>{signerId || "Connect a NEAR wallet in the global wallet bar"}</strong>
      </div>
      {demoWalletsEnabled() ? (
      <div className="step">
        <h3>Budget token (UAT)</h3>
        <p className="muted small">
          Test token only. Register the DAO and Vault for FT storage, then mint the mandate budget to the DAO.
        </p>
        {budgetTokenStatus ? (
          <table>
            <tbody>
              <tr><td>Token</td><td className="mono">{budgetTokenStatus.tokenAccountId}</td></tr>
              <tr><td>Decimals</td><td>{budgetTokenStatus.decimals} (USDC-compatible)</td></tr>
              <tr><td>DAO storage</td><td>{budgetTokenStatus.daoStorageRegistered ? "registered" : "required"}</td></tr>
              <tr><td>Vault storage</td><td>{budgetTokenStatus.vaultStorageRegistered ? "registered" : "required"}</td></tr>
              <tr><td>DAO balance</td><td>{formatToken(budgetTokenStatus.daoBalance, budgetTokenStatus.decimals, budgetTokenStatus.symbol)}</td></tr>
            </tbody>
          </table>
        ) : (
          <button className="ghost" disabled={busy} title={busy ? "Wait for the current token action" : "Read the test-token state"} onClick={() => void refreshBudgetToken().catch((cause: unknown) => props.onError(String(cause)))}>
            Read test-token state
          </button>
        )}
        <button
          className="primary"
          disabled={!signerId || busy || budgetTokenStatus?.decimals !== 6}
          title={!signerId ? "Connect a council NEAR wallet" : busy ? "Wait for the current token action" : budgetTokenStatus?.decimals !== 6 ? "The budget token must use six decimals" : "Register storage and mint the UAT budget"}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                const plan = await api<BudgetTokenPlan>("/v1/console/treasury/budget-token/plan", {
                  method: "POST",
                  body: JSON.stringify({ amount: parseUnits(budget || "0", 6).toString() }),
                });
                const hashes = await signNearFunctionCalls(signerId, plan.actions);
                setBudgetTokenHashes(hashes);
                await refreshBudgetToken();
              } catch (cause) {
                props.onError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Register storage and mint test budget
        </button>
        {budgetTokenHashes.length > 0 ? <pre>{budgetTokenHashes.join("\n")}</pre> : null}
      </div>
      ) : null}
      <button
        className="primary"
        disabled={busy || !agentAccount || selectedSupplierIds.length === 0 || !budgetTokenAddress}
        title={busy ? "Wait for the current permission review" : !agentAccount ? "Select an agent" : selectedSupplierIds.length === 0 ? "Select at least one approved supplier" : !budgetTokenAddress ? "Approve a supplier contract with a USDC token first" : "Review this spending permission"}
        onClick={() => {
          void (async () => {
            setBusy(true);
            try {
              const preview = await api<MandatePreview>("/v1/console/mandates/preview", {
                method: "POST",
                body: JSON.stringify(mandateInput()),
              });
              props.onPreview(preview);
            } catch (cause) {
              props.onError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        {busy ? "Compiling…" : "Review spending permission"}
      </button>

      {props.preview ? (
        <>
          <div className="row wrap">
            <span className="pill">Agent status: {props.preview.agentStatus === "ready" ? "Ready" : "Setup required"}</span>
          </div>
          {props.preview.warnings.map((warning) => (
            <div key={warning} className="alert warning">{warning}</div>
          ))}
          <details>
            <summary>Advanced on-chain details</summary>
          <h3>Diff</h3>
          <table>
            <thead><tr><th>Field</th><th>Current</th><th>Next</th></tr></thead>
            <tbody>
              {props.preview.diff.map((change) => (
                <tr key={change.field}>
                  <td>{change.field}</td>
                  <td><code>{JSON.stringify(change.current)}</code></td>
                  <td><code>{JSON.stringify(change.next)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap">
            <div className="step">
              <h3>Vault</h3>
              <pre>{JSON.stringify(props.preview.vault.config, null, 2)}</pre>
            </div>
            <div className="step">
              <h3>Zodiac</h3>
              <pre>{JSON.stringify({ target: props.preview.zodiac.target, selector: props.preview.zodiac.selector, calls: props.preview.zodiac.calls.map((call) => call.description) }, null, 2)}</pre>
            </div>
            <div className="step">
              <h3>Guard</h3>
              <pre>{JSON.stringify(props.preview.guard, null, 2)}</pre>
            </div>
          </div>
          </details>
          <h3>Council decisions</h3>
          <div className="stack">
            {orderedMandateProposals(props.preview).map((proposal, index, proposals) => {
              const description = onChainProposalDescription(proposal);
              const run = proposalRuns[description];
              const state = run?.state ?? "Not proposed";
              const proposalWarnings = proposal.warnings ?? [];
              const decision = proposalDecision({
                kind: onChainProposalKind(proposal),
                relayAccountId: props.treasury.relayAccountId,
              });
              const previousDescription = index > 0
                ? onChainProposalDescription(proposals[index - 1]!)
                : null;
              const previousExecuted =
                previousDescription === null ||
                proposalRuns[previousDescription]?.state === "Executed";
              const action =
                state === "In progress"
                  ? "Vote approve"
                  : state === "Failed" || state === "Expired"
                    ? "Re-propose"
                    : "Propose";
              return (
                <div key={description} className="step">
                  <div className="row wrap">
                    <strong>{index + 1}. {decision.title}</strong>
                    <span className="pill">
                      {state}{run ? ` · #${run.id} · ${run.rawStatus}` : ""}
                    </span>
                  </div>
                  {decision.details.map((detail) => <div key={detail} className="small">{detail}</div>)}
                  {decision.warnings.map((warning) => <div key={warning} className="alert warning">{warning}</div>)}
                  {!previousExecuted ? (
                    <div className="muted small">Waiting for the previous proposal to be Executed on-chain.</div>
                  ) : null}
                  {state === "Failed" || state === "Expired" ? (
                    <div className="alert error">Proposal {state.toLowerCase()}. Re-propose the same deterministic step.</div>
                  ) : null}
                  {proposalWarnings.map((warning) => (
                    <div key={warning} className="alert warning">{warning}</div>
                  ))}
                  {state !== "Executed" ? (
                    <button
                      className="primary"
                      disabled={!signerId || busy || !previousExecuted || proposalWarnings.length > 0}
                      title={!signerId ? "Connect a council NEAR wallet" : busy ? "Wait for the current council action" : !previousExecuted ? "The previous decision must execute first" : proposalWarnings.length > 0 ? proposalWarnings.join(" ") : `${action} this decision`}
                      onClick={() => {
                        void (async () => {
                          setBusy(true);
                          try {
                            if (state === "In progress" && run) {
                              const transactionHash = await signDaoVote(
                                signerId,
                                props.treasury.daoAccountId,
                                run.id,
                                run.kind,
                              );
                              const refreshed = await readDaoProposalRpc(props.treasury.daoAccountId, run.id);
                              if (
                                refreshed.state === "Executed" &&
                                props.preview?.proposals.zodiacRelay === proposal
                              ) {
                                await api("/v1/console/governance/relay-operation", {
                                  method: "POST",
                                  body: JSON.stringify({
                                    proposalId: run.id,
                                    nearTransactionHash: transactionHash,
                                    signerAccountId: signerId,
                                  }),
                                });
                              }
                              setProposalRuns((current) => ({
                                ...current,
                                [description]: { ...refreshed, transactionHash },
                              }));
                              setProposalHashes((current) => [...current, transactionHash]);
                            } else {
                              let proposalToSubmit = proposal;
                              let submittedDescription = description;
                              if (props.preview?.proposals.zodiacRelay === proposal) {
                                proposalToSubmit = await api<MandateProposal>("/v1/console/mandates/zodiac-proposal", {
                                  method: "POST",
                                  body: JSON.stringify(mandateInput()),
                                });
                                props.onPreview({
                                  ...props.preview,
                                  proposals: {
                                    ...props.preview.proposals,
                                    zodiacRelay: proposalToSubmit,
                                  },
                                });
                                submittedDescription = onChainProposalDescription(proposalToSubmit);
                                const materializedWarnings = proposalToSubmit.warnings ?? [];
                                if (materializedWarnings.length > 0) {
                                  throw new Error(materializedWarnings.join(" "));
                                }
                              }
                              const submitted = await signDaoProposal(signerId, proposalToSubmit);
                              const refreshed = await readDaoProposalRpc(
                                props.treasury.daoAccountId,
                                submitted.proposalId,
                              );
                              setProposalRuns((current) => ({
                                ...current,
                                [submittedDescription]: {
                                  ...refreshed,
                                  transactionHash: submitted.transactionHash,
                                },
                              }));
                              setProposalHashes((current) => [...current, submitted.transactionHash]);
                            }
                          } catch (cause) {
                            props.onError(cause instanceof Error ? cause.message : String(cause));
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      {action}
                    </button>
                  ) : null}
                  {state === "Executed" &&
                  demoWalletsEnabled() &&
                  props.preview?.proposals.zodiacRelay === proposal ? (
                    <button
                      className="ghost"
                      disabled={!signerId || busy}
                      title={!signerId ? "Connect a council NEAR wallet" : busy ? "Wait for the current council action" : "Run the UAT veto scenario"}
                      onClick={() => {
                        void (async () => {
                          setBusy(true);
                          try {
                            const vetoProposal = await api<MandateProposal>("/v1/console/mandates/zodiac-proposal", {
                              method: "POST",
                              body: JSON.stringify(mandateInput()),
                            });
                            const submitted = await signDaoProposal(signerId, vetoProposal);
                            const refreshed = await readDaoProposalRpc(
                              props.treasury.daoAccountId,
                              submitted.proposalId,
                            );
                            setProposalRuns((current) => ({
                              ...current,
                              [description]: { ...refreshed, transactionHash: submitted.transactionHash },
                            }));
                            setProposalHashes((current) => [...current, submitted.transactionHash]);
                          } catch (cause) {
                            props.onError(cause instanceof Error ? cause.message : String(cause));
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      Propose again for veto test (UAT)
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {proposalHashes.length ? (
            <details>
              <summary>{proposalHashes.length} proposal transaction(s)</summary>
              <pre>{proposalHashes.join("\n")}</pre>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}


type AgentRow = {
  id: string;
  name: string;
  role: string;
  nearAccountId: string;
  nearPublicKey: string;
  evmAddress: string | null;
  active: boolean;
};

type AgentProvisioningView = {
  status: string;
  transactionHash: string | null;
  confirmedAt?: string | null;
  attestation: {
    valid: boolean;
    expected: {
      accountId: string;
      publicKey: string;
      vaultAccountId: string;
      methodNames: string[];
      allowanceYocto: null;
    };
  } | null;
};

function AgentList(props: { treasury: TreasuryView; onError: (message: string) => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [provisioning, setProvisioning] = useState<{
    agentId: string;
    server: AgentProvisioningView;
    browser: AgentAccessKeyRpcAttestation;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await api<{ agents: AgentRow[] }>("/v1/console/agents");
    setAgents(result.agents);
  }

  async function provision(agent: AgentRow) {
    const server = await api<AgentProvisioningView>(`/v1/console/agents/${agent.id}/provision`, {
      method: "POST",
    });
    if (!server.attestation) throw new Error("server access-key attestation missing");
    const browser = await readAgentAccessKeyRpc(server.attestation.expected);
    setProvisioning({ agentId: agent.id, server, browser });
  }

  useEffect(() => {
    load().catch((cause: unknown) => props.onError(String(cause)));
  }, []);

  return (
    <div className="stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>Agents</h3>
        <button className="ghost" onClick={() => void load().catch((cause) => props.onError(String(cause)))}>Refresh</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Role</th><th>NEAR account</th><th>Base account</th><th>Status</th><th /></tr></thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>{agent.name}</td>
              <td>{agent.role}</td>
              <td>{agent.nearAccountId}</td>
              <td>{agent.evmAddress ? short(agent.evmAddress) : "Created after council registration"}</td>
              <td>{agent.active ? "active" : "revoked"}</td>
              <td>
                <div className="row wrap">
                  <button
                    className="primary"
                    disabled={busy}
                    title={busy ? "Wait for the current agent action" : "Create the limited NEAR account and verify its access key"}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          await provision(agent);
                        } catch (cause) {
                          props.onError(cause instanceof Error ? cause.message : String(cause));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Provision
                  </button>
                  <button
                    className="ghost"
                    disabled={busy}
                    title={busy ? "Wait for the current agent action" : "Refresh this agent's on-chain state"}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          const result = await api<Record<string, unknown>>(`/v1/console/agents/${agent.id}`);
                          setDetail(result);
                          await load();
                        } catch (cause) {
                          props.onError(cause instanceof Error ? cause.message : String(cause));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Advanced state
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {provisioning ? (
        <div className="stack">
          <h3>Direct RPC access-key attestation</h3>
          <table>
            <thead><tr><th>Check</th><th>Expected</th><th>Observed</th><th>Status</th></tr></thead>
            <tbody>
              {provisioning.browser.checks.map((check) => (
                <tr key={check.label}>
                  <td>{check.label}</td>
                  <td><code>{short(check.expected)}</code></td>
                  <td><code>{short(check.actual)}</code></td>
                  <td>{check.ok ? "match" : "MISMATCH"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="primary"
            disabled={busy || !provisioning.browser.valid}
            title={busy ? "Wait for the current agent action" : !provisioning.browser.valid ? "The browser RPC attestation must pass first" : "Confirm the limited access key"}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  const confirmed = await api<AgentProvisioningView>(
                    `/v1/console/agents/${provisioning.agentId}/provision-confirm`,
                    { method: "POST" },
                  );
                  setProvisioning((current) => current ? ({ ...current, server: confirmed }) : current);
                } catch (cause) {
                  props.onError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            Confirm restricted FunctionCall key
          </button>
          {provisioning.server.status === "confirmed" ? (
            <div className="alert success">Agent provisioning confirmed by the admin.</div>
          ) : null}
        </div>
      ) : null}
      {detail ? <pre>{JSON.stringify(detail, null, 2)}</pre> : null}
    </div>
  );
}
