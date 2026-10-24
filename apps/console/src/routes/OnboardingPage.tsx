import { useEffect, useState } from "react";

import { API_BASE, api, explorerBase, explorerNear, type BudgetTokenPlan, type BudgetTokenStatus, type MandatePreview, type MandateProposal, type TreasuryPlan, type TreasuryView } from "../api.js";
import { demoWalletsEnabled, generatedNearPublicKey, selectDemoWalletScopeForAccounts, selectDemoWalletScopeForEvmAddress, setDemoWalletScope, setGeneratedNearAccountId } from "../lib/wallet-store.js";
import { formatToken } from "../lib/format.js";
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
  connectNearWallet,
  disableFactoryAutoUpdate,
  evmAccounts,
  findDaoProposalsRpc,
  evmWalletClient,
  nearAccounts,
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
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [plan, setPlan] = useState<TreasuryPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MandatePreview | null>(null);
  const [founderNear, setFounderNear] = useState("");
  const [passkeyReady, setPasskeyReady] = useState<boolean | null>(null);
  const claimMemberId = new URLSearchParams(window.location.search).get("member");

  const signedIn = Boolean(session.data?.user);

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
    void nearAccounts().then((accounts) => setFounderNear(accounts[0] ?? "")).catch(() => undefined);
  }, [signedIn, passkeyReady]);

  useEffect(() => {
    if (!activeOrganization) return;
    void (async () => {
      await authClient.organization.setActive({ organizationId: activeOrganization.id }).catch(() => undefined);
      await refreshMembers(activeOrganization.id).catch((cause: unknown) => setError(String(cause)));
      await refreshTreasury().catch((cause: unknown) => setError(String(cause)));
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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">MandateOS</div>
        <div className="muted small">Company console</div>
        <nav>
          <a className="active" href="#onboarding">Onboarding</a>
          <a href="#treasury">Treasury</a>
          <a href="#agents">Agents</a>
          <a href="#mandates">Mandates</a>
        </nav>
        <div className="spacer" />
        <div className="small muted">{session.data?.user.email}</div>
        <button
          className="ghost"
          disabled={Boolean(busy)}
          onClick={() => void run("passkey", async () => {
            const result = await authClient.passkey.addPasskey({
              name: `MandateOS ${session.data?.user.email ?? "console"}`,
            });
            if (result.error) throw new Error(result.error.message ?? "Could not add passkey");
            setNotice("Passkey added.");
          })}
        >
          Add passkey
        </button>
        <button className="ghost" onClick={() => authClient.signOut()}>Sign out</button>
      </aside>

      <main>
        <header>
          <div>
            <h1>{activeOrganization?.name ?? "Create your company"}</h1>
            <p className="muted">Passkey identity, human council, no server key.</p>
          </div>
          <div className="row wrap">
            <div className="pill">Base Sepolia · NEAR testnet</div>
            {activeOrganization ? <a className="pill" href="/">Open console →</a> : null}
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

        <section id="onboarding" className="card">
          <h2>1. Company and members</h2>
          <OrganizationPanel
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
        </section>

        {activeOrganization ? (
          <section className="card">
            <h2>2. Member wallets</h2>
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

        {activeOrganization && !treasury ? (
          <section className="card">
            <h2>3. Treasury plan</h2>
            <p className="muted">
              The server builds unsigned transactions only. DAO, Vault, relay and Base transactions
              are signed in your wallets.
            </p>
            <div className="row">
              <input
                placeholder="founder.testnet"
                value={founderNear}
                onChange={(event) => setFounderNear(event.target.value)}
              />
              <button
                className="ghost"
                onClick={() => void nearAccounts().then((accounts) => setFounderNear(accounts[0] ?? "")).catch((cause) => setError(String(cause)))}
              >
                Use generated NEAR account
              </button>
            </div>
            <button
              className="primary"
              disabled={Boolean(busy) || founderNear.length < 2}
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

        {plan ? (
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

        {treasury ? <Summary treasury={treasury} /> : null}
        {treasury && demoWalletsEnabled() ? (
          <section className="card">
            <h2>Base governance gas (UAT)</h2>
            <button
              className="ghost"
              disabled={Boolean(busy)}
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


        {treasury ? (
          <section id="agents" className="card">
            <h2>4. Register an agent</h2>
            {treasury.status === "active" ? (
              <>
                <AgentForm
                  treasury={treasury}
                  onCreated={(createdKey) => {
                    setApiKey(createdKey);
                    setNotice("Agent created. The API key is shown once.");
                  }}
                  onError={setError}
                />
                {apiKey ? <pre className="secret">{apiKey}</pre> : null}
                <AgentList key={apiKey ?? "agents"} treasury={treasury} onError={setError} />
              </>
            ) : (
              <>
              <div className="alert error">
                Treasury status: {treasury.status}. Agent registration is blocked until every
                register check passes (DAO hardening, init parameters, Safe modules and Delay).
              </div>
              <button
                className="primary"
                disabled={Boolean(busy)}
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

        {treasury?.status === "active" ? (
          <section id="mandates" className="card">
            <h2>5. Agent mandate</h2>
            <MandatePanel treasury={treasury} preview={mandate} onPreview={setMandate} onError={setError} />
          </section>
        ) : null}
      </main>
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
        <button className="primary" disabled={busy} onClick={() => void enroll()}>
          {busy ? "Waiting for your authenticator…" : "Create passkey"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void authClient.signOut()}>
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
          <li>Guard visa bound to one exact transaction</li>
          <li>Vault role, budget and idempotence on NEAR</li>
          <li>Zodiac permissions on a 2/3 Safe</li>
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
          <button className="primary" disabled={busy} onClick={() => void signInWithPasskey()}>
            {busy ? "Waiting for your authenticator…" : "Continue with passkey"}
          </button>
        ) : (
          <>
            <label>Full name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Work email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <button className="primary" disabled={busy || !email || !name} onClick={() => void register(email, name)}>
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
  const [memberEvm, setMemberEvm] = useState("");

  return (
    <div className="stack">
      {props.organizations.length ? (
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
      <div className="row">
        <input placeholder="Company name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="primary"
          disabled={name.trim().length < 2}
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
      {props.active ? (
        <div className="stack">
          <div className="muted small">
            Pick an existing member to replace a wallet declaration, or add a pending member. Paste
            accounts as copied from the wallet: <code>busyvideo615.testnet (*testnet)</code>.
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
            <input placeholder="near.testnet" value={memberNear} onChange={(event) => setMemberNear(event.target.value)} />
            <input placeholder="0x EVM address" value={memberEvm} onChange={(event) => setMemberEvm(event.target.value)} />
            <button
              className="ghost"
              disabled={!memberNear || !memberEvm || (!selectedMemberId && !memberName)}
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
                        body: JSON.stringify({ name: memberName, nearAccountId: memberNear, evmAddress: memberEvm }),
                      });
                    }
                    setSelectedMemberId("");
                    setMemberName("");
                    setMemberNear("");
                    setMemberEvm("");
                    await props.onMembersChanged();
                  } catch (cause) {
                    props.onError(cause instanceof Error ? cause.message : String(cause));
                  }
                })()
              }
            >
              {selectedMemberId ? "Save member wallets" : "Add member"}
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
  const [nearAccountId, setNearAccountId] = useState(props.initialNear ?? "");
  const [evmAddress, setEvmAddress] = useState(props.initialEvm ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="stack">
      {error ? <div className="alert error">{error}</div> : null}
      <div className="row">
        <button
          className="ghost"
          disabled={busy}
          onClick={() => void (async () => {
            try {
              const accounts = demoWalletsEnabled() ? await nearAccounts() : await connectNearWallet();
              if (accounts[0]) setNearAccountId(accounts[0]);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              setError(message);
              props.onError(message);
            }
          })()}
        >
          {demoWalletsEnabled() ? "Use generated NEAR account" : "Connect NEAR wallet"}
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => void evmAccounts()
            .then((accounts) => setEvmAddress(accounts[0] ?? ""))
            .catch((cause: unknown) => {
              const message = String(cause);
              setError(message);
              props.onError(message);
            })}
        >
          {demoWalletsEnabled() ? "Use generated EVM account" : "Connect MetaMask / Rabby"}
        </button>
      </div>
      <div className="row">
        <input placeholder="alice.testnet" value={nearAccountId} onChange={(event) => setNearAccountId(event.target.value)} />
        <input placeholder="0x…" value={evmAddress} onChange={(event) => setEvmAddress(event.target.value)} />
        <button
          className="primary"
          disabled={busy || !nearAccountId || !evmAddress}
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
        The challenge is scoped to this member, organization, both wallets, Base Sepolia and a
        ten-minute nonce. MandateOS verifies the NEAR full-access key and recovered EVM signer.
      </div>
    </div>
  );
}

function WalletProofPanel(props: {
  memberId: string;
  onVerified: () => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">MandateOS</div>
        <h1>Accept wallet invitation</h1>
        <p className="muted">Your passkey identifies your profile. Control of both declared wallets accepts the membership.</p>
        <WalletProofForm {...props} />
      </div>
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
                {member.walletProofVerifiedAt
                  ? "proved"
                  : member.walletProofClaimable
                    ? <a href={`/onboarding?member=${member.id}`}>claim link</a>
                    : "signature required"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {demoWalletsEnabled() ? (
        <button
          className="ghost"
          disabled={provisioningCouncil}
          onClick={() => void provisionDemoCouncilAccounts()}
        >
          {provisioningCouncil ? "Provisioning council accounts…" : "Provision generated council NEAR accounts (UAT)"}
        </button>
      ) : null}
      {self ? (
        <>
          <h3>{self.walletProofVerifiedAt ? "Replace my wallet proof" : "Prove my wallets"}</h3>
          <WalletProofForm
            memberId={self.id}
            initialNear={self.nearAccountId ?? ""}
            initialEvm={self.evmAddress ?? ""}
            onVerified={props.onSaved}
            onError={props.onError}
          />
        </>
      ) : (
        <div className="alert error">This passkey profile is not a member of the active organization.</div>
      )}
      <div className="muted small">
        Unproved admin declarations remain pending and are excluded from DAO council and Safe owners.
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
      <h2>3. Treasury transactions</h2>
      <div className="alert">
        One-time NEAR setup balances (not payment-operation fees): DAO {formatNear(daoDeposit)} +
        Vault {formatNear(vaultDeposit)} + relay {formatNear(relayDeposit)} ={" "}
        <strong>{formatNear(setupDeposit)} NEAR</strong>. Most of this balance is locked against
        contract storage. The observed 14.288 Tgas payment authorization costs about 0.00143 NEAR
        at the current testnet gas price.
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
          <h3>a. DAO</h3>
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
          <div className="row">
            <button
              className="ghost"
              onClick={() => void nearAccounts().then((accounts) => setSignerId(accounts[0] ?? "")).catch((cause) => props.onError(String(cause)))}
            >
              Use founder NEAR account
            </button>
            <input placeholder="founder.testnet" value={signerId} onChange={(event) => setSignerId(event.target.value)} />
            <button
              className="primary"
              disabled={
                Boolean(props.busy) ||
                !creationPolicyConfirmed ||
                signerId !== props.plan.founderNearAccountId
              }
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
          <h3>b. Vault and relay</h3>
          <p className="muted">
            Two accounts, each deployed with CreateAccount + Transfer + DeployContract + new().
            No AddKey action is emitted.
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={Boolean(props.busy) || !contractsAffordable || !policyConfirmed}
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
              Deploy Vault + relay (MandateOS pays)
            </button>
          </div>
          <div className="row wrap">
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              onClick={() => props.run("near-rpc-attestation", verifyNearDeploymentAndConfirm)}
            >
              Verify by direct RPC and confirm as this member
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
              onClick={() => props.run("near-confirmations", refreshDeploymentConfirmations)}
            >
              Refresh member confirmations
            </button>
          </div>
          <div className="muted small">Signed by the MandateOS relayer; contracts remain owned by the DAO.</div>
          <div className="muted small">
            Vault wasm {short(props.plan.vault.wasmSha256)} · relay wasm {short(props.plan.relay.wasmSha256)}
          </div>
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
              Read the DAO policy from NEAR RPC and confirm every council member and the threshold
              before deploying Vault/relay.
            </div>
          ) : null}
        </div>

        <div className="step">
          <h3>c. Base Safe, Roles and Delay</h3>
          <p className="muted">
            Safe {short(props.plan.base.safeAddress)} · Roles {short(props.plan.base.rolesAddress)} · Delay{" "}
            {short(props.plan.base.delayAddress)} · 0xGOV {short(props.plan.govAddress)}
          </p>
          <div className="row wrap">
            <button
              className="ghost"
              disabled={Boolean(props.busy)}
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
            <button
              className="primary"
              disabled={Boolean(props.busy) || baseDeployed || !deploymentConfirmed}
              onClick={() => props.run("base-deploy", deployBase)}
            >
              Deploy Safe + modules
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy) || !baseDeployed}
              onClick={() => props.run("safe-prepare", async () => {
                setSafeBatch(await buildSafeBatch(props.plan));
                setSignatures([]);
              })}
            >
              Prepare Safe batch
            </button>
            {demoWalletsEnabled() ? props.plan.council.map((member) => (
              <button
                key={member.evmAddress}
                className="ghost"
                disabled={Boolean(props.busy) || !baseDeployed}
                onClick={() => props.run(`safe-sign-${member.memberId}`, () => collectSafeSignature(member.evmAddress))}
              >
                Sign as {short(member.evmAddress)} ({signatures.length}/{props.plan.threshold})
              </button>
            )) : (
              <button
                className="ghost"
                disabled={Boolean(props.busy) || !baseDeployed}
                onClick={() => props.run("safe-sign", () => collectSafeSignature())}
              >
                Sign as owner ({signatures.length}/{props.plan.threshold})
              </button>
            )}
            <button
              className="ghost"
              disabled={Boolean(props.busy) || signatures.length < props.plan.threshold}
              onClick={() => props.run("safe-execute", executeBatch)}
            >
              Execute Safe batch
            </button>
          </div>
          {!deploymentConfirmed ? (
            <div className="alert">
              Safe deployment remains blocked until every proven council member independently reads
              Vault and relay from NEAR RPC and confirms the same deployment digest.
            </div>
          ) : null}
        </div>
      </div>

      <div className="row">
        <button
          className="primary"
          disabled={Boolean(props.busy) || !baseDeployed || signatures.length < props.plan.threshold}
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
          <tr><td>DAO</td><td><a href={explorerNear(treasury.daoAccountId)} target="_blank" rel="noreferrer">{treasury.daoAccountId}</a></td></tr>
          <tr><td>Vault</td><td><a href={explorerNear(treasury.vaultAccountId)} target="_blank" rel="noreferrer">{treasury.vaultAccountId}</a></td></tr>
          <tr><td>Relay</td><td><a href={explorerNear(treasury.relayAccountId)} target="_blank" rel="noreferrer">{treasury.relayAccountId}</a></td></tr>
          <tr><td>Safe</td><td><a href={explorerBase(treasury.safeAddress)} target="_blank" rel="noreferrer">{treasury.safeAddress}</a></td></tr>
          <tr><td>Roles</td><td><a href={explorerBase(treasury.rolesAddress)} target="_blank" rel="noreferrer">{treasury.rolesAddress}</a></td></tr>
          <tr><td>Delay</td><td><a href={explorerBase(treasury.delayAddress)} target="_blank" rel="noreferrer">{treasury.delayAddress}</a></td></tr>
          <tr><td>0xGOV</td><td><a href={explorerBase(treasury.govAddress)} target="_blank" rel="noreferrer">{treasury.govAddress}</a></td></tr>
        </tbody>
      </table>
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

  return (
    <div className="stack">
      <div className="row wrap">
        <input placeholder="Agent name" value={name} onChange={(event) => setName(event.target.value)} />
        <input placeholder="ed25519:…" value={nearPublicKey} onChange={(event) => setNearPublicKey(event.target.value)} />
        <input placeholder="role" value={role} onChange={(event) => setRole(event.target.value)} />
        <button
          className="primary"
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
        Run <code>mandateos agent init --name "{name || "Compta Bot"}"</code>, then paste only
        the generated public key. MandateOS derives the account id and never receives the private key.
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

type ProposalRun = DaoProposalRpc & { transactionHash?: string };

export function MandatePanel(props: {
  treasury: TreasuryView;
  preview: MandatePreview | null;
  onPreview: (preview: MandatePreview) => void;
  onError: (message: string) => void;
}) {
  const [role, setRole] = useState("researcher");
  const [maxPerTx, setMaxPerTx] = useState("5000000");
  const [budget, setBudget] = useState("6000000");
  const [periodDays, setPeriodDays] = useState("30");
  const [recipients, setRecipients] = useState("");
  const [token, setToken] = useState("0x418A2b47911dE05e21688F7490195F5324B49474");
  const [agentAccount, setAgentAccount] = useState("");
  const [signerId, setSignerId] = useState("");
  const [proposalHashes, setProposalHashes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [budgetTokenStatus, setBudgetTokenStatus] = useState<BudgetTokenStatus | null>(null);
  const [budgetTokenHashes, setBudgetTokenHashes] = useState<string[]>([]);
  const [proposalRuns, setProposalRuns] = useState<Record<string, ProposalRun>>({});

  const [agents, setAgents] = useState<AgentRow[]>([]);
  useEffect(() => {
    void api<{ agents: AgentRow[] }>("/v1/console/agents")
      .then((result) => setAgents(result.agents))
      .catch((cause: unknown) => props.onError(String(cause)));
  }, []);
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
    return {
      role,
      operations: ["pay"],
      maxPerTx,
      budget,
      periodDays: Number(periodDays),
      recipients: recipients.split(",").map((value) => value.trim()).filter(Boolean),
      token,
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
        One YAML-like mandate compiles into three locks. The preview is deterministic; the server
        prepares unsigned Trezu proposals and never signs.
      </p>
      <div className="row wrap">
        <input placeholder="role" value={role} onChange={(event) => setRole(event.target.value)} />
        <input placeholder="max per tx" value={maxPerTx} onChange={(event) => setMaxPerTx(event.target.value)} />
        <input placeholder="budget" value={budget} onChange={(event) => setBudget(event.target.value)} />
        <input placeholder="period days" value={periodDays} onChange={(event) => setPeriodDays(event.target.value)} />
      </div>
      <input placeholder="recipient 0x…, comma separated" value={recipients} onChange={(event) => setRecipients(event.target.value)} />
      <input placeholder="token 0x…" value={token} onChange={(event) => setToken(event.target.value)} />
      <div className="row wrap">
        <select
          value={agentAccount}
          onChange={(event) => {
            const accountId = event.target.value;
            setAgentAccount(accountId);
            const selected = agents.find((agent) => agent.nearAccountId === accountId);
            if (selected) setRole(selected.role);
          }}
        >
          <option value="">No agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.nearAccountId}>
              {agent.name} · {agent.evmAddress ?? "0xAAA not derived"}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <input placeholder="your NEAR council account" value={signerId} onChange={(event) => setSignerId(event.target.value)} />
        <button className="ghost" onClick={() => void nearAccounts().then((accounts) => setSignerId(accounts[0] ?? "")).catch((cause) => props.onError(String(cause)))}>
          Use connected NEAR account
        </button>
      </div>
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
          <button className="ghost" disabled={busy} onClick={() => void refreshBudgetToken().catch((cause: unknown) => props.onError(String(cause)))}>
            Read test-token state
          </button>
        )}
        <button
          className="primary"
          disabled={!signerId || busy || budgetTokenStatus?.decimals !== 6}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                const plan = await api<BudgetTokenPlan>("/v1/console/treasury/budget-token/plan", {
                  method: "POST",
                  body: JSON.stringify({ amount: budget }),
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
      <button
        className="primary"
        disabled={busy}
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
        {busy ? "Compiling…" : "Preview mandate"}
      </button>

      {props.preview ? (
        <>
          <div className="row wrap">
            <span className="pill">roleKey {short(props.preview.roleKey)}</span>
            <span className="pill">allowance {short(props.preview.allowanceKey)}</span>
            <span className="pill">agent: {props.preview.agentStatus}</span>
          </div>
          {props.preview.warnings.map((warning) => (
            <div key={warning} className="alert warning">{warning}</div>
          ))}
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
          <h3>Ordered DAO execution</h3>
          <div className="stack">
            {orderedMandateProposals(props.preview).map((proposal, index, proposals) => {
              const description = onChainProposalDescription(proposal);
              const run = proposalRuns[description];
              const state = run?.state ?? "Not proposed";
              const proposalWarnings = proposal.warnings ?? [];
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
                    <strong>{index + 1}. {proposal.description}</strong>
                    <span className="pill">
                      {state}{run ? ` · #${run.id} · ${run.rawStatus}` : ""}
                    </span>
                  </div>
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
        <thead><tr><th>Name</th><th>Role</th><th>NEAR</th><th>0xAAA</th><th>Status</th><th /></tr></thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>{agent.name}</td>
              <td>{agent.role}</td>
              <td>{agent.nearAccountId}</td>
              <td>{agent.evmAddress ? short(agent.evmAddress) : "derive after register_agent"}</td>
              <td>{agent.active ? "active" : "revoked"}</td>
              <td>
                <div className="row wrap">
                  <button
                    className="primary"
                    disabled={busy}
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
                    On-chain state
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
