/**
 * Sealed orders: limit orders the treasury places without showing them. The browser picks the terms,
 * hashes them (Poseidon2) and asks the members to seal the hash; the terms leave only as the order
 * file the member keeps for the watcher. On chain, and on this page, an order is a hash and what it
 * has filled.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  BASE_SEPOLIA_UNISWAP as U,
  randomSalt,
  rateFromPrice,
  sealedConfigureKind,
  sealedSealKind,
  serializeOrder,
  type SealedOrder,
} from "@euthyna/sdk/sealed-orders";

import { Kicker, Slab } from "../components/design.js";
import { commitmentOf, downloadOrderFile } from "../lib/sealed-order.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type SealedView } from "../omniroles-api.js";
import { signDaoProposal } from "../wallets.js";

const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--ink-2)" };
const SLIPPAGE_BPS = 50;

/** Every draft must be a proposal to this DAO; the ones to the sealed contract must match what this page builds. */
function checkDraft(draft: ProposalDraft, view: SealedView, expected?: unknown) {
  if (draft.receiverId !== view.daoAccountId) throw new Error("The server returned a proposal for another DAO: nothing was signed.");
  if (expected && JSON.stringify(draft.args.proposal.kind) !== JSON.stringify(expected)) {
    throw new Error("The server returned an unexpected proposal: nothing was signed.");
  }
}

export function SealedOrdersCard() {
  const wallets = useWallets();
  const query = useQuery({ queryKey: ["omni-sealed"], queryFn: omni.sealed, refetchInterval: 30_000 });
  const [budget, setBudget] = useState("100");
  const [approval, setApproval] = useState("1000");
  const [price, setPrice] = useState("");
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const view = query.data;
  if (!view?.enabled || !view.sealedAccountId) return null;
  const me = wallets.nearAccountId;
  const sealedId = view.sealedAccountId;
  const ready = Boolean(view.config) && view.roleReady;

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
      await query.refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const turnOn = () => run(async () => {
    const drafts = await omni.sealedSetup({ budgetUsdc: budget, periodDays: 1, maxApprovalUsdc: approval, slippageBps: SLIPPAGE_BPS });
    const configure = sealedConfigureKind(sealedId, { vault: view.vaultAccountId, chainId: U.chainId, router: U.router, slippageBps: SLIPPAGE_BPS });
    drafts.forEach((draft, index) => checkDraft(draft, view, index === 1 ? configure : undefined));
    const ids: number[] = [];
    for (const draft of drafts) ids.push((await signDaoProposal(me!, draft)).proposalId);
    return `Proposals #${ids.join(", #")} submitted: the role, the contract's settings and the router approval. Members approve them in Decisions.`;
  });

  const seal = () => run(async () => {
    const order: SealedOrder = {
      vaultId: view.vaultAccountId,
      chainId: U.chainId,
      tokenIn: U.usdc,
      tokenOut: U.weth,
      fee: 3000,
      limitRate: rateFromPrice(Number(price), 6, 18),
      cap: parseUnits(cap, 6),
      expiry: Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86_400),
      salt: randomSalt(),
    };
    const commitment = await commitmentOf(order);
    const draft = await omni.sealedSeal(commitment);
    checkDraft(draft, view, sealedSealKind(sealedId, commitment));
    const { proposalId } = await signDaoProposal(me!, draft);
    // The id the contract will give, if no other seal passes first: the watcher checks it.
    const id = view.config?.next_id ?? 0;
    downloadOrderFile(`sealed-order-${commitment.slice(2, 10)}.json`, { order: serializeOrder(order), dao: view.daoAccountId, id, sealedAccountId: sealedId, commitment });
    setPrice("");
    setCap("");
    return `Proposal #${proposalId} seals hash ${commitment.slice(0, 10)}…. The order file was saved: it is the only copy of the terms. Keep it, and run the watcher with it once the vote passes.`;
  });

  const cancel = (id: number) => run(async () => {
    const draft = await omni.sealedCancel(id);
    checkDraft(draft, view);
    return `Proposal #${(await signDaoProposal(me!, draft)).proposalId} cancels order #${id}.`;
  });

  return (
    <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
      <Kicker>Sealed orders</Kicker>
      <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
        Buy WETH with USDC on Uniswap when the price reaches a limit nobody else sees. The chain holds one hash per order;
        a fill proves in zero knowledge that it meets the hidden limit, size and deadline, and the vault still checks the role.
      </p>

      {!ready ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 13 }}>{view.config ? "Waiting for the role to apply (veto window)." : "Not turned on for this company yet. Three votes: the role, the contract's settings, the router approval."}</span>
          {!view.config ? (
            <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
              <label style={label}>Most USDC a day<input value={budget} inputMode="decimal" onChange={(event) => setBudget(event.target.value)} /></label>
              <label style={label}>Router approval (USDC)<input value={approval} inputMode="decimal" onChange={(event) => setApproval(event.target.value)} /></label>
              <button className="btn" disabled={!me || busy} onClick={() => void turnOn()}>Propose: turn on sealed orders</button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
          <label style={label}>Buy when 1 WETH costs at most (USDC)<input value={price} inputMode="decimal" placeholder="1800" onChange={(event) => setPrice(event.target.value)} /></label>
          <label style={label}>Spend at most (USDC, in all)<input value={cap} inputMode="decimal" placeholder="50" onChange={(event) => setCap(event.target.value)} /></label>
          <label style={label}>Valid for (days)<input value={days} inputMode="numeric" onChange={(event) => setDays(event.target.value)} /></label>
          <button className="btn" disabled={!me || busy || !(Number(price) > 0) || !(Number(cap) > 0) || !(Number(days) > 0)} onClick={() => void seal()}>Propose: seal this order</button>
        </div>
      )}

      {view.orders.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {view.orders.map((order) => (
            <div key={order.id} className="row wrap" style={{ justifyContent: "space-between", fontSize: 12.5, borderTop: "1px solid rgba(13,23,48,.12)", paddingTop: 6 }}>
              <span className="mono">#{order.id} · {order.commitment.slice(0, 10)}…{order.commitment.slice(-4)}</span>
              <span>{formatUnits(BigInt(order.filled), 6)} USDC in {order.fills} fill{order.fills === 1 ? "" : "s"} · {order.cancelled ? "cancelled" : "open"}</span>
              {!order.cancelled ? <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!me || busy} onClick={() => void cancel(order.id)}>Propose cancel</button> : null}
            </div>
          ))}
        </div>
      ) : null}
      {!me ? <p style={{ margin: 0, fontSize: 12, color: "var(--ink-2)" }}>Connect your NEAR wallet to propose.</p> : null}
      {message ? <p style={{ margin: 0, fontSize: 12.5 }}>{message}</p> : null}
    </Slab>
  );
}
