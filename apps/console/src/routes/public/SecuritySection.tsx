const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', sans-serif";

const CAPABILITIES = [
  { title: "A role per agent", text: "Scope each agent to chains, contracts, functions and even parameter values. Outside its role, NEAR refuses, whoever asks.", icon: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h5" /></> },
  { title: "Budgets per role", text: "Each role has allowances that refill every period, counted from the transaction itself, not from what the agent says.", icon: <><path d="M4 19h16" /><path d="M7 16V9M12 16V5M17 16v-4" /></> },
  { title: "Assign, suspend, revoke", text: "Grant a role to one agent or several, suspend it in place, revoke one member. The role outlives the agent.", icon: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6" /><path d="M15 14l2 2 4-4" /></> },
  { title: "Changes by vote only", text: "Creating or widening a role is a DAO vote, and the new rule waits out a veto window that any council member can use.", icon: <><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></> },
  { title: "No keys to steal", text: "Company wallets are signed by NEAR MPC, only after the vault approves. The vault itself has no access key, not even for Euthyna.", icon: <><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></> },
  { title: "Kill switch", text: "One council member can pause every agent at once. Only a vote resumes them.", icon: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></> },
];

const ROLE_ROWS: Array<[string, string]> = [
  ["Chains", "Base · Ethereum"],
  ["May call", "Uniswap V3 · exactInputSingle"],
  ["Parameters", "USDC in · output to the company wallet"],
  ["Budget", "500 USDC every 7 days"],
  ["Members", "treasury-agent.near"],
  ["To change it", "owners' vote + veto window"],
];

export function SecuritySection() {
  return (
    <section id="security" style={{ maxWidth: "1392px", margin: "0 auto", padding: "72px 24px 24px" }}>
      <span style={{ fontFamily: mono, fontSize: "12px", letterSpacing: "0.1em", color: "#F2B544" }}>SECURITY BY DESIGN · OMNIROLES</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "32px", alignItems: "center", margin: "10px 0 32px" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: mono, fontSize: "36px", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.02em" }}>Give agents roles, not keys.</h2>
          <p style={{ margin: "14px 0 0", fontFamily: sans, fontSize: "18px", lineHeight: 1.6, color: "#C9D6EE" }}>
            OmniRoles is role-based access control for AI agents, enforced on chain. The owners decide what each agent may do, on which chain, and how much. A hacked or tricked agent stays inside its role.
          </p>
        </div>
        <img src="/landing/roles.webp" alt="A robot holds up its badge and only one door in a row of locked doors opens for it." style={{ flex: "1 1 420px", minWidth: 0, maxWidth: "640px", width: "100%", height: "auto", borderRadius: "20px", display: "block" }} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "20px", alignItems: "stretch" }}>
        <div style={{ flex: "1 1 400px", minWidth: 0, background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", padding: "28px", display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ width: "40px", height: "40px", borderRadius: "12px", background: "#0F2A5C", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4FD1E8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9.5 13h.01M14.5 13h.01" /></svg>
              </span>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontFamily: mono, fontSize: "12px", color: "#5A6B8C" }}>ROLE</span>
                <span style={{ fontFamily: mono, fontSize: "20px", fontWeight: 700 }}>treasury</span>
              </div>
            </div>
            <span style={{ fontFamily: mono, fontSize: "11px", color: "#5A6B8C", border: "1px solid #C3CFE3", borderRadius: "6px", padding: "4px 8px" }}>example</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ROLE_ROWS.map(([label, value]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: "16px", padding: "12px 0", borderTop: "1px solid #E4EAF4", flexWrap: "wrap" }}>
                <span style={{ fontFamily: mono, fontSize: "13px", color: "#5A6B8C" }}>{label}</span>
                <span style={{ fontFamily: mono, fontSize: "14px", fontWeight: 600, textAlign: "right" }}>{value}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: "auto", background: "#0F2A5C", color: "#F2F6FC", borderRadius: "14px", padding: "16px 18px", fontFamily: sans, fontSize: "14px", lineHeight: 1.55 }}>
            <span style={{ fontFamily: mono, fontSize: "11px", letterSpacing: "0.08em", color: "#F2B544" }}>WORST CASE</span><br />
            What is left of the role's budget, inside the role's scope. Nothing else can leave the company.
          </div>
        </div>

        <div style={{ flex: "999 1 560px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: "16px" }}>
          {CAPABILITIES.map((item) => (
            <article key={item.title} style={{ background: "#16376F", border: "1px solid rgba(201,214,238,.25)", borderRadius: "18px", padding: "22px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4FD1E8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{item.icon}</svg>
              <h3 style={{ margin: 0, fontFamily: mono, fontSize: "17px", fontWeight: 700 }}>{item.title}</h3>
              <p style={{ margin: 0, fontFamily: sans, fontSize: "14px", lineHeight: 1.6, color: "#C9D6EE" }}>{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
