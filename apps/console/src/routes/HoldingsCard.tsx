import { useQuery } from "@tanstack/react-query";

import { Kicker, SectionHead, Slab } from "../components/design.js";
import { formatUsd } from "../lib/money.js";
import { formatAmount, omni } from "../omniroles-api.js";

const ROW = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto", gap: 14, alignItems: "baseline", padding: "11px 0", borderTop: "1px solid rgba(13,23,48,.12)" } as const;

/** Everything the company owns, chain by chain: wallets and lending deposits. */
export function HoldingsCard() {
  const holdings = useQuery({ queryKey: ["omni-holdings"], queryFn: omni.holdings, refetchInterval: 30_000 });
  const chains = holdings.data?.chains ?? [];
  return (
    <Slab style={{ padding: "20px 24px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
      <SectionHead left={<Kicker>Holdings</Kicker>} right={holdings.data ? <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{holdings.data.indicative ? "testnet tokens valued at mainnet prices" : "USD at market prices"}</span> : null} />
      {holdings.isLoading ? (
        <div className="loading-slab" style={{ marginTop: 10 }} />
      ) : holdings.error ? (
        <div className="empty-state" style={{ padding: "10px 0" }}>Could not read the balances.</div>
      ) : chains.length === 0 ? (
        <div className="empty-state" style={{ padding: "10px 0" }}>No wallet yet.</div>
      ) : (
        chains.map((chain) => (
          <div key={chain.chain} style={{ display: "flex", flexDirection: "column", marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "4px 0 6px" }}>
              <b style={{ font: "700 12px var(--font-brand)", letterSpacing: ".14em", textTransform: "uppercase", color: "var(--ink-2)" }}>{chain.chain}</b>
              <a className="mono" style={{ fontSize: 12, color: "var(--aegean-ink)" }} href={chain.explorer} target="_blank" rel="noreferrer">
                {chain.address.slice(0, 6)}…{chain.address.slice(-4)} ↗
              </a>
            </div>
            {chain.assets.length === 0 ? (
              <span style={{ ...ROW, fontSize: 13, color: "var(--ink-3)" }}>Empty.</span>
            ) : (
              chain.assets.map((asset) => (
                <div key={`${asset.symbol}-${asset.where}`} style={ROW}>
                  <b className="mono" style={{ fontSize: 14, color: "var(--ink)" }}>{formatAmount(asset.amount, asset.symbol)}</b>
                  <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{asset.where}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--ink-2)" }}>{asset.usd === null ? "test token" : formatUsd(asset.usd)}</span>
                </div>
              ))
            )}
          </div>
        ))
      )}
    </Slab>
  );
}
