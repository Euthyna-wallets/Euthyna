/**
 * Indicative USD prices for the treasury view. Testnet tokens have no market:
 * each is valued at its mainnet counterpart (ETH, SOL, NEAR, EURC) and dollar
 * stablecoins at 1. Coinbase public spot prices, cached for five minutes.
 */

const STABLE = /^(USDC|USDT|DAI|TestUSDC|USDC \(Aave test\))$/;
const BASE: Record<string, string> = { ETH: "ETH", WETH: "ETH", SOL: "SOL", NEAR: "NEAR", wNEAR: "NEAR", EURC: "EURC" };

let cache: { at: number; prices: Record<string, number> } | null = null;

async function spot(base: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.coinbase.com/v2/prices/${base}-USD/spot`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { amount?: string } };
    const value = Number(body.data?.amount);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function usdPrices(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.prices;
  const bases = [...new Set(Object.values(BASE))];
  const values = await Promise.all(bases.map(spot));
  const prices: Record<string, number> = { ...(cache?.prices ?? {}) };
  bases.forEach((base, index) => {
    if (values[index] !== null) prices[base] = values[index]!;
  });
  cache = { at: Date.now(), prices };
  return prices;
}

/** USD value of `amount` of `symbol`, or null when there is no reference price. */
export function usdValue(symbol: string, amount: string, prices: Record<string, number>): number | null {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  if (STABLE.test(symbol)) return value;
  const price = prices[BASE[symbol] ?? ""];
  return price === undefined ? null : value * price;
}
