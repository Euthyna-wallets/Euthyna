import { NEAR_TESTNET_TOKENS } from "@euthyna/sdk/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Kicker, PageTitle, Seal, SectionHead, Slab, NightPanel, SpendingCard } from "../components/design.js";
import { PageState, short } from "../components/ui.js";

import { marketConsole, slaText, tokenAmount, type Listing, type Sale } from "../lib/market.js";

const NEAR_EXPLORER = "https://testnet.nearblocks.io/txns";

/** Same wording as Activity: what the market does with the money. */
const PAYMENT_TEXT: Record<string, string> = {
  held: "Buyer's signed cheque held by the market, paid on delivery",
  settling: "Delivered: the market relays the cheque",
  settled: "Paid on NEAR after delivery",
  prepaid: "Paid upfront from a browser wallet, checked on NEAR",
  failed: "The cheque could not be paid (balance or nonce changed)",
  expired: "Not delivered in time: the cheque was never relayed",
};

const SEAL_OF_HOLD: Record<string, { word: string; tone?: "refused" | "expired" }> = {
  held: { word: "HELD" },
  settling: { word: "SETTLING" },
  settled: { word: "SETTLED" },
  prepaid: { word: "SETTLED" },
  failed: { word: "FAILED", tone: "refused" },
  expired: { word: "EXPIRED", tone: "expired" },
};

const LINK_BUTTON = {
  border: 0,
  background: "none",
  padding: 0,
  color: "#4A5675",
  font: "600 12.5px var(--font-ui)",
  cursor: "pointer",
} as const;

function tagStyle(status: Listing["status"]) {
  return {
    font: "700 10px var(--font-brand)",
    letterSpacing: ".18em",
    padding: "4px 9px",
    borderRadius: 2,
    background: status === "live" ? "#DDF4F8" : status === "paused" ? "#FBE3D6" : "#ECE6DA",
    color: status === "live" ? "#0B6E86" : status === "paused" ? "#A8381E" : "#66718C",
  };
}

/** The name inside an agent's account (`naomi-card.vault.testnet` → `naomi`). */
function agentName(account: string): string {
  const match = /^(.+?)-(?:agent|card)\./.exec(account);
  return (match?.[1] ?? account).replaceAll(/[-_]/g, " ");
}

function saleSeal(sale: Sale): { word: string; tone?: "refused" | "expired" } {
  const fromHold = sale.holdState ? SEAL_OF_HOLD[sale.holdState] : undefined;
  if (fromHold) return fromHold;
  if (sale.state === "completed" || sale.state === "completed_unpaid") return { word: "DELIVERED" };
  if (sale.state === "failed") return { word: "FAILED", tone: "refused" };
  if (sale.state === "expired") return { word: "EXPIRED", tone: "expired" };
  return { word: "QUEUED" };
}

type Step = { word: string; tone?: "refused" | "expired"; title: string; body: ReactNode };

/** The steps this purchase actually went through: only the seals the data shows. */
function purchaseSteps(purchase: Sale): Step[] {
  const amount = `${tokenAmount(purchase.amount)} USDC`;
  const steps: Step[] = [
    {
      word: "ASKED",
      title: `hire_agent · @${purchase.handle}`,
      body: `${agentName(purchase.buyer)} asks for “${purchase.title}” at ${amount}.`,
    },
  ];
  const hold = purchase.holdState;
  if (hold === "held" || hold === "settling" || hold === "settled" || hold === "expired") {
    steps.push({ word: "HELD", title: "One cheque, signed and held", body: PAYMENT_TEXT["held"] ?? "" });
  }
  if (purchase.state === "completed" && hold !== "settling") {
    steps.push({ word: "DELIVERED", title: "The seller’s worker delivers", body: "The result reaches the buyer as data from another company." });
  }
  if (purchase.state === "completed_unpaid") {
    steps.push({ word: "DELIVERED", title: "Delivered, no cheque held", body: "The seller delivered; nothing was paid." });
  }
  if (hold === "settling") {
    steps.push({ word: "SETTLING", title: "The market relays the cheque", body: PAYMENT_TEXT["settling"] ?? "" });
  }
  if (hold === "settled" || hold === "prepaid") {
    steps.push({
      word: "PAID",
      title: hold === "prepaid" ? "Paid upfront" : "Paid on NEAR after delivery",
      body: (
        <>
          {PAYMENT_TEXT[hold] ?? ""} · ft_transfer from the card to the seller’s vault
          {purchase.settleTxHash ? (
            <>
              {" · "}
              <a href={`${NEAR_EXPLORER}/${purchase.settleTxHash}`} target="_blank" rel="noreferrer" className="mono" style={{ color: "#8FE3F1" }}>
                {short(purchase.settleTxHash)} ↗
              </a>
            </>
          ) : null}
        </>
      ),
    });
  }
  if (hold === "failed") {
    steps.push({ word: "FAILED", tone: "refused", title: "The cheque could not be paid", body: PAYMENT_TEXT["failed"] ?? "" });
  }
  if (hold === "expired") {
    steps.push({ word: "EXPIRED", tone: "expired", title: "Not delivered in time", body: PAYMENT_TEXT["expired"] ?? "" });
  }
  return steps;
}

function NewListing({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ handle: "", title: "", description: "", category: "research", price: "2", asset: "USDC", slaMinutes: "30", inputHint: "", webhookUrl: "" });
  const create = useMutation({
    mutationFn: () => marketConsole.create({
      handle: form.handle, title: form.title, description: form.description, category: form.category, price: form.price, asset: form.asset,
      slaSeconds: Math.round(Number(form.slaMinutes) * 60), inputHint: form.inputHint || undefined, webhookUrl: form.webhookUrl || null,
    }),
    onSuccess: onDone,
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const column = { display: "flex", flexDirection: "column", gap: 6 } as const;
  return (
    <Slab style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
      <SectionHead left={<Kicker>New listing</Kicker>} right={<button className="btn-line" onClick={onDone}>CANCEL</button>} />
      {create.error ? <div className="alert error" style={{ margin: 0 }}>{create.error.message}</div> : null}
      <div className="field-app" style={{ gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          <label style={column}>Handle (never changes)<input value={form.handle} onChange={set("handle")} placeholder="defi-due-diligence" /></label>
          <label style={column}>Title<input value={form.title} onChange={set("title")} placeholder="DeFi project due diligence" /></label>
          <label style={column}>Category
            <select value={form.category} onChange={set("category")}><option>research</option><option>security</option><option>data</option></select>
          </label>
        </div>
        <label style={column}>Description<textarea rows={3} value={form.description} onChange={set("description")} /></label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          <label style={column}>Price<input inputMode="decimal" value={form.price} onChange={set("price")} /></label>
          {/* TestUSDC can be minted by anyone on testnet: what a tester can pay with. */}
          <label style={column}>Paid in
            <select value={form.asset} onChange={set("asset")}>{NEAR_TESTNET_TOKENS.map((token) => <option key={token.symbol} value={token.symbol}>{token.symbol}</option>)}</select>
          </label>
          <label style={column}>Delivers within (minutes)<input type="number" min={1} value={form.slaMinutes} onChange={set("slaMinutes")} /></label>
          <label style={column}>Input hint<input value={form.inputHint} onChange={set("inputHint")} placeholder="Project name, URL, chain" /></label>
        </div>
        <label style={column}>Worker webhook (optional, https)<input value={form.webhookUrl} onChange={set("webhookUrl")} placeholder="https://worker.example.com/hook" /></label>
        <span style={{ fontSize: 13, color: "#4A5675" }}>Paid in {form.asset} on NEAR to the company vault, which must be able to receive it: vote a role that pays in that token first (Rules, + Pay in NEAR tokens). The listing stays a draft until a worker token exists and you put it live.</span>
        <button className="btn-ori" style={{ alignSelf: "flex-start" }} disabled={create.isPending || !form.handle || !form.title || form.description.length < 10} onClick={() => create.mutate()}>CREATE LISTING</button>
      </div>
    </Slab>
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
    <li style={{ padding: "13px 18px", borderTop: "1px solid rgba(13,23,48,.12)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 14, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <div>
            <b style={{ fontSize: 15 }}>{listing.title}</b>{" "}
            <span className="mono" style={{ fontSize: 12, color: "#66718C" }}>@{listing.handle}</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: "#4A5675" }}>
            <b className="mono" style={{ color: "#0D1730" }}>{tokenAmount(listing.priceAtomic)} USDC</b> · within {slaText(listing.slaSeconds)} · paid to{" "}
            <span className="mono">{short(listing.payTo, 14)}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <span style={tagStyle(listing.status)}>{listing.status.toUpperCase()}</span>
          {listing.status !== "live"
            ? <button style={LINK_BUTTON} disabled={!listing.hasDeliveryToken || status.isPending} title={listing.hasDeliveryToken ? "" : "Create a worker token first"} onClick={() => status.mutate("live")}>Put live</button>
            : <button style={LINK_BUTTON} onClick={() => status.mutate("paused")}>Pause</button>}
          <button style={LINK_BUTTON} onClick={() => rotate.mutate()}>{listing.hasDeliveryToken ? "Rotate worker token" : "Create worker token"}</button>
        </div>
      </div>
      {error ? <div className="alert error" style={{ margin: "10px 0 0", fontSize: 13, padding: "10px 12px" }}>{error.message}</div> : null}
      {secret ? (
        <div className="alert" style={{ margin: "10px 0 0", fontSize: 13, padding: "10px 12px" }}>
          <strong>Shown once.</strong> Give these to the worker (MARKET_DELIVERY_TOKEN, WEBHOOK_SECRET); the previous token stops working now.
          <div className="mono small" style={{ wordBreak: "break-all", marginTop: 6 }}>MARKET_DELIVERY_TOKEN={secret.deliveryToken}</div>
          <div className="mono small" style={{ wordBreak: "break-all" }}>WEBHOOK_SECRET={secret.webhookSecret}</div>
          <button className="btn-line" style={{ marginTop: 8, padding: "8px 14px" }} onClick={() => void navigator.clipboard.writeText(`MARKET_DELIVERY_TOKEN=${secret.deliveryToken}\nWEBHOOK_SECRET=${secret.webhookSecret}`)}>COPY</button>
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

  const purchaseRows = purchases.data?.purchases ?? [];
  const featured = purchaseRows.find((purchase) => purchase.settleTxHash) ?? purchaseRows[0] ?? null;
  const featuredSpent = featured
    ? purchaseRows
      .filter((purchase) => purchase.buyer === featured.buyer && (purchase.holdState === "settled" || purchase.holdState === "prepaid"))
      .reduce((sum, purchase) => sum + BigInt(purchase.amount ?? "0"), 0n)
    : 0n;
  const steps = featured ? purchaseSteps(featured) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span style={{ font: "600 12px var(--font-ui)", color: "#66718C" }}>Euthyna Market · the agora</span>
          <PageTitle style={{ fontSize: 40, lineHeight: 1, letterSpacing: ".12em" }}>Market</PageTitle>
          <span style={{ fontSize: 14, color: "#4A5675" }}>What your company sells to other agents and people, and what its agents bought.</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link to="/market" className="btn-line">PUBLIC MARKET ↗</Link>
          <button className="btn-ori" onClick={() => setCreating(true)}>NEW LISTING</button>
        </div>
      </header>

      <div className="g3" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", boxShadow: "14px 18px 40px rgba(13,23,48,.14)" }}>
        <Slab style={{ padding: "14px 22px", boxShadow: "none", borderRight: "1px solid rgba(13,23,48,.1)" }}>
          <Kicker>Revenue</Kicker>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
            <b className="mono" style={{ fontSize: 32, color: "#0D1730" }}>{sales.data ? tokenAmount(sales.data.revenueAtomic) : "…"}</b>
            <span style={{ fontSize: 13, color: "#4A5675" }}>USDC paid to the vault</span>
          </div>
        </Slab>
        <Slab style={{ padding: "14px 22px", boxShadow: "none", borderRight: "1px solid rgba(13,23,48,.1)" }}>
          <Kicker>Sales</Kicker>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
            <b className="mono" style={{ fontSize: 32, color: "#0D1730" }}>{sales.data ? settled : "…"}</b>
            <span style={{ fontSize: 13, color: "#4A5675" }}>{sales.data ? `paid, of ${sales.data.sales.length} orders` : "paid, of your orders"}</span>
          </div>
        </Slab>
        <Slab style={{ padding: "14px 22px", boxShadow: "none" }}>
          <Kicker>Purchases</Kicker>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
            <b className="mono" style={{ fontSize: 32, color: "#0D1730" }}>{purchases.data ? tokenAmount(purchases.data.spentAtomic) : "…"}</b>
            <span style={{ fontSize: 13, color: "#4A5675" }}>{purchases.data ? `USDC spent · ${purchases.data.purchases.length} purchases by your agents` : "USDC spent by your agents"}</span>
          </div>
        </Slab>
      </div>

      {creating ? <NewListing onDone={() => { setCreating(false); void client.invalidateQueries({ queryKey: ["market-listings"] }); }} /> : null}

      <div className="g2" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.12fr) minmax(0, .88fr)", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <Slab style={{ padding: "14px 0 2px", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "0 18px 10px" }}>
              <SectionHead
                left={<Kicker>Your stalls · {listings.data?.listings.length ?? 0} listings</Kicker>}
                right={<span style={{ fontSize: 12, color: "#66718C" }}>Live once its worker has a token</span>}
              />
            </div>
            <PageState
              loading={listings.isLoading}
              error={listings.error}
              empty={!listings.data?.listings.length}
              emptyContent={<div className="empty-state" style={{ padding: "8px 18px 16px" }}>No listing yet. Create one, run its worker, then put it live.</div>}
            >
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {listings.data?.listings.map((listing) => <ListingRow key={listing.id} listing={listing} />)}
              </ul>
            </PageState>
          </Slab>

          <Slab style={{ padding: "14px 18px 6px", display: "flex", flexDirection: "column" }}>
            <SectionHead
              left={<Kicker>Sales · paid on delivery</Kicker>}
              right={<Link to="/activity" className="section-link">ALL SALES →</Link>}
            />
            <div style={{ marginTop: 6 }}>
              <PageState loading={sales.isLoading} error={sales.error} empty={!sales.data?.sales.length}>
                {sales.data?.sales.map((sale) => {
                  const seal = saleSeal(sale);
                  const payment = sale.holdState ? PAYMENT_TEXT[sale.holdState] ?? sale.holdState : "No payment held";
                  return (
                    <div key={sale.taskId} style={{ display: "grid", gridTemplateColumns: "42px minmax(0, 1.3fr) minmax(0, 1.1fr) 78px", gap: 12, alignItems: "center", padding: "9px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13 }}>
                      <Seal word={seal.word} size={38} {...(seal.tone ? { tone: seal.tone } : {})} />
                      <div style={{ minWidth: 0 }}>
                        <Link to={`/market/task/${sale.taskId}`} style={{ fontWeight: 700, color: "#0D1730", textDecoration: "none" }}>{sale.title}</Link>
                        <div style={{ color: "#66718C" }}><small>{new Date(sale.createdAt).toLocaleString()} · {sale.state}</small></div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <span className="mono" style={{ fontSize: 11.5, color: "#4A5675", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sale.buyer}</span>
                        <small style={{ color: "#4A5675" }}>
                          {sale.settleTxHash
                            ? <a href={`${NEAR_EXPLORER}/${sale.settleTxHash}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{payment} ↗</a>
                            : payment}
                        </small>
                      </div>
                      <b className="mono" style={{ textAlign: "right" }}>{tokenAmount(sale.amount)} USDC</b>
                    </div>
                  );
                })}
              </PageState>
            </div>
          </Slab>

          <Slab style={{ padding: "14px 18px 6px", display: "flex", flexDirection: "column" }}>
            <SectionHead
              left={<Kicker>Bought by your agents</Kicker>}
              right={<span style={{ fontSize: 12, color: "#66718C" }}>From their spending cards, within their mandate</span>}
            />
            <div style={{ marginTop: 6 }}>
              <PageState loading={purchases.isLoading} error={purchases.error} empty={!purchaseRows.length}>
                {purchaseRows.map((purchase) => {
                  const seal = saleSeal(purchase);
                  return (
                    <div key={purchase.taskId} style={{ display: "grid", gridTemplateColumns: "42px minmax(0, 1fr) auto 78px", gap: 12, alignItems: "center", padding: "9px 0", borderTop: "1px solid rgba(13,23,48,.1)", fontSize: 13 }}>
                      <Seal word={seal.word} size={38} {...(seal.tone ? { tone: seal.tone } : {})} />
                      <div style={{ minWidth: 0 }}>
                        <b>{purchase.title}</b>
                        <div style={{ color: "#66718C" }}><small>from @{purchase.handle} · {new Date(purchase.createdAt).toLocaleString()}</small></div>
                      </div>
                      <b style={{ font: "800 12px var(--font-brand)", letterSpacing: ".14em", color: "#4A5675", textTransform: "uppercase" }}>{short(agentName(purchase.buyer), 12)}</b>
                      <b className="mono" style={{ textAlign: "right" }}>{tokenAmount(purchase.amount)} USDC</b>
                    </div>
                  );
                })}
              </PageState>
            </div>
          </Slab>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <NightPanel style={{ padding: "18px 22px 8px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              <Kicker color="#F2B544">A purchase, sealed at each step</Kicker>
              <span style={{ fontSize: 13, color: "#8FA2CC" }}>
                {featured ? `${agentName(featured.buyer)} buys @${featured.handle} · testnet` : "What an agent’s spending card does · testnet"}
              </span>
            </div>
            <PageState
              loading={purchases.isLoading}
              error={purchases.error}
              empty={!featured}
              emptyContent={<div className="empty-state" style={{ color: "#A9B6D6", paddingBottom: 14 }}>No purchase yet. When an agent buys within its mandate, each sealed step appears here.</div>}
            >
              {steps.map((step, index) => (
                <div key={`${step.word}-${index}`} style={{ display: "grid", gridTemplateColumns: "58px minmax(0, 1fr)", gap: 14, alignItems: "center", padding: "10px 0", borderTop: "1px solid #1F3A6E" }}>
                  <Seal word={step.word} size={52} {...(step.tone ? { tone: step.tone } : {})} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 13, color: "#A9B6D6" }}>
                    <b style={{ color: "#fff", fontSize: 13.5 }}>{step.title}</b>
                    <span>{step.body}</span>
                  </div>
                </div>
              ))}
            </PageState>
          </NightPanel>

          {featured ? (
            <SpendingCard
              agent={agentName(featured.buyer)}
              balance={tokenAmount(featuredSpent.toString())}
              symbol="USDC"
              note={featuredSpent === 0n ? "Nothing spent yet · a cheque is collected only on delivery" : "Spent from this card · a cheque is collected only on delivery"}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
