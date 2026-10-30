#!/usr/bin/env python3
"""DeFiLlama CLI for DeFi due diligence. Standard library only.

Prints compact, readable summaries by default; add --json for the raw API payload.
Free endpoints need no key. Raises and bridges are on DeFiLlama's paid API:
set DEFILLAMA_API_KEY to use them (requests then go to pro-api.llama.fi).

Usage: python3 tools/defillama.py <command> [args] [--json] [--limit N]
Run with no arguments for the command list.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.llama.fi"
COINS = "https://coins.llama.fi"
YIELDS = "https://yields.llama.fi"
STABLES = "https://stablecoins.llama.fi"
BRIDGES = "https://bridges.llama.fi"
PRO = "https://pro-api.llama.fi"
UA = "defi-research-agent/1.0 (+stdlib)"
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "defillama-cli")
CACHE_TTL = 600  # seconds; the big lists (protocols, pools) are 10+ MB


class ApiError(Exception):
    pass


def fetch(url: str, *, cache: bool = False, retries: int = 3) -> object:
    """GET a JSON URL with retries, an optional disk cache, and clear errors."""
    path = os.path.join(CACHE_DIR, urllib.parse.quote(url, safe="") + ".json")
    if cache and os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if cache:
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
            return data
        except urllib.error.HTTPError as err:
            if err.code == 402:
                raise ApiError(f"{url}: paid endpoint (HTTP 402). Set DEFILLAMA_API_KEY to use DeFiLlama Pro.") from err
            if err.code in (400, 404):
                raise ApiError(f"{url}: not found (HTTP {err.code}). Check the slug with the `search` command.") from err
            last = err
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last = err
        time.sleep(1.5 * (attempt + 1))
    raise ApiError(f"{url}: {last}")


def pro_or_free(path: str, free_base: str) -> str:
    key = os.environ.get("DEFILLAMA_API_KEY")
    return f"{PRO}/{key}{path}" if key else f"{free_base}{path}"


def usd(value: object) -> str:
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "n/a"
    for unit, size in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if abs(v) >= size:
            return f"${v / size:,.2f}{unit}"
    return f"${v:,.2f}"


def day(ts: object) -> str:
    try:
        return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime("%Y-%m-%d")  # type: ignore[arg-type]
    except (TypeError, ValueError, OSError):
        return "n/a"


def pct(value: object) -> str:
    try:
        return f"{float(value):+.2f}%"  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "n/a"


def apy(value: object) -> str:
    try:
        return f"{float(value):.2f}%"  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "n/a"


def emit(args: argparse.Namespace, raw: object, lines: list[str]) -> None:
    if args.json:
        print(json.dumps(raw, indent=2))
    else:
        print("\n".join(lines))


def matches(query: str, *fields: object) -> bool:
    q = query.lower()
    return any(q in str(f).lower() for f in fields if f)


# ---------------------------------------------------------------- commands


def cmd_search(args: argparse.Namespace) -> None:
    protocols = fetch(f"{API}/protocols", cache=True)
    found = [p for p in protocols if matches(args.query, p.get("name"), p.get("slug"), p.get("symbol"))]  # type: ignore[union-attr]
    found.sort(key=lambda p: p.get("tvl") or 0, reverse=True)
    lines = [f"{len(found)} match(es) for '{args.query}'"]
    for p in found[: args.limit]:
        lines.append(f"- {p.get('name')} | slug: {p.get('slug')} | {p.get('category')} | TVL {usd(p.get('tvl'))} | chains: {', '.join((p.get('chains') or [])[:6])}")
    emit(args, found[: args.limit], lines)


def cmd_protocol(args: argparse.Namespace) -> None:
    p = fetch(f"{API}/protocol/{args.slug}")
    assert isinstance(p, dict)
    tvl_series = p.get("tvl") or []
    current = tvl_series[-1]["totalLiquidityUSD"] if tvl_series else None
    def tvl_ago(days: int) -> object:
        if len(tvl_series) <= days:
            return None
        return tvl_series[-1 - days]["totalLiquidityUSD"]
    lines = [
        f"# {p.get('name')} ({p.get('symbol') or 'no token'})",
        f"url: {p.get('url')} | twitter: @{p.get('twitter')} | github: {', '.join(p.get('github') or []) or 'n/a'}",
        f"category: {p.get('category', 'n/a')} | parent protocol: {p.get('isParentProtocol', False)}",
        f"description (project's own words): {p.get('description')}",
        f"token address: {p.get('address')} | gecko_id: {p.get('gecko_id')} | mcap: {usd(p.get('mcap'))}",
        f"TVL now: {usd(current)} | 7d ago: {usd(tvl_ago(7))} | 30d ago: {usd(tvl_ago(30))} | 365d ago: {usd(tvl_ago(365))}",
        f"first TVL datapoint: {day(tvl_series[0]['date']) if tvl_series else 'n/a'}",
        f"audits: {p.get('audits', 'n/a')} | audit links: {', '.join(p.get('audit_links') or []) or 'n/a'}",
        f"oracles: {', '.join(p.get('oracles') or []) or 'n/a'} | forked from: {', '.join(p.get('forkedFrom') or []) or 'n/a'}",
        f"wrongLiquidity flag: {p.get('wrongLiquidity', False)} | misrepresentedTokens: {p.get('misrepresentedTokens', False)}",
        "TVL by chain (current; borrowed, staking and pool2 listed separately by DeFiLlama):",
    ]
    chain_tvls = p.get("currentChainTvls") or {}
    extras = ("borrowed", "staking", "pool2", "vesting", "treasury", "OwnTokens")
    main = {k: v for k, v in chain_tvls.items() if "-" not in k and k not in extras}
    for chain, value in sorted(main.items(), key=lambda kv: kv[1] or 0, reverse=True)[: args.limit]:
        lines.append(f"  - {chain}: {usd(value)}")
    for key in extras:
        if key in chain_tvls:
            lines.append(f"  ({key}, all chains: {usd(chain_tvls[key])})")
    lines.append("Raises:")
    for r in p.get("raises") or []:
        lines.append(f"  - {day(r.get('date'))} {r.get('round') or ''} {usd((r.get('amount') or 0) * 1e6)} led by {', '.join(r.get('leadInvestors') or []) or 'n/a'}; others: {', '.join(r.get('otherInvestors') or []) or 'n/a'}")
    lines.append("Hacks recorded by DeFiLlama:")
    for h in p.get("hacks") or []:
        lines.append(f"  - {day(h.get('date'))} {h.get('technique')} {usd(h.get('amount'))} ({h.get('classification')})")
    lines.append("Hallmarks (notable events):")
    for h in p.get("hallmarks") or []:
        if isinstance(h, list) and len(h) == 2:
            lines.append(f"  - {day(h[0])}: {h[1]}")
    lines.append(f"Related protocols: {', '.join(p.get('otherProtocols') or []) or 'n/a'}")
    raw = {k: v for k, v in p.items() if k not in ("tvl", "tokens", "tokensInUsd", "chainTvls")}
    emit(args, raw, lines)


def cmd_tvl(args: argparse.Namespace) -> None:
    value = fetch(f"{API}/tvl/{args.slug}")
    emit(args, value, [f"{args.slug} TVL: {usd(value)}"])


def cmd_prices(args: argparse.Namespace) -> None:
    data = fetch(f"{COINS}/prices/current/{urllib.parse.quote(args.coins, safe=':,')}")
    coins = (data or {}).get("coins", {})  # type: ignore[union-attr]
    lines = [f"- {cid}: {usd(c.get('price'))} ({c.get('symbol')}, confidence {c.get('confidence')}, at {day(c.get('timestamp'))})" for cid, c in coins.items()]
    emit(args, data, lines or ["no price found (check the coin id: coingecko:<id> or <chain>:<address>)"])


def cmd_yields(args: argparse.Namespace) -> None:
    pools = fetch(f"{YIELDS}/pools", cache=True).get("data", [])  # type: ignore[union-attr]
    found = [p for p in pools if args.project.lower() in str(p.get("project", "")).lower()]
    found.sort(key=lambda p: p.get("tvlUsd") or 0, reverse=True)
    lines = [f"{len(found)} pool(s) for project '{args.project}' (sorted by TVL)"]
    for p in found[: args.limit]:
        lines.append(
            f"- {p.get('chain')} {p.get('symbol')} | TVL {usd(p.get('tvlUsd'))} | APY {apy(p.get('apy'))} "
            f"(base {apy(p.get('apyBase'))}, rewards {apy(p.get('apyReward'))}) | 30d mean {apy(p.get('apyMean30d'))} "
            f"| IL risk: {p.get('ilRisk')} | outlier: {p.get('outlier')} | pool {p.get('pool')}"
        )
    lines.append("Note: a large 'rewards' share means yield paid in emissions, not earned from fees.")
    emit(args, found[: args.limit], lines)


def summary(kind: str, args: argparse.Namespace) -> None:
    data = fetch(f"{API}/summary/{kind}/{args.protocol}")
    assert isinstance(data, dict)
    label = "fees" if kind == "fees" else "volume"
    lines = [
        f"# {data.get('name', args.protocol)} {label}",
        f"24h: {usd(data.get('total24h'))} | 7d: {usd(data.get('total7d'))} | 30d: {usd(data.get('total30d'))} | all time: {usd(data.get('totalAllTime'))}",
        f"change 1d: {pct(data.get('change_1d'))} | 7d: {pct(data.get('change_7d'))} | 1m: {pct(data.get('change_1m'))}",
    ]
    if kind == "fees":
        rev = fetch(f"{API}/summary/fees/{args.protocol}?dataType=dailyRevenue")
        assert isinstance(rev, dict)
        lines.append(f"protocol revenue 24h: {usd(rev.get('total24h'))} | 30d: {usd(rev.get('total30d'))} | all time: {usd(rev.get('totalAllTime'))}")
    chart = data.get("totalDataChart") or []
    if chart:
        lines.append(f"history from {day(chart[0][0])} to {day(chart[-1][0])}; last {min(args.limit, len(chart))} days:")
        for ts, value in chart[-args.limit:]:
            lines.append(f"  - {day(ts)}: {usd(value)}")
    raw = {k: v for k, v in data.items() if k not in ("totalDataChart", "totalDataChartBreakdown")}
    emit(args, raw, lines)


def cmd_fees(args: argparse.Namespace) -> None:
    summary("fees", args)


def cmd_dex_volume(args: argparse.Namespace) -> None:
    summary("dexs", args)


def cmd_raises(args: argparse.Namespace) -> None:
    try:
        data = fetch(pro_or_free("/api/raises", API) if os.environ.get("DEFILLAMA_API_KEY") else f"{API}/raises")
    except ApiError as err:
        raise ApiError(f"{err} Free alternative: `protocol <slug>` lists the protocol's raises.") from err
    raises = (data or {}).get("raises", [])  # type: ignore[union-attr]
    found = [r for r in raises if not args.name or matches(args.name, r.get("name"))]
    found.sort(key=lambda r: r.get("date") or 0, reverse=True)
    lines = [f"{len(found)} raise(s)"]
    for r in found[: args.limit]:
        lines.append(f"- {day(r.get('date'))} {r.get('name')} {r.get('round') or ''} {usd((r.get('amount') or 0) * 1e6)} | lead: {', '.join(r.get('leadInvestors') or []) or 'n/a'} | others: {', '.join(r.get('otherInvestors') or []) or 'n/a'} | source: {r.get('source')}")
    lines.append("Tip: `protocol <slug>` also lists raises for free.")
    emit(args, found[: args.limit], lines)


def cmd_hacks(args: argparse.Namespace) -> None:
    hacks = fetch(f"{API}/hacks", cache=True)
    found = [h for h in hacks if not args.name or matches(args.name, h.get("name"))]  # type: ignore[union-attr]
    found.sort(key=lambda h: h.get("date") or 0, reverse=True)
    lines = [f"{len(found)} hack(s) recorded"]
    for h in found[: args.limit]:
        lines.append(f"- {day(h.get('date'))} {h.get('name')} | {usd(h.get('amount'))} | {h.get('technique')} | {h.get('classification')} | chains: {', '.join(h.get('chain') or [])} | returned: {usd(h.get('returnedFunds')) if h.get('returnedFunds') else 'n/a'} | source: {h.get('source') or 'n/a'}")
    emit(args, found[: args.limit], lines)


def cmd_treasury(args: argparse.Namespace) -> None:
    data = fetch(f"{API}/treasury/{args.protocol}")
    assert isinstance(data, dict)
    lines = [f"# {data.get('name', args.protocol)} treasury"]
    chain_tvls = data.get("currentChainTvls") or {}
    for chain, info in sorted(chain_tvls.items(), key=lambda kv: kv[1] or 0, reverse=True)[: args.limit]:
        lines.append(f"- {chain}: {usd(info)}")
    if "OwnTokens" in chain_tvls:
        lines.append("('OwnTokens' = the project's own token: not real runway.)")
    tokens = data.get("tokensInUsd") or []
    if tokens:
        latest = tokens[-1].get("tokens", {})
        total = sum(v for v in latest.values() if isinstance(v, (int, float))) or 1
        lines.append(f"holdings at {day(tokens[-1].get('date'))} (largest first):")
        for sym, value in sorted(latest.items(), key=lambda kv: kv[1] or 0, reverse=True)[: args.limit]:
            lines.append(f"  - {sym}: {usd(value)} ({100 * value / total:.1f}%)")
        lines.append("Watch for: a treasury mostly in the project's own token is not real runway.")
    raw = {k: v for k, v in data.items() if k not in ("tvl", "tokens", "tokensInUsd", "chainTvls")}
    emit(args, raw, lines)


def cmd_stablecoins(args: argparse.Namespace) -> None:
    data = fetch(f"{STABLES}/stablecoins?includePrices=true", cache=True)
    assets = (data or {}).get("peggedAssets", [])  # type: ignore[union-attr]
    def circ(a: dict) -> float:
        return float(((a.get("circulating") or {}).get("peggedUSD")) or 0)
    assets.sort(key=circ, reverse=True)
    lines = ["Stablecoins by circulating supply:"]
    for a in assets[: args.limit]:
        lines.append(f"- {a.get('name')} ({a.get('symbol')}) | {usd(circ(a))} | peg: {a.get('pegType')} | mechanism: {a.get('pegMechanism')} | price: {a.get('price')}")
    emit(args, assets[: args.limit], lines)


def cmd_chains(args: argparse.Namespace) -> None:
    chains = fetch(f"{API}/v2/chains", cache=True)
    chains.sort(key=lambda c: c.get("tvl") or 0, reverse=True)  # type: ignore[union-attr]
    lines = [f"{i + 1}. {c.get('name')}: {usd(c.get('tvl'))}" for i, c in enumerate(chains[: args.limit])]  # type: ignore[index]
    emit(args, chains[: args.limit], lines)  # type: ignore[index]


def cmd_bridges(args: argparse.Namespace) -> None:
    url = pro_or_free("/bridges/bridges", "") if os.environ.get("DEFILLAMA_API_KEY") else f"{BRIDGES}/bridges"
    data = fetch(url)
    bridges = (data or {}).get("bridges", [])  # type: ignore[union-attr]
    bridges.sort(key=lambda b: b.get("lastDailyVolume") or 0, reverse=True)
    lines = [f"- {b.get('displayName')}: 24h {usd(b.get('lastDailyVolume'))} | chains: {', '.join((b.get('chains') or [])[:6])}" for b in bridges[: args.limit]]
    emit(args, bridges[: args.limit], lines)


def cmd_raw(args: argparse.Namespace) -> None:
    host = urllib.parse.urlparse(args.url).hostname or ""
    if host != "llama.fi" and not host.endswith(".llama.fi"):
        raise ApiError("raw only accepts DeFiLlama URLs (*.llama.fi)")
    print(json.dumps(fetch(args.url), indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(prog="defillama.py", description="DeFiLlama CLI for DeFi due diligence (stdlib only).")
    parser.add_argument("--json", action="store_true", help="print the raw API payload")
    parser.add_argument("--limit", type=int, default=15, help="max rows in lists (default 15)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("search", help="find a protocol slug by name/symbol").add_argument("query")
    sub.add_parser("protocol", help="deep dive: TVL history, chains, raises, hacks, hallmarks, audits").add_argument("slug")
    sub.add_parser("tvl", help="current TVL").add_argument("slug")
    sub.add_parser("prices", help='prices, e.g. "coingecko:near,ethereum:0x..."').add_argument("coins")
    y = sub.add_parser("yields", help="yield pools of a project (base vs reward APY)")
    y.add_argument("--project", required=True)
    sub.add_parser("fees", help="fees and protocol revenue").add_argument("protocol")
    sub.add_parser("dex-volume", help="DEX volume").add_argument("protocol")
    r = sub.add_parser("raises", help="funding rounds (DeFiLlama Pro; `protocol` lists them for free)")
    r.add_argument("--name", default="")
    h = sub.add_parser("hacks", help="hacks and exploits")
    h.add_argument("--name", default="")
    sub.add_parser("treasury", help="treasury holdings").add_argument("protocol")
    sub.add_parser("stablecoins", help="stablecoins overview")
    sub.add_parser("chains", help="chain TVL ranking")
    sub.add_parser("bridges", help="bridge volumes (DeFiLlama Pro)")
    sub.add_parser("raw", help="any DeFiLlama URL").add_argument("url")

    # Allow --json / --limit after the subcommand too.
    argv = [a.lower() if a == "Stablecoins" else a for a in sys.argv[1:]]
    flags = [a for a in argv if a == "--json"]
    rest = [a for a in argv if a != "--json"]
    for i, a in enumerate(list(rest)):
        if a == "--limit" and i + 1 < len(rest):
            flags += ["--limit", rest[i + 1]]
    rest = [a for i, a in enumerate(rest) if a != "--limit" and not (i > 0 and rest[i - 1] == "--limit")]
    args = parser.parse_args(flags + rest)

    commands = {
        "search": cmd_search, "protocol": cmd_protocol, "tvl": cmd_tvl, "prices": cmd_prices,
        "yields": cmd_yields, "fees": cmd_fees, "dex-volume": cmd_dex_volume, "raises": cmd_raises,
        "hacks": cmd_hacks, "treasury": cmd_treasury, "stablecoins": cmd_stablecoins,
"chains": cmd_chains, "bridges": cmd_bridges, "raw": cmd_raw,
    }
    try:
        commands[args.command](args)
    except ApiError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
