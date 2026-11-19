#!/usr/bin/env python3
"""Build data/performance.json for the Fourier Fund site.

Inputs (all in the repo):
  config.json          fund settings, portfolio sleeves, benchmarks
  data/holdings.csv    position snapshots: one block of rows per effective_date
  data/securities.csv  display names and asset classes

Method
  * A snapshot dated D is the set of positions held at the close of D (trades
    are assumed to execute at D's close). Returns on D itself are earned by the
    previous snapshot; the new snapshot earns from D+1 onwards.
  * Blank `shares` are sized from `target_weight` (a fraction of the TOTAL fund)
    at D's close. For the first snapshot the fund size is config.initial_capital;
    for later snapshots it is the fund's market value at D's close, i.e. a
    rebalance back to target. With whole_shares, leftovers go to that sleeve's cash.
  * Daily returns are holdings-based and time-weighted: each position's total
    return (dividend-adjusted close) weighted by its prior-day market value.
    Cash earns 0%. Sleeve and fund returns therefore ignore external cash flows.

Output: data/performance.json, read by the static page.
"""
from __future__ import annotations

import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "prices_cache.csv"
CASH = "CASH"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- prices
def fetch_prices(tickers: list[str], start: str) -> pd.DataFrame:
    """Long frame [date, ticker, close, adjclose, split] from Yahoo, with retries.

    Yahoo back-adjusts `close` for splits (not dividends) and `adjclose` for both.
    `split` is the split ratio on its ex-date (e.g. 3.0 for 3-for-1), else 0.
    """
    import yfinance as yf

    frames, missing = [], list(tickers)
    for attempt in range(4):
        if not missing:
            break
        if attempt:
            time.sleep(5 * attempt)
        log(f"fetching {len(missing)} tickers (attempt {attempt + 1})")
        try:
            raw = yf.download(missing, start=start, auto_adjust=False, actions=True,
                              progress=False, group_by="ticker", threads=True)
        except Exception as e:  # network errors: retry
            log(f"  download error: {e}")
            continue
        still = []
        for t in missing:
            try:
                sub = raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw
                if "Stock Splits" not in sub:
                    sub = sub.assign(**{"Stock Splits": 0.0})
                sub = sub[["Close", "Adj Close", "Stock Splits"]].dropna(subset=["Close", "Adj Close"])
            except KeyError:
                sub = pd.DataFrame()
            if sub.empty:
                still.append(t)
                continue
            f = sub.rename(columns={"Close": "close", "Adj Close": "adjclose",
                                    "Stock Splits": "split"}).reset_index()
            f = f.rename(columns={f.columns[0]: "date"})
            f["date"] = pd.to_datetime(f["date"]).dt.strftime("%Y-%m-%d")
            f["ticker"] = t
            f["split"] = f["split"].fillna(0.0)
            frames.append(f[["date", "ticker", "close", "adjclose", "split"]])
        missing = still
    if missing:
        log(f"WARNING: no fresh prices for {missing}; using cache if available")
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(
        columns=["date", "ticker", "close", "adjclose", "split"])


def load_prices(tickers: list[str], start: str, offline: bool) -> pd.DataFrame:
    cache = pd.read_csv(CACHE, dtype={"date": str}) if CACHE.exists() else pd.DataFrame(
        columns=["date", "ticker", "close", "adjclose", "split"])
    if "split" not in cache:
        cache["split"] = 0.0
    if offline:
        fresh = pd.DataFrame(columns=cache.columns)
    else:
        fresh = fetch_prices(tickers, start)
    # A fresh download replaces a ticker's whole history (adjusted closes are
    # restated after every dividend); tickers that failed keep their cached rows.
    keep = cache[~cache["ticker"].isin(fresh["ticker"].unique())]
    prices = pd.concat([keep, fresh], ignore_index=True)
    prices = prices[prices["ticker"].isin(tickers) & (prices["date"] >= start)]
    prices = prices.sort_values(["ticker", "date"]).drop_duplicates(["ticker", "date"], keep="last")
    prices["split"] = prices["split"].fillna(0.0)
    prices.to_csv(CACHE, index=False, float_format="%.6f")
    absent = sorted(set(tickers) - set(prices["ticker"]))
    if absent:
        sys.exit(f"ERROR: no price data at all for {absent}")
    return prices


# --------------------------------------------------------------------------- holdings
def load_holdings(cfg: dict) -> pd.DataFrame:
    h = pd.read_csv(DATA / "holdings.csv", dtype={"effective_date": str, "ticker": str,
                                                  "portfolio": str})
    h.columns = [c.strip() for c in h.columns]
    h["ticker"] = h["ticker"].str.strip().str.upper()
    h["portfolio"] = h["portfolio"].str.strip()
    h["effective_date"] = pd.to_datetime(h["effective_date"]).dt.strftime("%Y-%m-%d")
    valid = {p["id"] for p in cfg["portfolios"]}
    bad = set(h["portfolio"]) - valid
    if bad:
        sys.exit(f"ERROR: holdings.csv has unknown portfolio ids {bad}; expected {valid}")
    for col in ("shares", "target_weight"):
        h[col] = pd.to_numeric(h.get(col), errors="coerce")
    unsized = h["shares"].isna() & h["target_weight"].isna()
    if unsized.any():
        sys.exit(f"ERROR: rows need shares or target_weight:\n{h[unsized]}")
    return h


def size_snapshot(snap: pd.DataFrame, fund_value: float, close: pd.Series,
                  whole: bool) -> list[dict]:
    """Return positions [{portfolio, ticker, shares}] (CASH shares = dollars)."""
    out, leftover = [], {}
    for r in snap.itertuples():
        if not math.isnan(r.shares):
            out.append({"portfolio": r.portfolio, "ticker": r.ticker, "shares": float(r.shares)})
            continue
        dollars = fund_value * r.target_weight
        if r.ticker == CASH:
            out.append({"portfolio": r.portfolio, "ticker": CASH, "shares": dollars})
            continue
        px = close.get(r.ticker)
        if px is None or math.isnan(px):
            sys.exit(f"ERROR: no close for {r.ticker} on {r.effective_date} to size position")
        sh = math.floor(dollars / px) if whole else dollars / px
        leftover[r.portfolio] = leftover.get(r.portfolio, 0.0) + dollars - sh * px
        out.append({"portfolio": r.portfolio, "ticker": r.ticker, "shares": float(sh)})
    for p, cash in leftover.items():
        if cash > 0.005:
            out.append({"portfolio": p, "ticker": CASH, "shares": cash})
    # merge duplicate tickers in a sleeve (e.g. explicit CASH + leftover cash)
    merged: dict[tuple, float] = {}
    for o in out:
        merged[(o["portfolio"], o["ticker"])] = merged.get((o["portfolio"], o["ticker"]), 0) + o["shares"]
    return [{"portfolio": p, "ticker": t, "shares": s} for (p, t), s in merged.items()]


# --------------------------------------------------------------------------- engine
def run(offline: bool = False) -> None:
    cfg = json.loads((ROOT / "config.json").read_text())
    sec = pd.read_csv(DATA / "securities.csv").set_index("ticker")
    holdings = load_holdings(cfg)
    inception = cfg["inception_date"]
    first_snap = holdings["effective_date"].min()
    if first_snap != inception:
        sys.exit(f"ERROR: first holdings snapshot {first_snap} must equal inception_date {inception}")

    bench = cfg["benchmarks"]
    held = sorted(set(holdings["ticker"]) - {CASH})
    tickers = held + [b["ticker"] for b in bench]
    # start a week early so a snapshot dated on a non-trading day can still size
    start = (pd.Timestamp(inception) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    prices = load_prices(tickers, start, offline)

    adj = prices.pivot(index="date", columns="ticker", values="adjclose").sort_index().ffill()
    # Yahoo's `close` is back-adjusted for splits. Undo that so prices are as
    # traded on each day and share counts in holdings.csv mean what they say:
    # as-traded close_t = split-adjusted close_t x product of split ratios after t.
    split = prices.pivot(index="date", columns="ticker", values="split").sort_index()
    split = split.reindex(adj.index).fillna(0.0)
    ratio = split.where(split > 0, 1.0)
    later = ratio[::-1].cumprod()[::-1].shift(-1).fillna(1.0)   # splits strictly after t
    close = (prices.pivot(index="date", columns="ticker", values="close").sort_index()
             .reindex(adj.index) * later).ffill()
    split_events = [{"ticker": t, "date": d, "ratio": float(split.at[d, t])}
                    for t in split.columns for d in split.index
                    if split.at[d, t] > 0 and d >= inception and t in holdings["ticker"].values]
    # trading calendar = days the primary benchmark (or SPY) traded, from inception
    cal_ticker = "SPY" if "SPY" in close else bench[0]["ticker"]
    dates = [d for d in close.index if d >= inception and not pd.isna(close.at[d, cal_ticker])]
    # if inception is not a trading day, start on the last trading day before it
    prior = [d for d in close.index if d < inception]
    if inception not in dates and prior:
        dates = [prior[-1]] + dates
    if len(dates) < 1:
        sys.exit("ERROR: no trading days since inception")

    snap_dates = sorted(holdings["effective_date"].unique())

    def asof(d: str) -> str:
        """Trading date on/just before d."""
        cands = [x for x in close.index if x <= d]
        return cands[-1] if cands else close.index[0]

    port_ids = [p["id"] for p in cfg["portfolios"]]
    positions: list[dict] = []
    snapshots_out = []
    idx = {pid: [1.0] for pid in port_ids + ["total"]}
    values = {pid: [] for pid in port_ids + ["total"]}
    first_held: dict[str, str] = {}

    def mv(pos: list[dict], d: str) -> dict[str, float]:
        out = {pid: 0.0 for pid in port_ids}
        for p in pos:
            px = 1.0 if p["ticker"] == CASH else close.at[d, p["ticker"]]
            out[p["portfolio"]] += p["shares"] * px
        return out

    snap_i = 0
    for k, d in enumerate(dates):
        if k > 0:
            prev = dates[k - 1]
            num = {pid: 0.0 for pid in port_ids}
            den = {pid: 0.0 for pid in port_ids}
            for p in positions:
                if p["ticker"] == CASH:
                    v0, r = p["shares"], 0.0
                else:
                    v0 = p["shares"] * close.at[prev, p["ticker"]]
                    r = adj.at[d, p["ticker"]] / adj.at[prev, p["ticker"]] - 1
                num[p["portfolio"]] += v0 * r
                den[p["portfolio"]] += v0
            for pid in port_ids:
                ret = num[pid] / den[pid] if den[pid] else 0.0
                idx[pid].append(idx[pid][-1] * (1 + ret))
            tot = sum(num.values()) / sum(den.values()) if sum(den.values()) else 0.0
            idx["total"].append(idx["total"][-1] * (1 + tot))
            # splits take effect at d's open: holders now own ratio x shares
            for p in positions:
                r = 0.0 if p["ticker"] == CASH else split.at[d, p["ticker"]]
                if r > 0:
                    p["shares"] *= r
                    log(f"split {p['ticker']} {r:g}:1 on {d} -> {p['shares']:g} shares")
        # apply any snapshot effective on/before this trading day (after its returns)
        while snap_i < len(snap_dates) and (asof(snap_dates[snap_i]) <= d):
            sd = snap_dates[snap_i]
            fund_value = cfg["initial_capital"] if not positions else sum(mv(positions, d).values())
            positions = size_snapshot(holdings[holdings["effective_date"] == sd], fund_value,
                                      close.loc[d], cfg.get("whole_shares", True))
            for p in positions:
                if p["ticker"] != CASH:
                    first_held.setdefault(p["ticker"], d)
            snapshots_out.append({"effective_date": sd, "trade_date": d,
                                  "fund_value": round(fund_value, 2)})
            log(f"snapshot {sd} applied at {d}, fund value ${fund_value:,.2f}")
            snap_i += 1
        m = mv(positions, d)
        for pid in port_ids:
            values[pid].append(round(m[pid], 2))
        values["total"].append(round(sum(m.values()), 2))

    # benchmarks: total-return index from adjusted close
    bench_series = {}
    for b in bench:
        s = adj[b["ticker"]].reindex(dates)
        base = s.iloc[0]
        bench_series[b["id"]] = [None if pd.isna(v) else round(v / base, 6) for v in s]

    # current holdings detail
    last = dates[-1]
    latest = mv(positions, last)
    fund_total = sum(latest.values())
    tw = holdings[holdings["effective_date"] == snap_dates[-1]].groupby(
        ["portfolio", "ticker"])["target_weight"].sum()
    portfolios_out = []
    for p in cfg["portfolios"]:
        pid = p["id"]
        rows = []
        for pos in sorted((x for x in positions if x["portfolio"] == pid),
                          key=lambda x: (x["ticker"] == CASH, x["ticker"])):
            t = pos["ticker"]
            px = 1.0 if t == CASH else float(close.at[last, t])
            val = pos["shares"] * px
            since = first_held.get(t)
            ret = None if t == CASH or since is None else float(adj.at[last, t] / adj.at[since, t] - 1)
            day = None if t == CASH or len(dates) < 2 else float(adj.at[last, t] / adj.at[dates[-2], t] - 1)
            target = tw.get((pid, t))
            rows.append({
                "ticker": t,
                "name": str(sec["name"].get(t, t)),
                "asset_class": str(sec["asset_class"].get(t, "")),
                "shares": None if t == CASH else round(pos["shares"], 4),
                "price": None if t == CASH else round(px, 4),
                "value": round(val, 2),
                "weight_portfolio": val / latest[pid] if latest[pid] else 0,
                "weight_fund": val / fund_total if fund_total else 0,
                "target_weight_fund": None if target is None or pd.isna(target) else float(target),
                "return_1d": day,
                "return_since_held": ret,
                "held_since": since,
            })
        target_sleeve = float(tw.loc[pid].sum()) if pid in tw.index.get_level_values(0) else None
        portfolios_out.append({**p, "value": round(latest[pid], 2),
                               "weight_fund": latest[pid] / fund_total if fund_total else 0,
                               "target_weight_fund": target_sleeve, "holdings": rows})

    # asset-class mix of the whole fund
    mix: dict[str, float] = {}
    for p in portfolios_out:
        for r in p["holdings"]:
            mix[r["asset_class"] or "Other"] = mix.get(r["asset_class"] or "Other", 0) + r["weight_fund"]

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fund_name": cfg["fund_name"],
        "inception_date": inception,
        "as_of": last,
        "placeholder": cfg.get("placeholder", False),
        "placeholder_note": cfg.get("placeholder_note", ""),
        "risk_free_rate": cfg.get("risk_free_rate", 0.0),
        "fund_value": round(fund_total, 2),
        "dates": dates,
        "series": {k: [round(v, 6) for v in s] for k, s in idx.items()},
        "values": values,
        "benchmarks": [{**b, "series": bench_series[b["id"]]} for b in bench],
        "portfolios": portfolios_out,
        "asset_mix": {k: v for k, v in sorted(mix.items(), key=lambda kv: -kv[1])},
        "snapshots": snapshots_out,
        "splits": split_events,
    }
    (DATA / "performance.json").write_text(json.dumps(out, separators=(",", ":")))
    log(f"wrote data/performance.json: {len(dates)} days, as of {last}, "
        f"fund ${fund_total:,.2f}, total {idx['total'][-1] - 1:+.2%}")


if __name__ == "__main__":
    run(offline="--offline" in sys.argv)
