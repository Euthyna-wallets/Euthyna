import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Kpi } from "../components/ops.js";
import { Card, PageState, Status, short } from "../components/ui.js";
import { marketConsole, slaText, tokenAmount, type Listing } from "../lib/market.js";

const NEAR_EXPLORER = "https://testnet.nearblocks.io/txns";

function NewListing({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ handle: "", title: "", description: "", category: "research", price: "2", slaMinutes: "30", inputHint: "", webhookUrl: "" });
  const create = useMutation({
    mutationFn: () => marketConsole.create({
      handle: form.handle, title: form.title, description: form.description, category: form.category, price: form.price,
      slaSeconds: Math.round(Number(form.slaMinutes) * 60), inputHint: form.inputHint || undefined, webhookUrl: form.webhookUrl || null,
    }),
    onSuccess: onDone,
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <Card title="New listing" action={<button className="ghost" onClick={onDone}>Cancel</button>}>
      {create.error ? <div className="alert error">{create.error.message}</div> : null}
      <div className="stack">
        <div className="row wrap">
          <label>Handle (never changes)<input value={form.handle} onChange={set("handle")} placeholder="defi-due-diligence" /></label>
          <label>Title<input value={form.title} onChange={set("title")} placeholder="DeFi project due diligence" /></label>
          <label>Category
            <select value={form.category} onChange={set("category")}><option>research</option><option>security</option><option>data</option></select>
          </label>
        </div>
        <label>Description<textarea rows={3} value={form.description} onChange={set("description")} /></label>
        <div className="row wrap">
          <label>Price (USDC)<input inputMode="decimal" value={form.price} onChange={set("price")} /></label>
          <label>Delivers within (minutes)<input type="number" min={1} value={form.slaMinutes} onChange={set("slaMinutes")} /></label>
          <label>Input hint<input value={form.inputHint} onChange={set("inputHint")} placeholder="Project name, URL, chain" /></label>
        </div>
        <label>Worker webhook (optional, https)<input value={form.webhookUrl} onChange={set("webhookUrl")} placeholder="https://worker.example.com/hook" /></label>
        <span className="small muted">Paid in USDC on NEAR to the company vault. The listing stays a draft until a worker token exists and you put it live.</span>
        <button className="primary" disabled={create.isPending || !form.handle || !form.title || form.description.length < 10} onClick={() => create.mutate()}>Create listing</button>
      </div>
    </Card>
  );
}

function ListingRow({ listing }: { listing: Listing }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState<{ deliveryToken: string; webhookSecret: string } | null>(null);
  const refresh = () => void client.invalidateQueries({ queryKey: ["market-listings"] });
  const status = useMutation({ mutationFn: (next: Listing["status"]) => marketConsole.update(listing.id, { status: next }), onSuccess: refresh });
  const rotate = useMutation({ mutationFn: () => marketConsole.rotate(listing.id), onSuccess: (value) => { setSecret(value); refresh(); } });
  const error = status.error ?? rotate.error;
  return (
    <li className="listing">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <strong>{listing.title}</strong> <span className="mono small muted">{listing.handle}</span>
          <div className="small muted">{tokenAmount(listing.priceAtomic)} USDC · {slaText(listing.slaSeconds)} · paid to <span className="mono">{short(listing.payTo, 14)}</span></div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Status value={listing.status} />
          {listing.status !== "live"
            ? <button disabled={!listing.hasDeliveryToken || status.isPending} title={listing.hasDeliveryToken ? "" : "Create a worker token first"} onClick={() => status.mutate("live")}>Put live</button>
            : <button onClick={() => status.mutate("paused")}>Pause</button>}
          <button className="ghost" onClick={() => rotate.mutate()}>{listing.hasDeliveryToken ? "Rotate worker token" : "Create worker token"}</button>
        </div>
      </div>
      {error ? <div className="alert error">{error.message}</div> : null}
      {secret ? (
        <div className="alert">
          <strong>Shown once.</strong> Give these to the worker (MARKET_DELIVERY_TOKEN, WEBHOOK_SECRET); the previous token stops working now.
          <div className="mono small" style={{ wordBreak: "break-all", marginTop: 6 }}>MARKET_DELIVERY_TOKEN={secret.deliveryToken}</div>
          <div className="mono small" style={{ wordBreak: "break-all" }}>WEBHOOK_SECRET={secret.webhookSecret}</div>
          <button className="ghost" onClick={() => void navigator.clipboard.writeText(`MARKET_DELIVERY_TOKEN=${secret.deliveryToken}\nWEBHOOK_SECRET=${secret.webhookSecret}`)}>Copy</button>
        </div>
      ) : null}
    </li>
  );
}

/** The company as a seller: listings, worker tokens, sales and revenue. */
export function MarketConsolePage() {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const listings = useQuery({ queryKey: ["market-listings"], queryFn: marketConsole.listings });
  const sales = useQuery({ queryKey: ["market-sales"], queryFn: marketConsole.sales, refetchInterval: 15_000 });
  const purchases = useQuery({ queryKey: ["market-purchases"], queryFn: marketConsole.purchases, refetchInterval: 30_000 });
  const settled = (sales.data?.sales ?? []).filter((sale) => sale.holdState === "settled" || sale.holdState === "prepaid").length;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Euthyna Market</span>
          <h1>Market</h1>
          <p className="muted">What your company sells to other agents and people, and what its agents bought. <Link to="/market" style={{ color: "var(--cyan)" }}>See the public market →</Link></p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>New listing</button>
      </header>
      <div className="kpis">
        <Kpi label="Revenue" value={sales.data ? `${tokenAmount(sales.data.revenueAtomic)} USDC` : "…"} hint="paid to the vault" tone="cyan" />
        <Kpi label="Sales" value={sales.data ? settled : "…"} hint={`${sales.data?.sales.length ?? 0} orders`} />
        <Kpi label="Purchases" value={purchases.data ? `${tokenAmount(purchases.data.spentAtomic)} USDC` : "…"} hint={`${purchases.data?.purchases.length ?? 0} by your agents`} />
      </div>
      {creating ? <NewListing onDone={() => { setCreating(false); void client.invalidateQueries({ queryKey: ["market-listings"] }); }} /> : null}
      <Card title="Listings">
        <PageState loading={listings.isLoading} error={listings.error} empty={!listings.data?.listings.length} emptyContent={<div className="state">No listing yet. Create one, run its worker, then put it live.</div>}>
          <ul className="listings">{listings.data?.listings.map((listing) => <ListingRow key={listing.id} listing={listing} />)}</ul>
        </PageState>
      </Card>
      <Card title="Sales">
        <PageState loading={sales.isLoading} error={sales.error} empty={!sales.data?.sales.length}>
          <table className="table">
            <thead><tr><th>When</th><th>Service</th><th>Buyer</th><th>Price</th><th>State</th><th>Payment</th></tr></thead>
            <tbody>
              {sales.data?.sales.map((sale) => (
                <tr key={sale.taskId}>
                  <td className="small">{new Date(sale.createdAt).toLocaleString()}</td>
                  <td><Link to={`/market/task/${sale.taskId}`}>{sale.title}</Link></td>
                  <td className="mono small">{short(sale.buyer, 14)}</td>
                  <td>{tokenAmount(sale.amount)} USDC</td>
                  <td><Status value={sale.state} /></td>
                  <td>{sale.settleTxHash ? <a href={`${NEAR_EXPLORER}/${sale.settleTxHash}`} target="_blank" rel="noreferrer">{sale.holdState} ↗</a> : sale.holdState ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PageState>
      </Card>
    </div>
  );
}
