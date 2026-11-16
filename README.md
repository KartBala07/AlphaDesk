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
| **Buy & hold SPY over the same window** | **13.1% CAGR, 34.1% max drawdown** |

**Read those last two rows carefully.** Return per unit of drawdown: model 0.33,
momentum 0.32, **buy-and-hold SPY 0.38**. The model earned more than the index but
with more than proportionally more pain, and it needed 2,047 trades to do it.

So the honest summary is: the ranking carries real information (top decile earns
0.72 ATR of forward return against 0.14 for the bottom), and the trade plan is
sound, but **this portfolio does not beat simply holding the S&P 500 on a
risk-adjusted basis**. Its value is consistent framing — probability, stop,
target, size, and a screen that says "no trade" most of the time — not
clairvoyance. Anyone selling you the opposite is selling something else. The app
prints this comparison on its own Model page, next to the equity curve.

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

---

## Terminal UI

The interface follows TradingView's layout rather than a dashboard: a top
toolbar (symbol search, section links, session state, account), a 52 px icon
rail, a full-height chart workspace, and a status bar. Inside the terminal:

- **Chart engine** (`docs/js/chart-pro.js`, no dependencies): wheel zoom anchored
  at the cursor, drag to pan, double-click to reset, keyboard nudge.
- **Intervals** D / W / Mo aggregated from daily bars; ranges 1M → MAX scaled to
  the interval, not to a fixed bar count.
- **Chart types**: candles, hollow candles, OHLC bars, line, area, Heikin-Ashi.
- **Overlays**: EMA 20/50/200, Bollinger Bands; **panes**: volume, RSI 14, MACD.
- **Drawing tools**: trendline, horizontal line, rectangle, Fibonacci retracement,
  measure. Persisted per symbol in localStorage; right-click or Delete to remove.
- **Watchlist** with the active symbol pinned, headers, and live quotes when the
  Robinhood bridge is connected.
- **Model rail** with the verdict, plan, drivers, risk flags, journal and the
  broker hand-off.

## Accounts, journal and the API

`server/server.mjs` is a zero-dependency Node service: `node:sqlite` for storage,
`node:crypto` for password hashing. It serves **both** the site and the API, so a
single command gives you a working app with real sign-in:

```bash
node server/server.mjs          # http://127.0.0.1:8789  (site + API)
```

> Accounts need to talk to the API on the **same site**. `SameSite=Lax` cookies are
> blocked cross-site, so sign-in works when the page is served by the API (as above)
> or from a deployed HTTPS API (`COOKIE_SECURE=true` switches cookies to
> `SameSite=None`). On GitHub Pages alone the app runs in guest mode and the journal
> stays in localStorage — which is still fully functional.

Endpoints: `/api/health`, `/api/csrf`, `/api/auth/{register,login,logout,me,password}`,
`/api/journal` (list/add), `/api/journal/:id` (patch/delete), `/api/audit`.

### What the security actually does

| Control | Implementation |
|---|---|
| Password storage | scrypt, N=32768 r=8 p=1, 16-byte per-user salt, 64-byte key |
| Sessions | opaque 256-bit tokens, stored only as SHA-256 digests, 30-day expiry |
| Cookie | `HttpOnly`, `SameSite=Lax` (or `None` + `Secure` in production), `Path=/` |
| CSRF | double-submit token, timing-safe comparison, required on every write |
| Brute force | per-IP sliding limits, per-account lockout after 8 failures (15 min) |
| Enumeration | uniform login errors, dummy hash for unknown accounts to equalise timing |
| Injection | parameterised SQL everywhere; symbol/email/number validation |
| Headers | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS when secure |
| Transport | TLS terminated at the host; HSTS sent when `COOKIE_SECURE=true` |
| Audit | auth events and journal changes written to an append-only table |

**It is not "unhackable", and nothing is.** These controls remove the cheap,
common attacks — credential stuffing, session theft via JavaScript, CSRF, SQL
injection, account enumeration. What remains is operational: patch the host,
terminate TLS, back up `server/data/`, rotate `ALLOWED_ORIGINS`, and never commit
the data directory (it is gitignored).

### Deploying it (free tier)

Any host that runs Node works. Set these environment variables:

```bash
PORT=8789
DATA_DIR=/var/data
COOKIE_SECURE=true                     # HTTPS deployments
ALLOWED_ORIGINS=https://your.site      # exact origin of the front end
```

Render / Fly / Railway: point the start command at `node server/server.mjs`, add a
persistent disk mounted at `DATA_DIR`, then open the service URL — it serves the
site and the API from one origin. On the deployed site, set the API base in
Settings only if the front end is hosted separately.

## Why not a 99% win rate

A 99% hit rate is not a training target; it is a choice of payoff. If you take a
tiny target and a wide stop you can win 99 times out of 100 and still lose money —
the 100th trade gives back more than the previous 99 earned. Conversely, the 2:1
geometry this model trades breaks even at 33.3%, and hit rates in the high 30s
with positive expectancy are what a real daily-bar edge looks like.

Any service promising 99% is either (a) risking far more than it wins, (b) leaking
future data into the backtest, or (c) lying. The Model page publishes calibration,
rank IC, the decile ladder and a buy-and-hold benchmark precisely so you can tell
which one you are looking at.
