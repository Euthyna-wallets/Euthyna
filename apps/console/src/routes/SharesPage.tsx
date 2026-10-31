import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { formatNear, OMNI_CHAINS, OMNI_NEAR_TESTNET, parseNear, proceedsToEvmKinds, revenueProposalKind, sharesProposalKinds } from "@mandateos/sdk/roles";
import { formatUnits, getAddress, toHex, type Hex } from "viem";

import { Kicker, NightPanel, PageTitle, Slab, VetoRing } from "../components/design.js";
import { PageState, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type SharesView } from "../omniroles-api.js";
import { signContractCall, signDaoProposal, viewContract } from "../wallets.js";

const SECTION_LINE: CSSProperties = { font: "600 12px var(--font-ui)", color: "#66718C" };
const INPUT: CSSProperties = {
  background: "#fff", border: "1px solid rgba(13,23,48,.2)", borderRadius: 2, padding: "9px 12px",
  font: "13px var(--font-mono)", color: "var(--ink)", width: "100%", boxSizing: "border-box", minWidth: 0,
};
const ALERT: CSSProperties = { padding: "12px 16px", borderRadius: 2, fontSize: 13.5 };
const group = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const REGISTRATION_FEE = parseNear("0.01");
const TOKEN_REGISTRATION = parseNear("0.0125");

/** The server prepares the votes; the browser checks they are exactly the expected ones before the wallet signs. */
function verifySetupDrafts(drafts: ProposalDraft[], sharesAccountId: string, daoAccountId: string) {
  const expected = sharesProposalKinds(sharesAccountId).map((vote) => JSON.stringify(vote.kind));
  for (const draft of drafts) {
    if (draft.receiverId !== daoAccountId || !expected.includes(JSON.stringify(draft.args.proposal.kind))) {
      throw new Error("The server returned an unexpected proposal: nothing was signed.");
    }
  }
}

function verifyRevenueDraft(draft: ProposalDraft, sharesAccountId: string, daoAccountId: string, amountNear: string) {
  const expected = JSON.stringify(revenueProposalKind(sharesAccountId, parseNear(amountNear)));
  if (draft.receiverId !== daoAccountId || JSON.stringify(draft.args.proposal.kind) !== expected) {
    throw new Error("The server returned an unexpected proposal: nothing was signed.");
  }
}

/** Highest bridge fee the browser accepts, as a share of the amount (the server reads it from the Omni Bridge API). */
const MAX_BRIDGE_FEE_PERCENT = 5n;

/**
 * Rebuild both proceeds votes from chain data read by the browser: the company
 * wallet from the vault, the members from the DAO, the storage prices from the
 * bridge. Only the bridge fee comes from the server, and it is capped.
 */
async function verifyProceedsDrafts(drafts: ProposalDraft[], view: { daoAccountId: string; vaultAccountId: string }, chainId: number, amountNear: string): Promise<Hex> {
  const fail = (why: string): never => {
    throw new Error(`The server returned an unexpected proposal (${why}): nothing was signed.`);
  };
  if (drafts.length !== 2 || drafts.some((draft) => draft.receiverId !== view.daoAccountId)) fail("receiver");
  const owner = await viewContract<string>(view.vaultAccountId, "owner_id");
  if (owner !== view.daoAccountId) fail("vault owner");
  const wallet = await viewContract<{ address: number[] | null } | null>(view.vaultAccountId, "get_wallet", { chain_id: chainId });
  if (!wallet?.address) fail("no company wallet");
  const address = getAddress(toHex(new Uint8Array(wallet!.address!)));
  const bridge = OMNI_NEAR_TESTNET.bridge;
  const policy = await viewContract<{ roles: Array<{ kind: unknown }> }>(view.daoAccountId, "get_policy");
  const members = policy.roles.flatMap((role) => ((role.kind as { Group?: string[] })?.Group ?? []));
  const perAccount = await viewContract<string>(bridge, "required_balance_for_account");
  const perTransfer = await viewContract<string>(bridge, "required_balance_for_init_transfer");
  const membersToRegister: string[] = [];
  for (const member of members) {
    if (!(await viewContract<unknown>(bridge, "storage_balance_of", { account_id: member }))) membersToRegister.push(member);
  }
  const transfer = (drafts[1]!.args.proposal.kind as { FunctionCall?: { actions?: Array<{ method_name: string; args: string }> } }).FunctionCall;
  const call = transfer?.actions?.find((action) => action.method_name === "ft_transfer_call");
  if (!call) fail("transfer");
  const fee = BigInt((JSON.parse(JSON.parse(atob(call!.args)).msg) as { fee: string }).fee);
  const amount = BigInt(parseNear(amountNear));
  if (fee * 100n > amount * MAX_BRIDGE_FEE_PERCENT) fail(`bridge fee ${formatNear(fee)} above ${MAX_BRIDGE_FEE_PERCENT}%`);
  const expected = proceedsToEvmKinds({
    daoAccountId: view.daoAccountId, chainId, wallet: address, amountYocto: amount.toString(), feeYocto: fee.toString(),
    membersToRegister, perAccountYocto: perAccount, perTransferYocto: perTransfer,
  });
  if (JSON.stringify(drafts[0]!.args.proposal.kind) !== JSON.stringify(expected.storage)) fail("bridge storage");
  if (JSON.stringify(drafts[1]!.args.proposal.kind) !== JSON.stringify(expected.transfer)) fail("transfer");
  return address;
}

export function SharesPage() {
  const wallets = useWallets();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["omni-shares"], queryFn: omni.shares, refetchInterval: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const me = wallets.nearAccountId;

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await queryClient.invalidateQueries({ queryKey: ["omni-shares"] });
      await queryClient.invalidateQueries({ queryKey: ["omni-governance"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
        <span style={SECTION_LINE}>Collective ownership</span>
        <PageTitle>OWNERS</PageTitle>
        <p style={{ margin: 0, fontSize: 14, color: "#4A5675", maxWidth: 820, lineHeight: 1.55 }}>
          Anyone with a NEAR wallet can buy shares. Locked shares vote on company calls and transfers. Revenue is
          split by epoch among the holders who voted: the part of those who did not goes to those who did. Members
          keep their two-thirds vote and their veto.
        </p>
      </header>
      {error ? (
        <div role="alert" style={{ ...ALERT, background: "#FBE3D6", border: "1px solid rgba(168,56,30,.35)", color: "var(--terra-ink)" }}>{error}</div>
      ) : null}
      {notice ? (
        <div style={{ ...ALERT, background: "var(--aegean-bg)", border: "1px solid rgba(11,110,134,.25)", color: "var(--aegean-ink)" }}>{notice}</div>
      ) : null}
      {!me ? (
        <div style={{ ...ALERT, background: "#FCF0D4", border: "1px solid rgba(201,137,12,.4)", color: "var(--gold-ink)" }}>
          Connect your NEAR wallet (top right) to buy, vote or claim.
        </div>
      ) : null}
      <PageState loading={query.isLoading} error={query.error}>
        {query.data && !query.data.deployed ? (
          <CreateShares accountId={query.data.accountId} me={me} busy={busy} onCreate={(draft) => run("create", async () => {
            const result = await omni.createShares(draft);
            const status = await omni.status();
            verifySetupDrafts(result.proposals, result.accountId, status.treasury!.daoAccountId);
            for (const proposal of result.proposals) await signDaoProposal(me, proposal);
            return `${result.accountId} deployed with no access key. ${result.proposals.length} proposals submitted: members vote to turn shares on.`;
          })} />
        ) : null}
        {query.data?.deployed ? <SharesDashboard data={query.data} me={me} busy={busy} run={run} /> : null}
      </PageState>
    </div>
  );
}

function CreateShares(props: { accountId: string; me: string; busy: string | null; onCreate: (draft: Parameters<typeof omni.createShares>[0]) => void }) {
  const [name, setName] = useState("Company shares");
  const [symbol, setSymbol] = useState("SHARE");
  const [totalSupply, setTotalSupply] = useState("1000000");
  const [priceNear, setPriceNear] = useState("0.001");
  const [founderShares, setFounderShares] = useState("0");
  const founder = Number(founderShares);
  return (
    <Slab style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
      <Kicker>Issue shares</Kicker>
      <p style={{ margin: 0, fontSize: 13.5, color: "#4A5675", lineHeight: 1.55 }}>
        Deploys <code style={{ font: "12.5px var(--font-mono)" }}>{props.accountId}</code> with no access key: nobody, not even Euthyna, can change it. Then two
        proposals: the DAO counts locked shares as votes, and shareholders get a vote on company calls and transfers.
      </p>
      <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-3)", textTransform: "uppercase" }}>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} style={INPUT} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-3)", textTransform: "uppercase" }}>Symbol</span>
          <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} style={INPUT} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-3)", textTransform: "uppercase" }}>Total shares</span>
          <input inputMode="numeric" value={totalSupply} onChange={(event) => setTotalSupply(event.target.value)} style={INPUT} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-3)", textTransform: "uppercase" }}>Price of one share (NEAR)</span>
          <input inputMode="decimal" value={priceNear} onChange={(event) => setPriceNear(event.target.value)} style={INPUT} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".14em", color: "var(--ink-3)", textTransform: "uppercase" }}>
            Shares for you{props.me ? ` (${short(props.me, 14)})` : ""}
          </span>
          <input inputMode="numeric" value={founderShares} onChange={(event) => setFounderShares(event.target.value)} style={INPUT} />
        </div>
      </div>
      <span style={{ fontSize: 12, color: "#66718C" }}>Sale proceeds go to the DAO account. Unsold shares earn nothing and do not vote.</span>
      <div>
        <button
          className="btn-ori"
          disabled={!props.me || Boolean(props.busy)}
          onClick={() => props.onCreate({
            name,
            symbol,
            totalSupply: Number(totalSupply),
            priceNear,
            allocations: founder > 0 ? [{ accountId: props.me, shares: founder }] : [],
          })}
        >
          {props.busy === "create" ? "DEPLOYING…" : "ISSUE SHARES"}
        </button>
      </div>
    </Slab>
  );
}

function SharesDashboard(props: {
  data: Extract<SharesView, { deployed: true }>;
  me: string;
  busy: string | null;
  run: (label: string, action: () => Promise<string>) => Promise<void>;
}) {
  const { data, me, busy, run } = props;
  const { info } = data;
  const holder = data.me?.holder ?? null;
  const sold = BigInt(info.total_supply) - BigInt(info.unsold);
  const [buyCount, setBuyCount] = useState("100");
  const [lockCount, setLockCount] = useState("");
  const [revenue, setRevenue] = useState("1");
  const [proceeds, setProceeds] = useState("1");
  const [proceedsChain, setProceedsChain] = useState(84532);
  const ready = data.votesCounted && data.shareholdersVote;
  const token = data.revenueToken;
  const tokenAmount = (amount: string) => (token ? `${formatUnits(BigInt(amount), token.decimals)} ${token.symbol}` : amount);
  const call = (label: string, method: string, args: Record<string, unknown>, deposit = "0") =>
    run(label, async () => {
      await signContractCall(me, data.accountId, method, args, { deposit });
      return `${method} sent.`;
    });
  const epochEnds = new Date(Number(BigInt(info.current_epoch_ends_ns) / 1_000_000n));
  const epochLength = Number(BigInt(info.epoch_ns) / 1_000_000_000n);
  const epochLabel = epochLength % 86_400 === 0 ? `${epochLength / 86_400} days` : epochLength % 3_600 === 0 ? `${epochLength / 3_600} h` : `${Math.round(epochLength / 60)} min`;
  const lastVote = data.me?.lastEpochVote ?? null;
  const buyDeposit = () => {
    const count = BigInt(buyCount || "0");
    return (count * BigInt(info.price_per_share) + (holder ? 0n : BigInt(REGISTRATION_FEE))).toString();
  };

  const total = BigInt(info.total_supply);
  const lockedShares = BigInt(data.lockedTotal);
  const freeShares = sold > lockedShares ? sold - lockedShares : 0n;
  const unsoldShares = BigInt(info.unsold);
  const percentage = (part: bigint) => (total > 0n ? Math.min(100, Math.max(0, Number((part * 10_000n) / total) / 100)) : 0);
  const epochRemaining = Math.max(0, (epochEnds.getTime() - Date.now()) / 1000);
  const countdown = epochRemaining >= 86_400
    ? `${Math.floor(epochRemaining / 86_400)} d ${Math.floor((epochRemaining % 86_400) / 3_600)} h`
    : `${Math.floor(epochRemaining / 3_600)} h ${Math.floor((epochRemaining % 3_600) / 60)} min`;
  const revenueItems: Array<{ title: string; details: string[] }> = [
    { title: "NEAR from the DAO account", details: ["members or shareholders vote it", "goes to this epoch's voters"] },
  ];
  if (token) revenueItems.push({ title: `${token.symbol} (${token.accountId}) sent to ${data.accountId}`, details: ["for example Base ETH sent by Omni Bridge", "anyone can trigger the split once it arrived"] });
  const proceedsItems: Array<{ title: string; details: string[] }> = [
    { title: "NEAR held by the DAO goes to the company wallet on an EVM chain", details: ["as wNEAR, through Omni Bridge", "two votes: the bridge storage, then the transfer"] },
    { title: "Your browser rebuilds both votes before signing", details: ["company wallet read from the vault", "members and storage prices read from the DAO and the bridge", `bridge fee capped at ${MAX_BRIDGE_FEE_PERCENT}% of the amount`] },
  ];
  const checks = [
    { ok: data.keyless, pending: false, label: `${data.accountId} has no access key` },
    { ok: data.votesCounted, pending: true, label: "The DAO counts locked shares as votes" },
    { ok: data.shareholdersVote, pending: true, label: "Shareholders vote on company calls and transfers" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <section className="ori-panel" style={{ display: "flex", flexDirection: "column", boxShadow: "18px 22px 40px rgba(13,23,48,.3), inset 0 1px 0 rgba(255,230,190,.5)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", padding: "16px 20px 4px" }}>
          <b style={{ font: "800 20px var(--font-brand)", letterSpacing: ".12em", color: "rgba(42,13,4,.85)", textShadow: "0 1px 0 rgba(255,222,170,.5)" }}>
            {info.name.toUpperCase()} · {info.symbol}
          </b>
          <span style={{ font: "12px var(--font-mono)", color: "rgba(32,10,3,.75)", overflowWrap: "anywhere" }}>{data.accountId}</span>
        </div>
        <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
          {[
            { label: "Price", value: formatNear(info.price_per_share) },
            { label: "Sold", value: `${group(sold.toString())} / ${group(info.total_supply)}` },
            { label: "Locked to vote", value: group(data.lockedTotal) },
            { label: "Revenue shared", value: formatNear(info.near_distributed) },
          ].map((metric, index) => (
            <div key={metric.label} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "14px 18px", borderRight: index === 3 ? 0 : "1px solid rgba(60,20,4,.25)" }}>
              <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".22em", color: "rgba(32,10,3,.72)" }}>{metric.label}</span>
              <b style={{ font: "600 22px var(--font-mono)", color: "#200A03", overflowWrap: "anywhere" }}>{metric.value}</b>
              {metric.label === "Revenue shared" && token ? (
                <span style={{ font: "11px var(--font-mono)", color: "rgba(32,10,3,.7)" }}>+ {tokenAmount(info.token_distributed)}</span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, .9fr)", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <Slab style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Kicker>Who owns the company</Kicker>
            <div style={{ display: "flex", height: 14, overflow: "hidden", boxShadow: "inset 0 1px 2px rgba(13,23,48,.3)" }} role="img" aria-label={`Locked ${lockedShares.toString()}, free ${freeShares.toString()}, unsold ${unsoldShares.toString()}`}>
              {lockedShares > 0n ? <div style={{ width: `${percentage(lockedShares)}%`, background: "linear-gradient(180deg,#FFE2A8,#C9890C)" }} /> : null}
              {freeShares > 0n ? <div style={{ width: `${percentage(freeShares)}%`, background: "#E2DBCD" }} /> : null}
              {unsoldShares > 0n ? <div style={{ width: `${percentage(unsoldShares)}%`, background: "repeating-linear-gradient(135deg, rgba(13,23,48,.08) 0 6px, rgba(13,23,48,0) 6px 12px)" }} /> : null}
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12, color: "#4A5675" }}>
              <span><b style={{ color: "var(--gold-ink)" }}>■</b> Locked to vote · {group(lockedShares.toString())}</span>
              <span><b style={{ color: "#B7AE9C" }}>■</b> Free · {group(freeShares.toString())}</span>
              <span>▨ Unsold · {group(unsoldShares.toString())}</span>
            </div>
            <div style={{ borderTop: "1px solid rgba(13,23,48,.12)", marginTop: 4, paddingTop: 6 }}>
              {checks.map((check) => {
                const mark = check.ok ? "✓" : check.pending ? "…" : "✗";
                const tone = check.ok ? "#0B4E5E" : check.pending ? "#8A5A00" : "#6E1C0A";
                return (
                  <div key={check.label} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, padding: "6px 0" }}>
                    <span style={{ width: 24, height: 24, flex: "0 0 auto", borderRadius: "50%", background: "var(--seal)", boxShadow: "inset 0 0 0 2px rgba(255,236,196,.28), inset 0 -2px 4px rgba(40,18,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", font: "800 11px var(--font-brand)", color: tone }}>{mark}</span>
                    <span style={{ overflowWrap: "anywhere" }}>{check.label}</span>
                  </div>
                );
              })}
            </div>
            {!ready ? (
              <div>
                <button className="btn-line" disabled={!me || Boolean(busy)} onClick={() => void run("setup", async () => {
                  const { proposals } = await omni.sharesProposals();
                  verifySetupDrafts(proposals, data.accountId, data.daoAccountId);
                  for (const proposal of proposals) await signDaoProposal(me, proposal);
                  return proposals.length ? `${proposals.length} proposal(s) submitted. Members vote on them in Decisions.` : "Already proposed.";
                })}>PROPOSE THE MISSING VOTES</button>
              </div>
            ) : null}
          </Slab>

          <Slab style={{ padding: "16px 0 0", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "0 20px 10px" }}>
              <Kicker>Your shares{me ? ` · ${short(me, 18)}` : ""}</Kicker>
              {lastVote !== null ? <span style={{ fontSize: 12, color: "var(--aegean-ink)", fontWeight: 700 }}>You voted last epoch</span> : null}
            </div>
            {holder ? (
              <>
                <div className="g4" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", borderTop: "1px solid rgba(13,23,48,.1)" }}>
                  {[
                    { label: "Held", value: group(holder.balance), color: "var(--ink)" },
                    { label: "Locked (votes)", value: group(holder.locked), color: "var(--ink)" },
                    { label: "Free", value: group(holder.transferable), color: "var(--ink)" },
                    { label: "To claim", value: formatNear(holder.claimable_near), color: "var(--aegean-ink)" },
                  ].map((mine, index) => (
                    <div key={mine.label} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 16px", borderRight: index === 3 ? 0 : "1px solid rgba(13,23,48,.1)", minWidth: 0 }}>
                      <span style={{ font: "700 10px var(--font-brand)", letterSpacing: ".2em", color: "var(--gold-ink)" }}>{mine.label}</span>
                      <b style={{ font: "600 20px var(--font-mono)", color: mine.color, overflowWrap: "anywhere" }}>{mine.value}</b>
                      {mine.label === "Free" && holder.cooling !== "0" ? (
                        <span style={{ fontSize: 11.5, color: "#66718C" }}>
                          · {group(holder.cooling)} frozen until {new Date(Number(BigInt(holder.cooling_until_ns) / 1_000_000n)).toLocaleString()}
                        </span>
                      ) : null}
                      {mine.label === "To claim" && holder.claimable_token !== "0" ? (
                        <span style={{ font: "11.5px var(--font-mono)", color: "#66718C" }}>+ {tokenAmount(holder.claimable_token)}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "14px 20px 16px", borderTop: "1px solid rgba(13,23,48,.1)" }}>
                  <input inputMode="numeric" aria-label="Shares to lock or unlock" placeholder={holder.transferable} value={lockCount} onChange={(event) => setLockCount(event.target.value)} style={{ ...INPUT, flex: "0 1 150px" }} />
                  <button className="btn-line" disabled={!me || Boolean(busy) || holder.transferable === "0"} onClick={() => void call("lock", "lock", { amount: lockCount || holder.transferable })}>
                    {busy === "lock" ? "SIGNING…" : "LOCK TO VOTE"}
                  </button>
                  <button className="btn-ori" disabled={!me || Boolean(busy) || (holder.claimable_near === "0" && holder.claimable_token === "0")} onClick={() => void call("claim", "claim", {})}>
                    {busy === "claim" ? "SIGNING…" : holder.claimable_near !== "0" ? `CLAIM ${formatNear(holder.claimable_near)}` : "CLAIM"}
                  </button>
                  <button className="btn-line" disabled={!me || Boolean(busy) || holder.locked === "0"} onClick={() => void call("unlock", "unlock", { amount: lockCount || holder.locked })}>UNLOCK</button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 20px 16px" }}>
                  <span style={{ fontSize: 12.5, color: "#4A5675" }}>
                    {holder.steady_now !== "0"
                      ? `${holder.steady_now} shares count for this epoch: vote on a proposal before ${epochEnds.toLocaleString()}.`
                      : "No share counts for this epoch: shares locked now count from the next one."}
                  </span>
                  {holder.proofs.filter((proof) => proof.verified).map((proof) => (
                    <span key={proof.epoch} style={{ fontSize: 12.5, color: "#66718C" }}>
                      ✓ Vote proved for epoch {proof.epoch} ({proof.shares} shares): claimable from epoch {proof.epoch + 2}.
                    </span>
                  ))}
                  {info.revenue_token && holder.claimable_token !== "0" ? (
                    <button
                      className="btn-line"
                      style={{ alignSelf: "flex-start" }}
                      disabled={!me || Boolean(busy)}
                      onClick={() => void run("register", async () => {
                        await signContractCall(me, info.revenue_token!, "storage_deposit", { account_id: me, registration_only: true }, { deposit: TOKEN_REGISTRATION, gas: "30000000000000" });
                        return `Registered on ${info.revenue_token}: claim again to receive it.`;
                      })}
                    >
                      {busy === "register" ? "REGISTERING…" : `REGISTER FOR ${short(info.revenue_token, 18)}`}
                    </button>
                  ) : null}
                  <span style={{ fontSize: 12, color: "#66718C" }}>
                    Unlocked shares stay frozen for {Number(BigInt(info.unlock_period_ns) / 3_600_000_000_000n) || "<1"} h, longer than a vote, so the same share cannot vote twice.
                  </span>
                </div>
              </>
            ) : (
              <p style={{ margin: 0, padding: "14px 20px 18px", fontSize: 14, color: "#4A5675" }}>You hold no share yet.</p>
            )}
          </Slab>

          <Slab style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Kicker>Buy shares</Kicker>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input inputMode="numeric" aria-label="Number of shares to buy" value={buyCount} onChange={(event) => setBuyCount(event.target.value)} style={{ ...INPUT, flex: "0 1 120px" }} />
              <span style={{ fontSize: 13, color: "#4A5675" }}>{buyCount || "0"} shares · {formatNear(buyDeposit())}</span>
              <button className="btn-ori" disabled={!me || Boolean(busy) || info.unsold === "0"} onClick={() => void call("buy", "buy", {}, buyDeposit())}>
                {busy === "buy" ? "SIGNING…" : "BUY"}
              </button>
            </div>
            <span style={{ fontSize: 12, color: "#66718C" }}>Sale proceeds go to the DAO account. Unsold shares earn nothing and do not vote.</span>
          </Slab>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <NightPanel style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <Kicker color="#F2B544">This epoch · {epochLabel}</Kicker>
              <span style={{ font: "600 11.5px var(--font-mono)", color: "#8FA2CC" }}>#{info.current_epoch}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: 16, alignItems: "center" }}>
              <div style={{ position: "relative", width: 120, height: 120, flex: "0 0 auto" }}>
                <VetoRing remaining={epochRemaining} total={epochLength} size={120} />
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
                  <b style={{ font: "600 16px var(--font-mono)", color: "#F3EFE6" }}>{countdown}</b>
                  <span style={{ font: "700 8px var(--font-brand)", letterSpacing: ".16em", color: "#8FA2CC" }}>EPOCH ENDS</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5, color: "#C9D3EA", minWidth: 0 }}>
                <span>
                  Revenue waiting to be shared: <b style={{ font: "600 14px var(--font-mono)", color: "#fff" }}>{formatNear(info.current.near)}</b>
                  {token && info.current.token !== "0" ? ` + ${tokenAmount(info.current.token)}` : ""}
                </span>
                <span>
                  Last epoch: <b style={{ font: "600 13px var(--font-mono)", color: "#E7ECF6" }}>{formatNear(info.last.near)}</b>
                  {token && info.last.token !== "0" ? ` + ${tokenAmount(info.last.token)}` : ""}
                  {" · "}{info.last.voted_shares} locked shares proved a vote so far
                </span>
                <span style={{ color: "#A9B6D6" }}>
                  Only holders who voted get a part; the part of the others goes to them. Ends {epochEnds.toLocaleString()}.
                </span>
                <span style={{ fontSize: 12, color: "#8FA2CC" }}>
                  To earn an epoch's revenue: keep shares locked the whole epoch and vote on at least one proposal submitted in it.
                  During the next epoch, prove that vote. The epoch after, the revenue is split among the provers.
                  With no voter, it moves to the current epoch.
                </span>
                {holder && holder.provable_last_epoch !== "0" ? (
                  lastVote !== null ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 12.5, color: "#A9B6D6" }}>You voted on proposal #{lastVote} during the last epoch.</span>
                      <button
                        className="btn-ori"
                        style={{ padding: "9px 14px", fontSize: 11, alignSelf: "flex-start" }}
                        disabled={!me || Boolean(busy)}
                        onClick={() => void call("prove", "prove_vote", { proposal_id: lastVote })}
                      >
                        {busy === "prove" ? "SIGNING…" : `PROVE MY VOTE · ${holder.provable_last_epoch} SHARES`}
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12.5, color: "#A9B6D6" }}>You did not vote during the last epoch: its revenue goes to the holders who did.</span>
                  )
                ) : null}
              </div>
            </div>
          </NightPanel>

          <Slab style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Kicker>Share revenue</Kicker>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {revenueItems.map((item) => (
                <div key={item.title} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 13, color: "#0D1730" }}>{item.title}</span>
                  <span style={{ fontSize: 12, color: "#66718C" }}>{item.details.join(" · ")}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input inputMode="decimal" aria-label="Amount to share" value={revenue} onChange={(event) => setRevenue(event.target.value)} style={{ ...INPUT, flex: "0 1 100px" }} />
              <span style={{ fontSize: 13, color: "#4A5675" }}>NEAR</span>
              <button className="btn-line" disabled={!me || Boolean(busy) || !ready} onClick={() => void run("revenue", async () => {
                const draft = await omni.revenueProposal(revenue);
                verifyRevenueDraft(draft, data.accountId, data.daoAccountId, revenue);
                const result = await signDaoProposal(me, draft);
                return `Proposal #${result.proposalId} submitted.`;
              })}>
                {busy === "revenue" ? "SIGNING…" : "PROPOSE TO SHARE IT"}
              </button>
            </div>
            {info.revenue_token ? (
              <button
                style={{ border: 0, background: "none", padding: 0, font: "12.5px var(--font-ui)", color: "#4A5675", cursor: "pointer", textAlign: "left" }}
                disabled={!me || Boolean(busy)}
                onClick={() => void call("sync", "sync_revenue", {})}
              >
                Split bridged revenue
              </button>
            ) : null}
          </Slab>

          <Slab style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Kicker>Send proceeds to the company wallet</Kicker>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {proceedsItems.map((item) => (
                <div key={item.title} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 13, color: "#0D1730" }}>{item.title}</span>
                  <span style={{ fontSize: 12, color: "#66718C" }}>{item.details.join(" · ")}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input inputMode="decimal" aria-label="Amount to send" value={proceeds} onChange={(event) => setProceeds(event.target.value)} style={{ ...INPUT, flex: "0 1 100px" }} />
              <select aria-label="Chain" value={proceedsChain} onChange={(event) => setProceedsChain(Number(event.target.value))} style={{ ...INPUT, flex: "0 1 170px", font: "13px var(--font-ui)" }}>
                {Object.entries(OMNI_CHAINS).map(([chainId, chain]) => <option key={chainId} value={chainId}>{chain.name}</option>)}
              </select>
              <button className="btn-line" disabled={!me || Boolean(busy)} onClick={() => void run("proceeds", async () => {
                const { proposals } = await omni.proceedsProposals({ chainId: proceedsChain, amountNear: proceeds });
                const wallet = await verifyProceedsDrafts(proposals, data, proceedsChain, proceeds);
                const storage = await signDaoProposal(me, proposals[0]!);
                const transfer = await signDaoProposal(me, proposals[1]!);
                return `Proposals #${storage.proposalId} (bridge storage) and #${transfer.proposalId} (transfer to ${short(wallet, 12)}) submitted. Approve them in order in Decisions.`;
              })}>
                {busy === "proceeds" ? "SIGNING…" : "PROPOSE THE TRANSFER"}
              </button>
            </div>
            <span style={{ fontSize: 12, color: "#66718C" }}>The bridge takes about 20 minutes.</span>
          </Slab>
        </div>
      </div>
    </div>
  );
}
