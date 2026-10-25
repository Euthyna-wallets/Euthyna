const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', sans-serif";

const STEPS = [
  { who: "AI agent", text: "asks to pay", color: "#4FD1E8" },
  { who: "OmniRoles", text: "checks the role on NEAR", color: "#F2B544" },
  { who: "Guard", text: "screens the invoice", color: "#F2B544" },
  { who: "NEAR MPC", text: "signs only if both pass", color: "#F2F6FC" },
  { who: "Base · Ethereum", text: "the payment goes out", color: "#9AD39C" },
];

const LOCKS = [
  { title: "OmniRoles", text: "Each AI employee has a role written on chain: which contract, which function, which recipients, how much. Anything else is refused before it is signed.", icon: <><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></> },
  { title: "Budgets measured, not declared", text: "Amounts are read from the transaction itself and counted against a budget that refills each period. An agent cannot under-report what it sends.", icon: <><path d="M4 19h16" /><path d="M7 16V9M12 16V5M17 16v-4" /></> },
  { title: "No master key", text: "The vault, the shares contract and the directory have no access key. Not the founders, not MandateOS, not a stolen server can sign as them.", icon: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /><path d="M4 4l16 16" /></> },
  { title: "Veto window and pause", text: "A new rule waits before it applies, and any council member can stop it. One member can pause every agent; only a vote resumes them.", icon: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></> },
  { title: "Guard against injections", text: "Off chain, the Guard screens invoices for prompt injection and checks payees against suppliers that two members approved.", icon: <><path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></> },
  { title: "Attacked on purpose", text: "An attack suite plays a prompt-injected agent, a stolen Guard key, a stolen server and a rogue member against a real vault. Run it yourself.", icon: <><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></> },
];

export function SecuritySection() {
  return (
    <section id="security" style={{ maxWidth: "1392px", margin: "0 auto", padding: "72px 24px 24px" }}>
      <span style={{ fontFamily: mono, fontSize: "12px", letterSpacing: "0.1em", color: "#F2B544" }}>SECURITY BY DESIGN</span>
      <h2 style={{ margin: "10px 0 0", fontFamily: mono, fontSize: "32px", fontWeight: 700, maxWidth: "900px", lineHeight: 1.2 }}>Built so a hacked agent cannot empty the company.</h2>
      <p style={{ margin: "12px 0 32px", fontFamily: sans, fontSize: "17px", lineHeight: 1.6, color: "#C9D6EE", maxWidth: "820px" }}>
        Agents read invoices, emails and web pages, so one day one of them will be tricked. MandateOS assumes it: the agent's key alone can never move money outside its role.
      </p>

      <div style={{ background: "#16376F", border: "1px solid rgba(201,214,238,.25)", borderRadius: "20px", padding: "24px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "20px" }}>
        {STEPS.map((step, index) => (
          <div key={step.who} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ flex: "0 0 32px", height: "32px", borderRadius: "999px", border: `2px solid ${step.color}`, color: step.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: "14px", fontWeight: 700 }}>{index + 1}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontFamily: mono, fontSize: "15px", fontWeight: 700, color: step.color }}>{step.who}</span>
              <span style={{ fontFamily: sans, fontSize: "14px", color: "#C9D6EE" }}>{step.text}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: "20px" }}>
        {LOCKS.map((lock) => (
          <article key={lock.title} style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "20px", padding: "26px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <span style={{ width: "46px", height: "46px", borderRadius: "14px", background: "#0F2A5C", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4FD1E8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{lock.icon}</svg>
            </span>
            <h3 style={{ margin: 0, fontFamily: mono, fontSize: "19px", color: "#0F2A5C" }}>{lock.title}</h3>
            <p style={{ margin: 0, fontFamily: sans, fontSize: "15px", lineHeight: 1.6, color: "#44557A" }}>{lock.text}</p>
          </article>
        ))}
      </div>
      <p style={{ margin: "20px 0 0", fontFamily: mono, fontSize: "14px", color: "#C9D6EE" }}>
        Run the attacks: <code style={{ background: "#16376F", color: "#4FD1E8", padding: "4px 8px", borderRadius: "6px" }}>pnpm attack:all</code> · <a href="https://github.com/joindefi/MandateOS/blob/main/docs/attacks.md" style={{ color: "#4FD1E8" }}>what each attack tries</a>
      </p>
    </section>
  );
}
