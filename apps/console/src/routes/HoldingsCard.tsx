import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/ui.js";
import { formatAmount, omni } from "../omniroles-api.js";

/** Everything the company owns, chain by chain: wallets and lending deposits. */
export function HoldingsCard() {
  const holdings = useQuery({ queryKey: ["omni-holdings"], queryFn: omni.holdings, refetchInterval: 30_000 });
  return (
    <Card title="Holdings">
      {holdings.isLoading ? <div className="state">Loading…</div> : holdings.error ? <div className="state">Could not read the balances.</div> : (holdings.data?.chains ?? []).length === 0 ? (
        <div className="state">No wallet yet.</div>
      ) : (
        <div className="stack">
          {holdings.data!.chains.map((chain) => (
            <div key={chain.chain}>
              <div className="row wrap" style={{ justifyContent: "space-between" }}>
                <strong>{chain.chain}</strong>
                <a className="small mono" href={chain.explorer} target="_blank" rel="noreferrer">{chain.address.slice(0, 6)}…{chain.address.slice(-4)}</a>
              </div>
              {chain.assets.length === 0 ? <p className="small muted">Empty.</p> : (
                <table>
                  <tbody>
                    {chain.assets.map((asset) => (
                      <tr key={`${asset.symbol}-${asset.where}`}>
                        <td><strong>{formatAmount(asset.amount, asset.symbol)}</strong></td>
                        <td className="small muted">{asset.where}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
