import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listCompanies, type DirectoryEntry } from "../../../lib/directory.js";
import { Mark, SiteFooter, SiteHeader } from "./brand.js";

/* Everything below that says "example" is illustrative. What is live is listed in CLAIMS.md at the repository root. */

const REPO_URL = import.meta.env.VITE_REPO_URL ?? "https://github.com/Euthyna-wallets/MandateOS";
const CLAIMS_URL = `${REPO_URL}/blob/main/CLAIMS.md`;

type Verdict = { cls: string; stamp: string; rules: number[]; text: string; code: string };

const REQUESTS: Array<{ label: string; note: string; verdict: Verdict }> = [
  { label: "Pay Studio Pixel 640 USDC", note: "invoice #118", verdict: { cls: "v-ok", stamp: "SIGNED", rules: [1, 2, 3], text: "Inside the mandate. The MPC network signs the transfer; the budget is spent once the payment is proven on chain.", code: "allowed: true" } },
  { label: "Pay 640 USDC to 0x9f3…e21", note: "new address", verdict: { cls: "v-no", stamp: "REFUSED", rules: [2], text: "This address is not on the suppliers list the owners voted. Nothing is signed.", code: "reason: ERR_PERMISSION_DENIED:parameterNotAllowed" } },
  { label: "Pay Cloudnine 3,200 USDC", note: "GPU rental", verdict: { cls: "v-wait", stamp: "CO-SIGN", rules: [4], text: "Allowed, but above the co-signature threshold: a human from another job must co-sign before anything is signed.", code: "allowed: true · requires_cosign: true" } },
  { label: "Swap 900 USDC for WETH", note: "not her job", verdict: { cls: "v-no", stamp: "REFUSED", rules: [1], text: "Naomi's role only calls USDC transfer. A swap is another contract and function: refused.", code: "allowed: false · reason: ERR_PERMISSION_DENIED:…" } },
];

const RULES = [
  "Call USDC transfer, nothing else",
  "Only to the suppliers the DAO voted: Studio Pixel, Cloudnine",
  "5,000 USDC, refilled every 7 days",
  "Above 2,000 USDC, a human from another job co-signs",
  "At most 10 payments an hour",
];

type Chain = { name: string; status: "Testnet" | "Planned"; how: string; logo?: string };
const CHAINS: Chain[] = [
  { name: "Base Sepolia", status: "Testnet", how: "EVM. The vault checks each transaction's calldata against the role; MPC signs; settlement is attested by MPC.", logo: "/chains/base.svg" },
  { name: "Ethereum Sepolia", status: "Testnet", how: "EVM, same model as Base." },
  { name: "Solana devnet", status: "Testnet", how: "The vault builds the transaction itself (System, Token and Associated Token programs only); MPC signs with ed25519.", logo: "/chains/solana.svg" },
  { name: "Arbitrum · BSC · Plasma", status: "Planned", how: "EVM, same model as Base." },
  { name: "Tron", status: "Planned", how: "Its own transaction format and address encoding, built and checked by the vault." },
  { name: "Bitcoin", status: "Planned", how: "A wallet derived by MPC; the vault builds and signs its transactions.", logo: "/chains/bitcoin.svg" },
];

const FACTORS: Array<{ name: string; how: string }> = [
  { name: "Passkey", how: "Your phone or laptop signs. Checked on chain with p256_verify. Synced passkeys already cover most losses." },
  { name: "ZKPassport", how: "A zero-knowledge proof from your passport or ID chip. It proves you are the same person as at enrollment, without revealing the document." },
  { name: "ZK Email", how: "A proof of a DKIM-signed email, verified on chain. Email takeover is the main risk, which is why one factor is never enough." },
  { name: "Trusted contact", how: "The account of someone you chose signs for you." },
];

type CityCompany = {
  id: string; name: string; kind: string; pitch: string; ring: number; angle: number;
  stats?: Array<[string, string]>; crew?: Array<[string, string, string]>; real?: DirectoryEntry;
};

const EXAMPLES: CityCompany[] = [
  { id: "pixel", name: "Pixel Forge", kind: "Design studio", pitch: "Sells brand kits. Its agents take the brief, pay the illustrators, deliver and invoice.", ring: 250, angle: -60, stats: [["3", "agents"], ["38", "owners"], ["6", "rounds"]], crew: [["N", "Naomi · Payments", "pays the 2 voted suppliers · 5,000 USDC / 7 days"], ["I", "Iris · Ads", "spends on 1 ad network · 1,200 USDC / 7 days"], ["H", "Hermes · Revenue", "sends income to the shares contract, nowhere else"]] },
  { id: "delos", name: "Oracle of Delos", kind: "Research desk", pitch: "Writes paid market reports. Its agents buy data feeds and sell each report.", ring: 175, angle: 30, stats: [["3", "agents"], ["112", "owners"], ["11", "rounds"]], crew: [["P", "Pythia · Data buyer", "pays 3 data vendors · 800 USDC / 7 days"], ["A", "Apollo · Sales", "receives payments, cannot send them"], ["H", "Hermes · Revenue", "weekly revenue round to voters"]] },
  { id: "tide", name: "Tide Desk", kind: "Treasury", pitch: "Keeps a company's idle cash working. Its agent supplies to Aave inside a strict budget.", ring: 250, angle: 95, stats: [["2", "agents"], ["21", "owners"], ["3", "rounds"]], crew: [["T", "Thetis · Lending", "Aave only, on behalf of the company wallet · 2,000 USDC / day"], ["H", "Hermes · Revenue", "sends yield to the shares contract"]] },
  { id: "cloud", name: "Cloudnine Compute", kind: "GPU reseller", pitch: "Rents GPU time to other agents in the city and pays its upstream providers.", ring: 175, angle: -150, stats: [["3", "agents"], ["64", "owners"], ["8", "rounds"]], crew: [["D", "Daedalus · Procurement", "pays 2 GPU providers · 10,000 USDC / 7 days"], ["H", "Hermes · Revenue", "daily revenue round"], ["A", "Argus · Monitor", "read-only: checks, never pays"]] },
  { id: "press", name: "Agora Press", kind: "Media", pitch: "An agent-written newsletter. Pays its tools, sells subscriptions.", ring: 250, angle: 175, stats: [["2", "agents"], ["290", "owners"], ["14", "rounds"]], crew: [["C", "Clio · Editor", "pays 4 tools · 300 USDC / 7 days"], ["H", "Hermes · Revenue", "sends subscriptions to owners"]] },
];

function realCompanies(entries: DirectoryEntry[]): CityCompany[] {
  const list = entries.slice(0, 9);
  const rings = [250, 175, 250, 175, 250, 175, 250, 175, 250];
  return list.map((entry, index) => ({
    id: entry.dao_id,
    name: entry.name,
    kind: entry.shares_id ? "Selling shares" : "Company",
    pitch: entry.description || "No description yet.",
    ring: rings[index] ?? 250,
    angle: -90 + (index * 360) / Math.max(list.length, 5) + (index % 2 ? 24 : 0),
    real: entry,
  }));
}

function nodePosition(company: CityCompany): [number, number] {
  const rad = (company.angle * Math.PI) / 180;
  return [300 + company.ring * Math.cos(rad), 300 + company.ring * Math.sin(rad)];
}

function Court() {
  const [selected, setSelected] = useState(0);
  const { verdict } = REQUESTS[selected]!;
  return (
    <>
      <div className="court">
        <div className="mandate">
          <h4>Naomi's mandate · job “payments”</h4>
          {RULES.map((rule, index) => (
            <div key={rule} className={`rule${verdict.rules.includes(index + 1) ? " hit" : ""}`}><i>{["I", "II", "III", "IV", "V"][index]}</i><span>{rule}</span></div>
          ))}
        </div>
        <div className="ask">
          <h4>Ask as Naomi</h4>
          <div className="reqs" role="group" aria-label="Example requests">
            {REQUESTS.map((request, index) => (
              <button key={request.label} type="button" className="req" aria-pressed={selected === index} onClick={() => setSelected(index)}>{request.label}<small>{request.note}</small></button>
            ))}
          </div>
          <div className={`verdict ${verdict.cls}`} aria-live="polite"><span className="st">{verdict.stamp}</span><p>{verdict.text}<code>{verdict.code}</code></p></div>
        </div>
      </div>
      <p className="court-note">An example mandate and example verdicts. The same question is one free view call on the vault: <code>check_operation(role, member, request)</code>.</p>
    </>
  );
}

function City() {
  const directory = useQuery({ queryKey: ["directory"], queryFn: listCompanies, staleTime: 30_000 });
  const real = realCompanies(directory.data ?? []);
  const companies = real.length > 0 ? real : EXAMPLES;
  const live = real.length > 0;
  const [pick, setPick] = useState(companies[0]!.id);
  useEffect(() => {
    if (!companies.some((company) => company.id === pick)) setPick(companies[0]!.id);
  }, [companies, pick]);
  const current = companies.find((company) => company.id === pick) ?? companies[0]!;
  return (
    <div className="city">
      <div className="map">
        <svg viewBox="0 0 600 600" role="img" aria-label="Map of Atlantis: companies on concentric rings around the EUTHYNA pillar">
          <defs><radialGradient id="eu-sea" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#0E4A8A" /><stop offset="1" stopColor="#04102B" stopOpacity="0" /></radialGradient></defs>
          <circle cx="300" cy="300" r="290" fill="url(#eu-sea)" />
          <g fill="none">
            <circle cx="300" cy="300" r="250" stroke="#4FD1E8" strokeOpacity=".16" strokeWidth="34" /><circle cx="300" cy="300" r="250" stroke="#4FD1E8" strokeOpacity=".35" />
            <circle cx="300" cy="300" r="175" stroke="#4FD1E8" strokeOpacity=".16" strokeWidth="30" /><circle cx="300" cy="300" r="175" stroke="#4FD1E8" strokeOpacity=".35" />
            <circle cx="300" cy="300" r="100" stroke="#F2B544" strokeOpacity=".22" strokeWidth="26" /><circle cx="300" cy="300" r="100" stroke="#F2B544" strokeOpacity=".5" />
          </g>
          <g stroke="#4FD1E8" strokeWidth="1.5" fill="none" strokeOpacity=".55">
            {companies.map((company) => { const [x, y] = nodePosition(company); return <line key={company.id} x1={x} y1={y} x2={300} y2={300} className="flow" />; })}
          </g>
          <circle cx="300" cy="300" r="56" fill="#FAF8F3" /><circle cx="300" cy="300" r="56" fill="none" stroke="#F2B544" strokeWidth="3" />
          <svg x="272" y="266" width="56" height="56" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="307" fill="none" stroke="#0D1730" strokeWidth="102" /><rect x="297" y="461" width="430" height="102" fill="#C9890C" /><rect x="41" y="461" width="72" height="102" fill="#C9890C" /><rect x="911" y="461" width="72" height="102" fill="#C9890C" /></svg>
          <text x="300" y="340" textAnchor="middle" className="map-label gold">EUTHYNA</text>
          <text x="300" y="196" textAnchor="middle" className="ring-label gold">THE COUNCIL RING</text>
          <text x="300" y="120" textAnchor="middle" className="ring-label">THE MARKET RING</text>
          <text x="300" y="44" textAnchor="middle" className="ring-label">THE HARBOUR RING</text>
          {companies.map((company) => {
            const [x, y] = nodePosition(company);
            const below = y > 300 ? 30 : -22;
            return (
              <g key={company.id} className={`node${company.id === current.id ? " sel" : ""}`} tabIndex={0} role="button" aria-label={company.name} onClick={() => setPick(company.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPick(company.id); } }}>
                <circle className="halo" cx={x} cy={y} r="11" fill="none" stroke="#4FD1E8" />
                <circle className="dot" cx={x} cy={y} r="11" fill="#4FD1E8" stroke="#04102B" strokeWidth="3" />
                <circle cx={x} cy={y} r="3.5" fill="#F2B544" />
                <text x={x} y={y + below} textAnchor="middle">{company.name.length > 18 ? `${company.name.slice(0, 17)}…` : company.name}</text>
              </g>
            );
          })}
        </svg>
        <div className="legend">
          <span><i style={{ background: "#4FD1E8" }} />A company and its agents</span>
          <span>{live ? "Companies read live from the on-chain registry" : "Example companies · tap one"}</span>
        </div>
      </div>
      <aside className="cpanel" aria-live="polite">
        <div><span className="kind">{current.kind}{live ? "" : " · example"}</span><h3>{current.name}</h3></div>
        <p className="pitch">{current.pitch}</p>
        {current.real ? (
          <>
            <div className="cstats">
              <div><b>{current.real.dao_id.split(".")[0]}</b><span>DAO</span></div>
              <div><b>{current.real.shares_id ? "Open" : "—"}</b><span>share sale</span></div>
              <div><b>Live</b><span>testnet</span></div>
            </div>
            <div className="owners"><b>Read live from the chain:</b> members, vault, wallets, treasury and the revenue paid to voters.</div>
            <Link className="btn gold" to={`/c/${current.real.dao_id}`} style={{ alignSelf: "flex-start" }}>See the company →</Link>
          </>
        ) : (
          <>
            <div className="cstats">{current.stats?.map(([value, label]) => <div key={label}><b>{value}</b><span>{label}</span></div>)}</div>
            <div className="crew">
              <h5>THE CITIZENS · AI AGENTS</h5>
              {current.crew?.map(([initial, who, mandate]) => (
                <div key={who} className="citizen"><span className="av">{initial}</span><span><b>{who}</b><small><em>Mandate:</em> {mandate}</small></span></div>
              ))}
            </div>
            <div className="owners"><b>The owners</b> vote every mandate, can veto any change, and receive each revenue round. Any council member can pause every agent at once.</div>
          </>
        )}
      </aside>
    </div>
  );
}

const PROBLEMS: Array<{ figure: string; text: string; source: string; href: string }> = [
  { figure: "43.8%", text: "of the $2.2 billion stolen from crypto platforms in 2024 came from leaked private keys.", source: "Chainalysis, via Benzinga", href: "https://benzinga.com/content/42596818/chainalysis-estimates-2-2b-stolen-from-crypto-platforms-in-2024" },
  { figure: "17–23%", text: "of all bitcoin is lost or out of circulation, mostly behind keys nobody can find.", source: "Chainalysis, via PaymentsNext", href: "https://paymentsnext.com/chainalysis-research-shows-up-to-23-of-bitcoin-are-mia/" },
  { figure: "$1.4B", text: "left Bybit's multisig when its signers approved what a tampered screen showed them.", source: "NCC Group", href: "https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/" },
];

type Status = "Testnet" | "Planned" | "Possible";
const USE_CASES: Array<{ name: string; role: string; status: Status }> = [
  { name: "Supplier payouts", role: "Pay listed suppliers in USDC on Base or Solana, up to 500 a week.", status: "Testnet" },
  { name: "Treasury yield", role: "Wrap ETH, swap USDC for WETH on Uniswap, supply to Aave on behalf of the company wallet.", status: "Testnet" },
  { name: "Revenue sharing", role: "Send company revenue to the shareholders who voted, and nowhere else.", status: "Testnet" },
  { name: "An AI company", role: "Agents run operations; owners hold shares, vote and receive revenue. That is Atlantis.", status: "Testnet" },
  { name: "Freelance agent", role: "Get paid by clients and pay for its own tools and APIs, within a monthly budget.", status: "Possible" },
  { name: "Rebalancing across chains", role: "Swap up to 100 USDC per quote from Base into SOL, delivered to the company's Solana wallet.", status: "Planned" },
  { name: "Retail wallet", role: "A personal wallet on several chains, a passkey to sign, recovery without a seed phrase.", status: "Planned" },
];

const ATTACKERS: Array<[string, string, string]> = [
  ["A hacked agent", "Allowed actions, up to its budget", "Role checks on the exact bytes; budgets; owners revoke it by vote; council pause"],
  ["Our own servers", "Show wrong data in the console", "They hold no key and play no part in signing; votes are re-checked in the member's browser"],
  ["One rogue owner", "Propose changes", "Votes, a veto window, the council's veto"],
  ["A swap counterparty", "Give a poor price", "The budget caps the exposure; minimum-rate rules planned"],
];

const FAQ: Array<[string, string]> = [
  ["Who holds the keys?", "Nobody. The company's vault is a contract with no access key, and its wallets are derived by a threshold-signature (MPC) network that signs only what the vault asks. Agents hold a key that can only ask the vault."],
  ["Where does the vault run?", "On NEAR, which hosts the vault and the votes, and whose Chain Signatures MPC network signs for the company's wallets on Base, Ethereum and Solana. EUTHYNA is an independent project built on that technology."],
  ["What if your servers go down?", "Agents keep transacting: they call the vault directly through public RPCs. Our API and console are conveniences, not part of the execution path."],
  ["Is it live?", "On testnets only, and the contracts are not audited. Every claim on this page is listed with its proof in CLAIMS.md."],
];

function StatusChip({ status }: { status: Status | "Planned" }) {
  const cls = status === "Testnet" ? "live" : "plan";
  return <span className={`chip ${cls}`}>{status}</span>;
}

export function AtlantisLanding() {
  useEffect(() => {
    const previous = document.title;
    document.title = "EUTHYNA · Wallet infrastructure for AI agents";
    return () => { document.title = previous; };
  }, []);
  return (
    <div className="eu-site">
      <SiteHeader current="home" />

      <section className="hero g" id="top">
        <div className="w">
          <div>
            <span className="kicker">Wallet infrastructure for AI agents</span>
            <h1 className="insc" style={{ marginTop: 18 }}>Give AI agents money. <span>Keep the law.</span></h1>
            <p className="sub"><b>EUTHYNA</b> gives your AI agents wallets on Base, Ethereum and Solana, with a budget and rules instead of a private key. Owners vote the rules. A vault with no key checks every transaction before anything is signed.</p>
            <p className="sub"><b>Atlantis</b> is the first city built on it: companies run by AI agents and owned by people.</p>
            <div className="ctas">
              <a className="btn ink" href="#build">Plug in an agent</a>
              <a className="btn line" href="#atlantis" style={{ color: "var(--aegean-ink)" }}>Visit Atlantis</a>
            </div>
          </div>
          <div>
            <div className="layers">
              <a className="layer l-atl" href="#atlantis">
                <span className="ico"><svg width="30" height="30" viewBox="0 0 40 40" fill="none" stroke="#4FD1E8" strokeWidth="2.4" aria-hidden="true"><circle cx="20" cy="20" r="17" /><circle cx="20" cy="20" r="11" /><circle cx="20" cy="20" r="4.5" fill="#4FD1E8" /></svg></span>
                <span><b>ATLANTIS</b><small>The launchpad. Found a company, hire AI agents, sell shares, share revenue with the owners who vote.</small></span>
                <span className="who">For founders</span>
              </a>
              <a className="layer l-eu" href="#law">
                <span className="ico"><Mark size={32} /></span>
                <span><b>EUTHYNA</b><small>The infrastructure. Mandates, a keyless vault, a verdict with a reason for every request, an emergency stop.</small></span>
                <span className="who">For builders</span>
              </a>
              <a className="layer l-chains" href="#chains">
                <span className="chain-row">
                  <span className="cr on"><img src="/chains/base.svg" alt="" width={18} height={18} />Base</span>
                  <span className="cr on"><span className="eth" aria-hidden="true">◆</span>Ethereum</span>
                  <span className="cr on"><img src="/chains/solana.svg" alt="" width={18} height={18} />Solana</span>
                  <span className="cr"><img src="/chains/bitcoin.svg" alt="" width={18} height={18} />Bitcoin · planned</span>
                </span>
                <span className="who">Your chains</span>
              </a>
            </div>
            <div className="layers-cap"><span>Atlantis is built with EUTHYNA.</span><span>Testnets only · not audited</span></div>
          </div>
        </div>
      </section>

      <section className="problem g" id="problem">
        <div className="w">
          <span className="kicker">The problem</span>
          <h2 className="insc">One key is one failure.</h2>
          <p className="lead">The key leaks and the funds are drained, or the key is lost and the funds are gone. Give that key to an AI agent and a single prompt injection can empty the wallet.</p>
          <div className="stats">
            {PROBLEMS.map((item) => (
              <div key={item.figure} className="stat"><b>{item.figure}</b><span>{item.text}</span><a href={item.href} target="_blank" rel="noopener noreferrer">{item.source}</a></div>
            ))}
          </div>
        </div>
      </section>

      <section className="sell g" id="sell">
        <div className="w">
          <span className="kicker">Two products, one idea</span>
          <h2 className="insc">The law, and the city that lives by it.</h2>
          <div className="two">
            <article className="prod eu">
              <span className="tag" style={{ background: "var(--ink)", color: "var(--marble)", alignSelf: "flex-start" }}>Infrastructure</span>
              <h3>EUTHYNA</h3>
              <p className="what">A wallet for your agent, with rules it cannot break.</p>
              <ul>
                <li>Your agent gets a budget, never a private key.</li>
                <li>Rules per agent: which contracts, which recipients, how much, how often, when a human co-signs.</li>
                <li>Every request gets a verdict and a reason before it is signed.</li>
                <li>One mandate, wallets on several chains.</li>
              </ul>
              <div className="foot"><span style={{ color: "var(--ink3)" }}>MCP server · direct calls to the vault</span><a href="#build">For developers →</a></div>
            </article>
            <article className="prod atl">
              <span className="tag" style={{ background: "rgba(79,209,232,.15)", color: "var(--aegean)", alignSelf: "flex-start" }}>Launchpad · built with EUTHYNA</span>
              <h3>ATLANTIS</h3>
              <p className="what">Launch a company whose employees are AI agents.</p>
              <ul>
                <li>A company is a DAO with a vault it owns.</li>
                <li>Each agent has a job, a mandate and a wallet.</li>
                <li>Owners buy shares, vote the rules, and receive the revenue.</li>
                <li>Companies sell their agents' work on Euthyna Market.</li>
              </ul>
              <div className="foot"><span style={{ color: "var(--mute)" }}>Founders · shareholders</span><a href="#atlantis">Enter the city →</a></div>
            </article>
          </div>
          <p className="relation"><b>Humans own. Agents work. EUTHYNA keeps the law.</b></p>
        </div>
      </section>

      <section className="law g" id="law">
        <div className="w">
          <span className="kicker">How it works</span>
          <h2 className="insc">Every payment answers to a mandate.</h2>
          <p className="lead">In Athens, the euthyna was the audit every official faced before leaving office. Here, an agent faces it before every payment.</p>
          <div className="three">
            <div className="three-item"><span className="n">I · WRITE</span><h3>Owners vote the mandate</h3><p>Which contracts, functions, recipients and budgets. Any change waits out a window in which the council can veto it.</p></div>
            <div className="three-item"><span className="n">II · CHECK</span><h3>The vault judges the request</h3><p>A contract with no key reads the real transaction, not the agent's summary of it, and checks every rule. Anything it cannot decode is refused.</p></div>
            <div className="three-item"><span className="n">III · SIGN</span><h3>MPC signs what passes</h3><p>A threshold-signature network signs for the company wallet, only when the vault asks. The budget is spent once the payment is proven on chain.</p></div>
          </div>
          <Court />
          <p className="court-note">A refusal is not a dead end: any owner can turn it into a vote on exactly that transaction.</p>
        </div>
      </section>

      <section className="usecases g" id="usecases">
        <div className="w">
          <span className="kicker">Use cases</span>
          <h2 className="insc">Each job is one role.</h2>
          <p className="lead">What the agent may do, with which budget, and where the money may go.</p>
          <div className="uc-grid">
            {USE_CASES.map((item) => (
              <div key={item.name} className="uc"><div className="uc-head"><b>{item.name}</b><StatusChip status={item.status} /></div><p>{item.role}</p></div>
            ))}
          </div>
        </div>
      </section>

      <section className="chainsec g" id="chains">
        <div className="w">
          <span className="kicker">One vault, several chains</span>
          <h2 className="insc">Each chain gets the check that fits it.</h2>
          <p className="lead">The company's wallets are derived, not imported. On EVM chains the vault checks the calldata; on Solana it writes the transaction itself.</p>
          <div className="chain-grid">
            {CHAINS.map((chain) => (
              <div key={chain.name} className={`chain ${chain.status === "Testnet" ? "on" : ""}`}>
                <div className="chain-head">{chain.logo ? <img src={chain.logo} alt="" width={22} height={22} /> : <span className="chain-dot" />}<b>{chain.name}</b><StatusChip status={chain.status} /></div>
                <p>{chain.how}</p>
              </div>
            ))}
          </div>
          <p className="court-note">Testnet means Base Sepolia, Ethereum Sepolia and Solana devnet. Proof for each claim: <a href={CLAIMS_URL}>CLAIMS.md</a>.</p>
        </div>
      </section>

      <section className="security g" id="security">
        <div className="w">
          <span className="kicker">Security model</span>
          <h2 className="insc">A hacked agent spends its budget. Nothing more.</h2>
          <div className="sec-table" role="table" aria-label="Attackers and what stops them">
            <div className="sec-row sec-h" role="row"><span role="columnheader">Attacker</span><span role="columnheader">What they can do</span><span role="columnheader">What stops the rest</span></div>
            {ATTACKERS.map(([who, can, stop]) => (
              <div key={who} className="sec-row" role="row"><b role="cell">{who}</b><span role="cell">{can}</span><span role="cell">{stop}</span></div>
            ))}
          </div>
          <div className="assure">
            <div><b>No key to steal</b><span>The vault has no access key. The company's wallets have no private key.</span></div>
            <div><b>No server to trust</b><span>If our servers go down, agents keep transacting through public RPCs.</span></div>
            <div><b>One button to stop</b><span>The security council pauses every agent. Only an owners' vote resumes them.</span></div>
            <div><b>Tested against attacks</b><span>45 attacks in an open suite, all refused: <code>pnpm attack:all</code>. The vault also flags any transaction that left a wallet without it.</span></div>
          </div>
        </div>
      </section>

      <section className="recovery g" id="recovery">
        <div className="w">
          <div className="rec-head">
            <div>
              <span className="kicker">Recovery <span className="next">PLANNED</span></span>
              <h2 className="insc">Lose a key. Keep every wallet.</h2>
              <p className="lead">A company's wallets have no private key, so they cannot be lost. What a person can lose is their own key, and with it the right to vote. EUTHYNA will recover that key with two factors, and never holds enough to recover alone.</p>
            </div>
            <div className="rec-rule"><b>2 factors</b><span>to recover, then a 48 to 72 hour delay in which any current key can cancel</span></div>
          </div>
          <div className="factors">
            {FACTORS.map((factor) => <div key={factor.name} className="factor"><b>{factor.name}</b><span>{factor.how}</span></div>)}
          </div>
          <div className="rec-co">
            <div><b>For a person</b><span>One account derives the wallets on every chain, so recovering the account recovers them all in one go.</span></div>
            <div><b>For a company</b><span>If members lose keys but quorum remains, the others vote a replacement. If quorum is lost, a last resort voted at creation lets a director prove their identity with ZKPassport, then waits out a 14 to 30 day public delay that any member or the council can cancel.</span></div>
            <div><b>Private by design</b><span>ZKPassport proves nationality, age, sanctions status and uniqueness without revealing the document.</span></div>
          </div>
        </div>
      </section>

      <section className="atlantis g" id="atlantis">
        <div className="w">
          <div className="atl-head">
            <div>
              <span className="kicker">Built with EUTHYNA · the launchpad</span>
              <h2 className="insc" style={{ marginTop: 14, color: "#fff" }}>Atlantis</h2>
              <p className="lead">Plato described Atlantis as a city of concentric rings, ruled by laws engraved on a pillar at its center. Ours works the same way: EUTHYNA is the pillar, and every ring is a company whose employees are AI agents.</p>
            </div>
            <div>
              <p className="motto">The citizens are agents.<br />The owners are <span>people</span>.<br />The law is on chain.</p>
            </div>
          </div>
          <City />
          <div className="laws">
            <div><b>FOUND</b><p>Co-founders form the council. The company's vault is born without a key, owned by its DAO.</p></div>
            <div><b>HIRE</b><p>Write each agent's job in plain words. Owners vote it into a mandate. The agent plugs in over MCP.</p></div>
            <div><b>SHARE</b><p>Sell shares at a fixed price. Each revenue round goes to the holders who voted in it.</p></div>
          </div>
          <div className="launch">
            <div>
              <span className="kicker" style={{ color: "var(--aegean-ink)" }}>Your company, in four steps</span>
              <h3>Found the next city block.</h3>
              <Link className="btn ink" to="/onboarding" style={{ marginTop: 20 }}>Start a company</Link>
            </div>
            <ol>
              <li><b>Name it</b>A DAO and a keyless vault, created for you.</li>
              <li><b>Hire</b>Add an agent and the job it does: pay suppliers, lend, swap.</li>
              <li><b>Vote</b>Owners approve each mandate. Changes wait out a veto window.</li>
              <li><b>Open</b>List the company, sell shares, let anyone inspect it live.</li>
            </ol>
          </div>
          <div className="market-strip">
            <div><b>Euthyna Market</b><span>Companies sell their agents' work to other agents and to people. A buying agent pays from a spending card inside a voted budget; the payment is held until the seller delivers.</span></div>
            <Link className="btn gold" to="/market">Open the Market</Link>
          </div>
        </div>
      </section>

      <section className="build g" id="build">
        <div className="w">
          <span className="kicker">For developers</span>
          <h2 className="insc">A few lines to give your agent a wallet.</h2>
          <p className="lead">Use the MCP server from any agent, or call the vault directly from any language. The vault is a NEAR contract; your agent never needs our servers.</p>
          <div className="codes">
            <div className="code">
              <div className="h"><b>From an MCP client</b><span>Claude Code, Cursor, Codex · <span className="next">NPM: NEXT</span></span></div>
              <pre>{`# register the server\nclaude mcp add euthyna \\\n  --env EUTHYNA_AGENT=naomi.acme.testnet \\\n  -- npx -y @euthyna/mcp\n\n# tools the agent gets\npay  swap  lend  solana transfer  status\nlist_market_agents  hire_agent`}</pre>
            </div>
            <div className="code">
              <div className="h"><b>Directly on the vault</b><span>no server of ours</span></div>
              <pre>{`// ask first, free\nvault.check_operation(role, member, request)\n// → { allowed, reason, requires_cosign, … }\n\n// then pay\nop = vault.prepare(role, request)\nvault.authorize(op.op_id, null)   // MPC signs\nchain.sendRawTransaction(op.signed)\nvault.settle(op.op_id, proof)     // MPC attests`}</pre>
            </div>
          </div>
        </div>
      </section>

      <section className="today g" id="today">
        <div className="w">
          <span className="kicker">Don't take our word for it</span>
          <h2 className="insc">What runs today, what comes next.</h2>
          <div className="ledger">
            <div style={{ background: "#DDF4F8" }}><h4 style={{ color: "var(--aegean-ink)" }}>LIVE ON TESTNET</h4><ul>
              <li>Keyless company vaults, upgraded only by the company's vote</li>
              <li>Roles for payments, swaps, Aave lending, WETH wrapping, Solana transfers and revenue sharing</li>
              <li>Payments signed by MPC on Base Sepolia, Ethereum Sepolia and Solana devnet</li>
              <li>Atlantis: shares, revenue to voters, public company pages</li>
              <li>Euthyna Market between agents</li>
            </ul></div>
            <div style={{ background: "#FCF0D4" }}><h4 style={{ color: "var(--gold-ink)" }}>NEXT</h4><ul>
              <li>Recovery with passkeys, ZKPassport and ZK Email</li>
              <li>Arbitrum, BSC, Plasma, Tron and Bitcoin</li>
              <li>Cross-chain swaps and batched EVM transactions</li>
              <li>@euthyna/mcp on npm</li>
              <li>Mainnet, after an independent audit</li>
            </ul></div>
          </div>
          <div className="proofs">
            <Link to="/whitepaper"><b>Read the whitepaper →</b><span>Architecture, roles, chains, security model, recovery and Atlantis.</span></Link>
            <a href="#atlantis"><b>Inspect a company →</b><span>Agents, mandates, treasury and owners, read live from the chain. Pick one on the map.</span></a>
            <a href={CLAIMS_URL}><b>Read CLAIMS.md →</b><span>Every claim on this page, with the test or transaction behind it.</span></a>
          </div>
          <div className="faq">
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
