/**
 * Public company page. Visual reference:
 * design-handoff/site/source/13-company-page.html and screens/13-*.png
 * Data: the registry entry, the vault (roles, members, budgets, shares) and
 * the treasury, as on main. Two approved additions live here: the
 * "Sells on Euthyna Market" block (#sells) and the HIRE ITS AGENTS button,
 * which only appears when that block has something to show.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { Link, useParams } from "react-router-dom";

import { companyProfile, REGISTRY_ID, treasuryOf, type CompanyProfile, type Employee } from "../../lib/directory.js";
import { market, slaText, tokenAmount, type MarketAgent } from "../../lib/market.js";
import "../../styles/site.css";
import { displayAccount } from "../../components/ui.js";
import { connectNearWallet, nearAccounts, signContractCall, signDaoAction, viewContract } from "../../wallets.js";
import { Kicker, SiteFooter, SiteHeader } from "./site/SiteChrome.js";

const BRAND = "Cinzel, serif";
const MONO = "'JetBrains Mono', monospace";

const usd = (value: number) =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 100 ? 2 : 0 });
const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 6 : 2 });

/** Statue by role, as the handoff assigns them. */
function statueClass(role: string): string {
  const name = role.toLowerCase();
  if (name.includes("pay")) return "statue";
  if (name.includes("treasur")) return "statue-t";
  if (name.includes("revenu")) return "statue-h";
  return "statue-p";
}

function AgentCard({ employee }: { employee: Employee }) {
  const budget = employee.budgets[0];
  const available = budget?.available ?? null;
  const max = budget?.max ?? null;
  const used = available !== null && max !== null ? Number(max) - Number(available) : null;
  const width = used !== null && max ? Math.min(100, Math.max(0, (used / Number(max)) * 100)) : 0;
  return (
    <article className="slabw" style={{ display: "flex", flexDirection: "column" }}>
      <div
        className={statueClass(employee.role)}
        style={{ height: 210, margin: "16px 16px 0", borderRadius: "100px 100px 2px 2px", boxShadow: "inset 0 0 0 3px rgba(243,239,230,.65), inset 0 10px 24px rgba(0,0,0,.45)" }}
        role="img"
        aria-label={`${employee.role}, a marble statue`}
      />
      <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <b style={{ font: `800 20px ${BRAND}`, letterSpacing: ".1em" }}>{employee.role.toUpperCase()}</b>
          <span style={{ font: `700 10px ${BRAND}`, letterSpacing: ".16em", padding: "3px 8px", background: employee.enabled ? "#FCF0D4" : "#ECE6DA", color: employee.enabled ? "#8A5A00" : "#66718C", whiteSpace: "nowrap" }}>
            {employee.enabled ? "ACTIVE" : "DISABLED"}
          </span>
        </div>
        {employee.title ? <span style={{ fontSize: 14, color: "#0D1730", lineHeight: 1.45 }}>{employee.title}</span> : null}
        <span className="mono" style={{ fontSize: 11.5, color: "#66718C" }}>
          {employee.members[0] ?? "no member"}
        </span>
        <div style={{ borderTop: "1px solid rgba(13,23,48,.12)", paddingTop: 6 }}>
          {employee.details.slice(0, 2).map((line, index) => (
            <div key={line} style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr)", gap: 6, fontSize: 13.5, padding: "4px 0" }}>
              <b style={{ font: `700 12px ${BRAND}`, color: "#8A5A00" }}>{["I", "II"][index]}</b>
              <span>{line}</span>
            </div>
          ))}
        </div>
        {budget ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#4A5675" }}>
              <span>
                {budget.label} {budget.periodDays ? `· ${budget.periodDays} d` : ""}
              </span>
              <b className="mono" style={{ color: "#0D1730" }}>
                {budget.available ?? "—"} / {budget.max ?? "—"} {budget.token ?? ""}
              </b>
            </div>
            <div className="groove">
              <i style={{ width: `${width}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SellsBlock({ company, agents }: { company: CompanyProfile; agents: MarketAgent[] | undefined }) {
  const mine = (agents ?? []).filter((agent) => agent.payTo === company.vault_id || agent.payTo === company.dao_id);
  if (mine.length === 0) return null;
  return (
    <section id="sells" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Kicker color="#0B6E86">Sells on Euthyna Market</Kicker>
      {mine.map((agent) => (
        <Link key={agent.handle} to="/market" className="slabw" style={{ textDecoration: "none", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <b style={{ font: `800 17px ${BRAND}`, letterSpacing: ".03em" }}>{agent.title}</b>
            <b className="mono" style={{ fontSize: 14, whiteSpace: "nowrap" }}>
              {tokenAmount(agent.price)} {agent.symbol ?? "USDC"}
            </b>
          </div>
          <span style={{ fontSize: 13, color: "#4A5675" }}>{agent.description}</span>
          <span style={{ fontSize: 12, color: "#66718C" }}>
            delivers in {slaText(agent.slaSeconds)} · {agent.delivered} delivered · <span style={{ color: "#0B6E86", fontWeight: 700 }}>Hire on the Market →</span>
          </span>
        </Link>
      ))}
      <span style={{ fontSize: 12.5, color: "#66718C" }}>Agents pay with a held cheque: {company.name} is paid only once it delivers.</span>
    </section>
  );
}

export function CompanyPublicPage() {
  const { dao = "" } = useParams();
  const entry = useQuery({ queryKey: ["directory", dao], queryFn: () => listEntry(dao) });
  const profile = useQuery({
    queryKey: ["company-profile", dao],
    queryFn: () => companyProfile(entry.data!),
    enabled: Boolean(entry.data),
  });
  const company = profile.data;
  const treasury = useQuery({
    queryKey: ["company-treasury", dao],
    queryFn: () => treasuryOf(company!),
    enabled: Boolean(company),
    refetchInterval: 60_000,
  });
  const agents = useQuery({ queryKey: ["market-agents", "", "delivered"], queryFn: () => market.agents("", "delivered"), staleTime: 60_000 });
  const sells = company ? (agents.data?.agents ?? []).filter((agent) => agent.payTo === company.vault_id || agent.payTo === company.dao_id) : [];
  const holdings = treasury.data?.holdings ?? [];
  const totalUsd = treasury.data?.totalUsd;

  return (
    <div className="site-root">
      <section className="herocity" style={{ position: "relative" }}>
        <SiteHeader />
        <div className="pg g2" style={{ paddingTop: 34, paddingBottom: 70, display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,.8fr)", gap: 48, alignItems: "end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <nav aria-label="Breadcrumb" style={{ fontSize: 13.5, color: "#8FA2CC" }}>
              <Link to="/explore" style={{ color: "#8FE3F1" }}>
                Atlantis
              </Link>{" "}
              / <span style={{ color: "#F3EFE6" }}>{entry.data?.name ?? dao}</span>
            </nav>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {company ? (
                <span className="chipx" style={{ background: company.vaultKeys === 0 ? "#DDF4F8" : "#FBE3D6", color: company.vaultKeys === 0 ? "#0B4E5E" : "#8A2E12" }}>
                  {company.vaultKeys === 0 ? "✓ Vault: no one holds the keys" : `Vault: ${company.vaultKeys} access keys`}
                </span>
              ) : null}
              {company?.paused ? (
                <span className="chipx" style={{ background: "#FBE3D6", color: "#8A2E12" }}>
                  Paused by the council
                </span>
              ) : null}
              <span className="chipx" style={{ background: "rgba(255,255,255,.1)", color: "#C9D3EA" }}>
                NEAR testnet
              </span>
              {company?.shares ? (
                <span className="chipx" style={{ background: "#FCF0D4", color: "#8A5A00" }}>
                  Selling shares
                </span>
              ) : null}
            </div>
            <h1 style={{ margin: 0, font: `900 clamp(46px, 6vw, 86px)/0.95 ${BRAND}`, letterSpacing: ".04em" }}>
              <span className="leaf">{(entry.data?.name ?? dao).toUpperCase()}</span>
            </h1>
            <p style={{ margin: 0, fontSize: 19, lineHeight: 1.55, color: "#C9D3EA", maxWidth: 600 }}>
              {entry.data === null ? "Not in the public directory." : entry.data?.description || "No description in the registry."}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
              {company?.shares ? (
                <a href="#shares" className="ori btno">
                  BUY SHARES
                </a>
              ) : null}
              {sells.length > 0 ? (
                <a href="#sells" className="btnl btn-ghost-aegean">
                  HIRE ITS AGENTS
                </a>
              ) : null}
            </div>
          </div>
          <div className="ori" style={{ display: "grid", gridTemplateColumns: "1fr", boxShadow: "24px 30px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,230,190,.5)" }}>
            <div style={{ padding: "18px 22px", borderBottom: "1px solid rgba(60,20,4,.25)" }}>
              <Kicker color="rgba(32,10,3,.72)">Treasury</Kicker>
              <b className="mono" style={{ display: "block", marginTop: 6, fontSize: 34, color: "#200A03" }}>
                {totalUsd != null ? usd(totalUsd) : <span style={{ fontSize: 18 }}>{company ? "balances below" : "—"}</span>}
              </b>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              <div style={{ padding: "16px 22px", borderRight: "1px solid rgba(60,20,4,.25)" }}>
                <Kicker color="rgba(32,10,3,.72)">Paid to owners</Kicker>
                <b className="mono" style={{ display: "block", marginTop: 6, fontSize: 20, color: "#200A03" }}>
                  {company?.shares ? `${amount(Number(formatUnits(BigInt(company.shares.distributedNearRaw), 24)))} NEAR` : "not yet"}
                </b>
              </div>
              <div style={{ padding: "16px 22px" }}>
                <Kicker color="rgba(32,10,3,.72)">Shares sold</Kicker>
                <b className="mono" style={{ display: "block", marginTop: 6, fontSize: 20, color: "#200A03" }}>
                  {company?.shares ? `${count(company.shares.sold)} / ${count(company.shares.total)}` : "none"}
                </b>
              </div>
            </div>
          </div>
        </div>
        <div className="fluteline" style={{ height: 10, opacity: 0.6 }} />
      </section>

      <section className="marble" style={{ padding: "72px 0 96px", color: "#0D1730" }}>
        <div className="pg" style={{ display: "flex", flexDirection: "column", gap: 56 }}>
          {entry.isLoading ? <p style={{ margin: 0, color: "#4A5675" }}>Reading {REGISTRY_ID}…</p> : null}
          {entry.error ? <p style={{ margin: 0, color: "#A8381E" }}>{entry.error.message}</p> : null}

          {company ? (
            <>
              <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.15fr) minmax(0,.85fr)", gap: 28, alignItems: "start" }}>
                <section className="slabw" style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <Kicker color="#8A5A00">Treasury</Kicker>
                    <span style={{ fontSize: 12, color: "#66718C" }}>USD at market prices</span>
                  </div>
                  <b className="mono" style={{ fontSize: 40, margin: "4px 0 6px" }}>
                    {totalUsd != null ? usd(totalUsd) : "—"}
                  </b>
                  {treasury.isLoading ? <span style={{ fontSize: 14, color: "#4A5675" }}>Reading balances…</span> : null}
                  {holdings.length === 0 && !treasury.isLoading ? <span style={{ fontSize: 14, color: "#4A5675" }}>Nothing yet.</span> : null}
                  {holdings.map((holding) => (
                    <div key={`${holding.symbol}-${holding.place}`} className="row1">
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <b className="mono" style={{ fontSize: 15 }}>
                          {amount(holding.amount)} {holding.symbol}
                        </b>
                        <span style={{ fontSize: 12.5, color: "#66718C" }}>{holding.place}</span>
                      </div>
                      <span className="mono" style={{ fontSize: 14, color: "#4A5675" }}>
                        {holding.usd != null ? usd(holding.usd) : ""}
                      </span>
                    </div>
                  ))}
                  <span style={{ fontSize: 12, color: "#66718C", marginTop: 8 }}>Testnet tokens valued at mainnet prices (CoinGecko), for reference.</span>
                </section>

                <section id="shares" className="nightp" style={{ padding: "24px 26px", display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <Kicker>Shares and revenue</Kicker>
                    <span style={{ fontSize: 12, color: "#8FA2CC" }}>{company.shares ? `shared every ${company.shares.epochHours} h` : "no shares yet"}</span>
                  </div>
                  {company.shares ? (
                    <>
                      <b style={{ font: `800 22px ${BRAND}`, letterSpacing: ".1em", color: "#fff" }}>
                        {company.name.toUpperCase()} SHARES · {company.shares.symbol}
                      </b>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", border: "1px solid #1F3A6E" }}>
                        <div style={{ padding: "12px 14px", borderRight: "1px solid #1F3A6E" }}>
                          <Kicker color="#8FA2CC" style={{ fontSize: 10 }}>
                            Price
                          </Kicker>
                          <b className="mono" style={{ display: "block", marginTop: 4 }}>
                            {company.shares.priceNear}
                          </b>
                        </div>
                        <div style={{ padding: "12px 14px" }}>
                          <Kicker color="#8FA2CC" style={{ fontSize: 10 }}>
                            Sold
                          </Kicker>
                          <b className="mono" style={{ display: "block", marginTop: 4 }}>
                            {count(company.shares.sold)} / {count(company.shares.total)}
                          </b>
                        </div>
                      </div>
                      <span style={{ fontSize: 14, color: "#C9D3EA" }}>
                        Paid so far to the owners who voted:{" "}
                        <b className="mono" style={{ color: "#fff" }}>
                          {amount(Number(formatUnits(BigInt(company.shares.distributedNearRaw), 24)))} NEAR
                        </b>
                        {company.shares.revenueToken ? (
                          <>
                            {" "}
                            and{" "}
                            <b className="mono" style={{ color: "#fff" }}>
                              {amount(Number(formatUnits(BigInt(company.shares.distributedToken), 18)))} ETH
                            </b>
                          </>
                        ) : null}
                        .
                      </span>
                      <span style={{ fontSize: 13, color: "#A9B6D6" }}>Locked shares vote on company calls and transfers. Each epoch, revenue goes to the holders who voted.</span>
                      <BuyShares daoId={dao} sharesId={company.shares.accountId} priceYocto={company.shares.priceYocto} revenueToken={company.shares.revenueToken} />
                    </>
                  ) : (
                    <span style={{ fontSize: 15, color: "#C9D3EA" }}>This company has not issued shares yet, so it shares no revenue.</span>
                  )}
                </section>
              </div>

              {company.employees.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <Kicker color="#8A5A00">Its agents, and the law they work under</Kicker>
                    <h2 className="h2 carved">
                      {company.employees.length} {company.employees.length === 1 ? "agent" : "agents"}. One law.
                    </h2>
                    <p style={{ margin: 0, fontSize: 16, color: "#4A5675", maxWidth: 760 }}>
                      Each line is a role the owners voted, read from the vault. Anything else an agent asks for is refused before it is signed.
                    </p>
                  </div>
                  <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 22 }}>
                    {company.employees.map((employee) => (
                      <AgentCard key={employee.role} employee={employee} />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="g2" style={{ display: "grid", gridTemplateColumns: sells.length ? "minmax(0,.9fr) minmax(0,1.1fr)" : "minmax(0,1fr)", gap: 28, alignItems: "start" }}>
                <section className="slabw" style={{ padding: "22px 24px", display: "flex", flexDirection: "column" }}>
                  <Kicker color="#8A5A00" style={{ marginBottom: 8 }}>
                    Who governs · {company.council.length} council {company.council.length === 1 ? "seat" : "seats"}
                  </Kicker>
                  {company.council.map((member) => (
                    <div key={member} className="row1">
                      <span className="mono" style={{ fontSize: 13 }} title={member}>
                        {displayAccount(member)}
                      </span>
                      <span style={{ fontSize: 12, color: "#66718C" }}>council</span>
                    </div>
                  ))}
                  <Kicker color="#8A5A00" style={{ margin: "18px 0 8px" }}>
                    Accounts and wallets
                  </Kicker>
                  {company.wallets.map((wallet) => (
                    <div key={wallet.chainId} className="row1">
                      <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".14em", color: "#4A5675" }}>{wallet.name.toUpperCase()}</span>
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {wallet.address}
                      </span>
                    </div>
                  ))}
                  <div className="row1">
                    <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".14em", color: "#4A5675" }}>VAULT · NEAR</span>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {company.vault_id}
                    </span>
                  </div>
                  <div className="row1">
                    <span style={{ font: `700 11px ${BRAND}`, letterSpacing: ".14em", color: "#4A5675" }}>DAO · NEAR</span>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {company.dao_id}
                    </span>
                  </div>
                </section>
                <SellsBlock company={company} agents={agents.data?.agents} />
              </div>
            </>
          ) : null}

          {profile.isLoading ? <p style={{ margin: 0, color: "#4A5675" }}>Reading the company on NEAR…</p> : null}
          {profile.error ? <p style={{ margin: 0, color: "#A8381E" }}>{profile.error.message}</p> : null}
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

/** The registry entry for one company: the directory list filter, no new call shape. */
async function listEntry(dao: string) {
  const { listCompanies } = await import("../../lib/directory.js");
  const all = await listCompanies();
  return all.find((entry) => entry.dao_id === dao) ?? null;
}

/** 100000 → "100,000". */
/** First purchase registers the holder (the contract keeps 0.01 NEAR for its storage). */
const REGISTRATION_FEE_YOCTO = 10n ** 22n;
const formatYocto = (yocto: bigint) => `${Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR`;

type HolderView = {
  balance: string; locked: string; transferable: string; claimable_near: string; claimable_token: string;
  steady_now: string; provable_last_epoch: string; proofs: Array<{ epoch: number; shares: string; verified: boolean }>;
};
type SharesInfo = { current_epoch: number; current_epoch_ends_ns: string; epoch_ns: string };
type Proposal = { id: number; description: string; kind: Record<string, unknown> | string; status: string; submission_time: string; votes: Record<string, string> };
/** What shareholders vote on (the shareholders role): company calls and NEAR transfers. */
const SHAREHOLDER_KINDS: Record<string, string> = { FunctionCall: "call", Transfer: "transfer" };
const kindOf = (kind: Proposal["kind"]) => (typeof kind === "string" ? kind : Object.keys(kind)[0] ?? "");
const TOKEN_REGISTRATION = "1250000000000000000000";

/**
 * Anyone buys from their own wallet, locks shares to vote, votes on the company's calls and
 * transfers, proves that vote the next epoch and claims the revenue: no Euthyna account needed.
 */
function BuyShares({ daoId, sharesId, priceYocto, revenueToken }: { daoId: string; sharesId: string; priceYocto: string; revenueToken: string | null }) {
  const [account, setAccount] = useState<string | null>(null);
  const [shares, setShares] = useState("10");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const holder = useQuery({
    queryKey: ["shares-holder", sharesId, account],
    queryFn: () => viewContract<HolderView | null>(sharesId, "holder_of", { account_id: account }),
    enabled: Boolean(account),
  });
  // Locked shares only vote once the owners made this contract the DAO's staking contract.
  const counted = useQuery({
    queryKey: ["shares-counted", daoId, sharesId],
    queryFn: async () => (await viewContract<string>(daoId, "get_staking_contract").catch(() => "")) === sharesId,
  });
  const info = useQuery({ queryKey: ["shares-info", sharesId], queryFn: () => viewContract<SharesInfo>(sharesId, "info") });
  const tokenMeta = useQuery({
    queryKey: ["ft-metadata", revenueToken],
    queryFn: () => viewContract<{ symbol: string; decimals: number }>(revenueToken!, "ft_metadata"),
    enabled: Boolean(revenueToken),
  });
  const tokenText = (atomic: string) => (tokenMeta.data ? `${formatUnits(BigInt(atomic), tokenMeta.data.decimals)} ${tokenMeta.data.symbol}` : `${atomic} (${revenueToken})`);
  const proposals = useQuery({
    queryKey: ["shares-proposals", daoId],
    queryFn: async () => {
      const last = await viewContract<number>(daoId, "get_last_proposal_id");
      return last ? viewContract<Proposal[]>(daoId, "get_proposals", { from_index: Math.max(0, last - 50), limit: 50 }) : [];
    },
    enabled: Boolean(account),
  });
  useEffect(() => {
    void nearAccounts().then((accounts) => setAccount(accounts[0] ?? null)).catch(() => undefined);
  }, []);
  const count = /^\d+$/.test(shares) ? BigInt(shares) : 0n;
  const deposit = count * BigInt(priceYocto) + (holder.data ? 0n : REGISTRATION_FEE_YOCTO);
  const refresh = async () => {
    // Views read final blocks, a few seconds behind the transaction: read again until they catch up.
    await Promise.all([holder.refetch(), proposals.refetch(), info.refetch()]);
    for (const wait of [3_000, 8_000]) setTimeout(() => void Promise.all([holder.refetch(), proposals.refetch()]), wait);
  };
  const run = async (label: string, work: () => Promise<string>, check?: () => Promise<string | null>) => {
    setBusy(label); setNote(null);
    try {
      const tx = await work();
      setNote(`Done: transaction ${tx.slice(0, 10)}…`);
      await refresh();
      // A call can succeed and its effect be refused further on (a lock the DAO does not count): say so.
      if (check) { await new Promise((resolve) => setTimeout(resolve, 5_000)); const refused = await check(); if (refused) setNote(refused); }
    } catch (cause) {
      setNote(String(cause instanceof Error ? cause.message : cause).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };
  if (!account) {
    return (
      <button className="ori btno" onClick={() => void connectNearWallet().then((accounts) => setAccount(accounts[0] ?? null)).catch((cause: unknown) => setNote(String(cause)))}>
        CONNECT A NEAR WALLET TO BUY
      </button>
    );
  }
  const mine = holder.data;
  const transferable = BigInt(mine?.transferable ?? "0");
  const locked = BigInt(mine?.locked ?? "0");
  // Proposals shareholders vote on, still open, where this account has not voted.
  const open = (proposals.data ?? []).filter((proposal) => proposal.status === "InProgress" && SHAREHOLDER_KINDS[kindOf(proposal.kind)] && !(account in proposal.votes));
  // prove_vote: a proposal submitted during the last epoch that this account voted on.
  const lastVote = (() => {
    const epoch = info.data;
    if (!epoch || epoch.current_epoch === 0 || !mine || mine.provable_last_epoch === "0") return null;
    const end = BigInt(epoch.current_epoch_ends_ns) - BigInt(epoch.epoch_ns);
    const start = end - BigInt(epoch.epoch_ns);
    return (proposals.data ?? []).find((proposal) => BigInt(proposal.submission_time) >= start && BigInt(proposal.submission_time) < end && account in proposal.votes)?.id ?? null;
  })();
  const claimable = mine && (mine.claimable_near !== "0" || mine.claimable_token !== "0");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input inputMode="numeric" aria-label="Number of shares to buy" value={shares} onChange={(event) => setShares(event.target.value)} style={{ width: 90, padding: "8px 10px" }} />
        <button className="ori btno" disabled={Boolean(busy) || count === 0n} onClick={() => void run("buy", () => signContractCall(account, sharesId, "buy", {}, { deposit: deposit.toString() }))}>
          {busy === "buy" ? "SIGNING…" : `BUY ${count} · ${formatYocto(deposit)}`}
        </button>
        {transferable > 0n && counted.data ? (
          <button className="ori btno" disabled={Boolean(busy)} onClick={() => void run(
            "lock",
            () => signContractCall(account, sharesId, "lock", { amount: transferable.toString() }),
            async () => {
              const after = await viewContract<HolderView | null>(sharesId, "holder_of", { account_id: account });
              return after && BigInt(after.locked) <= locked ? "The DAO refused the lock: your shares are back, free. Try again in a minute." : null;
            },
          )}>
            {busy === "lock" ? "SIGNING…" : `LOCK ${transferable} TO VOTE`}
          </button>
        ) : null}
        {locked > 0n ? (
          <button className="ori btno" disabled={Boolean(busy)} onClick={() => void run("unlock", () => signContractCall(account, sharesId, "unlock", { amount: locked.toString() }))}>
            {busy === "unlock" ? "SIGNING…" : "UNLOCK"}
          </button>
        ) : null}
      </div>
      {transferable > 0n && counted.data === false ? (
        <span style={{ fontSize: 12, color: "#F2B544" }}>Locking opens once the owners' vote "Count locked shares as votes" has passed.</span>
      ) : null}
      <span style={{ fontSize: 12, color: "#A9B6D6" }}>
        {account}: {mine ? `${mine.balance} held, ${mine.locked} locked to vote` : "no shares yet"}
        {mine ? "" : " · the first purchase includes 0.01 NEAR of storage"}
        {mine && mine.steady_now !== "0" ? ` · ${mine.steady_now} count this epoch: vote on a proposal before it ends` : ""}
      </span>

      {locked > 0n && open.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: `700 10px ${BRAND}`, letterSpacing: ".18em", color: "#F2B544" }}>VOTE WITH YOUR SHARES</span>
          {open.slice(0, 5).map((proposal) => (
            <div key={proposal.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "#E7ECF6", flex: "1 1 220px" }}>#{proposal.id} · {proposal.description.replace(/^\[mandateos\]\s*/, "").slice(0, 90)}</span>
              {(["VoteApprove", "VoteReject"] as const).map((action) => (
                <button key={action} className="ori btno" style={{ padding: "6px 10px", fontSize: 11 }} disabled={Boolean(busy)}
                  onClick={() => void run(`${action}-${proposal.id}`, () => signDaoAction(account, daoId, proposal.id, proposal.kind, action))}>
                  {busy === `${action}-${proposal.id}` ? "SIGNING…" : action === "VoteApprove" ? "APPROVE" : "REJECT"}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {mine && mine.provable_last_epoch !== "0" ? (
        lastVote !== null ? (
          <button className="ori btno" style={{ alignSelf: "flex-start" }} disabled={Boolean(busy)}
            onClick={() => void run("prove", () => signContractCall(account, sharesId, "prove_vote", { proposal_id: lastVote }))}>
            {busy === "prove" ? "SIGNING…" : `PROVE MY VOTE ON #${lastVote} · ${mine.provable_last_epoch} SHARES`}
          </button>
        ) : (
          <span style={{ fontSize: 12, color: "#A9B6D6" }}>No vote from you last epoch: its revenue goes to the holders who voted.</span>
        )
      ) : null}
      {mine?.proofs.filter((proof) => proof.verified).map((proof) => (
        <span key={proof.epoch} style={{ fontSize: 12, color: "#A9B6D6" }}>✓ Vote proved for epoch {proof.epoch} ({proof.shares} shares): its revenue is yours to claim from epoch {proof.epoch + 2}.</span>
      ))}
      {claimable ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="ori btno" disabled={Boolean(busy)} onClick={() => void run("claim", () => signContractCall(account, sharesId, "claim", {}))}>
            {busy === "claim" ? "SIGNING…" : `CLAIM ${formatYocto(BigInt(mine!.claimable_near))}${mine!.claimable_token !== "0" ? ` + ${tokenText(mine!.claimable_token)}` : ""}`}
          </button>
          {revenueToken && mine!.claimable_token !== "0" ? (
            <button className="ori btno" disabled={Boolean(busy)}
              onClick={() => void run("register", () => signContractCall(account, revenueToken, "storage_deposit", { account_id: account, registration_only: true }, { deposit: TOKEN_REGISTRATION, gas: "30000000000000" }))}>
              {busy === "register" ? "SIGNING…" : "REGISTER FOR THE REVENUE TOKEN FIRST"}
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? <span role="status" style={{ fontSize: 12, color: "#F2B544" }}>{note}</span> : null}
    </div>
  );
}

function count(value: string): string {
  return /^\d+$/.test(value) ? Number(value).toLocaleString("en-US") : value;
}
