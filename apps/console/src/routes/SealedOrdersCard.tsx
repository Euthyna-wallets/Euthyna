/**
 * Sealed orders: limit orders the treasury places without showing them. Turned on in a swap role
 * ("Allow sealed orders"); placed here by a vote, or by an agent of that role over MCP. The chain
 * holds a hash per order; the terms travel encrypted to the members' reading keys, which each member
 * derives from a signature of their own wallet and registers once.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { formatUnits, parseUnits } from "viem";
import {
  BASE_SEPOLIA_UNISWAP as U,
  decryptTerms,
  encryptTerms,
  publicKeyBase64,
  randomSalt,
  rateFromPrice,
  RATE_SCALE,
  readerKeyFromSignature,
  readerMessage,
  SEALED_DEPOSIT_YOCTO,
  sealedOrderKind,
  serializeOrder,
  type SealedOrder,
} from "@euthyna/sdk/sealed-orders";

import { Kicker, Slab } from "../components/design.js";
import { commitmentOf, downloadOrderFile } from "../lib/sealed-order.js";
import { useWallets } from "../lib/wallet-context.js";
import { omni, type ProposalDraft, type SealedView } from "../omniroles-api.js";
import { signContractCall, signDaoProposal, signNearMessage } from "../wallets.js";

const SLIPPAGE_BPS = 50;
const label: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };
const num = (width: number): React.CSSProperties => ({ width, minWidth: 0, padding: "6px 10px" });
const small: React.CSSProperties = { fontSize: 12.5, color: "var(--ink-2)" };
const tile: React.CSSProperties = { flex: "1 1 220px", padding: "10px 12px", border: "1px solid rgba(13,23,48,.12)", background: "rgba(255,255,255,.55)", fontSize: 13 };

/** USDC per WETH from a rate (WETH wei per USDC unit, ×1e18). */
function priceOf(limitRate: bigint): string {
  if (limitRate === 0n) return "?";
  return (Number((10n ** 12n * RATE_SCALE * 100n) / limitRate) / 100).toLocaleString("en-US");
}

function checkDraft(draft: ProposalDraft, view: SealedView, expected: unknown) {
  if (draft.receiverId !== view.daoAccountId || JSON.stringify(draft.args.proposal.kind) !== JSON.stringify(expected)) {
    throw new Error("The server returned an unexpected proposal: nothing was signed.");
  }
}

async function readerKey(vault: string) {
  const message = readerMessage(vault);
  const signed = await signNearMessage({ message: message.message, recipient: message.recipient, nonceBase64: btoa(String.fromCharCode(...message.nonce)) });
  const signature = Uint8Array.from(atob(String(signed.signature)), (char) => char.charCodeAt(0));
  return readerKeyFromSignature(signature);
}

export function SealedOrdersCard() {
  const wallets = useWallets();
  const query = useQuery({ queryKey: ["omni-sealed"], queryFn: omni.sealed, refetchInterval: 30_000 });
  const [role, setRole] = useState("");
  const [price, setPrice] = useState("");
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [terms, setTerms] = useState<Record<number, SealedOrder | null>>({});
  const view = query.data;
  if (!view?.enabled || !view.sealedAccountId) return null;
  const me = wallets.nearAccountId;
  const sealedId = view.sealedAccountId;
  const roleName = role || view.roles[0]?.name || "";
  const registered = Boolean(me && view.readers.some((reader) => reader.account === me));

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

  const register = () => run(async () => {
    const key = await readerKey(view.vaultAccountId);
    await signContractCall(me!, sealedId, "register_reader", { vault: view.vaultAccountId, public_key: publicKeyBase64(key.publicKey) }, { deposit: SEALED_DEPOSIT_YOCTO, gas: "80000000000000" });
    return "Your reading key is registered: the next orders are encrypted for you too.";
  });

  const unlock = () => run(async () => {
    const key = await readerKey(view.vaultAccountId);
    const opened: Record<number, SealedOrder | null> = {};
    for (const order of view.orders) {
      opened[order.id] = order.terms ? await decryptTerms(order.terms, me!, key.privateKey).catch(() => null) : null;
    }
    setTerms(opened);
    const count = Object.values(opened).filter(Boolean).length;
    return count ? `${count} order${count === 1 ? "" : "s"} unlocked, in this browser only.` : "No order was encrypted for your key yet.";
  });

  const propose = () => run(async () => {
    const order: SealedOrder = {
      vaultId: view.vaultAccountId, chainId: U.chainId, tokenIn: U.usdc, tokenOut: U.weth, fee: 3000,
      limitRate: rateFromPrice(Number(price), 6, 18), cap: parseUnits(cap, 6),
      expiry: Math.floor(Date.now() / 1000) + Math.round(Number(days) * 86_400), salt: randomSalt(),
    };
    const commitment = await commitmentOf(order);
    const encrypted = view.readers.length
      ? await encryptTerms(order, view.readers.map((reader) => ({ account: reader.account, publicKey: reader.public_key })))
      : null;
    // The router needs an approval when the wallet's is under the order: the role's budget, a public number.
    const budget = view.roles.find((item) => item.name === roleName)?.budgets.find((item) => item.token === "USDC")?.max ?? cap;
    const needsApproval = view.allowance === null || BigInt(view.allowance) < order.cap;
    const draft = await omni.sealedOrder({ role: roleName, commitment, slippageBps: SLIPPAGE_BPS, terms: encrypted, approveUsdc: needsApproval ? budget : null });
    const seal = { vault: view.vaultAccountId, role: roleName, chainId: U.chainId, commitment, slippageBps: SLIPPAGE_BPS, terms: encrypted };
    const expectedApprove = (draft.args.proposal.kind as { FunctionCall: { actions: unknown[] } }).FunctionCall.actions.length === 2;
    if (needsApproval !== expectedApprove) throw new Error("The server returned an unexpected proposal: nothing was signed.");
    const kind = draft.args.proposal.kind as ReturnType<typeof sealedOrderKind>;
    checkDraft(draft, view, needsApproval ? { FunctionCall: { receiver_id: sealedId, actions: [kind.FunctionCall.actions[0], sealedOrderKind(sealedId, seal).FunctionCall.actions[0]] } } : sealedOrderKind(sealedId, seal));
    const { proposalId } = await signDaoProposal(me!, draft);
    const guessedId = view.orders.reduce((max, item) => Math.max(max, item.id + 1), 0);
    downloadOrderFile(`sealed-order-${commitment.slice(2, 10)}.json`, { order: serializeOrder(order), vault: view.vaultAccountId, role: roleName, id: guessedId, sealedAccountId: sealedId, commitment });
    setPrice("");
    setCap("");
    return `Proposal #${proposalId}: seal hash ${commitment.slice(0, 10)}…${needsApproval ? " (with the router approval)" : ""}. `
      + `${encrypted ? `Terms encrypted for ${view.readers.length} member key${view.readers.length === 1 ? "" : "s"}. ` : ""}`
      + "The order file was saved: run the watcher with it once the vote passes.";
  });

  const cancel = (id: number) => run(async () => {
    const draft = await omni.sealedCancel(id);
    if (draft.receiverId !== view.daoAccountId) throw new Error("The server returned a proposal for another DAO: nothing was signed.");
    return `Proposal #${(await signDaoProposal(me!, draft)).proposalId} cancels order #${id}.`;
  });

  return (
    <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", alignItems: "stretch", gap: 14, textAlign: "left" }}>
      <Kicker>Sealed orders</Kicker>
      <p style={{ margin: 0, fontSize: 13.5 }}>
        Limit orders nobody else sees. The chain stores one hash per order; when the market reaches the limit, a zero-knowledge
        proof shows the fill respects it, and the vault still checks the role.
      </p>

      {view.roles.length === 0 ? (
        <div style={{ ...tile, flex: "none" }}>
          Not turned on yet. In <Link to="/roles">Rules</Link>, open a role with a swap block on Uniswap and tick
          <strong> Allow sealed orders</strong>; it applies after the members' vote.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 15 }}>
            <span>Buy <strong>WETH</strong> with up to</span>
            <span style={label}><input value={cap} inputMode="decimal" placeholder="50" style={num(80)} onChange={(event) => setCap(event.target.value)} /> USDC</span>
            <span>when 1 WETH costs at most</span>
            <span style={label}><input value={price} inputMode="decimal" placeholder="1800" style={num(90)} onChange={(event) => setPrice(event.target.value)} /> USDC,</span>
            <span>within</span>
            <span style={label}><input value={days} inputMode="numeric" style={num(54)} onChange={(event) => setDays(event.target.value)} /> days</span>
            {view.roles.length > 1 ? (
              <span style={label}>through
                <select value={roleName} onChange={(event) => setRole(event.target.value)}>
                  {view.roles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
              </span>
            ) : <span style={small}>through the role {roleName}</span>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <div style={tile}><div style={small}>Hidden, before and after</div>The price limit, the total and the deadline</div>
            <div style={tile}><div style={small}>Public at each fill</div>The amount, the price obtained, the company wallet</div>
            <div style={tile}><div style={small}>Who reads the terms</div>
              {view.readers.length ? `${view.readers.length} member${view.readers.length === 1 ? "" : "s"} with a reading key` : "Nobody yet: register your key below"}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={small}>One vote of the members. Then the watcher fills it when the market gets there.</span>
            <button className="btn" disabled={!me || busy || !(Number(price) > 0) || !(Number(cap) > 0) || !(Number(days) > 0)} onClick={() => void propose()}>Propose this order</button>
          </div>
        </>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", borderTop: "1px solid rgba(13,23,48,.12)", paddingTop: 10 }}>
        <span style={small}>
          {registered ? "Your reading key is registered. Unlocking signs a message with your wallet; nothing is sent." : "Members read the terms with a key derived from a signature of their wallet, registered once."}
        </span>
        {me && !registered ? <button className="btn" disabled={busy} onClick={() => void register()}>Register my reading key</button> : null}
        {me && registered && view.orders.some((order) => order.terms) ? <button className="btn" disabled={busy} onClick={() => void unlock()}>Show the terms</button> : null}
      </div>

      {view.orders.length ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {view.orders.map((order) => {
            const opened = terms[order.id];
            const by = order.sealer === view.daoAccountId ? "a vote" : order.sealer;
            return (
              <div key={order.id} style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid rgba(13,23,48,.12)", padding: "8px 0", fontSize: 13 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span className="mono">#{order.id} · {order.commitment.slice(0, 10)}…{order.commitment.slice(-4)}</span>
                  <span>{formatUnits(BigInt(order.filled), 6)} USDC filled in {order.fills} fill{order.fills === 1 ? "" : "s"} · {order.cancelled ? "cancelled" : "open"}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, ...small }}>
                  <span>Placed by {by} · role {order.role}</span>
                  {opened ? (
                    <span>≤ {priceOf(opened.limitRate)} USDC/WETH · up to {formatUnits(opened.cap, 6)} USDC · until {new Date(opened.expiry * 1000).toLocaleDateString()}</span>
                  ) : <span>{order.terms ? "Terms encrypted" : "Terms only in the order file"}</span>}
                  {!order.cancelled ? <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} disabled={!me || busy} onClick={() => void cancel(order.id)}>Propose cancel</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {!me ? <p style={{ margin: 0, ...small }}>Connect your NEAR wallet to propose or read orders.</p> : null}
      {message ? <p style={{ margin: 0, fontSize: 12.5 }}>{message}</p> : null}
    </Slab>
  );
}
