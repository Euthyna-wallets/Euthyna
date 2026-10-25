import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatUnits } from "viem";
import { formatNear, parseNear, revenueProposalKind, sharesProposalKinds } from "@mandateos/sdk/roles";

import { Card, PageState, short } from "../components/ui.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type SharesView } from "../omniroles-api.js";
import { signContractCall, signDaoProposal } from "../wallets.js";
import { SentenceList } from "./GovernancePage.js";

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
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Collective ownership</span>
          <h1>Shares</h1>
          <p className="muted">
            Anyone with a NEAR wallet can buy shares. Locked shares vote on company calls and transfers. Revenue is
            split by epoch among the holders who voted: the part of those who did not goes to those who did. Members
            keep their two-thirds vote and their veto.
          </p>
        </div>
      </header>
      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}
      {!me ? <div className="notice">Connect your NEAR wallet (top right) to buy, vote or claim.</div> : null}
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
    <Card title="Issue shares">
      <p className="muted">
        Deploys <code>{props.accountId}</code> with no access key: nobody, not even MandateOS, can change it. Then two
        proposals: the DAO counts locked shares as votes, and shareholders get a vote on company calls and transfers.
      </p>
      <div className="form-grid">
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Symbol<input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></label>
        <label>Total shares<input inputMode="numeric" value={totalSupply} onChange={(event) => setTotalSupply(event.target.value)} /></label>
        <label>Price of one share (NEAR)<input inputMode="decimal" value={priceNear} onChange={(event) => setPriceNear(event.target.value)} /></label>
        <label>Shares for you{props.me ? ` (${short(props.me, 14)})` : ""}<input inputMode="numeric" value={founderShares} onChange={(event) => setFounderShares(event.target.value)} /></label>
      </div>
      <p className="small muted">Sale proceeds go to the DAO account. Unsold shares earn nothing and do not vote.</p>
      <button
        className="primary"
        disabled={!props.me || Boolean(props.busy)}
        onClick={() => props.onCreate({
          name,
          symbol,
          totalSupply: Number(totalSupply),
          priceNear,
          allocations: founder > 0 ? [{ accountId: props.me, shares: founder }] : [],
        })}
      >
        {props.busy === "create" ? "Deploying…" : "Issue shares"}
      </button>
    </Card>
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

  return (
    <>
      <Card title={`${info.name} · ${info.symbol}`}>
        <div className="metric-grid">
          <div><span className="eyebrow">Price</span><strong>{formatNear(info.price_per_share)}</strong></div>
          <div><span className="eyebrow">Sold</span><strong>{sold.toString()} / {info.total_supply}</strong></div>
          <div><span className="eyebrow">Locked to vote</span><strong>{data.lockedTotal}</strong></div>
          <div><span className="eyebrow">Revenue shared</span><strong>{formatNear(info.near_distributed)}</strong>
            {token ? <span className="small muted"> + {tokenAmount(info.token_distributed)}</span> : null}
          </div>
        </div>
        <ul className="share-checks">
          <li className={data.keyless ? "ok" : "bad"}>{data.keyless ? "✓" : "✗"} {data.accountId} has no access key</li>
          <li className={data.votesCounted ? "ok" : "bad"}>{data.votesCounted ? "✓" : "…"} the DAO counts locked shares as votes</li>
          <li className={data.shareholdersVote ? "ok" : "bad"}>{data.shareholdersVote ? "✓" : "…"} shareholders vote on company calls and transfers</li>
        </ul>
        {!ready ? (
          <button className="secondary" disabled={!me || Boolean(busy)} onClick={() => void run("setup", async () => {
            const { proposals } = await omni.sharesProposals();
            verifySetupDrafts(proposals, data.accountId, data.daoAccountId);
            for (const proposal of proposals) await signDaoProposal(me, proposal);
            return proposals.length ? `${proposals.length} proposal(s) submitted. Members vote on them in Decisions.` : "Already proposed.";
          })}>Propose the missing votes</button>
        ) : null}
      </Card>

      <Card title={`Revenue for voters · epoch ${info.current_epoch} (${epochLabel})`}>
        <div className="metric-grid">
          <div><span className="eyebrow">This epoch</span><strong>{formatNear(info.current.near)}</strong>
            {token && info.current.token !== "0" ? <span className="small muted"> + {tokenAmount(info.current.token)}</span> : null}
            <span className="small muted">ends {epochEnds.toLocaleString()}</span>
          </div>
          <div><span className="eyebrow">Last epoch</span><strong>{formatNear(info.last.near)}</strong>
            {token && info.last.token !== "0" ? <span className="small muted"> + {tokenAmount(info.last.token)}</span> : null}
            <span className="small muted">{info.last.voted_shares} locked shares proved a vote so far</span>
          </div>
        </div>
        <p className="small muted">
          To earn an epoch's revenue: keep shares locked the whole epoch and vote on at least one proposal submitted in it.
          During the next epoch, prove that vote. The epoch after, the revenue is split among the provers.
          With no voter, it moves to the current epoch.
        </p>
      </Card>

      <Card title={me ? `Your shares · ${short(me, 18)}` : "Your shares"}>
        {holder ? (
          <div className="metric-grid">
            <div><span className="eyebrow">Held</span><strong>{holder.balance}</strong></div>
            <div><span className="eyebrow">Locked (votes)</span><strong>{holder.locked}</strong></div>
            <div><span className="eyebrow">Free</span><strong>{holder.transferable}</strong>
              {holder.cooling !== "0" ? <span className="small muted"> · {holder.cooling} frozen until {new Date(Number(BigInt(holder.cooling_until_ns) / 1_000_000n)).toLocaleString()}</span> : null}
            </div>
            <div><span className="eyebrow">To claim</span><strong>{formatNear(holder.claimable_near)}</strong>
              {holder.claimable_token !== "0" ? <span className="small muted"> + {tokenAmount(holder.claimable_token)}</span> : null}
            </div>
          </div>
        ) : <p className="muted">You hold no share yet.</p>}
        {holder ? (
          <div className="stack">
            <p className="small">
              {holder.steady_now !== "0"
                ? `${holder.steady_now} shares count for this epoch: vote on a proposal before ${epochEnds.toLocaleString()}.`
                : "No share counts for this epoch: shares locked now count from the next one."}
            </p>
            {holder.provable_last_epoch !== "0" ? (
              lastVote !== null ? (
                <div className="row wrap">
                  <span className="small">You voted on proposal #{lastVote} during the last epoch.</span>
                  <button className="primary" disabled={!me || Boolean(busy)} onClick={() => void call("prove", "prove_vote", { proposal_id: lastVote })}>
                    {busy === "prove" ? "Signing…" : `Prove it for ${holder.provable_last_epoch} shares`}
                  </button>
                </div>
              ) : <p className="small muted">You did not vote during the last epoch: its revenue goes to the holders who did.</p>
            ) : null}
            {holder.proofs.filter((proof) => proof.verified).map((proof) => (
              <p key={proof.epoch} className="small muted">✓ Vote proved for epoch {proof.epoch} ({proof.shares} shares): claimable from epoch {proof.epoch + 2}.</p>
            ))}
          </div>
        ) : null}
        <div className="row wrap">
          <label className="inline">Buy<input inputMode="numeric" value={buyCount} onChange={(event) => setBuyCount(event.target.value)} />shares</label>
          <button className="primary" disabled={!me || Boolean(busy) || info.unsold === "0"} onClick={() => void call("buy", "buy", {}, buyDeposit())}>
            {busy === "buy" ? "Signing…" : `Buy for ${formatNear(buyDeposit())}`}
          </button>
        </div>
        {holder ? (
          <div className="row wrap">
            <label className="inline">Shares<input inputMode="numeric" placeholder={holder.transferable} value={lockCount} onChange={(event) => setLockCount(event.target.value)} /></label>
            <button className="secondary" disabled={!me || Boolean(busy) || holder.transferable === "0"} onClick={() => void call("lock", "lock", { amount: lockCount || holder.transferable })}>Lock to vote</button>
            <button className="ghost" disabled={!me || Boolean(busy) || holder.locked === "0"} onClick={() => void call("unlock", "unlock", { amount: lockCount || holder.locked })}>Unlock</button>
            <button className="primary" disabled={!me || Boolean(busy) || (holder.claimable_near === "0" && holder.claimable_token === "0")} onClick={() => void call("claim", "claim", {})}>Claim</button>
            {info.revenue_token && holder.claimable_token !== "0" ? (
              <button className="ghost" disabled={!me || Boolean(busy)} onClick={() => void run("register", async () => {
                await signContractCall(me, info.revenue_token!, "storage_deposit", { account_id: me, registration_only: true }, { deposit: TOKEN_REGISTRATION, gas: "30000000000000" });
                return `Registered on ${info.revenue_token}: claim again to receive it.`;
              })}>Register for {short(info.revenue_token, 18)}</button>
            ) : null}
          </div>
        ) : null}
        <p className="small muted">
          Unlocked shares stay frozen for {Number(BigInt(info.unlock_period_ns) / 3_600_000_000_000n) || "<1"} h, longer than a vote, so the same share cannot vote twice.
        </p>
      </Card>

      <Card title="Share revenue">
        <SentenceList items={[
          { title: "NEAR from the DAO account", details: ["members or shareholders vote it", "goes to this epoch's voters"] },
          ...(token ? [{ title: `${token.symbol} (${token.accountId}) sent to ${data.accountId}`, details: ["for example Base ETH sent by Omni Bridge", "anyone can trigger the split once it arrived"] }] : []),
        ]} />
        <div className="row wrap">
          <label className="inline">Amount<input inputMode="decimal" value={revenue} onChange={(event) => setRevenue(event.target.value)} />NEAR</label>
          <button className="secondary" disabled={!me || Boolean(busy) || !ready} onClick={() => void run("revenue", async () => {
            const draft = await omni.revenueProposal(revenue);
            verifyRevenueDraft(draft, data.accountId, data.daoAccountId, revenue);
            const result = await signDaoProposal(me, draft);
            return `Proposal #${result.proposalId} submitted.`;
          })}>Propose to share it</button>
          {info.revenue_token ? (
            <button className="ghost" disabled={!me || Boolean(busy)} onClick={() => void call("sync", "sync_revenue", {})}>Split bridged revenue</button>
          ) : null}
        </div>
      </Card>
    </>
  );
}
