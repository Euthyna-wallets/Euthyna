import { useQuery } from "@tanstack/react-query";
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
import { omni } from "../omniroles-api.js";
import { FundWallet, TreasuryCreate, WalletSetup } from "./TreasurySetup.js";
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
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrganization, setActiveOrganization] = useState<Organization | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);
  const claimMemberId = new URLSearchParams(window.location.search).get("member");
  const status = useQuery({ queryKey: ["omni-status", activeOrganization?.id], queryFn: omni.status, enabled: Boolean(activeOrganization), refetchInterval: 8_000 });
  const roles = useQuery({ queryKey: ["omni-roles", activeOrganization?.id], queryFn: omni.roles, enabled: Boolean(status.data?.treasury), refetchInterval: 15_000 });

  const signedIn = Boolean(session.data?.user);
  const approvedMemberCount = members.filter((member) => member.walletProofApprovedAt).length;
  const treasury = status.data?.treasury ?? null;
  const setupStage = !activeOrganization
    ? "company"
    : approvedMemberCount < 3
      ? "members"
      : !treasury
        ? "treasury"
        : !status.data?.wallet
          ? "wallet"
          : (roles.data?.roles.length ?? 0) === 0
            ? "role"
            : "done";
  const waitingFor = {
    company: "The founder creates the company",
    members: `${approvedMemberCount} of 3 members verified · invited members prove their wallets, an admin reviews them`,
    treasury: "An admin creates the treasury",
    wallet: "Members vote to create the company wallet",
    role: "Fund the wallet, then create the first role",
    done: "Setup complete",
  }[setupStage];

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
  }, [signedIn, passkeyReady]);

  useEffect(() => {
    if (!activeOrganization) return;
    void (async () => {
      await authClient.organization.setActive({ organizationId: activeOrganization.id }).catch(() => undefined);
      await refreshMembers(activeOrganization.id).catch((cause: unknown) => setError(String(cause)));
    })();
  }, [activeOrganization?.id]);

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
          <span className="eyebrow">Company setup</span>
          <h1>{activeOrganization?.name ?? "Create your company"}</h1>
          <p className="muted">Humans set the rules once. Agents then work inside them, and nothing else gets signed.</p>
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

      <SetupProgress stage={setupStage} />

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
            Members are the people who vote on the rules. Each one proves the NEAR account they vote with;
            another admin then confirms it. At least three verified members are needed.
          </p>
          <MemberWallets
            members={members}
            currentUserId={session.data?.user.id ?? ""}
            onSaved={async () => refreshMembers(activeOrganization.id)}
            onError={setError}
          />
        </section>
      ) : null}

      {setupStage === "treasury" && activeOrganization ? (
        <TreasuryCreate companyName={activeOrganization.name} onCreated={async () => { await status.refetch(); }} />
      ) : null}

      {setupStage === "wallet" && status.data ? (
        <WalletSetup status={status.data} onChanged={async () => { await status.refetch(); }} />
      ) : null}

      {(setupStage === "role" || setupStage === "done") && status.data ? <FundWallet status={status.data} /> : null}

      {setupStage === "done" ? (
        <section className="card empty-action">
          <div>
            <h2>Setup complete</h2>
            <p className="muted">The treasury, the wallet and a first role are in place.</p>
          </div>
          <a className="button primary" href="/">Go to Overview</a>
        </section>
      ) : null}
    </div>
  );
}

function SetupProgress({ stage }: { stage: string }) {
  const steps = [
    { id: "company", label: "Company" },
    { id: "members", label: "Members" },
    { id: "treasury", label: "Treasury" },
    { id: "wallet", label: "Wallet" },
    { id: "role", label: "First role" },
  ];
  const current = stage === "done" ? steps.length : steps.findIndex((step) => step.id === stage);
  return (
    <nav className="setup-progress" aria-label="Company setup progress">
      {steps.map((step, index) => (
        <div key={step.id} className={`${index < current ? "done" : ""} ${index === current ? "current" : ""}`}>
          <span>{index < current ? "✓" : index + 1}</span>
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

export function AgentForm(props: {
  treasury: { vaultAccountId: string };
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

export function AgentList(props: { treasury: { vaultAccountId: string }; onError: (message: string) => void }) {
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
