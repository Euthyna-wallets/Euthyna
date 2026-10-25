const mono = "'IBM Plex Mono', ui-monospace, monospace";
const sans = "'IBM Plex Sans', sans-serif";

/** What a hacked or rogue AI employee would try, and why it fails. */
const ATTEMPTS = [
  { tries: "Send the treasury to its own wallet", why: "Its role lists who it may pay. Any other address is refused on NEAR before anything is signed." },
  { tries: "Pay itself in many small transfers", why: "Every payment counts against a budget that refills each period, measured from the transaction itself, not from what the agent declares." },
  { tries: "Approve a contract to spend company tokens", why: "Its role lists the contracts and functions it may call. An approve, or any other call, is refused." },
  { tries: "Raise its own budget, or rewrite its rules", why: "Only a vote of the owners changes a role, and the new rule waits out a veto window first." },
  { tries: "Sign with its own key and skip the checks", why: "The company wallet is signed by NEAR MPC, and only for what the vault approved. The vault itself has no key." },
  { tries: "Keep going once someone notices", why: "One council member can pause every agent at once. Only a vote resumes them, and a vote fires the agent." },
];

const STEPS = [
  { who: "AI employee", text: "asks to pay", color: "#4FD1E8" },
  { who: "OmniRoles", text: "checks its role on NEAR", color: "#F2B544" },
  { who: "Guard", text: "checks the invoice", color: "#F2B544" },
  { who: "NEAR MPC", text: "signs only if both pass", color: "#F2F6FC" },
];

export function SecuritySection() {
  return (
    <section id="security" style={{ maxWidth: "1392px", margin: "0 auto", padding: "72px 24px 24px" }}>
      <div style={{ background: "#FFFFFF", color: "#0F1E3D", borderRadius: "24px", padding: "48px", display: "flex", flexDirection: "column", gap: "32px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "32px", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: "14px" }}>
            <span style={{ alignSelf: "flex-start", fontFamily: mono, fontSize: "12px", letterSpacing: "0.1em", color: "#8A2E12", background: "#FBE3D6", borderRadius: "6px", padding: "5px 10px" }}>NO RUG BY DESIGN</span>
            <h2 style={{ margin: 0, fontFamily: mono, fontSize: "40px", fontWeight: 700, lineHeight: 1.12, letterSpacing: "-0.02em", color: "#0F2A5C" }}>Your AI employee cannot rug you.</h2>
            <p style={{ margin: 0, fontFamily: sans, fontSize: "18px", lineHeight: 1.6, color: "#44557A", maxWidth: "720px" }}>
              Not if it is hacked, not if it is tricked by a prompt, not if it goes rogue. Its power is a role the owners voted, and NEAR enforces that role on every transaction.
            </p>
          </div>
          <div style={{ flex: "0 1 380px", minWidth: "260px", background: "#0F2A5C", color: "#F2F6FC", borderRadius: "18px", padding: "22px 24px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontFamily: mono, fontSize: "12px", letterSpacing: "0.08em", color: "#F2B544" }}>WORST CASE, IN WRITING</span>
            <span style={{ fontFamily: sans, fontSize: "17px", lineHeight: 1.55 }}>What is left of its budget this week, paid to recipients the owners approved. Nothing more.</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))", gap: "16px" }}>
          {ATTEMPTS.map((attempt) => (
            <article key={attempt.tries} style={{ border: "1px solid #DCE5F0", borderRadius: "16px", padding: "20px 22px", display: "flex", gap: "16px", alignItems: "flex-start" }}>
              <span aria-hidden="true" style={{ flex: "0 0 34px", height: "34px", borderRadius: "999px", background: "#FBE3D6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B4321A" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontFamily: mono, fontSize: "16px", fontWeight: 700 }}>{attempt.tries}</span>
                <span style={{ fontFamily: sans, fontSize: "14px", lineHeight: 1.6, color: "#44557A" }}>{attempt.why}</span>
              </div>
            </article>
          ))}
        </div>

        <div style={{ borderTop: "1px solid #E4EAF4", paddingTop: "24px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#44557A" }}>Every payment, the same path:</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
            {STEPS.map((step, index) => (
              <div key={step.who} style={{ display: "flex", alignItems: "center", gap: "12px", background: "#0F2A5C", borderRadius: "14px", padding: "14px 16px" }}>
                <span style={{ flex: "0 0 30px", height: "30px", borderRadius: "999px", border: `2px solid ${step.color}`, color: step.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: "13px", fontWeight: 700 }}>{index + 1}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <span style={{ fontFamily: mono, fontSize: "14px", fontWeight: 700, color: step.color }}>{step.who}</span>
                  <span style={{ fontFamily: sans, fontSize: "13px", color: "#C9D6EE" }}>{step.text}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
