# AlphaDesk

A quantitative market-analysis desk that runs entirely in the browser.

Ask it about any instrument and it returns a **long / short / no-trade call**, a
**take-profit ladder**, a **stop loss**, a **position size** and the **measured
probability** behind all of it — then lets you check its homework.

**Live site:** https://kartbala07.github.io/AlphaDesk/
(Enable GitHub Pages on `main` → `/web` if the link 404s in a fresh fork.)

---

## What it does

| Capability | How it works |
|---|---|
| **Signal engine** | A softmax logistic model trained on **290,785 labelled bars** from 10 years of daily data across 139 instruments. Labels are triple-barrier outcomes: *did price reach +2.0 ATR before −1.0 ATR inside 15 days?* |
| **Trade plan** | Entry at the signal bar, stop at 1.0×ATR, TP1 at 1.0×ATR, TP2 at 2.0×ATR — the exact geometry the model was trained on. Position size from account risk. |
| **Screener** | All 139 instruments ranked by expected edge, filterable by class and side. |
| **Chart scan** | Drop a screenshot of any chart. Pixel analysis extracts candles, trend slope, R², support/resistance and volatility; an optional multimodal LLM adds pattern reasoning (bring your own key). |
| **News wire** | Live headlines from the GDELT global news index, deduplicated, plus a directory of 25 financial desks. |
| **Research** | A sourced write-up of the past decade and of what the academic literature actually says about the indicators used here. |
| **Model page** | Out-of-sample performance, rank IC, decile ladder, calibration table, gate sensitivity — including the numbers that do not flatter the model. |

## Honest performance summary

Measured out of sample (walk-forward: each year judged only by weights fit on
earlier years), after 0.05% costs per side and gap-aware fills:

| Metric | Value |
|---|---|
| Signals (gate applied) | 121,452 |
| Expectancy per signal | **+0.066R** (profit factor 1.10) |
| Hit rate | 38.7% (break-even for 2:1 is 33.3%) |
| Rank IC (daily) | 0.014, IR 1.37, positive on 53% of days |
| Top-5 portfolio, 1% risk | **18.5% CAGR, 56.8% max drawdown** |
| Same mechanics ranked by 20-day momentum | 18.2% CAGR, 56.2% max drawdown |

**Read that last row carefully.** The model does not materially beat a plain
momentum ranking. Its value is consistent framing — probability, stop, target,
size — not clairvoyance. Anyone selling you the opposite is selling something
else. The app prints this comparison on its own Model page.

## Architecture

Static site, no build step, no backend, no dependencies.

```
docs/
  index.html
  css/app.css
  js/
    engine.js     indicators, feature construction, inference, backtests  (shared with tooling)
    app.js        router + eight views
    charts.js     canvas candlestick / line / bar / sparkline renderers
    news.js       GDELT news client + network directory
    vision.js     chart-image pixel scanner + BYO-key vision adapters
    live.js       live quotes (CoinGecko crypto, Twelve Data equities)
  data/
    model.json       weights, standardisation, per-fold refits, importance
    backtest.json    out-of-sample evaluation output
    signals.json     the model's current read on all 139 instruments
    universe.json    instrument metadata
    bars/<SYM>.json  10 years of daily OHLCV per instrument
    research.json    sourced decade + evidence dataset
tools/
  universe.mjs       master instrument list
  fetch-data.mjs     data download (Nasdaq / Kraken / CBOE adapters)
  build-dataset.mjs  feature matrix + triple-barrier labels
  train.py           model fitting (numpy, walk-forward folds)
  evaluate.mjs       out-of-sample evaluation, rank IC, portfolios
  publish-data.mjs   regenerates docs/data/*
research/
  DECADE.md          year-by-year market history with sources
  EVIDENCE.md        literature review with sources
```

Inference happens client-side: the browser downloads `model.json` plus one
instrument's bars and does the maths itself. No price or signal ever leaves the
device.

## Rebuilding the data

```bash
node tools/fetch-data.mjs --force   # 139 symbols, ~2 min
node tools/build-dataset.mjs        # ~290k labelled rows
python3 tools/train.py              # walk-forward folds + deployed weights (~4 min)
node tools/evaluate.mjs             # out-of-sample metrics, rank IC, portfolios
node tools/publish-data.mjs         # regenerate docs/data/*
python3 -m http.server 8000 -d docs  # preview at localhost:8000
```

`tools/fetch-data.mjs` uses three public sources because no single one covers
everything: Nasdaq's historical endpoint (stocks, ETFs, indexes, major crypto),
Kraken's OHLC API (pairs Nasdaq lacks) and CBOE's VIX history CSV.

## Regenerating signals without retraining

`node tools/build-dataset.mjs && node tools/evaluate.mjs && node tools/publish-data.mjs`

## Optional keys

Everything works without keys. Two upgrades exist, stored only in this browser's
localStorage:

- **Twelve Data** (free tier, 8 req/min) → live equity quotes and analysis of
  tickers outside the bundled 139.
- **OpenAI / Anthropic / Gemini** → a second opinion on uploaded chart images.

## Limitations

- Daily bars only. No intraday, no order book, no options flow, no short interest.
- The universe is today's large caps — survivorship bias flatters every long bias.
- Backtests assume fills at the barrier or the gap open; real slippage on thin
  names is worse.
- The model cannot see earnings dates, news or macro prints. It reads price.
- A 57% drawdown at 1% risk per trade is in the results above. Position sizing is
  not optional.

## Disclaimer

AlphaDesk is a research and education tool. Its model is a statistical estimator
trained on historical prices. It does not know the future, cannot read news in
real time, and its output is not investment advice. Backtested results are
hypothetical and exclude taxes and financing. Never risk money you cannot afford
to lose.
