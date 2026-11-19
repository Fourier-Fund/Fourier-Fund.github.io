# fourierfund.github.io

Performance site for the Fourier Fund quant team. It shows the **Total Fund**, the
**Quant Team** sleeve (70%), the **ESG / ESGV** sleeve (10%) and the **Analyst Picks**
sleeve (20%), each against the S&P 500 Total Return Index, SPY and QQQ.

## How it updates

GitHub Pages only serves static files, so a scheduled GitHub Action does the work:

1. Every weekday at 22:15 UTC (after the U.S. close), and on every push to `main`,
   `.github/workflows/update.yml` runs `scripts/build_data.py`.
2. The script downloads prices from Yahoo Finance (`yfinance`), computes daily
   time-weighted total returns for each sleeve and the whole fund, and writes
   `data/performance.json`.
3. The workflow commits the new data and deploys the site to Pages.
4. `index.html` + `assets/app.js` read `data/performance.json` in the browser and draw
   the charts and tables.

To refresh by hand, open **Actions → Update performance and deploy → Run workflow**.

## One-time setup

In **Settings → Pages**, set **Source** to **GitHub Actions**. Without this the deploy
step fails.

Note on the URL: an organization site at `https://fourier-fund.github.io/` must live in
a repo named exactly `Fourier-Fund.github.io`. This repo is named
`fourierfund.github.io`, so it publishes at
`https://fourier-fund.github.io/fourierfund.github.io/`. Rename the repo in Settings to get the
short URL. The site uses relative paths, so it works either way.

## Updating holdings: the only file you normally edit

`data/holdings.csv` lists position **snapshots**. Each `effective_date` is a complete
list of the fund's positions as held **at the close of that day**:

```csv
effective_date,portfolio,ticker,shares,target_weight
2026-10-22,quant,QQQ,13,
2026-10-22,esg,ESGV,110,
2026-10-22,analyst,LEN,29,
2026-10-22,quant,CASH,1072.15,
```

- `portfolio` is one of `quant`, `esg`, `analyst` (defined in `config.json`).
- `shares` is the actual share count. For `CASH` rows it is a dollar amount.
- `target_weight` is the target as a fraction of the **whole fund** (e.g. `0.0636`). If
  `shares` is left blank, the script sizes the position from `target_weight` at that
  day's close, using whole shares, with the leftover going to that sleeve's cash. Use this for
  simulations, or to model a rebalance back to targets.
- Targets shown on the page come from the latest snapshot.

**After a rebalance or any trade**, add a new block of rows with that date containing
every position held after the trade, and commit. Do not edit older blocks; they are
the history the returns are computed from.

To add a new security, add a row to `data/securities.csv` (ticker, display name, asset
class) so it gets a proper name on the page.

### Going live

The repo currently ships **simulated** holdings: target weights sized at an assumed
inception date of 2026-10-22 with $150,000. When the fund is funded:

1. Set `inception_date` and `initial_capital` in `config.json`.
2. Replace `data/holdings.csv` with the real filled share counts and cash, dated on the
   inception date. The first snapshot must equal `inception_date`.
3. Set `"placeholder": false` in `config.json` to remove the banner.
4. Delete `data/prices_cache.csv` so prices are refetched from the new start date.

## Methodology

- **Returns** are holdings-based and time-weighted: each day, every position's total return
  (dividend-adjusted close) is weighted by its prior-day market value; cash earns 0%.
  Contributions or withdrawals of capital don't distort the return.
- **Holdings value** is shares × close plus cash. It does not include dividends paid out
  unless you record them as `CASH` in a new snapshot.
- **Volatility / Sharpe** are annualized from daily returns over the selected range and
  are hidden until at least 20 trading days exist. Risk-free rate: `risk_free_rate` in
  `config.json`.
- Trades are assumed to execute at the close of the snapshot date.
- **Stock splits** are handled automatically. Yahoo back-adjusts historical prices for
  splits, so the script rebuilds the actual traded prices and multiplies share counts by
  the split ratio on the ex-date. Enter `shares` in `holdings.csv` as you actually held
  them on that snapshot date: pre-split counts before a split, post-split counts after.
  Splits are listed under each sleeve's holdings table (e.g. ITA 3-for-1 on 2026-11-05).

## Running locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python scripts/build_data.py          # or --offline to reuse data/prices_cache.csv
python -m http.server 8000            # then open http://localhost:8000
```

## Files

| Path | Purpose |
|---|---|
| `config.json` | Fund name, inception, capital, sleeves, benchmarks, risk-free rate |
| `data/holdings.csv` | Position snapshots (edit this) |
| `data/securities.csv` | Names and asset classes |
| `data/performance.json` | Generated, so don't edit by hand |
| `data/prices_cache.csv` | Generated price cache, used if Yahoo is temporarily unavailable |
| `scripts/build_data.py` | Performance engine |
| `index.html`, `assets/` | The site |
| `.github/workflows/update.yml` | Schedule, build and deploy |
