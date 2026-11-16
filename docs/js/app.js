/* =============================================================================
 * AlphaDesk — application shell, router and views.
 * Static site: every number is computed in the browser from bundled daily bars,
 * a model trained offline (tools/train.py) and, optionally, live APIs.
 * ========================================================================== */

import {
  analyze, backtestWalkForward, normaliseBars, buildContext, ema, rsi, atr, metrics,
  TP_MULT, SL_MULT, HORIZON, DISCLAIMER, ENGINE_VERSION, FEATURE_LABELS,
} from './engine.js';
import { CandleChart, LineChart, barChart, sparkline, fmtPrice } from './charts.js';
import * as live from './live.js';

/* ---------------------------------- utils --------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const n2 = (v, d = 2) => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const pct = (v, d = 2) => (isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '—');
const pctRaw = (v, d = 2) => (isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
const rmult = (v, d = 2) => (isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}R` : '—');
const money = (v) => (isNum(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—');
const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut');
const dateOf = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function toast(msg, kind = '') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 4200);
}

/* -------------------------------- settings -------------------------------- */

const DEFAULT_SETTINGS = {
  account: 25000, riskPct: 1, theme: 'dark', twelveDataKey: '',
  aiProvider: 'openai', aiModel: '', aiKey: '', autoLive: true,
};
const loadSettings = () => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('alphadesk.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
};
const saveSettings = () => localStorage.setItem('alphadesk.settings', JSON.stringify(S.settings));

/* --------------------------------- state ---------------------------------- */

const S = {
  settings: loadSettings(),
  universe: [], bySymbol: new Map(), signals: [], signalBy: new Map(),
  model: null, backtest: null, research: null, news: null, vision: null,
  bars: new Map(), raw: new Map(), ctx: null,
  liveQuotes: new Map(),
  screener: { q: '', cls: 'all', side: 'all', sort: 'edgeR', dir: -1 },
  scanResult: null,
  ready: false,
};

const URLS = {
  universe: 'data/universe.json',
  signals: 'data/signals.json',
  model: 'data/model.json',
  backtest: 'data/backtest.json',
  research: 'data/research.json',
  bars: (sym) => `data/bars/${sym.replace(/[^\w.-]/g, '_')}.json`,
};

async function loadJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function bootData() {
  const [universe, signals, model, backtest] = await Promise.all([
    loadJSON(URLS.universe), loadJSON(URLS.signals), loadJSON(URLS.model), loadJSON(URLS.backtest),
  ]);
  S.universe = universe;
  S.bySymbol = new Map(universe.map((u) => [u.symbol, u]));
  S.signals = signals;
  S.signalBy = new Map(signals.map((s) => [s.symbol, s]));
  S.model = model;
  S.backtest = backtest;
  S.research = await loadJSON(URLS.research).catch(() => null);
  S.news = await import('./news.js').catch(() => null);
  S.vision = await import('./vision.js').catch(() => null);
  S.ready = true;
}

async function getBars(symbol) {
  if (S.bars.has(symbol)) return S.bars.get(symbol);
  const inst = S.bySymbol.get(symbol);
  const url = inst?.barsFile ? `data/bars/${inst.barsFile}` : URLS.bars(symbol);
  const j = await loadJSON(url);
  const bars = normaliseBars(j);
  S.raw.set(symbol, j);
  S.bars.set(symbol, bars);
  return bars;
}

async function getContext() {
  if (S.ctx) return S.ctx;
  const [spy, vix] = await Promise.all([getBars('SPY').catch(() => null), getBars('^VIX').catch(() => null)]);
  if (!spy || !vix) throw new Error('Market context series unavailable (SPY / VIX).');
  S.ctx = buildContext({ spy: { bars: spy.date.map((d, i) => [d, spy.o[i], spy.h[i], spy.l[i], spy.c[i], spy.v[i]]) }, vix: { bars: vix.date.map((d, i) => [d, vix.o[i], vix.h[i], vix.l[i], vix.c[i], vix.v[i]]) } });
  return S.ctx;
}

const threshold = () => S.backtest?.threshold ?? 0.42;

async function runAnalysis(symbol, barsOverride = null) {
  const inst = S.bySymbol.get(symbol) || { symbol, name: symbol, cls: 'equity', sector: '—' };
  const bars = barsOverride || await getBars(symbol);
  const ctx = await getContext();
  return analyze({
    bars, ctx, model: S.model, inst,
    accountSize: S.settings.account, riskPct: S.settings.riskPct,
    threshold: threshold(), minEdge: S.backtest?.rule?.minEdgeR ?? 0.10,
  });
}

/* ------------------------------- components -------------------------------- */

function sideBadge(side, conviction) {
  const label = side === 'long' ? 'LONG' : side === 'short' ? 'SHORT' : 'NO TRADE';
  return `<span class="badge ${side}">${label}</span>${conviction && side !== 'flat' ? `<span class="badge muted" style="margin-left:5px">${esc(conviction)}</span>` : ''}`;
}

function gaugeSVG(p, color, caption, big) {
  const r = 46, cx = 64, cy = 60;
  const end = 180 + 180 * clamp(p, 0, 1);
  const pt = (deg) => [cx + r * Math.cos((Math.PI * deg) / 180), cy + r * Math.sin((Math.PI * deg) / 180)];
  const [x0, y0] = pt(180);
  const [x1, y1] = pt(end);
  const [tx, ty] = pt(180);
  const [nx, ny] = [cx + (r - 12) * Math.cos((Math.PI * end) / 180), cy + (r - 12) * Math.sin((Math.PI * end) / 180)];
  const large = end - 180 > 180 ? 1 : 0;
  return `<div class="gauge">
    <svg viewBox="0 0 128 74" aria-hidden="true">
      <path d="M ${x0} ${y0} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="var(--line)" stroke-width="9" stroke-linecap="round"/>
      <path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
      <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity=".85"/>
      <circle cx="${cx}" cy="${cy}" r="2.6" fill="${color}"/>
      <text x="${tx + 3}" y="${cy + 12}" font-size="8" fill="var(--dim)" font-family="ui-monospace">0</text>
      <text x="${cx + r - 9}" y="${cy + 12}" font-size="8" fill="var(--dim)" font-family="ui-monospace">100</text>
    </svg>
    <span class="g-val" style="color:${color}">${(p * 100).toFixed(0)}%</span>
    <span class="g-cap">${esc(caption)}</span>
  </div>`;
}

function meterRow(label, value, color) {
  return `<div class="bar-row">
    <span class="mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
    <span class="meter"><i style="width:${clamp(value, 0, 1) * 100}%;background:${color || 'var(--long)'}"></i></span>
    <span class="mono dim" style="text-align:right">${(clamp(value, 0, 1) * 100).toFixed(0)}</span>
  </div>`;
}

function sparkCell(sig) {
  const box = document.createElement('span');
  box.className = 'spark';
  box.appendChild(sparkline(sig.spark, { width: 76, height: 22 }));
  return box.outerHTML;
}

const outlier = (sig) => sig.side !== 'flat';

/* --------------------------------- news glue -------------------------------- */

/** Resolve a typed query to a universe symbol when possible (better GDELT results). */
function tickerParams(q) {
  const t = String(q || '').trim().toUpperCase();
  if (!t) return null;
  const inst = S.bySymbol.get(t);
  if (inst) return { symbol: inst.symbol, companyName: inst.name, timespan: undefined, limit: 40 };
  return { query: t, limit: 40 };
}

/**
 * Wrap the news client: GDELT rejects malformed boolean queries and rate-limits
 * bursts, so a failed search retries once with plain terms instead of dying.
 */
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
]);

async function fetchNewsSafe(params, timeoutMs = 26000) {
  if (!S.news) return { ok: false, error: 'news module not loaded', items: [] };
  let last = { ok: false, error: 'no attempt', items: [] };
  const attempts = [params];
  if (params.query) attempts.push({ query: 'stocks', timespan: params.timespan, limit: params.limit });
  else attempts.push({ query: `"${params.companyName || params.symbol || 'stocks'}"`, timespan: params.timespan, limit: params.limit });
  for (const attempt of attempts) {
    try {
      const clean = Object.fromEntries(Object.entries(attempt).filter(([, v]) => v !== undefined));
      const r = await withTimeout(S.news.fetchNews(clean), timeoutMs, 'news index');
      if (r && r.ok && r.items && r.items.length) return r;
      last = r || last;
    } catch (e) { last = { ok: false, error: e.message, items: [] }; }
  }
  return last;
}

/* -------------------------------- dashboard -------------------------------- */

async function viewDashboard() {
  const b = S.backtest;
  const live_ = S.signals.filter(outlier);
  const longs = S.signals.filter((s) => s.side === 'long').length;
  const shorts = S.signals.filter((s) => s.side === 'short').length;
  const spy = S.signalBy.get('SPY');
  const vix = S.signalBy.get('^VIX');
  const above50 = S.signals.filter((s) => isNum(s.ema50) && s.price > s.ema50).length;
  const above200 = S.signals.filter((s) => isNum(s.ema200) && s.price > s.ema200).length;
  const eq = S.signals.filter((s) => s.cls === 'equity' || s.cls === 'etf');
  const regime = regimeOf(spy, vix, above50 / Math.max(1, S.signals.length));

  const top = [...S.signals].filter(outlier).sort((a, x) => x.edgeR - a.edgeR).slice(0, 9);
  const sorted = [...S.signals].sort((a, x) => x.change - x.change);
  const movers = [...sorted.slice(0, 4).reverse(), ...sorted.slice(-4)];

  const viewEl = $('#view');
  viewEl.innerHTML = `
    <div class="hero">
      <h1>Market overview</h1>
      <p>Signals are generated by a logistic-regression ensemble trained on ${n2(S.model.training.rows, 0)} labelled bars from ${esc(S.model.training.symbols)} symbols. Each one answers a single question: how likely is this instrument to reach a ${TP_MULT.toFixed(1)}×ATR target before its ${SL_MULT.toFixed(1)}×ATR stop? Measured out of sample, the edge is thin — the Model page prints the numbers, including the drawdown.</p>
    </div>

    <div class="kpi-grid" style="margin-bottom:14px">
      <div class="kpi"><div class="k">Portfolio CAGR, out of sample</div><div class="v ${signCls(b.portfolio?.cagrPct)}">${isNum(b.portfolio?.cagrPct) ? b.portfolio.cagrPct.toFixed(1) + '%' : '—'}</div><div class="s">top-${b.rule.topK} book · max drawdown ${isNum(b.portfolio?.maxDrawdownPct) ? b.portfolio.maxDrawdownPct.toFixed(0) + '%' : '—'}</div></div>
      <div class="kpi"><div class="k">Per-signal expectancy</div><div class="v ${signCls(b.oos.expectancyR)}">${rmult(b.oos.expectancyR)}</div><div class="s">${n2(b.oos.trades, 0)} signals · PF ${b.oos.profitFactor ? b.oos.profitFactor.toFixed(2) : '—'}</div></div>
      <div class="kpi"><div class="k">Hit rate</div><div class="v">${(b.oos.winRate * 100).toFixed(1)}%</div><div class="s">break-even is ${(b.rule.breakevenHitRate * 100).toFixed(1)}%</div></div>
      <div class="kpi"><div class="k">Signals firing now</div><div class="v">${live_.length}<span class="dim" style="font-size:14px">/${S.signals.length}</span></div><div class="s">${longs} long · ${shorts} short · gate ${(threshold() * 100).toFixed(0)}%</div></div>
    </div>

    <div class="row cols-2" style="margin-bottom:14px">
      <section class="card">
        <div class="card-head">
          <h2>Top-ranked setups</h2>
          <span class="card-sub">as of ${dateOf(S.model.training.dateRange[1])}</span>
        </div>
        <div class="table-wrap">
          <table class="tight">
            <colgroup><col style="width:27%"><col style="width:13%"><col style="width:13%"><col style="width:12%"><col style="width:35%"></colgroup>
            <thead><tr><th class="no-sort">Instrument</th><th class="no-sort">Bias</th><th class="no-sort">P(TP)</th><th class="no-sort">Edge</th><th class="no-sort">Stop → target</th></tr></thead>
            <tbody>
              ${top.length ? top.map((s) => `
                <tr data-sym="${esc(s.symbol)}">
                  <td><span class="sym">${esc(s.symbol)}</span><span class="nm">${esc(s.name)}</span></td>
                  <td>${`<span class="badge ${s.side}">${s.side === 'long' ? 'LONG' : s.side === 'short' ? 'SHORT' : 'FLAT'}</span>`}</td>
                  <td class="mono">${(s.pWin * 100).toFixed(1)}%</td>
                  <td class="mono ${signCls(s.edgeR)}">${rmult(s.edgeR)}</td>
                  <td class="mono" title="stop → take-profit"><span class="neg">${fmtPrice(s.stop)}</span><span class="dim"> → </span><span class="pos">${fmtPrice(s.target)}</span></td>
                </tr>`).join('') : `<tr><td colspan="5"><div class="empty">No instrument currently clears the probability gate. That is a legitimate output: the model only speaks when its edge is positive.</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <div class="stack">
        <section class="card card-pad">
          <div class="flex" style="margin-bottom:12px">
            <h2 style="font-size:15px">Market regime</h2>
            <span class="spacer"></span>
            <span class="badge ${regime.kind}">${esc(regime.label)}</span>
          </div>
          <div class="bars">
            ${meterRow('S&P 500 vs 50-day', clamp(0.5 + (spy?.spyTrend || 0) / 6, 0, 1), (spy?.spyTrend || 0) >= 0 ? 'var(--long)' : 'var(--short)')}
            ${meterRow('Breadth above 50-day', above50 / Math.max(1, S.signals.length), 'var(--accent)')}
            ${meterRow('Breadth above 200-day', above200 / Math.max(1, S.signals.length), 'var(--accent)')}
            ${meterRow('Volatility (VIX)', clamp((vix?.price || 18) / 50, 0, 1), (vix?.price || 18) > 25 ? 'var(--short)' : 'var(--warn)')}
          </div>
          <div class="hint" style="margin-top:12px">${esc(regime.note)}</div>
        </section>

        <section class="card card-pad">
          <h2 style="font-size:15px;margin-bottom:10px">Biggest movers <span class="dim" style="font-weight:400;font-size:11.5px">· 1-day</span></h2>
          <div class="stack" style="gap:7px">
            ${movers.map((s) => `
              <div class="flex" data-sym="${esc(s.symbol)}" style="cursor:pointer;font-size:12.5px">
                <span class="mono" style="min-width:66px">${esc(s.symbol)}</span>
                <span class="dim" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
                <span class="mono">${fmtPrice(s.price)}</span>
                <span class="mono ${signCls(s.change)}" style="min-width:62px;text-align:right">${pctRaw(s.change)}</span>
              </div>`).join('')}
          </div>
        </section>
      </div>
    </div>

    <div class="row cols-2">
      <section class="card">
        <div class="card-head"><h2>Live news wire</h2><a class="card-sub" href="#/news">All sources →</a></div>
        <div class="news-list" id="dashNews">${[1, 2, 3, 4].map(() => `<div class="news-item"><div class="skeleton" style="height:12px;width:78px"></div><div style="flex:1"><div class="skeleton" style="height:12px;width:92%"></div></div></div>`).join('')}</div>
      </section>
      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:8px">How to read this desk</h2>
        <p class="hint" style="margin-bottom:10px">Every number here comes from one of three places: the bundled 10-year price history, the model weights in <code>data/model.json</code>, or a live API you enable yourself. Nothing is a mock-up.</p>
        <div class="stack" style="gap:9px">
          ${[['1', 'Pick an instrument', 'Search any ticker, or open the Screener and sort by edge.'],
             ['2', 'Read the plan', 'Entry, stop and target are derived from ATR — the same geometry the model was trained on.'],
             ['3', 'Check the replay', 'Each instrument carries its own out-of-sample trade history, not a chart-perfect fit.'],
             ['4', 'Size it', 'Risk a fixed percentage per trade; the position size is computed for you.']].map(([n, t, d]) => `
            <div class="flex" style="align-items:flex-start;gap:10px">
              <span class="badge accent" style="min-width:20px;justify-content:center">${n}</span>
              <div><b style="font-size:12.5px">${esc(t)}</b><div class="hint">${esc(d)}</div></div>
            </div>`).join('')}
        </div>
      </section>
    </div>
  `;

  wireSymbolRows(viewEl);
  renderDashNews();
}

function regimeOf(spy, vix, breadth) {
  const trend = spy?.spyTrend ?? 0;
  const v = vix?.price ?? 18;
  if (trend > 0.5 && v < 22 && breadth > 0.5) return { kind: 'long', label: 'Risk-on', note: 'Trend, volatility and breadth are aligned. Trend-following signals have the wind behind them; mean-reversion shorts are lower quality.' };
  if (trend < -0.5 || v > 28) return { kind: 'short', label: 'Risk-off', note: 'Either the index is below its 50-day trend or volatility is elevated. Longs need a higher probability to justify the same risk.' };
  return { kind: 'warn', label: 'Mixed', note: 'The index trend, volatility and breadth disagree. Expect more false breakouts; smaller size is the sane response.' };
}

async function renderDashNews() {
  const box = $('#dashNews');
  if (!box) return;
  if (!S.news) { box.innerHTML = `<div class="empty">News module not loaded.</div>`; return; }
  try {
    const r = await fetchNewsSafe({ query: '("stock market" OR "Federal Reserve" OR "Wall Street")', timespan: '1d', limit: 6 });
    if (!r.ok || !r.items.length) throw new Error(r.error || 'no items');
    box.innerHTML = r.items.slice(0, 6).map((it) => `
      <div class="news-item">
        <span class="src" title="${esc(it.domain)}">${esc(it.source || it.domain)}</span>
        <div style="min-width:0">
          <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
          <div class="t">${esc((it.published || '').replace('T', ' ').slice(0, 16))}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">Live news unavailable right now (${esc(e.message)}). The <a href="#/news">news page</a> retries automatically.</div>`;
  }
}

/* --------------------------------- analyzer -------------------------------- */

async function viewAnalyze(symbol) {
  const viewEl = $('#view');
  if (!symbol) {
    const top = [...S.signals].sort((a, x) => x.edgeR - a.edgeR).slice(0, 6);
    viewEl.innerHTML = `
      <div class="hero"><h1>Analyzer</h1><p>Search a ticker above, or start from one of the strongest current readings.</p></div>
      <div class="nets">
        ${top.map((s) => `<a class="net" href="#/analyze/${esc(s.symbol)}"><em>${esc(s.cls)}</em><b>${esc(s.symbol)} · ${fmtPrice(s.price)}</b><span>${esc(s.name)}</span><span style="margin-top:6px">${sideBadge(s.side, s.conviction)} <span class="mono ${signCls(s.edgeR)}">${rmult(s.edgeR)}</span></span></a>`).join('')}
      </div>`;
    return;
  }
  if (!S.bySymbol.has(symbol)) {
    viewEl.innerHTML = `<div class="hero"><h1>${esc(symbol)}</h1><p>This ticker is not in the bundled ${S.universe.length}-symbol dataset.</p></div>
      <section class="card card-pad"><p class="hint">The dataset ships with ${S.universe.length} instruments and 10 years of daily bars each. To analyse any other ticker, add a free Twelve Data API key in <a href="#/settings">Settings</a> — the app will then fetch its daily history on demand and run the same model.</p>
      <div class="flex" style="margin-top:10px"><a class="btn" href="#/settings">Open settings</a><a class="btn ghost" href="#/news">Read news for ${esc(symbol)}</a></div></section>`;
    return;
  }

  viewEl.innerHTML = `<div class="empty"><div class="skeleton" style="height:180px;max-width:800px;margin:0 auto 12px"></div><div class="skeleton" style="height:320px"></div></div>`;
  let a;
  try { a = await runAnalysis(symbol); } catch (e) { viewEl.innerHTML = `<div class="empty">Could not analyse ${esc(symbol)}: ${esc(e.message)}</div>`; return; }
  if (!a.ok) { viewEl.innerHTML = `<div class="empty">${esc(a.error)}</div>`; return; }

  const side = a.signal;
  const color = side === 'long' ? 'var(--long)' : side === 'short' ? 'var(--short)' : 'var(--flat)';
  const t = a.trade;
  const bars = await getBars(symbol);
  const replay = S.model.folds?.length ? backtestWalkForward({ bars, ctx: await getContext(), model: S.model, inst: S.bySymbol.get(symbol), threshold: threshold() }) : { trades: [], metrics: { trades: 0 } };
  const inst = S.bySymbol.get(symbol);
  const hist = `${dateOf(inst.first)} → ${dateOf(inst.last)}`;

  viewEl.innerHTML = `
    <div class="flex wrap" style="margin-bottom:12px">
      <div>
        <h1 style="font-size:24px">${esc(a.symbol)} <span class="dim" style="font-weight:400;font-size:15px">${esc(a.name || '')}</span></h1>
        <div class="flex" style="gap:8px;margin-top:2px">
          <span class="pill">${esc(inst.cls)}</span><span class="pill">${esc(inst.sector || '—')}</span>
          <span class="pill">${esc(hist)}</span>
          <span class="pill" title="Bars used">${n2(inst.count, 0)} bars</span>
        </div>
      </div>
      <span class="spacer"></span>
      <div style="text-align:right">
        <div class="num-big">${fmtPrice(a.price)}</div>
        <div class="mono ${signCls(a.change)}">${pctRaw(a.change)} <span class="dim">1d</span></div>
      </div>
    </div>

    <div class="verdict ${side}" style="margin-bottom:14px">
      <div class="verdict-top">
        <div style="min-width:250px">
          <div class="verdict-action"><small>Model verdict</small>${side === 'long' ? 'GO LONG' : side === 'short' ? 'GO SHORT' : 'NO TRADE'}</div>
          <div class="verdict-meta" style="margin-top:10px">
            <span>${sideBadge(side, a.conviction)}</span>
            <span>Expectancy <b class="${signCls(a.edgeR)}">${rmult(a.edgeR)}</b> per trade after est. costs</span>
            <span>Signal bar <b>${esc(dateOf(a.asOf))}</b> · ATR <b>${fmtPrice(a.atr)}</b> (${a.atrPct.toFixed(1)}% of price)</span>
            <span>Directional confidence <b>${(a.directionProb * 100).toFixed(1)}%</b></span>
          </div>
        </div>
        ${gaugeSVG(side === 'short' ? a.probs.short.win : a.probs.long.win, color, side === 'flat' ? 'best-side P(target)' : 'P(target before stop)', true)}
        <div class="verdict-meta" style="flex:1;min-width:210px">
          <span class="label-xs">Probabilities</span>
          <span>Long → target <b class="pos">${(a.probs.long.win * 100).toFixed(1)}%</b> · stop <b class="neg">${(a.probs.long.loss * 100).toFixed(1)}%</b> · timeout <b>${(a.probs.long.timeout * 100).toFixed(1)}%</b></span>
          <span>Short → target <b class="pos">${(a.probs.short.win * 100).toFixed(1)}%</b> · stop <b class="neg">${(a.probs.short.loss * 100).toFixed(1)}%</b> · timeout <b>${(a.probs.short.timeout * 100).toFixed(1)}%</b></span>
          <span class="hint">Gate in force: P(target) ≥ ${((S.backtest?.rule?.breakevenHitRate ?? 0.3333) * 100).toFixed(1)}% (the break-even rate for 2:1) and expectancy &gt; +${(S.backtest?.rule?.minEdgeR ?? 0.10).toFixed(2)}R after costs.</span>
        </div>
      </div>

      ${t ? `
      <div class="plan-grid" style="margin-top:16px">
        <div class="plan-cell"><div class="k">Entry</div><div class="v">${fmtPrice(t.entry)}</div><div class="s">${side === 'long' ? 'buy' : 'sell short'} at last close</div></div>
        <div class="plan-cell stop"><div class="k">Stop loss</div><div class="v">${fmtPrice(t.stop)}</div><div class="s">${t.stopDistancePct}% away · ${SL_MULT.toFixed(1)}×ATR</div></div>
        <div class="plan-cell target"><div class="k">Take profit 1</div><div class="v">${fmtPrice(t.tp1)}</div><div class="s">1.0×ATR · scale 50%</div></div>
        <div class="plan-cell target"><div class="k">Take profit 2</div><div class="v">${fmtPrice(t.target)}</div><div class="s">${TP_MULT.toFixed(1)}×ATR · model's target</div></div>
        <div class="plan-cell"><div class="k">Risk / share</div><div class="v">${fmtPrice(t.riskPerShare)}</div><div class="s">reward ${fmtPrice(t.rewardPerShare)}</div></div>
        <div class="plan-cell"><div class="k">Position size</div><div class="v">${n2(t.shares, 0)}</div><div class="s">${money(t.notional)} notional</div></div>
        <div class="plan-cell"><div class="k">Risk at stop</div><div class="v">${money(t.riskCash)}</div><div class="s">${S.settings.riskPct}% of ${money(S.settings.account)}</div></div>
        <div class="plan-cell"><div class="k">Reward : risk</div><div class="v">${t.riskReward}</div><div class="s">at target 2</div></div>
      </div>
      <div class="hint" style="margin-top:10px">${esc(t.invalidation)}</div>` : `
      <div class="hint" style="margin-top:14px">Neither side clears the gate. The model is saying the setup is not worth the risk — the strongest reading available is ${(Math.max(a.probs.long.win, a.probs.short.win) * 100).toFixed(1)}% against a ${(threshold() * 100).toFixed(0)}% requirement. Sitting out <em>is</em> the signal.</div>`}
    </div>

    <div class="row cols-2" style="margin-bottom:14px;grid-template-columns:minmax(0,1.75fr) minmax(0,1fr)">
      <section class="card">
        <div class="card-head">
          <h3>Price action</h3>
          <div class="seg" id="tfSeg">${['3M', '6M', '1Y', '2Y', '5Y', '10Y'].map((x) => `<button data-tf="${x}" class="${x === '1Y' ? 'on' : ''}">${x}</button>`).join('')}</div>
        </div>
        <div id="priceChart" style="padding:2px 4px 6px"></div>
        <div class="legend" style="padding:0 18px 14px">
          <span><i style="background:#5aa9ff"></i>EMA 50</span>
          <span><i style="background:#ffb84d"></i>EMA 200</span>
          <span><i style="background:var(--short)"></i>Stop</span>
          <span><i style="background:var(--long)"></i>Target</span>
        </div>
      </section>

      <div class="stack">
        <section class="card card-pad">
          <h3 style="margin-bottom:10px">What is driving the score</h3>
          <div class="bars">
            ${a.drivers.length ? a.drivers.map((d) => `
              <div class="bar-row" style="grid-template-columns:1fr 84px 46px">
                <span class="mut">${esc(d.label)}</span>
                <span class="bar-track"><i class="bar-fill ${d.push >= 0 ? 'pos' : 'neg'}" style="width:${clamp(Math.abs(d.push) / 0.6, 0, 1) * 50}%"></i></span>
                <span class="mono ${d.push >= 0 ? 'pos' : 'neg'}" style="text-align:right">${d.push >= 0 ? '+' : ''}${d.push.toFixed(2)}</span>
              </div>`).join('') : '<span class="hint">No single feature dominates.</span>'}
          </div>
          <div class="hint" style="margin-top:10px">Bars show each standardised feature's contribution to the ${side === 'flat' ? 'best' : side} probability. This is a linear model, so those contributions add up exactly.</div>
        </section>

        <section class="card card-pad">
          <h3 style="margin-bottom:10px">Context</h3>
          <div class="bars">
            ${meterRow('Trend structure', a.context.trend, 'var(--long)')}
            ${meterRow('Momentum', a.context.momentum, 'var(--accent)')}
            ${meterRow('Volume support', a.context.volume, 'var(--warn)')}
            ${meterRow('Market backdrop', a.context.market, 'var(--accent)')}
          </div>
          <div class="plan-grid" style="margin-top:12px;grid-template-columns:repeat(3,1fr)">
            <div class="plan-cell"><div class="k">RSI 14</div><div class="v" style="font-size:14px">${isNum(a.context.rsi) ? a.context.rsi.toFixed(1) : '—'}</div><div class="s">${esc(a.context.label)}</div></div>
            <div class="plan-cell"><div class="k">ADX</div><div class="v" style="font-size:14px">${isNum(a.context.adx) ? a.context.adx.toFixed(1) : '—'}</div><div class="s">${a.context.adx > 25 ? 'trending' : a.context.adx > 15 ? 'weak trend' : 'no trend'}</div></div>
            <div class="plan-cell"><div class="k">VIX</div><div class="v" style="font-size:14px">${isNum(a.context.vix) ? a.context.vix.toFixed(1) : '—'}</div><div class="s">${esc(a.context.volatilityBand)} vol</div></div>
          </div>
        </section>
      </div>
    </div>

    <div class="row cols-3" style="margin-bottom:14px">
      <section class="card card-pad">
        <h3 style="margin-bottom:10px">Key levels</h3>
        <div class="stack" style="gap:6px;font-size:12.5px">
          <div class="flex"><span class="dim" style="flex:1">Resistance</span><span class="mono">${a.levels.resistances.map((x) => fmtPrice(x)).join(' · ') || '—'}</span></div>
          <div class="flex"><span class="dim" style="flex:1">Support</span><span class="mono">${a.levels.supports.map((x) => fmtPrice(x)).join(' · ') || '—'}</span></div>
          <div class="flex"><span class="dim" style="flex:1">52-week high</span><span class="mono">${fmtPrice(a.levels.high52)}</span></div>
          <div class="flex"><span class="dim" style="flex:1">52-week low</span><span class="mono">${fmtPrice(a.levels.low52)}</span></div>
          <div class="flex"><span class="dim" style="flex:1">EMA 50 / 200</span><span class="mono">${fmtPrice(a.context.ema50)} / ${fmtPrice(a.context.ema200)}</span></div>
        </div>
      </section>

      <section class="card card-pad">
        <h3 style="margin-bottom:10px">Risk flags</h3>
        <div class="stack" style="gap:8px">
          ${a.flags.length ? a.flags.map((f) => `<div class="flex" style="align-items:flex-start;gap:8px"><span class="badge ${f.level === 'high' ? 'short' : f.level === 'med' ? 'warn' : 'muted'}" style="flex:none">${esc(f.level)}</span><span class="hint">${esc(f.text)}</span></div>`).join('') : '<span class="hint">Nothing unusual in volatility, liquidity or structure.</span>'}
        </div>
      </section>

      <section class="card card-pad">
        <h3 style="margin-bottom:6px">Out-of-sample replay</h3>
        <p class="hint" style="margin-bottom:10px">This instrument, traded by the walk-forward model (each year judged only by weights fit before it).</p>
        ${replay.metrics.trades ? `
          <div class="plan-grid" style="grid-template-columns:repeat(2,1fr)">
            <div class="plan-cell"><div class="k">Trades</div><div class="v" style="font-size:15px">${replay.metrics.trades}</div></div>
            <div class="plan-cell"><div class="k">Hit rate</div><div class="v" style="font-size:15px">${(replay.metrics.winRate * 100).toFixed(0)}%</div></div>
            <div class="plan-cell"><div class="k">Expectancy</div><div class="v ${signCls(replay.metrics.expectancyR)}" style="font-size:15px">${rmult(replay.metrics.expectancyR)}</div></div>
            <div class="plan-cell"><div class="k">Total</div><div class="v ${signCls(replay.metrics.totalR)}" style="font-size:15px">${replay.metrics.totalR.toFixed(1)}R</div></div>
          </div>
          <div class="hint" style="margin-top:8px">${replay.metrics.trades < 25 ? 'Small sample — treat these numbers as an anecdote, not evidence.' : 'Sample is large enough to be suggestive, not conclusive.'}</div>
        ` : `<div class="hint">No qualifying signals on this instrument in the evaluation years.</div>`}
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>News for ${esc(a.symbol)}</h2><span class="card-sub" id="newsMeta">live</span></div>
      <div class="news-list" id="tickerNews"><div class="news-item"><div class="skeleton" style="height:12px;width:90%"></div></div></div>
    </section>

    <div class="hint" style="margin:14px 2px 0">${esc(DISCLAIMER)}</div>
  `;

  drawPriceChart(symbol, bars, a);
  $$('#tfSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#tfSeg button').forEach((x) => x.classList.toggle('on', x === b));
    drawPriceChart(symbol, bars, a, b.dataset.tf);
  }));
  loadTickerNews(a.symbol, a.name);
}

function drawPriceChart(symbol, bars, a, timeframe = '1Y') {
  const spans = { '3M': 63, '6M': 126, '1Y': 252, '2Y': 504, '5Y': 1260, '10Y': 100000 };
  const n = spans[timeframe] || 252;
  const start = Math.max(0, bars.c.length - n);
  const slice = {
    date: bars.date.slice(start), o: bars.o.slice(start), h: bars.h.slice(start),
    l: bars.l.slice(start), c: bars.c.slice(start), v: bars.v.slice(start),
  };
  const e50 = ema(bars.c, 50).slice(start);
  const e200 = ema(bars.c, 200).slice(start);
  const box = $('#priceChart');
  if (!box) return;
  box.innerHTML = '';
  const levels = [];
  // Only draw trade levels if they are inside the visible price window
  if (a.trade) {
    const lo = Math.min(...slice.l), hi = Math.max(...slice.h);
    const inside = (p) => p >= lo * 0.9 && p <= hi * 1.1;
    if (inside(a.trade.stop)) levels.push({ price: a.trade.stop, color: 'var(--short)', label: `STOP ${fmtPrice(a.trade.stop)}` });
    if (inside(a.trade.target)) levels.push({ price: a.trade.target, color: 'var(--long)', label: `TARGET ${fmtPrice(a.trade.target)}` });
    if (inside(a.trade.entry)) levels.push({ price: a.trade.entry, color: 'var(--muted)', label: `ENTRY ${fmtPrice(a.trade.entry)}`, dash: [2, 3] });
  }
  levels.push({ price: a.levels.high52, color: 'var(--warn)', label: '52w high', dash: [1, 4] });
  levels.push({ price: a.levels.low52, color: 'var(--warn)', label: '52w low', dash: [1, 4] });
  new CandleChart(box, {
    height: 330,
    overlays: [
      { name: 'ema50', values: e50, color: '#5aa9ff', width: 1.3 },
      { name: 'ema200', values: e200, color: '#ffb84d', width: 1.3 },
    ],
    levels,
  }).setData(slice);
}

async function loadTickerNews(symbol, name) {
  const box = $('#tickerNews'), meta = $('#newsMeta');
  if (!box) return;
  if (!S.news) { box.innerHTML = `<div class="empty">News module unavailable.</div>`; return; }
  try {
    const r = await S.news.fetchNews({ symbol, companyName: name, timespan: '2w', limit: 8 });
    if (!r.ok) throw new Error(r.error || 'failed');
    if (meta) meta.textContent = `${r.items.length} stories · ${r.items[0]?.domain || ''}`;
    box.innerHTML = r.items.length ? r.items.map((it) => `
      <div class="news-item">
        <span class="src" title="${esc(it.domain)}">${esc(it.source || it.domain)}</span>
        <div style="min-width:0">
          <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
          <div class="t">${esc((it.published || '').replace('T', ' ').slice(0, 16))} · ${esc(it.country || '')}</div>
        </div>
      </div>`).join('') : `<div class="empty">No recent stories matched this ticker.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">Could not load news: ${esc(e.message)}</div>`;
  }
}

/* --------------------------------- screener -------------------------------- */

function viewScreener() {
  const viewEl = $('#view');
  viewEl.innerHTML = `
    <div class="hero"><h1>Screener</h1><p>Every instrument in the dataset, ranked by what the model expects. Click a row to open the full analysis.</p></div>
    <section class="card">
      <div class="card-head wrap" style="gap:10px">
        <div class="seg" id="clsSeg">
          ${[['all', 'All'], ['equity', 'Stocks'], ['etf', 'ETFs'], ['crypto', 'Crypto'], ['index', 'Indexes']].map(([k, l]) => `<button data-cls="${k}" class="${S.screener.cls === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <div class="seg" id="sideSeg">
          ${[['all', 'Any'], ['long', 'Long'], ['short', 'Short'], ['flat', 'No trade']].map(([k, l]) => `<button data-side="${k}" class="${S.screener.side === k ? 'on' : ''}">${l}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <input id="scrQ" type="search" placeholder="Filter by symbol or name…" value="${esc(S.screener.q)}" style="max-width:240px" />
      </div>
      <div class="table-wrap"><table id="scrTable"></table></div>
    </section>
    <div class="hint" style="margin-top:10px">Probabilities and edges are computed at the last bar of the bundled dataset (${dateOf(S.model.training.dateRange[1])}). Column headers sort.</div>
  `;
  renderScreenerTable();
  $('#scrQ').addEventListener('input', (e) => { S.screener.q = e.target.value; renderScreenerTable(); });
  $$('#clsSeg button').forEach((b) => b.addEventListener('click', () => {
    S.screener.cls = b.dataset.cls; $$('#clsSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderScreenerTable();
  }));
  $$('#sideSeg button').forEach((b) => b.addEventListener('click', () => {
    S.screener.side = b.dataset.side; $$('#sideSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderScreenerTable();
  }));
}

const SCR_COLS = [
  ['symbol', 'Instrument', false], ['price', 'Last', true], ['change', '1d %', true],
  ['side', 'Bias', false], ['pWin', 'P(target)', true], ['edgeR', 'Edge', true],
  ['stop', 'Stop', true], ['target', 'Target', true], ['conviction', 'Conviction', false], ['adx', 'ADX', true], ['atrPct', 'ATR %', true],
];

function renderScreenerTable() {
  const { q, cls, side, sort, dir } = S.screener;
  let rows = S.signals.filter((s) => {
    if (cls !== 'all' && s.cls !== cls) return false;
    if (side !== 'all' && s.side !== side) return false;
    if (q) { const t = `${s.symbol} ${s.name}`.toLowerCase(); if (!t.includes(q.toLowerCase())) return false; }
    return true;
  });
  rows.sort((a, b) => {
    const av = a[sort], bv = b[sort];
    if (typeof av === 'string') return dir * String(av).localeCompare(String(bv));
    return dir * ((av ?? -1e9) - (bv ?? -1e9));
  });
  const table = $('#scrTable');
  if (!table) return;
  table.innerHTML = `
    <thead><tr>${SCR_COLS.map(([k, label, numeric]) => `<th data-sort="${k}" class="${sort === k ? 'sorted' : ''} ${numeric ? '' : ''}">${label}${sort === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.length ? rows.map((s) => `
        <tr data-sym="${esc(s.symbol)}">
          <td><span class="sym">${esc(s.symbol)}</span><span class="nm">${esc(s.name)}</span></td>
          <td class="mono">${fmtPrice(s.price)}</td>
          <td class="mono ${signCls(s.change)}">${pctRaw(s.change)}</td>
          <td>${sideBadge(s.side)}</td>
          <td class="mono">${(s.pWin * 100).toFixed(1)}%</td>
          <td class="mono ${signCls(s.edgeR)}">${rmult(s.edgeR)}</td>
          <td class="mono neg">${s.stop ? fmtPrice(s.stop) : '—'}</td>
          <td class="mono pos">${s.target ? fmtPrice(s.target) : '—'}</td>
          <td class="dim">${esc(s.conviction || '—')}</td>
          <td class="mono dim">${isNum(s.adx) ? s.adx.toFixed(0) : '—'}</td>
          <td class="mono dim">${isNum(s.atrPct) ? s.atrPct.toFixed(1) : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="11"><div class="empty">No instruments match these filters.</div></td></tr>`}
    </tbody>
    <tfoot><tr><td colspan="11" class="dim" style="text-align:left;font-size:11.5px;padding:10px 16px">${rows.length} of ${S.signals.length} instruments</td></tr></tfoot>
  `;
  $$('#scrTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (S.screener.sort === k) S.screener.dir *= -1;
    else { S.screener.sort = k; S.screener.dir = ['symbol', 'side', 'conviction'].includes(k) ? 1 : -1; }
    renderScreenerTable();
  }));
  wireSymbolRows($('#scrTable'));
}

function wireSymbolRows(root) {
  $$('[data-sym]', root).forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      location.hash = `#/analyze/${el.dataset.sym}`;
    });
  });
}

/* ---------------------------------- model ---------------------------------- */

function viewModel() {
  const b = S.backtest, m = S.model;
  const p = b.portfolio || {};
  const curve = (b.portfolioCurve || []).map((x) => ({ x: x.x, y: x.y }));
  const bench = b.baseline?.momentumTopK || null;
  const years = Object.entries(p.byYear || {}).sort();
  const cal = (b.calibration || []).filter((c) => c.observed !== null && c.n >= 30);
  const deciles = b.deciles || [];
  const info = b.information || {};
  const maxDec = Math.max(...deciles.map((d) => d.meanFwdAtr), 0.01);

  $('#view').innerHTML = `
    <div class="hero"><h1>Model &amp; methodology</h1><p>A small, interpretable statistical model — deliberately not a black box. Every number here is measured out of sample, on years whose weights were fit only on earlier data, and the benchmark comparison is printed whether it flatters the model or not.</p></div>

    <div class="kpi-grid" style="margin-bottom:14px">
      <div class="kpi"><div class="k">Portfolio CAGR</div><div class="v ${signCls(p.cagrPct)}">${isNum(p.cagrPct) ? p.cagrPct.toFixed(1) + '%' : '—'}</div><div class="s">top-${b.rule.topK} signals, ${p.trades} trades, ${(p.years || 0).toFixed(1)} yrs</div></div>
      <div class="kpi"><div class="k">Max drawdown</div><div class="v neg">${isNum(p.maxDrawdownPct) ? p.maxDrawdownPct.toFixed(0) + '%' : '—'}</div><div class="s">peak-to-trough equity, 1% risk per trade</div></div>
      <div class="kpi"><div class="k">Per-signal expectancy</div><div class="v ${signCls(b.oos.expectancyR)}">${rmult(b.oos.expectancyR)}</div><div class="s">${n2(b.oos.trades, 0)} signals · PF ${b.oos.profitFactor ? b.oos.profitFactor.toFixed(2) : '—'}</div></div>
      <div class="kpi"><div class="k">Hit rate</div><div class="v">${(b.oos.winRate * 100).toFixed(1)}%</div><div class="s">break-even is ${(b.rule.breakevenHitRate * 100).toFixed(1)}%</div></div>
      <div class="kpi"><div class="k">Rank IC</div><div class="v">${isNum(info.rankIC) ? info.rankIC.toFixed(3) : '—'}</div><div class="s">IR ${info.icIR ?? '—'} · positive ${isNum(info.positiveShare) ? (info.positiveShare * 100).toFixed(0) + '%' : '—'} of days</div></div>
    </div>

    <div class="row cols-2" style="margin-bottom:14px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
      <section class="card">
        <div class="card-head"><h2>Portfolio equity, out of sample</h2><span class="card-sub">${esc(b.oos && b.rule ? b.selectionYears : '')} selection · ${esc(b.holdoutYears)} holdout</span></div>
        <div id="eqChart" style="padding:4px"></div>
        <div class="hint" style="padding:0 18px 14px">One position per instrument, at most ${b.rule.topK} at a time, best edge first, ${b.rule.riskPct}% of equity risked per trade. Costs of ${(b.assumptions.costPctPerSide * 100).toFixed(2)}% per side are included. This is the shape a follower would have lived through — including the drawdown.</div>
      </section>
      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:6px">By year</h2>
        <div class="flex dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;gap:0;padding:0 2px 4px">
          <span style="width:44px">Year</span><span style="width:44px;text-align:right">Trades</span><span style="flex:1"></span><span style="width:60px;text-align:right">Total R</span><span style="width:64px;text-align:right">Return</span>
        </div>
        <div id="yearBars"></div>
        <div class="stack" style="gap:4px;margin-top:8px;font-size:12px">
          ${years.map(([y, v]) => `<div class="flex"><span class="mono dim" style="width:44px">${y}</span><span class="mono" style="width:44px;text-align:right">${v.trades}</span><span class="dim" style="flex:1">trades</span><span class="mono ${signCls(v.r)}">${v.r > 0 ? '+' : ''}${v.r.toFixed(0)}R</span><span class="mono ${signCls(v.retPct)}" style="width:58px">${v.retPct > 0 ? '+' : ''}${v.retPct}%</span></div>`).join('')}
        </div>
      </section>
    </div>

    <div class="row cols-2" style="margin-bottom:14px">
      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:4px">Does the ranking work?</h2>
        <p class="hint" style="margin-bottom:10px">Sort every signal the model saw into ten buckets by predicted edge, then look at what actually happened. A useful model produces a rising staircase.</p>
        <div class="bars">
          ${deciles.map((d) => `<div class="bar-row" style="grid-template-columns:52px 1fr 52px"><span class="mono dim">D${d.decile}</span><span class="meter"><i style="width:${clamp(d.meanFwdAtr / maxDec, 0, 1) * 100}%;background:${d.meanFwdAtr > 0 ? 'var(--long)' : 'var(--short)'}"></i></span><span class="mono ${signCls(d.meanFwdAtr)}" style="text-align:right">${d.meanFwdAtr.toFixed(2)}</span></div>`).join('')}
        </div>
        <div class="hint" style="margin-top:10px">Mean forward 15-day return, in ATR units. Top decile ${deciles.length ? deciles[deciles.length - 1].meanFwdAtr.toFixed(2) : '—'} vs bottom ${deciles.length ? deciles[0].meanFwdAtr.toFixed(2) : '—'}.</div>
      </section>

      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:4px">Benchmark honesty</h2>
        <p class="hint" style="margin-bottom:10px">The same portfolio mechanics, ranked three ways. If the model cannot beat plain momentum, it is not adding information.</p>
        <div class="table-wrap"><table>
          <thead><tr><th class="no-sort">Ranking</th><th class="no-sort">CAGR</th><th class="no-sort">Max DD</th><th class="no-sort">Win rate</th></tr></thead>
          <tbody>
            <tr><td>Model edge</td><td class="mono ${signCls(p.cagrPct)}">${isNum(p.cagrPct) ? p.cagrPct.toFixed(1) + '%' : '—'}</td><td class="mono neg">${isNum(p.maxDrawdownPct) ? p.maxDrawdownPct.toFixed(0) + '%' : '—'}</td><td class="mono">${isNum(p.winRate) ? (p.winRate * 100).toFixed(0) + '%' : '—'}</td></tr>
            <tr><td>20-day momentum</td><td class="mono ${signCls(bench?.cagrPct)}">${isNum(bench?.cagrPct) ? bench.cagrPct.toFixed(1) + '%' : '—'}</td><td class="mono neg">${isNum(bench?.maxDrawdownPct) ? bench.maxDrawdownPct.toFixed(0) + '%' : '—'}</td><td class="mono">${isNum(bench?.winRate) ? (bench.winRate * 100).toFixed(0) + '%' : '—'}</td></tr>
            <tr><td>Buy every bar</td><td class="mono dim">—</td><td class="mono dim">—</td><td class="mono dim">${isNum(b.baseline?.buyEveryBar?.winRate) ? (b.baseline.buyEveryBar.winRate * 100).toFixed(0) + '%' : '—'}</td></tr>
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:10px">${isNum(p.cagrPct) && isNum(bench?.cagrPct) && p.cagrPct - bench.cagrPct < 1
          ? '<b style="color:var(--warn)">The model does not materially beat plain momentum.</b> Treat its edge as a tiebreaker, not an oracle — that is exactly what the numbers say, so the app says it too.'
          : 'The model outpaced the momentum benchmark, though both carry deep drawdowns.'}</div>
      </section>
    </div>

    <div class="row cols-2" style="margin-bottom:14px">
      <section class="card">
        <div class="card-head"><h2>Gate sensitivity</h2><span class="card-sub">minimum edge required to trade</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th class="no-sort">Min edge</th><th class="no-sort">Signals</th><th class="no-sort">Per-signal exp.</th><th class="no-sort">Portfolio CAGR</th><th class="no-sort">Max DD</th></tr></thead>
          <tbody>${(b.sweep || []).map((s) => `<tr style="${Math.abs(s.minEdgeR - b.rule.minEdgeR) < 1e-9 ? 'background:var(--panel-3)' : ''}">
            <td class="mono">${s.minEdgeR.toFixed(2)}R${Math.abs(s.minEdgeR - b.rule.minEdgeR) < 1e-9 ? ' ←' : ''}</td>
            <td class="mono dim">${n2(s.selection?.trades, 0)}</td>
            <td class="mono ${signCls(s.selection?.expectancyR)}">${isNum(s.selection?.expectancyR) ? rmult(s.selection.expectancyR) : '—'}</td>
            <td class="mono ${signCls(s.portfolio?.cagrPct)}">${isNum(s.portfolio?.cagrPct) ? s.portfolio.cagrPct.toFixed(1) + '%' : '—'}</td>
            <td class="mono neg">${isNum(s.portfolio?.maxDrawdownPct) ? s.portfolio.maxDrawdownPct.toFixed(0) + '%' : '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="hint" style="padding:12px 18px">Raising the bar trades less. The moving average of this table is why the shipped rule (${b.rule.minEdgeR}R) is stated up front instead of being tuned to the best-looking row.</div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Calibration</h2><span class="card-sub">predicted vs realised hit rate</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th class="no-sort">Predicted P(target)</th><th class="no-sort">Realised</th><th class="no-sort">n</th><th class="no-sort">Gap</th></tr></thead>
          <tbody>${cal.map((c) => {
            const gap = c.observed - c.predicted;
            return `<tr><td class="mono">${(c.predicted * 100).toFixed(0)}–${(c.predicted * 100 + 10).toFixed(0)}%</td>
              <td class="mono">${(c.observed * 100).toFixed(1)}%</td>
              <td class="mono dim">${n2(c.n, 0)}</td>
              <td class="mono ${Math.abs(gap) < 0.03 ? 'pos' : 'neg'}">${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp</td></tr>`;
          }).join('') || '<tr><td colspan="4"><div class="empty">Not enough resolved labels per bucket.</div></td></tr>'}</tbody>
        </table></div>
        <div class="hint" style="padding:12px 18px">A model whose 40% bucket really wins 40% of the time is worth listening to. The gaps here are the honest test of whether the probabilities mean anything.</div>
      </section>
    </div>

    <div class="row cols-2" style="margin-bottom:14px">
      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:10px">How it works</h2>
        <div class="stack" style="gap:10px">
          <p class="hint"><b style="color:var(--text)">1. Label the past.</b> For every daily bar: did price touch +${TP_MULT.toFixed(1)}×ATR before −${SL_MULT.toFixed(1)}×ATR within ${HORIZON} trading days? That is a triple-barrier label — the target is a trade outcome, not a price prediction.</p>
          <p class="hint"><b style="color:var(--text)">2. Describe the moment.</b> ${m.features.length} features per bar: trend structure, momentum, mean-reversion, volume behaviour, volatility, market context (S&amp;P trend, VIX), plus each instrument's own trailing z-scores so it can be compared with everything else.</p>
          <p class="hint"><b style="color:var(--text)">3. Fit a softmax classifier.</b> Multinomial logistic regression per side, Adam with L2, ${n2(m.training.rows, 0)} bars across ${m.training.symbols} instruments, ${esc(m.training.dateRange[0])} → ${esc(m.training.dateRange[1])}.</p>
          <p class="hint"><b style="color:var(--text)">4. Refit forward, judge backward.</b> One model per evaluation year, trained only on earlier data. Every performance number on this page is the sum of those honest calls.</p>
          <p class="hint" style="margin:0"><b style="color:var(--text)">5. Gate, rank, size.</b> A trade needs P(target) ≥ the ${(b.rule.breakevenHitRate * 100).toFixed(1)}% break-even hit rate and expectancy &gt; +${b.rule.minEdgeR}R after costs. Stop = ${SL_MULT.toFixed(1)}×ATR, target = ${TP_MULT.toFixed(1)}×ATR — the geometry the model was trained on.</p>
        </div>
      </section>
      <section class="card card-pad">
        <h2 style="font-size:15px;margin-bottom:10px">Feature importance</h2>
        <div class="stack" style="gap:7px">
          ${(m.importance?.long || []).slice(0, 10).map((f) => `
            <div class="bar-row" style="grid-template-columns:1fr 84px 40px">
              <span class="mut" style="font-size:11.5px">${esc(FEATURE_LABELS[f.feature] || f.feature)}</span>
              <span class="meter"><i style="width:${clamp(f.weight / (m.importance.long[0].weight || 1), 0, 1) * 100}%"></i></span>
              <span class="mono dim" style="text-align:right;font-size:10.5px">${f.weight.toFixed(3)}</span>
            </div>`).join('')}
        </div>
        <div class="hint" style="margin-top:12px">Mean absolute weight on the long head. Trend structure and market context dominate — the features the literature actually supports.</div>
      </section>
    </div>

    <details class="disclose"><summary>Assumptions, costs and known limitations</summary><div class="stack" style="gap:8px">
      <p class="hint"><b style="color:var(--text)">Execution.</b> ${esc(b.assumptions.entry)}. ${esc(b.assumptions.exit)}. Costs of ${(b.assumptions.costPctPerSide * 100).toFixed(2)}% per side are deducted from every trade, and a bar that gaps through the stop fills at the open rather than the stop.</p>
      <p class="hint"><b style="color:var(--text)">Overlapping signals.</b> ${esc(b.assumptions.note)}</p>
      <p class="hint"><b style="color:var(--text)">Drawdown is the real cost.</b> A top-${b.rule.topK} book of ${b.rule.riskPct}% risks is not a smooth line; the ${isNum(p.maxDrawdownPct) ? p.maxDrawdownPct.toFixed(0) : '—'}% peak-to-trough above is what following it would have felt like.</p>
      <p class="hint"><b style="color:var(--text)">What it cannot see.</b> Earnings, guidance, litigation, macro prints, index rebalances, or any news after the last bar. It does not read order flow, depth or short interest.</p>
      <p class="hint"><b style="color:var(--text)">Selection bias.</b> The universe is today's large caps, not the index membership of 2016. That flatters every long bias here.</p>
      <p class="hint" style="margin:0">${esc(DISCLAIMER)}</p>
    </div></details>
  `;

  if (curve.length > 1) new LineChart($('#eqChart'), { height: 260, zero: true, yFormat: (v) => `${v.toFixed(0)}%` }).setData(curve);
  barChart($('#yearBars'), Object.entries(p.byYear || {}).sort().map(([y, v]) => ({ label: y.slice(2), value: +v.retPct, display: `${v.retPct > 0 ? '+' : ''}${v.retPct.toFixed(0)}%` })), { height: 128, split: true, showValues: false });
}

/* ----------------------------------- news ---------------------------------- */

async function viewNews() {
  const viewEl = $('#view');
  const nets = S.news?.networkLinks?.() || [];
  viewEl.innerHTML = `
    <div class="hero"><h1>News wire</h1><p>Live headlines from the open web, deduplicated and sorted by recency. The directory below is the same set of desks a trader keeps open in other tabs.</p></div>
    <section class="card" style="margin-bottom:14px">
      <div class="card-head wrap">
        <form class="flex" id="newsForm" style="gap:8px;flex:1">
          <input id="newsQ" type="search" placeholder="Ticker or keyword — NVDA, 'rate cut', 'oil supply'…" style="max-width:360px" />
          <div class="seg" id="newsSpan">
            ${[['1d', '24h'], ['3d', '3d'], ['1w', '1w']].map(([k, l], i) => `<button data-span="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}
          </div>
          <button class="btn primary sm" type="submit">Search</button>
        </form>
        <span class="card-sub" id="newsInfo">—</span>
      </div>
      <div class="news-list" id="newsList"><div class="empty">Loading live headlines…</div></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Financial networks</h2><span class="card-sub">${nets.length} sources</span></div>
      <div style="padding:14px 18px"><div class="nets">
        ${nets.map((n) => `<a class="net" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer"><em>${esc(n.category)}</em><b>${esc(n.name)}</b><span>${esc(n.blurb || '')}</span></a>`).join('') || '<div class="hint">Directory unavailable.</div>'}
      </div></div>
    </section>
  `;

  let span = '1d';
  const run = async (q) => {
    const list = $('#newsList'), info = $('#newsInfo');
    list.innerHTML = `<div class="empty">Searching the live news index… <span class="dim">GDELT can take up to 20 seconds</span></div>`;
    if (!S.news) { list.innerHTML = `<div class="empty">News module failed to load.</div>`; return; }
    try {
      const base = tickerParams(q) || { query: '("stock market" OR "Wall Street" OR "stock futures")' };
      const r = await fetchNewsSafe({ ...base, timespan: span, limit: 40 });
      if (!r.ok) throw new Error(r.error || 'failed');
      info.textContent = `${r.items.length} stories · ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
      list.innerHTML = r.items.length ? r.items.map((it) => `
        <div class="news-item">
          <span class="src" title="${esc(it.domain)}">${esc(it.source || it.domain)}</span>
          <div style="min-width:0">
            <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
            <div class="t">${esc((it.published || '').replace('T', ' ').slice(0, 16))}${it.country ? ` · ${esc(it.country)}` : ''}</div>
          </div>
        </div>`).join('') : `<div class="empty">No stories matched. Try a broader query.</div>`;
    } catch (e) {
      list.innerHTML = `<div class="empty">
        <p>The live news index did not answer: <span class="mono dim">${esc(e.message)}</span></p>
        <p class="hint">GDELT is a free public index — it rate-limits bursts and is occasionally slow. The network directory below always works.</p>
        <button class="btn sm" onclick="document.querySelector('#newsForm button[type=submit]').click()">Try again</button>
      </div>`;
    }
  };
  $('#newsForm').addEventListener('submit', (e) => { e.preventDefault(); run($('#newsQ').value.trim()); });
  $$('#newsSpan button').forEach((b) => b.addEventListener('click', () => {
    span = b.dataset.span; $$('#newsSpan button').forEach((x) => x.classList.toggle('on', x === b)); run($('#newsQ').value.trim());
  }));
  run('');
}

/* --------------------------------- research -------------------------------- */

function viewResearch() {
  const r = S.research;
  if (!r) { $('#view').innerHTML = `<div class="empty">Research file not found. Run <code>node tools/publish-data.mjs</code>.</div>`; return; }
  $('#view').innerHTML = `
    <div class="hero"><h1>The last ten years</h1><p>What actually happened in markets from 2016 to 2026, and what the evidence says about the indicators this model uses. Every figure links to a source.</p></div>
    <div class="stat-grid" style="margin-bottom:16px">
      ${(r.stats || []).map((s) => `<div class="stat"><div class="k">${esc(s.label)}</div><div class="v">${esc(s.value)}</div><div class="d">${esc(s.detail || '')}</div>${s.source ? `<a href="${esc(s.source)}" target="_blank" rel="noopener noreferrer" style="font-size:10.5px;color:var(--accent)">source</a>` : ''}</div>`).join('')}
    </div>
    <div class="row cols-2" style="grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)">
      <section class="card card-pad">
        <h2 style="margin-bottom:6px">The decade, year by year</h2>
        <div class="timeline">
          ${(r.eras || []).map((e) => `
            <div class="tl-item">
              <div class="tl-year">${esc(e.period)}</div>
              <div class="tl-body">
                <h3>${esc(e.title)}</h3>
                <p class="hint">${esc(e.summary)}</p>
                ${e.perf ? `<div class="flex wrap" style="gap:6px;margin-top:6px">${Object.entries(e.perf).filter(([, v]) => v).map(([k, v]) => `<span class="pill"><b style="color:var(--text)">${esc(k.toUpperCase())}</b> ${esc(v)}</span>`).join('')}</div>` : ''}
                <div class="tl-events">
                  ${(e.events || []).map((ev) => `<div class="tl-event"><time>${esc(ev.date)}</time><span><b style="color:var(--text)">${esc(ev.label)}</b> — ${esc(ev.note)}</span></div>`).join('')}
                </div>
              </div>
            </div>`).join('')}
        </div>
      </section>
      <div class="stack">
        <section class="card card-pad">
          <h2 style="margin-bottom:8px">What the evidence supports</h2>
          <div class="evidence">
            ${(r.evidence || []).map((x) => `<div class="ev" style="grid-template-columns:1fr auto">
              <div><b>${esc(x.topic)}</b><div class="hint">${esc(x.finding)}</div><a href="${esc(x.source)}" target="_blank" rel="noopener noreferrer">read source ↗</a></div>
              <span class="badge ${x.strength === 'strong' ? 'long' : x.strength === 'moderate' ? 'warn' : 'muted'}">${esc(x.strength)}</span>
            </div>`).join('')}
          </div>
        </section>
        <section class="card card-pad">
          <h2 style="margin-bottom:8px">Why this matters here</h2>
          <p class="hint">The model is built only from effects with surviving evidence: time-series momentum, trend persistence, volatility scaling and ATR-based risk. It deliberately avoids the indicators that fail out of sample.</p>
          <p class="hint" style="margin:0">${esc((r.disclaimers || []).join(' '))}</p>
        </section>
      </div>
    </div>
  `;
}

/* ----------------------------------- scan ---------------------------------- */

async function viewScan() {
  $('#view').innerHTML = `
    <div class="hero"><h1>Chart scan</h1><p>Drop in a screenshot of any chart — TradingView, your broker, a phone screenshot. The scanner reads candles, trend and levels from the pixels, then hands the result to a vision model if you have added a key.</p></div>
    <div class="row cols-2" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)">
      <section class="card card-pad">
        <div class="drop" id="drop">
          <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5l5 5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke-linecap="round"/></svg>
          <h3>Drop a chart image</h3>
          <p class="hint">PNG, JPG or WebP · analysed locally in your browser</p>
          <input type="file" id="fileInput" accept="image/*" hidden />
          <div class="flex" style="justify-content:center;margin-top:12px;gap:8px">
            <button class="btn primary" id="pickBtn">Choose image</button>
            <button class="btn ghost" id="sampleBtn">Use a sample chart</button>
          </div>
        </div>
        <div class="stack" style="margin-top:14px;gap:10px">
          <div class="row cols-2" style="gap:10px">
            <label class="field"><span>Axis low (optional)</span><input type="number" id="priceLow" placeholder="e.g. 180.00" step="any" /></label>
            <label class="field"><span>Axis high (optional)</span><input type="number" id="priceHigh" placeholder="e.g. 220.00" step="any" /></label>
          </div>
          <p class="hint" style="margin:0">Give the scanner the price range on the chart's y-axis and its detected levels become real prices instead of pixel rows.</p>
          <label class="field"><span>Cross-check against the quant model (optional)</span><input type="text" id="scanSym" placeholder="AAPL" /></label>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Result</h2><span class="card-sub" id="scanMeta">waiting for an image</span></div>
        <div id="scanOut" style="padding:16px 18px"><div class="empty">No analysis yet.<br />The local scanner runs instantly; the AI pass needs a key in Settings.</div></div>
      </section>
    </div>
    <div class="preview hidden" id="preview" style="margin-top:14px"></div>
  `;

  const drop = $('#drop'), input = $('#fileInput');
  const handle = (file) => runScan(file, null);
  $('#pickBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) handle(input.files[0]); });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handle(f); });

  $('#sampleBtn').addEventListener('click', async () => {
    const canvas = makeSampleChart();
    $('#preview').classList.remove('hidden');
    $('#preview').innerHTML = '';
    $('#preview').appendChild(canvas);
    await runScan(canvas, canvas);
  });

  async function runScan(source, canvasEl) {
    const out = $('#scanOut'), meta = $('#scanMeta');
    if (!S.vision) { out.innerHTML = `<div class="empty">Vision module not loaded.</div>`; return; }
    meta.textContent = 'analysing…';
    out.innerHTML = `<div class="empty">Reading the image…</div>`;
    const lo = parseFloat($('#priceLow').value), hi = parseFloat($('#priceHigh').value);
    const priceRange = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { low: lo, high: hi } : undefined;
    let img = canvasEl;
    if (!img && source) {
      $('#preview').classList.remove('hidden');
      const url = URL.createObjectURL(source);
      $('#preview').innerHTML = `<img src="${url}" alt="uploaded chart" />`;
      img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    }
    const aiCfg = S.settings.aiKey ? { provider: S.settings.aiProvider, apiKey: S.settings.aiKey, model: S.settings.aiModel || undefined } : undefined;
    let res;
    try { res = await S.vision.analyzeChartImage(img, { priceRange, ai: aiCfg }); }
    catch (e) { out.innerHTML = `<div class="empty">Scanner error: ${esc(e.message)}</div>`; return; }
    S.scanResult = res;
    renderScanResult(res);
  }

  function renderScanResult(res) {
    const out = $('#scanOut'), meta = $('#scanMeta');
    if (!res?.ok) { out.innerHTML = `<div class="empty">${esc(res?.error || 'Could not read that image.')}</div>`; return; }
    const px = res.pixel;
    const dirCol = px.trend.direction === 'up' ? 'var(--long)' : px.trend.direction === 'down' ? 'var(--short)' : 'var(--flat)';
    meta.textContent = `${res.meta.usedAI ? 'pixel + AI' : 'pixel only'} · ${Math.round(res.meta.elapsedMs)}ms`;
    out.innerHTML = `
      <div class="flex" style="margin-bottom:12px">
        <div>
          <div class="label-xs">Detected structure</div>
          <div style="font-size:20px;font-weight:650;color:${dirCol};text-transform:capitalize">${esc(px.trend.direction)} trend</div>
        </div>
        <span class="spacer"></span>
        ${gaugeSVG(px.confidence, dirCol, 'scan confidence')}
      </div>
      <div class="plan-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
        <div class="plan-cell"><div class="k">Candles</div><div class="v" style="font-size:15px">${px.candles.bullish + px.candles.bearish}</div><div class="s">${(px.candles.bullRatio * 100).toFixed(0)}% bullish</div></div>
        <div class="plan-cell"><div class="k">Slope</div><div class="v" style="font-size:15px">${(px.trend.slopePctPerBar * 100).toFixed(2)}%</div><div class="s">R² ${px.trend.r2.toFixed(2)}</div></div>
        <div class="plan-cell"><div class="k">Volatility</div><div class="v" style="font-size:15px;text-transform:capitalize">${esc(px.volatility.regime)}</div><div class="s">ATR ≈ ${(px.volatility.atrPctPx * 100).toFixed(1)}% of plot</div></div>
      </div>
      <div class="stack" style="gap:6px;font-size:12.5px">
        <div class="flex"><span class="dim" style="flex:1">Resistance</span><span class="mono">${px.levels.resistances.map((r) => (r.price ? fmtPrice(r.price) : `${Math.round(r.y)}px`)).join(' · ') || '—'}</span></div>
        <div class="flex"><span class="dim" style="flex:1">Support</span><span class="mono">${px.levels.supports.map((r) => (r.price ? fmtPrice(r.price) : `${Math.round(r.y)}px`)).join(' · ') || '—'}</span></div>
        <div class="flex"><span class="dim" style="flex:1">Last price</span><span class="mono">${px.levels.lastPrice ? fmtPrice(px.levels.lastPrice) : 'not readable'}</span></div>
      </div>
      ${res.ai ? `
        <div class="card" style="margin-top:14px;padding:14px;background:var(--panel-2)">
          <div class="flex"><span class="badge ${res.ai.bias === 'long' ? 'long' : res.ai.bias === 'short' ? 'short' : 'flat'}">${esc(res.ai.bias)}</span><b style="font-size:12.5px">${esc(res.ai.provider)} · ${esc(res.ai.model)}</b><span class="spacer"></span><span class="mono dim">${(res.ai.confidence * 100).toFixed(0)}%</span></div>
          <p class="hint" style="margin:8px 0 0">${esc(res.ai.reasoning || '')}</p>
          ${(res.ai.patterns || []).length ? `<div class="flex wrap" style="gap:5px;margin-top:8px">${res.ai.patterns.map((p) => `<span class="pill">${esc(p)}</span>`).join('')}</div>` : ''}
          ${res.ai.invalidation ? `<div class="hint" style="margin-top:8px"><b style="color:var(--text)">Invalidation:</b> ${esc(res.ai.invalidation)}</div>` : ''}
        </div>` : `<div class="hint" style="margin-top:12px">Add a vision API key in <a href="#/settings">Settings</a> to get a second opinion from a multimodal model. The pixel pass above works without one.</div>`}
      <div class="flex" style="margin-top:12px;gap:8px;flex-wrap:wrap">
        <button class="btn sm" id="crossBtn">Cross-check with the model</button>
        <span class="hint" style="margin:0">${esc(((res.meta.warnings || [])[0]) || '')}</span>
      </div>
      <div id="crossOut" style="margin-top:10px"></div>
    `;
    $('#crossBtn').addEventListener('click', async () => {
      const sym = ($('#scanSym').value || '').trim().toUpperCase();
      const box = $('#crossOut');
      if (!sym) { box.innerHTML = `<div class="hint">Type a ticker above first.</div>`; return; }
      if (!S.bySymbol.has(sym)) { box.innerHTML = `<div class="hint">${esc(sym)} is not in the bundled dataset.</div>`; return; }
      box.innerHTML = `<div class="hint">Running the quant model…</div>`;
      const a = await runAnalysis(sym).catch((e) => ({ ok: false, error: e.message }));
      if (!a.ok) { box.innerHTML = `<div class="hint">${esc(a.error)}</div>`; return; }
      const scanDir = px.trend.direction === 'up' ? 'long' : px.trend.direction === 'down' ? 'short' : 'flat';
      const agree = scanDir === a.signal;
      box.innerHTML = `<div class="card card-pad" style="background:var(--panel-2)">
        <div class="flex"><span class="badge ${agree ? 'long' : 'warn'}">${agree ? 'agree' : 'disagree'}</span>
        <span class="hint" style="margin:0">Image says <b style="color:var(--text)">${esc(scanDir)}</b>, the 10-year model says <b style="color:var(--text)">${esc(a.signal)}</b> (${(Math.max(a.probs.long.win, a.probs.short.win) * 100).toFixed(0)}% P(target)).</span></div>
        <div class="hint" style="margin:8px 0 0">When the two disagree, trust neither: a screenshot shows one window of price, while the model weighs two decades of context. That disagreement is the most useful thing this page produces.</div>
      </div>`;
    });
  }
}

function makeSampleChart() {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 460;
  const ctx = c.getContext('2d');
  const dark = S.settings.theme !== 'light';
  ctx.fillStyle = dark ? '#0f1318' : '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  // grid
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.07)';
  for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(0, (i * 460) / 8); ctx.lineTo(900, (i * 460) / 8); ctx.stroke(); }
  // random walk candles
  let p = 100;
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const bars = [];
  for (let i = 0; i < 90; i++) {
    const drift = 0.16, vol = 1.5;
    const o = p;
    p = p + drift + (rnd() - 0.5) * vol * 2;
    const cl = p;
    const h = Math.max(o, cl) + rnd() * 0.8;
    const l = Math.min(o, cl) - rnd() * 0.8;
    bars.push([o, h, l, cl]);
  }
  const lo = Math.min(...bars.map((b) => b[2])), hi = Math.max(...bars.map((b) => b[1]));
  const Y = (v) => 440 - ((v - lo) / (hi - lo)) * 400;
  const bw = 860 / 90;
  bars.forEach(([o, h, l, cl], i) => {
    const x = 20 + i * bw + bw / 2;
    const up = cl >= o;
    ctx.strokeStyle = up ? '#2ee6a8' : '#ff5d6c';
    ctx.fillStyle = up ? '#2ee6a8' : '#ff5d6c';
    ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.stroke();
    const top = Math.min(Y(o), Y(cl)), hh = Math.max(1.5, Math.abs(Y(cl) - Y(o)));
    ctx.fillRect(x - bw * 0.32, top, bw * 0.64, hh);
  });
  ctx.fillStyle = dark ? '#9aa5b5' : '#55606f';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('SAMPLE · synthetic uptrend', 20, 26);
  return c;
}

/* --------------------------------- settings -------------------------------- */

function viewSettings() {
  const s = S.settings;
  $('#view').innerHTML = `
    <div class="hero"><h1>Settings</h1><p>Keys and preferences live in this browser's local storage only. Nothing is sent anywhere except to the API you configure.</p></div>
    <div class="row cols-2">
      <section class="card card-pad">
        <h2 style="margin-bottom:12px">Risk &amp; sizing</h2>
        <div class="row cols-2" style="gap:10px">
          <label class="field"><span>Account size (USD)</span><input type="number" id="setAccount" value="${s.account}" min="100" step="500" /></label>
          <label class="field"><span>Risk per trade (%)</span><input type="number" id="setRisk" value="${s.riskPct}" min="0.1" max="10" step="0.1" /></label>
        </div>
        <p class="hint" style="margin-top:10px">Position size = (account × risk%) ÷ stop distance. A 1% risk on a $25,000 account means $250 at risk — the share count adjusts to the instrument's ATR.</p>
        <div class="flex" style="margin-top:14px"><button class="btn primary" id="saveRisk">Save</button></div>
      </section>

      <section class="card card-pad">
        <h2 style="margin-bottom:12px">Live equity data <span class="badge muted">optional</span></h2>
        <p class="hint" style="margin-bottom:10px">The app ships with a complete 10-year snapshot, so live keys are never required. With a free <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Twelve Data</a> key (8 requests/minute) you can pull live quotes and analyse tickers outside the bundled set.</p>
        <label class="field"><span>Twelve Data API key</span><input type="password" id="setTd" value="${esc(s.twelveDataKey)}" placeholder="paste key" autocomplete="off" /></label>
        <div class="flex" style="margin-top:10px;gap:8px"><button class="btn" id="saveTd">Save key</button><button class="btn ghost" id="testTd">Test</button><span class="hint" id="tdStatus" style="margin:0"></span></div>
        <p class="hint" style="margin-top:12px">Crypto prices are live without any key — CoinGecko's public API allows browser calls.</p>
      </section>

      <section class="card card-pad">
        <h2 style="margin-bottom:12px">Chart scanner AI <span class="badge muted">optional</span></h2>
        <p class="hint" style="margin-bottom:10px">The pixel scanner works with no key. A multimodal model adds pattern recognition and written reasoning.</p>
        <div class="row cols-2" style="gap:10px">
          <label class="field"><span>Provider</span>
            <select id="setAiProv">
              <option value="openai" ${s.aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
              <option value="anthropic" ${s.aiProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
              <option value="google" ${s.aiProvider === 'google' ? 'selected' : ''}>Google Gemini</option>
            </select>
          </label>
          <label class="field"><span>Model (optional)</span><input type="text" id="setAiModel" value="${esc(s.aiModel)}" placeholder="default" /></label>
        </div>
        <label class="field" style="margin-top:10px"><span>API key</span><input type="password" id="setAiKey" value="${esc(s.aiKey)}" placeholder="sk-…" autocomplete="off" /></label>
        <div class="flex" style="margin-top:10px"><button class="btn" id="saveAi">Save</button><span class="hint" style="margin:0">Stored locally. Browser-key calls are intended for personal use only.</span></div>
      </section>

      <section class="card card-pad">
        <h2 style="margin-bottom:12px">Appearance &amp; data</h2>
        <div class="flex" style="margin-bottom:12px">
          <span class="hint" style="flex:1;margin:0">Theme</span>
          <div class="seg" id="themeSeg"><button data-theme="dark" class="${s.theme === 'dark' ? 'on' : ''}">Dark</button><button data-theme="light" class="${s.theme === 'light' ? 'on' : ''}">Light</button></div>
        </div>
        <div class="stack" style="gap:6px;font-size:12px">
          <div class="flex"><span class="dim" style="flex:1">Dataset snapshot</span><span class="mono">${dateOf(S.model.training.dateRange[1])}</span></div>
          <div class="flex"><span class="dim" style="flex:1">Instruments</span><span class="mono">${S.universe.length}</span></div>
          <div class="flex"><span class="dim" style="flex:1">Training bars</span><span class="mono">${n2(S.model.training.rows, 0)}</span></div>
          <div class="flex"><span class="dim" style="flex:1">Model trained</span><span class="mono">${esc(S.model.trainedAt.slice(0, 10))}</span></div>
          <div class="flex"><span class="dim" style="flex:1">Engine</span><span class="mono">v${ENGINE_VERSION}</span></div>
        </div>
        <details class="disclose" style="margin-top:12px"><summary>Refresh the dataset yourself</summary><div>
          <pre class="mono hint" style="white-space:pre-wrap;margin:0">node tools/fetch-data.mjs      # re-download daily bars
node tools/build-dataset.mjs   # rebuild labels
python3 tools/train.py         # refit the model
node tools/evaluate.mjs        # out-of-sample evaluation
node tools/publish-data.mjs    # regenerate site data</pre>
          <p class="hint" style="margin:8px 0 0">Then commit and push. The site has no backend, so the snapshot in the repo is the source of truth.</p>
        </div></details>
      </section>
    </div>
    <section class="card card-pad" style="margin-top:14px">
      <h2 style="margin-bottom:8px">Disclaimer</h2>
      <p class="hint" style="margin:0">${esc(DISCLAIMER)}</p>
    </section>
  `;

  $('#saveRisk').addEventListener('click', () => {
    S.settings.account = Math.max(100, +$('#setAccount').value || 25000);
    S.settings.riskPct = clamp(+$('#setRisk').value || 1, 0.1, 10);
    saveSettings(); toast('Risk settings saved', 'ok');
  });
  $('#saveTd').addEventListener('click', () => { S.settings.twelveDataKey = $('#setTd').value.trim(); saveSettings(); toast('Twelve Data key saved', 'ok'); });
  $('#testTd').addEventListener('click', async () => {
    const st = $('#tdStatus');
    st.textContent = 'testing…';
    try {
      const q = await live.quote('AAPL', $('#setTd').value.trim());
      st.innerHTML = `<span class="pos">ok · AAPL ${fmtPrice(q.price)}</span>`;
    } catch (e) { st.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  });
  $('#saveAi').addEventListener('click', () => {
    S.settings.aiProvider = $('#setAiProv').value;
    S.settings.aiModel = $('#setAiModel').value.trim();
    S.settings.aiKey = $('#setAiKey').value.trim();
    saveSettings();
    if (S.vision?.setAIConfig) S.vision.setAIConfig({ provider: S.settings.aiProvider, apiKey: S.settings.aiKey, model: S.settings.aiModel || undefined });
    toast('Scanner key saved', 'ok');
  });
  $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => {
    S.settings.theme = b.dataset.theme; saveSettings(); applyTheme();
    $$('#themeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
}

/* ---------------------------------- router --------------------------------- */

const ROUTES = {
  dashboard: () => viewDashboard(),
  analyze: (arg) => viewAnalyze(arg),
  scan: () => viewScan(),
  screener: () => viewScreener(),
  model: () => viewModel(),
  news: () => viewNews(),
  research: () => viewResearch(),
  settings: () => viewSettings(),
};

let currentRoute = '';

async function route() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [name, arg] = hash.split('/');
  const key = ROUTES[name] ? name : 'dashboard';
  const sym = arg ? decodeURIComponent(arg.split('?')[0]).toUpperCase() : '';
  currentRoute = `${key}/${sym}`;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === key));
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top: 0 });
  try {
    await ROUTES[key](sym);
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="empty">Something broke rendering this view.<br /><span class="mono dim">${esc(e.message)}</span></div>`;
  }
}

/* ---------------------------------- search --------------------------------- */

function wireSearch() {
  const input = $('#searchInput'), box = $('#suggest');
  let sel = -1, items = [];
  const close = () => { box.hidden = true; sel = -1; };
  const build = (q) => {
    const term = q.trim().toLowerCase();
    if (!term) { items = [...S.signals].sort((a, b) => b.edgeR - a.edgeR).slice(0, 7); }
    else {
      items = S.signals
        .map((s) => {
          const sym = s.symbol.toLowerCase(), nm = s.name.toLowerCase();
          let score = 0;
          if (sym === term) score = 100;
          else if (sym.startsWith(term)) score = 80;
          else if (nm.startsWith(term)) score = 60;
          else if (nm.includes(term)) score = 40;
          else if (sym.includes(term)) score = 30;
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 7)
        .map((x) => x.s);
    }
    box.innerHTML = items.map((s, i) => `<button data-i="${i}"><span class="s-sym">${esc(s.symbol)}</span><span class="s-name">${esc(s.name)}</span><span class="s-cls">${esc(s.cls)}</span></button>`).join('')
      + (term && !items.length ? `<button data-custom="1"><span class="s-sym">${esc(term.toUpperCase())}</span><span class="s-name">not in the bundled dataset</span><span class="s-cls">scan</span></button>` : '');
    box.hidden = false;
    $$('#suggest button').forEach((b) => b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (b.dataset.custom) location.hash = `#/analyze/${encodeURIComponent(term.toUpperCase())}`;
      else location.hash = `#/analyze/${items[+b.dataset.i].symbol}`;
      input.value = ''; close();
    }));
  };
  input.addEventListener('focus', () => build(input.value));
  input.addEventListener('input', () => build(input.value));
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    const btns = $$('#suggest button');
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(btns.length - 1, sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = btns[sel] || btns[0];
      if (pick) pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      else if (input.value.trim()) location.hash = `#/analyze/${encodeURIComponent(input.value.trim().toUpperCase())}`;
      return;
    } else if (e.key === 'Escape') { close(); return; }
    btns.forEach((b, i) => b.classList.toggle('sel', i === sel));
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) location.hash = `#/analyze/${encodeURIComponent(q.toUpperCase())}`;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
}

/* ----------------------------------- boot ---------------------------------- */

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
}

function setRegimeMini() {
  const spy = S.signalBy.get('SPY'), vix = S.signalBy.get('^VIX');
  const above50 = S.signals.filter((s) => isNum(s.ema50) && s.price > s.ema50).length / Math.max(1, S.signals.length);
  const r = regimeOf(spy, vix, above50);
  const el = $('#regimeMini');
  el.className = `regime-mini ${r.kind === 'long' ? 'risk-on' : r.kind === 'short' ? 'risk-off' : 'caution'}`;
  el.querySelector('.regime-text').textContent = `${r.label} · VIX ${(vix?.price || 0).toFixed(1)}`;
}

async function main() {
  applyTheme();
  $('#themeBtn').addEventListener('click', () => {
    S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(); applyTheme();
    route();
  });
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => { location.hash = `#/${n.dataset.route}`; }));
  window.addEventListener('hashchange', route);

  try {
    await bootData();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Could not load the dataset.<br /><span class="mono dim">${esc(e.message)}</span><br /><br />Run <code>node tools/publish-data.mjs</code> to generate <code>web/data/*</code>.</div>`;
    return;
  }

  $('#dataChip').textContent = `data ${S.model.training.dateRange[1]}`;
  setRegimeMini();
  wireSearch();
  if (S.vision?.setAIConfig && S.settings.aiKey) {
    S.vision.setAIConfig({ provider: S.settings.aiProvider, apiKey: S.settings.aiKey, model: S.settings.aiModel || undefined });
  }
  if (!location.hash) location.hash = '#/dashboard';
  await route();
}

main();
