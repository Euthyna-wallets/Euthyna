import { useEffect, useState } from "react";

import { API_BASE, api, explorerBase, explorerNear, type MandatePreview, type TreasuryPlan, type TreasuryView } from "../api.js";
import { generatedNearPublicKey, setGeneratedNearAccountId } from "../lib/wallet-store.js";
import {
  buildSafeBatch,
  executeSafeBatch,
  signSafeBatch,
  type SafeBatch,
  type SafeBatchSignature,
} from "../safe.js";
import { authClient } from "../auth.js";
import {
  createDao,
  disableFactoryAutoUpdate,
  evmAccounts,
  evmWalletClient,
  nearAccounts,
  sendEvmTransaction,
  signDaoProposal,
  signNearTransactions,
  waitForEvmTransaction,
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
    if (!signedIn) return;
    refreshOrganizations().catch((cause: unknown) => setError(String(cause)));
    void nearAccounts().then((accounts) => setFounderNear(accounts[0] ?? "")).catch(() => undefined);
  }, [signedIn]);

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
              Each member links the NEAR account that signs DAO proposals and the EVM address that
              becomes a Safe owner. The server only stores public addresses.
            </p>
            <MemberWallets
              members={members}
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
                <AgentList treasury={treasury} onError={setError} />
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
      const response = await fetch(`${API_BASE}/api/register/passkey-start`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ email, name, nearPublicKey: generatedNearPublicKey() }),
      });
      if (!response.ok) {
        if (response.status === 409 || response.status === 422) {
          setError("This email already has an account. Sign in with your passkey instead.");
          setMode("login");
          return;
        }
        throw new Error((await response.json().catch(() => ({}))).message ?? "Registration failed");
      }
      const payload = (await response.json().catch(() => ({}))) as { nearAccountId?: string };
      if (payload.nearAccountId) setGeneratedNearAccountId(payload.nearAccountId);
      const passkey = await authClient.passkey.addPasskey({ name: "MandateOS console" });
      if (passkey?.error) setError(passkey.error.message ?? "Could not create the passkey");
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
            ? "Use the passkey stored on this device. No password, no seed phrase."
            : "Your email identifies the organization account. Access is protected by a passkey created on this device."}
        </p>
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
              {busy ? "Creating your passkey…" : "Create account with passkey"}
            </button>
            <p className="muted small">No password is created. The email is only an identifier in this UAT.</p>
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
            Pick an existing member to attach wallets, or add a wallet-only member. Paste
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

function MemberWallets(props: {
  members: Member[];
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [nearAccountId, setNearAccountId] = useState("");
  const [evmAddress, setEvmAddress] = useState("");
  const self = props.members[0];

  useEffect(() => {
    void nearAccounts().then((accounts) => setNearAccountId(accounts[0] ?? "")).catch(() => undefined);
    void evmAccounts().then((accounts) => setEvmAddress(accounts[0] ?? "")).catch(() => undefined);
  }, []);

  return (
    <div className="stack">
      <table>
        <thead><tr><th>Member</th><th>Role</th><th>NEAR</th><th>EVM</th></tr></thead>
        <tbody>
          {props.members.map((member) => (
            <tr key={member.id}>
              <td>{member.name ?? member.email ?? short(member.userId)}</td>
              <td>{member.role}</td>
              <td>{member.nearAccountId ?? "—"}</td>
              <td>{member.evmAddress ? short(member.evmAddress) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button
          className="ghost"
          onClick={() =>
            void (async () => {
              try {
                const accounts = await nearAccounts();
                if (accounts[0]) setNearAccountId(accounts[0]);
              } catch (cause) {
                props.onError(cause instanceof Error ? cause.message : String(cause));
              }
            })()
          }
        >
          Use generated NEAR account
        </button>
        <button
          className="ghost"
          onClick={() =>
            void (async () => {
              try {
                const accounts = await evmAccounts();
                if (accounts[0]) setEvmAddress(accounts[0]);
              } catch (cause) {
                props.onError(cause instanceof Error ? cause.message : String(cause));
              }
            })()
          }
        >
          Use generated EVM account
        </button>
      </div>
      <div className="row">
        <input placeholder="alice.testnet" value={nearAccountId} onChange={(event) => setNearAccountId(event.target.value)} />
        <input placeholder="0x…" value={evmAddress} onChange={(event) => setEvmAddress(event.target.value)} />
        <button
          className="primary"
          onClick={() =>
            void (async () => {
              try {
                await api("/v1/console/members/me/wallets", {
                  method: "PATCH",
                  body: JSON.stringify({ nearAccountId, evmAddress }),
                });
                await props.onSaved();
              } catch (cause) {
                props.onError(cause instanceof Error ? cause.message : String(cause));
              }
            })()
          }
        >
          Link my wallets
        </button>
      </div>
      <div className="muted small">
        These wallets are generated in this browser (non-custodial). Fund the NEAR implicit account
        with testnet NEAR and the EVM address with Base Sepolia ETH before signing treasury
        transactions. The server never sees the private keys.
      </div>
      {self?.nearAccountId && self?.evmAddress ? null : (
        <div className="muted small">Every member must link both wallets before a plan is built.</div>
      )}
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
  const [daoCreated, setDaoCreated] = useState<string | null>(null);
  const [sponsor, setSponsor] = useState<{ accountId: string; balanceYocto: string } | null>(null);

  async function refreshSponsor() {
    setSponsor(await api<{ accountId: string; balanceYocto: string }>("/v1/console/treasury/sponsor-status"));
  }

  useEffect(() => {
    void refreshSponsor().catch((cause: unknown) => props.onError(String(cause)));
  }, []);

  async function deployBase() {
    for (const transaction of [
      props.plan.base.safeDeployment,
      props.plan.base.rolesDeployment,
      props.plan.base.delayDeployment,
    ]) {
      const hash = await sendEvmTransaction(transaction);
      await waitForEvmTransaction(hash);
      setTransactionHashes((current) => [...current, hash]);
    }
  }

  async function collectSafeSignature() {
    const batch = safeBatch ?? (await buildSafeBatch(props.plan));
    setSafeBatch(batch);
    const signature = await signSafeBatch(batch);
    setSignatures((current) => {
      if (current.some((item) => item.owner.toLowerCase() === signature.owner.toLowerCase())) {
        throw new Error(`${signature.owner} already signed`);
      }
      return [...current, signature];
    });
  }

  async function executeBatch() {
    if (!safeBatch) throw new Error("Prepare the Safe batch first");
    const hash = await executeSafeBatch(safeBatch, signatures);
    await waitForEvmTransaction(hash);
    setTransactionHashes((current) => [...current, hash]);
  }

  const baseDeployed = transactionHashes.length >= 3;
  const daoDeposit = BigInt(props.plan.daoCreate.depositYocto);
  const vaultDeposit = transferDeposit(props.plan.vault.actions);
  const relayDeposit = transferDeposit(props.plan.relay.actions);
  const setupDeposit = daoDeposit + vaultDeposit + relayDeposit;
  const sponsorBalance = sponsor ? BigInt(sponsor.balanceYocto) : null;
  const contractsDeposit = vaultDeposit + relayDeposit;
  const daoAffordable = sponsorBalance === null || sponsorBalance >= daoDeposit;
  const contractsAffordable = sponsorBalance === null || sponsorBalance >= contractsDeposit;

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
          Sponsor <code>{sponsor.accountId}</code>: {formatNear(BigInt(sponsor.balanceYocto))} NEAR available.
          Create only the DAO for additional hackathon companies; a full payment treasury adds{" "}
          {formatNear(contractsDeposit)} NEAR for Vault + relay.
        </div>
      ) : null}
      <div className="steps">
        <div className="step">
          <h3>a. DAO</h3>
          <p className="muted">{props.plan.daoAccountId} · threshold {props.plan.threshold}</p>
          <div className="row">
            <button
              className="ghost"
              onClick={() => void nearAccounts().then((accounts) => setSignerId(accounts[0] ?? "")).catch((cause) => props.onError(String(cause)))}
            >
              Use connected NEAR account
            </button>
            <input placeholder="founder.testnet" value={signerId} onChange={(event) => setSignerId(event.target.value)} />
            <button
              className="primary"
              disabled={Boolean(props.busy) || !daoAffordable}
              onClick={() => props.run("dao", async () => {
                const created = await api<{ daoAccountId: string; txHash: string }>(
                  "/v1/console/treasury/create-dao",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      environment: props.plan.environment,
                      daoName: props.plan.daoName,
                      founderNearAccountId: props.plan.founderNearAccountId,
                    }),
                  },
                );
                setTransactionHashes((current) => [...current, created.txHash]);
                setDaoCreated(created.daoAccountId);
                await refreshSponsor();
              })}
            >
              Create DAO (MandateOS pays)
            </button>
            <button
              className="ghost"
              disabled={
                Boolean(props.busy) ||
                !signerId ||
                !props.plan.council.some((member) => member.nearAccountId === signerId)
              }
              title={
                signerId && !props.plan.council.some((member) => member.nearAccountId === signerId)
                  ? "Connect a council NEAR account to propose"
                  : undefined
              }
              onClick={() => props.run("auto-update", async () => {
                const hashes = await disableFactoryAutoUpdate(props.plan, signerId);
                setTransactionHashes((current) => [...current, ...hashes]);
              })}
            >
              Propose auto_update=false
            </button>
          </div>
          {daoCreated ? (
            <div className="alert success">
              DAO deployed on-chain: <code>{daoCreated}</code>{" "}
              <a href={`https://testnet.nearblocks.io/address/${daoCreated}`} target="_blank" rel="noreferrer">
                explorer
              </a>
            </div>
          ) : null}
          {signerId && !props.plan.council.some((member) => member.nearAccountId === signerId) ? (
            <div className="muted small">
              <code>{signerId}</code> is not in the DAO council ({props.plan.council.map((member) => member.nearAccountId).join(", ")}).
              The auto-update proposal must be signed by a council member.
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
              disabled={Boolean(props.busy) || !contractsAffordable}
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
                await refreshSponsor();
              })}
            >
              Deploy Vault + relay (MandateOS pays)
            </button>
          </div>
          <div className="muted small">Signed by the MandateOS relayer; contracts remain owned by the DAO.</div>
          <div className="muted small">
            Vault wasm {short(props.plan.vault.wasmSha256)} · relay wasm {short(props.plan.relay.wasmSha256)}
          </div>
          {!contractsAffordable && sponsor ? (
            <div className="muted small">
              Full treasury unavailable: needs {formatNear(contractsDeposit)} NEAR; sponsor has{" "}
              {formatNear(BigInt(sponsor.balanceYocto))} NEAR. The Company and DAO remain usable.
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
              className="primary"
              disabled={Boolean(props.busy) || baseDeployed}
              onClick={() => props.run("base-deploy", deployBase)}
            >
              Deploy Safe + modules
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy) || !baseDeployed}
              onClick={() => props.run("safe-prepare", async () => { setSafeBatch(await buildSafeBatch(props.plan)); })}
            >
              Prepare Safe batch
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy) || !baseDeployed}
              onClick={() => props.run("safe-sign", collectSafeSignature)}
            >
              Sign as owner ({signatures.length}/{props.plan.threshold})
            </button>
            <button
              className="ghost"
              disabled={Boolean(props.busy) || signatures.length < props.plan.threshold}
              onClick={() => props.run("safe-execute", executeBatch)}
            >
              Execute Safe batch
            </button>
          </div>
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
  const [nearAccountId, setNearAccountId] = useState("");
  const [nearPublicKey, setNearPublicKey] = useState("");
  const [role, setRole] = useState("researcher");

  return (
    <div className="stack">
      <div className="row wrap">
        <input placeholder="Agent name" value={name} onChange={(event) => setName(event.target.value)} />
        <input placeholder="agent.testnet" value={nearAccountId} onChange={(event) => setNearAccountId(event.target.value)} />
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
                    nearAccountId,
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
        The agent's NEAR function-call private key stays in the SDK/MCP client. Only the public key is sent.
      </div>
    </div>
  );
}


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
  const [agentEvm, setAgentEvm] = useState("");
  const [signerId, setSignerId] = useState("");
  const [proposalHashes, setProposalHashes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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
        <input placeholder="agent near account (optional)" value={agentAccount} onChange={(event) => setAgentAccount(event.target.value)} />
        <input placeholder="agent EVM address (optional)" value={agentEvm} onChange={(event) => setAgentEvm(event.target.value)} />
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
                body: JSON.stringify({
                  role,
                  operations: ["pay"],
                  maxPerTx,
                  budget,
                  periodDays: Number(periodDays),
                  recipients: recipients.split(",").map((value) => value.trim()).filter(Boolean),
                  token,
                  gas: {
                    gasLimit: "200000",
                    maxFeePerGas: "20000000000",
                    maxPriorityFeePerGas: "1000000000",
                    maxTotalFee: "30000000000000000",
                  },
                  ...(agentAccount
                    ? {
                        agent: {
                          nearAccountId: agentAccount,
                          mpcPath: `agents/${role}/base`,
                          ...(agentEvm ? { evmAddress: agentEvm } : {}),
                        },
                      }
                    : {}),
                }),
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
            <div key={warning} className="alert success">{warning}</div>
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
          <h3>Unsigned proposals</h3>
          <div className="row">
            <input placeholder="your NEAR council account" value={signerId} onChange={(event) => setSignerId(event.target.value)} />
            <button className="ghost" onClick={() => void nearAccounts().then((accounts) => setSignerId(accounts[0] ?? "")).catch((cause) => props.onError(String(cause)))}>
              Use connected NEAR account
            </button>
          </div>
          <div className="stack">
            {[
              props.preview.proposals.vaultSetRole,
              props.preview.proposals.vaultRegisterAgent,
              props.preview.proposals.funding,
              ...props.preview.proposals.zodiacRelay,
            ]
              .filter((proposal): proposal is NonNullable<typeof proposal> => Boolean(proposal))
              .map((proposal, index) => (
                <div key={`${proposal.description}-${index}`} className="row">
                  <span>{proposal.description}</span>
                  <button
                    className="primary"
                    disabled={!signerId || busy}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        try {
                          const hash = await signDaoProposal(signerId, proposal);
                          setProposalHashes((current) => [...current, hash]);
                        } catch (cause) {
                          props.onError(cause instanceof Error ? cause.message : String(cause));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Sign with NEAR wallet
                  </button>
                </div>
              ))}
          </div>
          {proposalHashes.length ? (
            <details>
              <summary>{proposalHashes.length} proposal transaction(s)</summary>
              <pre>{proposalHashes.join("\n")}</pre>
            </details>
          ) : null}
          <pre>{JSON.stringify(props.preview.proposals, null, 2)}</pre>
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
  evmAddress: string | null;
  active: boolean;
};

function AgentList(props: { treasury: TreasuryView; onError: (message: string) => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await api<{ agents: AgentRow[] }>("/v1/console/agents");
    setAgents(result.agents);
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
        <thead><tr><th>Name</th><th>Role</th><th>NEAR</th><th>EVM</th><th>Status</th><th /></tr></thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.id}>
              <td>{agent.name}</td>
              <td>{agent.role}</td>
              <td>{agent.nearAccountId}</td>
              <td>{agent.evmAddress ? short(agent.evmAddress) : "—"}</td>
              <td>{agent.active ? "active" : "revoked"}</td>
              <td>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      try {
                        const result = await api<Record<string, unknown>>(`/v1/console/agents/${agent.id}`);
                        setDetail(result);
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail ? <pre>{JSON.stringify(detail, null, 2)}</pre> : null}
    </div>
  );
}
