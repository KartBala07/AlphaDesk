/* =============================================================================
 * AlphaDesk — application shell, router and views.
 * Static site: every number is computed in the browser from bundled daily bars,
 * a model trained offline (tools/train.py) and, optionally, live APIs.
 * ========================================================================== */

import {
  analyze, backtestWalkForward, normaliseBars, buildContext, ema, rsi, atr, metrics,
  TP_MULT, SL_MULT, HORIZON, DISCLAIMER, ENGINE_VERSION, FEATURE_LABELS,
} from './engine.js';
import { LineChart, barChart, sparkline, fmtPrice } from './charts.js';
import { ProChart } from './chart-pro.js?v=5';
import * as live from './live.js';
import * as auth from './auth.js';

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
  bridgeUrl: 'http://127.0.0.1:8788', liveRh: false, journalExport: true,
  apiBase: 'http://127.0.0.1:8789',
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

/* ------------------------------- terminal ---------------------------------- */
/* A TradingView-style workspace: watchlist, interactive chart, model rail.     */

const CHART_DEFAULTS = { interval: '1D', type: 'candles', range: '1Y', overlays: ['ema20', 'ema50', 'ema200'], panes: ['volume'] };
const chartPrefs = () => ({ ...CHART_DEFAULTS, ...(S.settings.chart || {}) });
const setChartPrefs = (patch) => { S.settings.chart = { ...chartPrefs(), ...patch }; saveSettings(); };

const drawKey = (sym) => `alphadesk.drawings.${sym}`;
const loadDrawings = (sym) => { try { return JSON.parse(localStorage.getItem(drawKey(sym)) || '[]'); } catch { return []; } };
const saveDrawings = (sym, list) => { try { localStorage.setItem(drawKey(sym), JSON.stringify(list)); } catch { /* quota */ } };

const journalAll = () => { try { return JSON.parse(localStorage.getItem('alphadesk.journal') || '[]'); } catch { return []; } };
const journalSave = (list) => localStorage.setItem('alphadesk.journal', JSON.stringify(list));

function openModal(title, bodyHTML, onMount) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head"><b>${esc(title)}</b><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">${bodyHTML}</div>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  onMount?.(wrap, close);
  return { close };
}

function orderTicket(a, inst) {
  const t = a.trade;
  if (!t) return `${a.symbol} — NO TRADE\nModel: no side clears the gate (P(target) max ${(Math.max(a.probs.long.win, a.probs.short.win) * 100).toFixed(1)}%).\nAs of ${dateOf(a.asOf)}. Not investment advice.`;
  return [
    `${a.symbol} — ${t.side === 'long' ? 'BUY' : 'SELL SHORT'} (limit ${fmtPrice(t.entry)})`,
    `Qty: ${t.shares}`,
    `Stop: ${fmtPrice(t.stop)}  (${t.stopDistancePct}%)`,
    `Target 1: ${fmtPrice(t.tp1)}  (sell half)`,
    `Target 2: ${fmtPrice(t.target)}  (${t.riskReward})`,
    `Risk: ${money(t.riskCash)} at stop · ${S.settings.riskPct}% of ${money(S.settings.account)}`,
    `Model: P(target) ${(t.side === 'short' ? a.probs.short.win : a.probs.long.win * 100).toFixed(0)}% · edge ${rmult(a.edgeR)} · ${esc(a.conviction)}`,
    `Signal bar: ${dateOf(a.asOf)}. Not investment advice.`,
  ].join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

async function viewTerminal(symbol) {
  const viewEl = $('#view');
  if (!symbol) {
    const top = [...S.signals].sort((a, x) => x.edgeR - a.edgeR).slice(0, 8);
    viewEl.innerHTML = `
      <div class="hero"><h1>Terminal</h1><p>Search a ticker above, or open one of the strongest current readings. Inside you get a pan/zoom chart with drawing tools, a watchlist, and the model's read in the rail.</p></div>
      <div class="nets">${top.map((s) => `<a class="net" href="#/analyze/${esc(s.symbol)}"><em>${esc(s.cls)}</em><b>${esc(s.symbol)} · ${fmtPrice(s.price)}</b><span>${esc(s.name)}</span><span style="margin-top:6px">${sideBadge(s.side, s.conviction)} <span class="mono ${signCls(s.edgeR)}">${rmult(s.edgeR)}</span></span></a>`).join('')}</div>`;
    return;
  }
  if (!S.bySymbol.has(symbol)) {
    viewEl.innerHTML = `<div class="hero"><h1>${esc(symbol)}</h1><p>This ticker is not in the bundled ${S.universe.length}-symbol dataset.</p></div>
      <section class="card card-pad"><p class="hint">Add a free Twelve Data key in <a href="#/settings">Settings</a> to fetch its history on demand, or connect the Robinhood bridge for live quotes and daily history.</p>
      <div class="flex" style="margin-top:10px"><a class="btn" href="#/settings">Open settings</a><a class="btn ghost" href="#/news">News for ${esc(symbol)}</a></div></section>`;
    return;
  }

  viewEl.innerHTML = `<div class="empty"><div class="skeleton" style="height:520px"></div></div>`;
  const inst = S.bySymbol.get(symbol);
  let a, bars;
  try {
    [a, bars] = await Promise.all([runAnalysis(symbol), getBars(symbol)]);
  } catch (e) { viewEl.innerHTML = `<div class="empty">Could not load ${esc(symbol)}: ${esc(e.message)}</div>`; return; }
  if (!a.ok) { viewEl.innerHTML = `<div class="empty">${esc(a.error)}</div>`; return; }

  const prefs = chartPrefs();
  const side = a.signal;
  const t = a.trade;
  const open = journalAll().filter((j) => j.status === 'open');

  viewEl.innerHTML = `
    <div class="tv" id="tv">
      <aside class="tv-watch">
        <div class="tv-watch-top"><span class="label-xs">Watchlist</span><input id="tvFilter" placeholder="Filter" spellcheck="false" /></div>
        <div class="tv-watch-hdr"><span>Symbol</span><span>Last</span><span>Chg</span><span></span></div>
        <div class="tv-watch-list" id="tvList"></div>
      </aside>

      <section class="tv-center">
        <div class="tv-title">
          <div class="tv-symblock">
            <div class="flex" style="gap:8px">
              <b class="mono" style="font-size:17px">${esc(symbol)}</b>
              <span class="dim" style="font-size:12px">${esc(inst.name || '')}</span>
              <span class="pill" style="padding:1px 7px">${esc(inst.cls)}</span>
            </div>
            <div class="flex" style="gap:9px;align-items:baseline;margin-top:2px">
              <span class="num-big" id="tvLast" style="font-size:26px">${fmtPrice(a.price)}</span>
              <span class="mono ${signCls(a.change)}" id="tvChg">${pctRaw(a.change)}</span>
              <span class="hint" id="tvSrc" style="margin:0"></span>
            </div>
          </div>
          <span class="spacer"></span>
          <div class="seg" id="tvIv">
            ${[['1D', 'D'], ['1W', 'W'], ['1M', 'Mo']].map(([x, l]) => `<button data-iv="${x}" class="${prefs.interval === x ? 'on' : ''}" title="${x === '1D' ? 'Daily' : x === '1W' ? 'Weekly' : 'Monthly'}">${l}</button>`).join('')}
          </div>
          <div class="tv-divider"></div>
          <div class="seg" id="tvRg">
            ${['1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', 'MAX'].map((x) => `<button data-rg="${x}" class="${prefs.range === x ? 'on' : ''}">${x}</button>`).join('')}
          </div>
        </div>

        <div class="tv-ohlc" id="tvOhlc"></div>

        <div class="tv-body">
          <div class="tv-tools" id="tvTools">
            ${[
              ['cursor', '<path d="M5 3l14 8-6 1.6L10 19z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'],
              ['trend', '<path d="M4 19L20 5" stroke="currentColor" stroke-width="1.8"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="5" r="2"/>'],
              ['hline', '<path d="M3 12h18" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2"/>'],
              ['rect', '<rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'],
              ['fib', '<path d="M4 7h16M4 11h16M4 15h16M4 19h16" stroke="currentColor" stroke-width="1.3"/>'],
              ['measure', '<path d="M4 17L17 4M14 4h3v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'],
            ].map(([tool, svg]) => `<button class="tv-tool ${prefs.tool === tool ? 'on' : ''}" data-tool="${tool}" title="${tool}"><svg viewBox="0 0 24 24">${svg}</svg></button>`).join('')}
            <div class="tv-tool-sep"></div>
            <button class="tv-tool" id="tvUndo" title="Undo drawing"><svg viewBox="0 0 24 24"><path d="M8 7H15a5 5 0 010 10H9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M11 4L7 7l4 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button class="tv-tool" id="tvClear" title="Clear drawings"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2M8 7l1 13h6l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
          </div>
          <div class="tv-chart" id="chartHost"></div>
        </div>

        <div class="tv-foot">
          <div class="seg" id="tvType">
            ${[['candles', 'Candles'], ['hollow', 'Hollow'], ['bars', 'Bars'], ['line', 'Line'], ['area', 'Area'], ['heikin', 'Heikin Ashi']].map(([x, l]) => `<button data-type="${x}" class="${prefs.type === x ? 'on' : ''}">${l}</button>`).join('')}
          </div>
          <div class="flex wrap" id="tvInd" style="gap:5px">
            ${[['ema20', 'EMA 20'], ['ema50', 'EMA 50'], ['ema200', 'EMA 200'], ['bb', 'Bollinger'], ['volume', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD']].map(([x, l]) => {
              const on = prefs.overlays.includes(x) || prefs.panes.includes(x);
              return `<button class="chip ${on ? 'on' : ''}" data-ind="${x}">${l}</button>`;
            }).join('')}
          </div>
          <span class="spacer"></span>
          <span class="hint" id="tvStatus" style="margin:0"></span>
        </div>
      </section>

      <aside class="tv-rail">
        <div class="tv-verdict tv-${side}">
          <div class="flex"><span class="label-xs">Model read</span><span class="spacer"></span><span class="dim mono" style="font-size:10.5px">${esc(dateOf(a.asOf))}</span></div>
          <div class="tv-action">${side === 'long' ? 'GO LONG' : side === 'short' ? 'GO SHORT' : 'NO TRADE'}</div>
          <div class="flex wrap" style="gap:6px;margin-top:6px">
            ${sideBadge(side, a.conviction)}
            <span class="pill mono">P(TP) ${((side === 'short' ? a.probs.short.win : a.probs.long.win) * 100).toFixed(0)}%</span>
            <span class="pill mono ${signCls(a.edgeR)}">${rmult(a.edgeR)}</span>
          </div>
        </div>

        ${t ? `
        <div class="plan-grid tv-plan">
          <div class="plan-cell"><div class="k">Entry</div><div class="v" style="font-size:14px">${fmtPrice(t.entry)}</div></div>
          <div class="plan-cell stop"><div class="k">Stop</div><div class="v" style="font-size:14px">${fmtPrice(t.stop)}</div></div>
          <div class="plan-cell target"><div class="k">TP1</div><div class="v" style="font-size:14px">${fmtPrice(t.tp1)}</div></div>
          <div class="plan-cell target"><div class="k">TP2</div><div class="v" style="font-size:14px">${fmtPrice(t.target)}</div></div>
          <div class="plan-cell"><div class="k">Qty</div><div class="v" style="font-size:14px">${n2(t.shares, 0)}</div></div>
          <div class="plan-cell"><div class="k">At risk</div><div class="v" style="font-size:14px">${money(t.riskCash)}</div></div>
        </div>` : `<div class="hint" style="padding:2px 2px 0">No side clears the gate. Best available is ${(Math.max(a.probs.long.win, a.probs.short.win) * 100).toFixed(1)}% against a ${(threshold() * 100).toFixed(0)}% requirement${t ? '' : ''}.</div>`}

        <div class="tv-broker">
          <button class="btn primary sm" id="rhOpen" ${t ? '' : 'disabled'}>Open in Robinhood</button>
          <button class="btn sm" id="rhCopy" ${t ? '' : 'disabled'}>Copy ticket</button>
          <button class="btn sm" id="rhLog" ${t ? '' : 'disabled'}>Log fill</button>
        </div>
        <div class="hint" id="rhHint" style="margin:0 0 2px"></div>

        <div class="tv-block">
          <div class="label-xs" style="margin-bottom:7px">Why</div>
          <div class="bars">
            ${a.drivers.slice(0, 5).map((d) => `<div class="bar-row" style="grid-template-columns:1fr 66px 40px">
              <span class="mut" style="font-size:11px">${esc(d.label)}</span>
              <span class="bar-track"><i class="bar-fill ${d.push >= 0 ? 'pos' : 'neg'}" style="width:${clamp(Math.abs(d.push) / 0.6, 0, 1) * 50}%"></i></span>
              <span class="mono ${d.push >= 0 ? 'pos' : 'neg'}" style="text-align:right;font-size:10px">${d.push >= 0 ? '+' : ''}${d.push.toFixed(2)}</span>
            </div>`).join('')}
          </div>
        </div>

        <div class="tv-block">
          <div class="label-xs" style="margin-bottom:7px">Risk</div>
          ${a.flags.slice(0, 3).map((f) => `<div class="flex" style="align-items:flex-start;gap:6px;margin-bottom:6px"><span class="badge ${f.level === 'high' ? 'short' : f.level === 'med' ? 'warn' : 'muted'}" style="flex:none;font-size:9px">${esc(f.level)}</span><span class="hint" style="font-size:11px">${esc(f.text)}</span></div>`).join('') || '<span class="hint" style="font-size:11px">Nothing unusual in volatility or structure.</span>'}
        </div>

        <div class="tv-block">
          <div class="flex" style="margin-bottom:6px"><span class="label-xs">Journal</span><span class="spacer"></span><span class="mono dim" style="font-size:10.5px">${open.length} open</span></div>
          <div id="tvJournal"></div>
        </div>

        <div class="hint" style="font-size:10px;margin-top:auto">${esc(DISCLAIMER)}</div>
      </aside>
    </div>
  `;

  /* ------------------------------- chart ---------------------------------- */
  const chartHost = $('#chartHost');
  const levelColor = (k) => (k === 'stop' ? 'var(--short)' : k === 'entry' ? 'var(--muted)' : 'var(--long)');
  const levels = t ? [
    { price: t.entry, color: levelColor('entry'), label: `ENTRY ${fmtPrice(t.entry)}`, dash: [3, 3] },
    { price: t.stop, color: levelColor('stop'), label: `STOP ${fmtPrice(t.stop)}` },
    { price: t.tp1, color: levelColor('tp'), label: `TP1 ${fmtPrice(t.tp1)}`, dash: [4, 4] },
    { price: t.target, color: levelColor('tp'), label: `TP2 ${fmtPrice(t.target)}` },
  ] : [];

  const last = { o: bars.o.at(-1), h: bars.h.at(-1), l: bars.l.at(-1), c: bars.c.at(-1) };
  const legend = (d) => {
    const el = $('#tvOhlc');
    if (!el) return;
    if (!d) {
      el.innerHTML = `<span class="dim">O</span> <b>${fmtPrice(last.o)}</b> &nbsp;<span class="dim">H</span> <b>${fmtPrice(last.h)}</b> &nbsp;<span class="dim">L</span> <b>${fmtPrice(last.l)}</b> &nbsp;<span class="dim">C</span> <b>${fmtPrice(last.c)}</b>`;
      return;
    }
    const up = d.c >= d.o;
    el.innerHTML = `<span class="${up ? 'pos' : 'neg'}">O ${fmtPrice(d.o)} &nbsp;H ${fmtPrice(d.h)} &nbsp;L ${fmtPrice(d.l)} &nbsp;C ${fmtPrice(d.c)}</span> &nbsp;<span class="dim">${esc(d.date)}</span>${isNum(d.v) && d.v ? ` &nbsp;<span class="dim">Vol ${n2(d.v / 1e6, 2)}M</span>` : ''}`;
  };

  const chart = new ProChart(chartHost, {
    interval: prefs.interval, type: prefs.type, range: prefs.range,
    overlays: prefs.overlays, panes: prefs.panes,
    onCrosshair: legend,
    onDrawingsChange: (list) => saveDrawings(symbol, list),
    onToolChange: (tool) => $$('#tvTools .tv-tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool)),
  });
  window.__chart = chart;   // handy for debugging in the console
  chart.setData({ symbol, bars })
    .setOverlays(prefs.overlays)
    .setPanes(prefs.panes)
    .setModelLevels(levels)
    .setDrawings(loadDrawings(symbol))
    .setTool(prefs.tool || 'cursor');
  legend(null);

  /* toolbar wiring */
  $$('#tvIv button').forEach((b) => b.addEventListener('click', () => {
    $$('#tvIv button').forEach((x) => x.classList.toggle('on', x === b));
    chart.setInterval(b.dataset.iv); setChartPrefs({ interval: b.dataset.iv }); legend(null); updateStatus();
  }));
  $$('#tvRg button').forEach((b) => b.addEventListener('click', () => {
    $$('#tvRg button').forEach((x) => x.classList.toggle('on', x === b));
    chart.setRange(b.dataset.rg); setChartPrefs({ range: b.dataset.rg }); updateStatus();
  }));
  $$('#tvType button').forEach((b) => b.addEventListener('click', () => {
    $$('#tvType button').forEach((x) => x.classList.toggle('on', x === b));
    chart.setType(b.dataset.type); setChartPrefs({ type: b.dataset.type });
  }));
  $$('#tvTools .tv-tool[data-tool]').forEach((b) => b.addEventListener('click', () => {
    $$('#tvTools .tv-tool[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
    chart.setTool(b.dataset.tool); setChartPrefs({ tool: b.dataset.tool });
  }));
  $('#tvUndo').addEventListener('click', () => { chart.undoDrawing(); saveDrawings(symbol, chart.getDrawings()); });
  $('#tvClear').addEventListener('click', () => { chart.clearDrawings(); saveDrawings(symbol, []); });
  $$('#tvInd .chip').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.ind;
    const isOverlay = ['ema20', 'ema50', 'ema200', 'bb'].includes(key);
    const cur = chartPrefs();
    const list = isOverlay ? [...cur.overlays] : [...cur.panes];
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1); else list.push(key);
    b.classList.toggle('on', list.includes(key));
    if (isOverlay) { chart.setOverlays(list); setChartPrefs({ overlays: list }); }
    else { chart.setPanes(list); setChartPrefs({ panes: list }); }
    updateStatus();
  }));

  function updateStatus() {
    const el = $('#tvStatus');
    if (!el) return;
    const p = chartPrefs();
    el.textContent = `${chart.bars.c.length} bars · ${p.interval} · ${p.range}` + (S.liveState?.robinhood ? ' · Robinhood live' : ' · snapshot');
  }
  updateStatus();

  /* ----------------------------- watchlist -------------------------------- */
  const renderList = (filter = '') => {
    const box = $('#tvList');
    if (!box) return;
    const q = filter.trim().toLowerCase();
    const all = S.signals
      .filter((x) => !q || `${x.symbol} ${x.name}`.toLowerCase().includes(q))
      .sort((x, y) => x.rank - y.rank);
    const me = all.find((x) => x.symbol === symbol);
    const rows = [...(me ? [me] : []), ...all.filter((x) => x.symbol !== symbol)].slice(0, 80);
    box.innerHTML = rows.map((x) => {
      const live = S.rhQuotes?.[x.symbol];
      const price = live?.last ?? x.price;
      const chg = live?.changePct ?? x.change;
      return `<button class="tv-row ${x.symbol === symbol ? 'active' : ''}" data-sym="${esc(x.symbol)}">
        <span class="tv-row-sym">${esc(x.symbol)}</span>
        <span class="tv-row-px mono">${fmtPrice(price)}</span>
        <span class="tv-row-chg mono ${signCls(chg)}">${pctRaw(chg)}</span>
        <i class="tv-dot ${x.side === 'long' ? 'long' : x.side === 'short' ? 'short' : ''}"></i>
      </button>`;
    }).join('') || `<div class="empty" style="padding:20px">No matches</div>`;
    $$('#tvList .tv-row').forEach((b) => b.addEventListener('click', () => { location.hash = `#/analyze/${b.dataset.sym}`; }));
  };
  renderList();
  $('#tvFilter').addEventListener('input', (e) => renderList(e.target.value));

  /* ------------------------------- broker --------------------------------- */
  const rhHint = $('#rhHint');
  const setHint = (msg) => { if (rhHint) rhHint.textContent = msg; };

  $('#rhOpen').addEventListener('click', () => {
    const url = live.robinhoodLink(symbol);
    window.open(url, '_blank', 'noopener');
    setHint('Opened Robinhood. Place the order there — AlphaDesk never touches your account.');
  });
  $('#rhCopy').addEventListener('click', async () => {
    const ok = await copyText(orderTicket(a, inst));
    toast(ok ? 'Order ticket copied' : 'Could not copy', ok ? 'ok' : 'err');
    if (ok) setHint('Ticket copied — paste it into Robinhood or your notes.');
  });
  $('#rhLog').addEventListener('click', () => {
    if (!t) return;
    openModal('Log a fill', `
      <p class="hint" style="margin-bottom:10px">Records what you actually filled, so the journal reflects your account rather than the model's suggestion.</p>
      <div class="row cols-2" style="gap:10px">
        <label class="field"><span>Side</span><select id="jSide"><option value="long" ${t.side === 'long' ? 'selected' : ''}>Long</option><option value="short" ${t.side === 'short' ? 'selected' : ''}>Short</option></select></label>
        <label class="field"><span>Quantity</span><input type="number" id="jQty" value="${t.shares}" min="0" step="1" /></label>
        <label class="field"><span>Entry price</span><input type="number" id="jEntry" value="${t.entry}" step="any" /></label>
        <label class="field"><span>Stop</span><input type="number" id="jStop" value="${t.stop}" step="any" /></label>
        <label class="field"><span>Target</span><input type="number" id="jTarget" value="${t.target}" step="any" /></label>
        <label class="field"><span>Date</span><input type="date" id="jDate" value="${a.asOf}" /></label>
      </div>
      <div class="flex" style="margin-top:12px;justify-content:flex-end"><button class="btn primary" id="jSave">Save to journal</button></div>
    `, (wrap, close) => {
      wrap.querySelector('#jSave').addEventListener('click', async () => {
        const payload = {
          symbol, side: wrap.querySelector('#jSide').value,
          qty: +wrap.querySelector('#jQty').value, entry: +wrap.querySelector('#jEntry').value,
          stop: +wrap.querySelector('#jStop').value, target: +wrap.querySelector('#jTarget').value,
          openedAt: wrap.querySelector('#jDate').value,
        };
        let entry = { ...payload, id: `${Date.now()}`, status: 'open', openedAt: payload.openedAt };
        if (S.user) {
          try {
            const r = await auth.addFill(payload, apiBase());
            if (r.fill) entry = r.fill;
          } catch (e) { toast(`Saved locally — server said: ${e.message}`, 'err'); }
        }
        const list = journalAll(); list.push(entry); journalSave(list);
        close(); renderJournal(); toast(S.user ? 'Fill saved to your account' : 'Fill logged locally', 'ok');
      });
    });
  });

  function renderJournal() {
    const box = $('#tvJournal');
    if (!box) return;
    const open = journalAll().filter((j) => j.status === 'open');
    if (!open.length) {
      box.innerHTML = `<div class="hint" style="font-size:11px">No open fills. Log one after you execute in Robinhood and the desk will track it here.</div>`;
      return;
    }
    box.innerHTML = open.slice(-6).reverse().map((j) => {
      const px = S.rhQuotes?.[j.symbol]?.last ?? S.signalBy.get(j.symbol)?.price ?? j.entry;
      const r = j.side === 'long' ? (px - j.entry) / Math.max(1e-9, j.entry - j.stop) : (j.entry - px) / Math.max(1e-9, j.stop - j.entry);
      return `<div class="flex" style="font-size:11.5px;padding:3px 0">
        <span class="mono" style="width:62px">${esc(j.symbol)}</span>
        <span class="dim" style="width:38px">${esc(j.side)}</span>
        <span class="mono" style="flex:1">${n2(j.qty, 0)} @ ${fmtPrice(j.entry)}</span>
        <span class="mono ${signCls(r)}">${rmult(r)}</span>
      </div>`;
    }).join('');
  }
  renderJournal();

  /* ------------------------- live quotes (optional) ----------------------- */
  if (S.settings.liveRh) {
    live.rhQuotes([symbol, ...S.signals.slice(0, 24).map((x) => x.symbol)], S.settings.bridgeUrl)
      .then((q) => {
        S.rhQuotes = { ...(S.rhQuotes || {}), ...q };
        if (q[symbol]?.last) {
          const el = $('#tvLast'); if (el) el.textContent = fmtPrice(q[symbol].last);
          const ch = $('#tvChg'); if (ch) { ch.textContent = pctRaw(q[symbol].changePct); ch.className = `mono ${signCls(q[symbol].changePct)}`; }
          const src = $('#tvSrc'); if (src) src.textContent = 'Robinhood live';
          renderList($('#tvFilter')?.value || '');
          renderJournal();
        }
        S.liveState = { ...(S.liveState || {}), robinhood: true };
        updateStatus();
      })
      .catch((e) => { setHint(`Live quotes unavailable: ${e.message}`); });
  } else {
    setHint('Connect the Robinhood bridge in Settings for live quotes. Orders always execute in the Robinhood app.');
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
  const bh = b.baseline?.buyAndHoldSPY || null;
  const ratio = (c, d) => (isNum(c) && isNum(d) && d > 0 ? (c / d).toFixed(2) : '—');
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
          <thead><tr><th class="no-sort">Ranking</th><th class="no-sort">CAGR</th><th class="no-sort">Max DD</th><th class="no-sort">CAGR ÷ DD</th></tr></thead>
          <tbody>
            <tr><td>Model edge (top-${b.rule.topK})</td><td class="mono ${signCls(p.cagrPct)}">${isNum(p.cagrPct) ? p.cagrPct.toFixed(1) + '%' : '—'}</td><td class="mono neg">${isNum(p.maxDrawdownPct) ? p.maxDrawdownPct.toFixed(0) + '%' : '—'}</td><td class="mono">${ratio(p.cagrPct, p.maxDrawdownPct)}</td></tr>
            <tr><td>20-day momentum</td><td class="mono ${signCls(bench?.cagrPct)}">${isNum(bench?.cagrPct) ? bench.cagrPct.toFixed(1) + '%' : '—'}</td><td class="mono neg">${isNum(bench?.maxDrawdownPct) ? bench.maxDrawdownPct.toFixed(0) + '%' : '—'}</td><td class="mono">${ratio(bench?.cagrPct, bench?.maxDrawdownPct)}</td></tr>
            <tr style="background:var(--panel-2)"><td>Buy &amp; hold SPY</td><td class="mono ${signCls(bh?.cagrPct)}">${isNum(bh?.cagrPct) ? bh.cagrPct.toFixed(1) + '%' : '—'}</td><td class="mono neg">${isNum(bh?.maxDrawdownPct) ? bh.maxDrawdownPct.toFixed(0) + '%' : '—'}</td><td class="mono">${ratio(bh?.cagrPct, bh?.maxDrawdownPct)}</td></tr>
          </tbody>
        </table></div>
        <div class="hint" style="margin-top:10px">${isNum(p.cagrPct) && isNum(bh?.cagrPct) && ratio(p.cagrPct, p.maxDrawdownPct) <= ratio(bh.cagrPct, bh.maxDrawdownPct)
          ? '<b style="color:var(--warn)">Buying and holding SPY beat this model on a risk-adjusted basis.</b> It returned ' + bh.cagrPct.toFixed(1) + '% a year with a ' + bh.maxDrawdownPct.toFixed(0) + '% drawdown; the portfolio returned ' + p.cagrPct.toFixed(1) + '% with ' + p.maxDrawdownPct.toFixed(0) + '%. More return, but more than proportionally more pain — and no screen time required. The ranking carries information; this portfolio does not yet convert it into an advantage. Treat the desk as a research surface, not a strategy.'
          : 'The model cleared buy-and-hold on a risk-adjusted basis in this window. One window is not proof, and the drawdown above is the price of admission.'}
        </div>
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
        <h2 style="margin-bottom:8px">Robinhood <span class="badge muted">local bridge</span></h2>
        <p class="hint" style="margin-bottom:8px">Robinhood has no public API, and their legacy login endpoint now returns <code>404</code>. AlphaDesk will not ask for your password or MFA code, and nothing here can place an order. What it can do is read Robinhood's public market data — quotes, daily history, market hours — through a bridge that runs on <em>your</em> machine.</p>
        <pre class="mono hint" style="white-space:pre-wrap;margin:0 0 10px;padding:8px 10px;background:var(--panel-2);border-radius:8px;border:1px solid var(--line)">node tools/robinhood-bridge.mjs</pre>
        <label class="field"><span>Bridge URL</span><input type="text" id="setBridge" value="${esc(s.bridgeUrl || 'http://127.0.0.1:8788')}" spellcheck="false" /></label>
        <div class="flex" style="margin-top:10px;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="rhConnect">Connect</button>
          <button class="btn ghost" id="rhDisconnect">Disconnect</button>
          <span class="hint" id="rhState" style="margin:0">not checked</span>
        </div>
        <label class="flex" style="margin-top:12px;gap:8px;align-items:center">
          <input type="checkbox" id="rhLive" ${s.liveRh ? 'checked' : ''} style="width:auto" />
          <span class="hint" style="margin:0">Use live Robinhood quotes and history in the terminal and watchlist</span>
        </label>
        <div class="hint" style="margin-top:10px">Order flow stays manual: the terminal's <b>Open in Robinhood</b> button deep-links to the instrument and <b>Copy ticket</b> gives you the exact quantity, limit, stop and targets to enter there.</div>
      </section>

      <section class="card card-pad">
        <h2 style="margin-bottom:12px">Trade journal</h2>
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <button class="btn sm" id="jExport">Export CSV</button>
          <button class="btn sm ghost" id="jClear">Clear journal</button>
          <span class="hint" id="jState" style="margin:0"></span>
        </div>
        <p class="hint" style="margin-top:10px">Fills you log from the terminal are stored in this browser only. The journal tracks R multiple against your entry and stop using the latest price the app knows.</p>
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
  const setRhState = (txt, kind) => {
    const el = $('#rhState');
    if (!el) return;
    el.innerHTML = `<span class="${kind === 'ok' ? 'pos' : kind === 'err' ? 'neg' : 'dim'}">${esc(txt)}</span>`;
  };
  const saveJournalState = () => {
    const j = journalAll();
    const el = $('#jState');
    if (el) el.textContent = `${j.length} fills · ${j.filter((x) => x.status === 'open').length} open`;
  };
  saveJournalState();

  $('#rhConnect').addEventListener('click', async () => {
    const url = $('#setBridge').value.trim() || 'http://127.0.0.1:8788';
    S.settings.bridgeUrl = url; saveSettings();
    setRhState('checking…', 'dim');
    try {
      const h = await live.bridgeHealth(url);
      setRhState(`connected · ${h.service} · ${h.capabilities.join(', ')}`, 'ok');
      toast('Robinhood bridge connected', 'ok');
    } catch (e) {
      setRhState(e.message, 'err');
    }
  });
  $('#rhDisconnect').addEventListener('click', () => {
    S.settings.liveRh = false; saveSettings();
    const cb = $('#rhLive'); if (cb) cb.checked = false;
    setRhState('disconnected', 'dim');
  });
  $('#rhLive').addEventListener('change', (e) => {
    S.settings.liveRh = e.target.checked; saveSettings();
    if (e.target.checked) { S.rhQuotes = {}; toast('Live Robinhood quotes enabled', 'ok'); }
  });
  $('#jExport').addEventListener('click', async () => {
    const j = journalAll();
    if (!j.length) { toast('Journal is empty', 'err'); return; }
    const cols = ['symbol', 'side', 'qty', 'entry', 'stop', 'target', 'openedAt', 'status'];
    const csv = [cols.join(',')].concat(j.map((r) => cols.map((c) => r[c] ?? '').join(','))).join('\n');
    const ok = await copyText(csv);
    toast(ok ? 'Journal CSV copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err');
  });
  $('#jClear').addEventListener('click', () => { journalSave([]); saveJournalState(); toast('Journal cleared'); });

  $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => {
    S.settings.theme = b.dataset.theme; saveSettings(); applyTheme();
    $$('#themeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
}

/* ------------------------------- accounts ---------------------------------- */
/* Server-backed accounts and journal. Everything degrades to guest mode when
   the API is not running: the app still works, the journal just stays local.   */

const apiBase = () => S.settings.apiBase || auth.DEFAULT_API;

function renderAcct() {
  const chip = $('#acctChip');
  if (!chip) return;
  if (S.user) {
    chip.classList.add('signed');
    chip.innerHTML = `<button class="acct-btn" id="acctBtn" title="Signed in as ${esc(S.user.email)}"><span class="acct-dot"></span><span class="acct-label">${esc(S.user.email.split('@')[0])}</span></button>`;
  } else {
    chip.classList.remove('signed');
    chip.innerHTML = `<button class="acct-btn" id="acctBtn" title="Sign in or create an account"><span class="acct-dot"></span><span class="acct-label">Sign in</span></button>`;
  }
  $('#acctBtn').addEventListener('click', () => (S.user ? openAccountMenu() : openAuthModal('login')));
  updateApiStatus();
}

function openAccountMenu() {
  openModal('Account', `
    <div class="stack" style="gap:12px">
      <div class="flex"><span class="label-xs">Signed in</span><span class="spacer"></span><span class="mono" style="font-size:12px">${esc(S.user.email)}</span></div>
      <div class="hint">Your journal is stored on the API server and mirrored in this browser. Sessions are HttpOnly cookies; the page never sees your password.</div>
      <div class="flex" style="gap:8px;flex-wrap:wrap">
        <button class="btn sm" id="amPw">Change password</button>
        <button class="btn sm ghost" id="amOut">Sign out</button>
      </div>
      <div class="hint" id="amMsg" style="margin:0"></div>
    </div>`, (wrap, close) => {
    wrap.querySelector('#amOut').addEventListener('click', async () => {
      try { await auth.logout(apiBase()); } catch { /* already gone */ }
      S.user = null; renderAcct(); close(); toast('Signed out');
    });
    wrap.querySelector('#amPw').addEventListener('click', () => { close(); openPasswordModal(); });
  });
}

function openPasswordModal() {
  openModal('Change password', `
    <div class="stack" style="gap:10px">
      <label class="field"><span>Current password</span><input type="password" id="pwCur" autocomplete="current-password" /></label>
      <label class="field"><span>New password (10+ characters)</span><input type="password" id="pwNew" autocomplete="new-password" /></label>
      <div class="pw-meter"><i id="pwBar"></i></div>
      <div class="auth-err" id="pwErr"></div>
      <div class="flex" style="justify-content:flex-end"><button class="btn primary" id="pwSave">Update password</button></div>
    </div>`, (wrap, close) => {
    const bar = wrap.querySelector('#pwBar');
    wrap.querySelector('#pwNew').addEventListener('input', (e) => {
      const v = e.target.value;
      const score = Math.min(4, (v.length >= 10 ? 1 : 0) + (v.length >= 14 ? 1 : 0) + (/[^a-zA-Z0-9]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) && /[0-9]/.test(v) ? 1 : 0));
      bar.style.width = `${score * 25}%`;
      bar.style.background = score <= 1 ? 'var(--short)' : score === 2 ? 'var(--warn)' : 'var(--long)';
    });
    wrap.querySelector('#pwSave').addEventListener('click', async () => {
      const err = wrap.querySelector('#pwErr');
      try {
        await auth.changePassword(wrap.querySelector('#pwCur').value, wrap.querySelector('#pwNew').value, apiBase());
        S.user = null; renderAcct(); close(); toast('Password changed — sign in again', 'ok');
      } catch (e) { err.textContent = e.message; }
    });
  });
}

function openAuthModal(mode = 'login') {
  let tab = mode;
  const body = () => `
    <div class="auth-tabs">
      <button data-tab="login" class="${tab === 'login' ? 'on' : ''}">Sign in</button>
      <button data-tab="register" class="${tab === 'register' ? 'on' : ''}">Create account</button>
    </div>
    <div class="stack" style="gap:10px">
      <label class="field"><span>Email</span><input type="email" id="auEmail" autocomplete="email" placeholder="you@example.com" /></label>
      <label class="field"><span>Password${tab === 'register' ? ' (10+ characters)' : ''}</span><input type="password" id="auPw" autocomplete="${tab === 'register' ? 'new-password' : 'current-password'}" /></label>
      ${tab === 'register' ? '<div class="pw-meter"><i id="auBar"></i></div>' : ''}
      <div class="auth-err" id="auErr"></div>
      <div class="flex" style="justify-content:space-between;gap:8px">
        <span class="hint" style="margin:0">${esc(apiBase().replace(/^https?:\/\//, ''))}</span>
        <button class="btn primary" id="auGo">${tab === 'login' ? 'Sign in' : 'Create account'}</button>
      </div>
      <div class="hint" style="margin:0">Passwords are hashed with scrypt on the server and never stored or sent back. Sessions use HttpOnly cookies. AlphaDesk cannot see your brokerage credentials — it never asks for them.</div>
    </div>`;
  const m = openModal('Account', body(), (wrap, close) => {
    const wire = () => {
      $$('.auth-tabs button', wrap).forEach((b) => b.addEventListener('click', () => {
        tab = b.dataset.tab;
        wrap.querySelector('.modal-body').innerHTML = body();
        wire();
        const bar = wrap.querySelector('#auBar');
        if (bar) wrap.querySelector('#auPw').addEventListener('input', (e) => {
          const v = e.target.value;
          const score = Math.min(4, (v.length >= 10 ? 1 : 0) + (v.length >= 14 ? 1 : 0) + (/[^a-zA-Z0-9]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) && /[0-9]/.test(v) ? 1 : 0));
          bar.style.width = `${score * 25}%`;
          bar.style.background = score <= 1 ? 'var(--short)' : score === 2 ? 'var(--warn)' : 'var(--long)';
        });
      }));
      wrap.querySelector('#auGo').addEventListener('click', async () => {
        const err = wrap.querySelector('#auErr');
        const email = wrap.querySelector('#auEmail').value.trim();
        const pw = wrap.querySelector('#auPw').value;
        err.textContent = '';
        const btn = wrap.querySelector('#auGo');
        btn.disabled = true; btn.textContent = 'Working…';
        try {
          const r = tab === 'login' ? await auth.login(email, pw, apiBase()) : await auth.register(email, pw, apiBase());
          S.user = r.user; S.apiOnline = true;
          renderAcct();
          await syncJournal();
          close(); toast(tab === 'login' ? 'Signed in' : 'Account created', 'ok');
          route();
        } catch (e) {
          err.textContent = e.message;
          btn.disabled = false; btn.textContent = tab === 'login' ? 'Sign in' : 'Create account';
        }
      });
    };
    wire();
  });
  return m;
}

/** Pull server fills into the local mirror (and push unsynced local rows up). */
async function syncJournal() {
  if (!S.user) return;
  try {
    const r = await auth.syncJournal(journalAll(), apiBase());
    journalSave(r.fills);
  } catch (e) { console.warn('journal sync failed:', e.message); }
}

async function refreshAuth() {
  renderAcct();
  try {
    const r = await auth.me(apiBase());
    S.user = r.user || null;
    S.apiOnline = true;
    if (S.user) await syncJournal();
  } catch {
    S.user = null;
    S.apiOnline = false;
  }
  renderAcct();
}

function updateApiStatus() {
  const el = $('#sbApi');
  if (!el) return;
  if (S.apiOnline === true) { el.textContent = S.user ? `API · ${S.user.email.split('@')[0]}` : 'API · guest'; el.className = 'sb-item ok'; }
  else if (S.apiOnline === false) { el.textContent = 'API offline · local mode'; el.className = 'sb-item off'; }
  else { el.textContent = 'API …'; el.className = 'sb-item'; }
}

/* ------------------------------- status bar -------------------------------- */

function marketState() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 0 || day === 6) return { state: 'closed', label: 'closed' };
  if (mins >= 570 && mins < 960) return { state: 'open', label: 'open' };
  if ((mins >= 240 && mins < 570) || (mins >= 960 && mins < 1200)) return { state: 'pre', label: 'extended' };
  return { state: 'closed', label: 'closed' };
}

function updateStatusBar(symbol) {
  const pill = $('#mktPill');
  if (pill) {
    const m = marketState();
    pill.textContent = m.state === 'open' ? 'Market open' : m.state === 'pre' ? 'Extended' : 'Market closed';
    pill.className = `mkt-pill ${m.state === 'open' ? 'open' : 'closed'}`;
  }
  const sym = $('#sbSym');
  if (sym) sym.textContent = symbol ? `${symbol} · ${S.bySymbol.get(symbol)?.cls || ''}` : 'no symbol';
  const data = $('#sbData');
  if (data) data.textContent = $('#dataChip')?.textContent || '';
  updateApiStatus();
}

function startClock() {
  const tick = () => {
    const el = $('#sbClock');
    if (!el) return;
    const m = marketState();
    el.textContent = `${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${m.label}`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ------------------------------- paper desk -------------------------------- */

async function viewTrade() {
  const viewEl = $('#view');
  if (!S.user) {
    viewEl.innerHTML = `
      <div class="hero"><h1>Auto-trader</h1><p>The execution engine places bracketed orders for you — on a paper account. Sign in to start it.</p></div>
      <section class="card card-pad" style="max-width:640px">
        <h2 style="font-size:15px;margin-bottom:8px">Why paper first</h2>
        <p class="hint">Measured out of sample, this model returns 18.5% a year with a 57% drawdown, and buys-and-holds SPY at 13.1% with 34%. Automating it with real money before it earns a forward record would be a bet, not a strategy. The paper desk gives it that record against real prices, with every order logged.</p>
        <div class="flex" style="margin-top:12px"><button class="btn primary" id="tradeSignIn">Sign in to start</button></div>
      </section>`;
    $('#tradeSignIn').addEventListener('click', () => openAuthModal('login'));
    return;
  }

  viewEl.innerHTML = `<div class="empty"><div class="skeleton" style="height:220px"></div></div>`;
  let st;
  try { st = await auth.traderStatus(apiBase()); }
  catch (e) { viewEl.innerHTML = `<div class="empty">Paper desk unavailable: ${esc(e.message)}<br /><span class="dim">Start the API with <code>node server/server.mjs</code>.</span></div>`; return; }

  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—');
  const money2 = (v) => (Number.isFinite(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—');

  viewEl.innerHTML = `
    <div class="hero" style="flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap">
      <h1 style="font-size:22px">Auto-trader</h1>
      <span class="badge warn">paper only</span>
      <span class="spacer"></span>
      <span class="hint" style="margin:0">signals as of ${esc(st.snapshotDate)} · ${st.openCount}/${st.settings.maxPositions} slots used</span>
    </div>

    <div class="kpi-grid" style="margin-bottom:14px">
      <div class="kpi"><div class="k">Equity</div><div class="v">${money2(st.equity)}</div><div class="s ${signCls(st.returnPct)}">${pct(st.returnPct)} since ${money2(st.startEquity)}</div></div>
      <div class="kpi"><div class="k">Realised P&amp;L</div><div class="v ${signCls(st.realized)}">${money2(st.realized)}</div><div class="s">${st.closedCount} closed trades</div></div>
      <div class="kpi"><div class="k">Win rate</div><div class="v">${st.winRate == null ? '—' : (st.winRate * 100).toFixed(1) + '%'}</div><div class="s">avg ${st.avgR == null ? '—' : (st.avgR >= 0 ? '+' : '') + st.avgR + 'R'} per trade</div></div>
      <div class="kpi"><div class="k">Engine</div><div class="v ${st.enabled ? 'pos' : 'mut'}" style="font-size:19px">${st.enabled ? 'RUNNING' : 'STOPPED'}</div><div class="s">${st.enabled ? 'sweeps every 15 min' : 'no new entries'}</div></div>
    </div>

    <section class="card" style="margin-bottom:14px">
      <div class="card-head wrap" style="gap:8px">
        <div class="flex" style="gap:8px">
          <button class="btn ${st.enabled ? 'ghost' : 'primary'} sm" id="trToggle">${st.enabled ? 'Stop engine' : 'Start engine'}</button>
          <button class="btn sm" id="trRun">Run cycle now</button>
          <button class="btn sm ghost" id="trReset">Reset account</button>
        </div>
        <span class="spacer"></span>
        <label class="hint" style="margin:0;display:flex;gap:6px;align-items:center">Risk per trade
          <input type="number" id="trRisk" value="${st.settings.riskPct}" min="0.1" max="5" step="0.1" style="width:66px" /> %
        </label>
        <label class="hint" style="margin:0;display:flex;gap:6px;align-items:center">Max positions
          <input type="number" id="trMax" value="${st.settings.maxPositions}" min="1" max="20" step="1" style="width:62px" />
        </label>
        <button class="btn sm" id="trSave">Save</button>
      </div>
      <div class="hint" style="padding:0 18px 12px">${st.note ? esc(st.note) : 'Engine idle.'} Guardrails: max ${st.settings.maxPositions} positions · ${st.settings.riskPct}% risk each · ${st.settings.maxNotionalPct}% notional cap · auto-stop at ${st.settings.maxDailyLossPct}% daily loss.</div>
    </section>

    <div class="row cols-2" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
      <section class="card">
        <div class="card-head"><h2>Open positions</h2><span class="card-sub">${st.openCount} live · marked to last close</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th class="no-sort">Symbol</th><th class="no-sort">Side</th><th class="no-sort">Qty</th><th class="no-sort">Entry</th><th class="no-sort">Stop</th><th class="no-sort">Target</th><th class="no-sort">Mark</th><th class="no-sort">Unreal.</th><th class="no-sort"></th></tr></thead>
          <tbody>${st.positions.length ? st.positions.map((p) => `
            <tr>
              <td><span class="sym">${esc(p.symbol)}</span></td>
              <td><span class="badge ${p.side}">${esc(p.side)}</span></td>
              <td class="mono">${n2(p.qty, 0)}</td>
              <td class="mono">${fmtPrice(p.entry)}</td>
              <td class="mono neg">${fmtPrice(p.stop)}</td>
              <td class="mono pos">${fmtPrice(p.target)}</td>
              <td class="mono">${fmtPrice(p.mark)}</td>
              <td class="mono ${signCls(p.unrealized)}">${p.unrealized >= 0 ? '+' : ''}${money2(p.unrealized)}</td>
              <td><button class="btn sm ghost" data-close="${esc(p.id)}">Close</button></td>
            </tr>`).join('') : `<tr><td colspan="9"><div class="empty">No open positions. ${st.enabled ? 'The next sweep will take the best signals.' : 'Start the engine to begin.'}</div></td></tr>`}</tbody>
        </table></div>
      </section>

      <div class="stack">
        <section class="card card-pad">
          <h2 style="font-size:15px;margin-bottom:8px">Cycle log</h2>
          <div class="stack" style="gap:6px;font-size:11.5px">
            ${st.runs.length ? st.runs.map((r) => `<div class="flex"><span class="mono dim" style="width:118px">${new Date(r.started_at * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><span class="flex" style="gap:6px"><span class="pill">${r.candidates ?? 0} cand</span><span class="pill">${r.opened ?? 0} open</span>${r.closed ? `<span class="pill">${r.closed} closed</span>` : ''}</span><span class="spacer"></span><span class="mono dim">${money2(r.equity)}</span></div>`).join('') : '<span class="hint">No cycles yet.</span>'}
          </div>
        </section>
        <section class="card card-pad">
          <h2 style="font-size:15px;margin-bottom:8px">Closed trades</h2>
          <div class="stack" style="gap:5px;font-size:11.5px">
            ${st.closed.length ? st.closed.slice(0, 10).map((c) => `<div class="flex"><span class="mono" style="width:62px">${esc(c.symbol)}</span><span class="dim" style="width:40px">${esc(c.side)}</span><span class="dim" style="flex:1">${esc(c.exit_reason || '')}</span><span class="mono ${signCls(c.r_multiple)}">${(c.r_multiple ?? 0) >= 0 ? '+' : ''}${(c.r_multiple ?? 0).toFixed(2)}R</span><span class="mono dim" style="width:78px;text-align:right">${money2(c.pnl)}</span></div>`).join('') : '<span class="hint">Nothing closed yet.</span>'}
          </div>
        </section>
        <section class="card card-pad">
          <h2 style="font-size:15px;margin-bottom:6px">Broker</h2>
          <p class="hint" style="margin:0 0 8px">Fills happen in this app's paper book. To mirror them at a real broker, use Alpaca's paper API — official, free, and key-based:</p>
          <pre class="mono hint" style="white-space:pre-wrap;margin:0;padding:8px;background:var(--panel-2);border-radius:8px;border:1px solid var(--line)">ALPACA_KEY_ID=...
ALPACA_SECRET=...
node server/server.mjs</pre>
          <p class="hint" style="margin:8px 0 0">The adapter refuses any endpoint that is not <code>paper-api.alpaca.markets</code>. Robinhood has no public order API, so it stays a manual hand-off.</p>
        </section>
      </div>
    </div>

    <div class="hint" style="margin:14px 2px 0">${esc(DISCLAIMER)} Paper results are simulated fills at the signal bar's close; slippage, borrow costs and dividends are not modelled.</div>
  `;

  const refresh = async () => { await viewTrade(); };
  $('#trToggle').addEventListener('click', async () => {
    try { await auth.traderSetEnabled(!st.enabled, apiBase()); toast(st.enabled ? 'Engine stopped' : 'Engine started', 'ok'); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#trRun').addEventListener('click', async () => {
    const btn = $('#trRun'); btn.disabled = true; btn.textContent = 'Running…';
    try {
      const r = await auth.traderRun(apiBase());
      toast(`Cycle: ${r.result.opened} opened, ${r.result.closed} closed`, 'ok');
      await refresh();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Run cycle now'; }
  });
  $('#trReset').addEventListener('click', async () => {
    if (!confirm('Reset the paper account to its starting balance? All positions and history are deleted.')) return;
    try { await auth.traderReset(apiBase()); toast('Paper account reset'); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#trSave').addEventListener('click', async () => {
    try {
      await auth.traderSetConfig({ riskPct: +$('#trRisk').value, maxPositions: +$('#trMax').value }, apiBase());
      toast('Limits saved', 'ok'); await refresh();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-close]').forEach((b) => b.addEventListener('click', async () => {
    try { await auth.traderClose(b.dataset.close, apiBase()); toast('Position closed', 'ok'); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

/* ---------------------------------- router --------------------------------- */

const ROUTES = {
  dashboard: () => viewDashboard(),
  analyze: (arg) => viewTerminal(arg),
  chart: (arg) => viewTerminal(arg),
  scan: () => viewScan(),
  screener: () => viewScreener(),
  model: () => viewModel(),
  news: () => viewNews(),
  research: () => viewResearch(),
  settings: () => viewSettings(),
  trade: () => viewTrade(),
};

let currentRoute = '';

async function route() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [name, arg] = hash.split('/');
  const key = ROUTES[name] ? name : 'dashboard';
  const sym = arg ? decodeURIComponent(arg.split('?')[0]).toUpperCase() : '';
  currentRoute = `${key}/${sym}`;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === key));
  $$('.quicknav a').forEach((a) => a.classList.toggle('active', (a.getAttribute('href') || '').includes(key)));
  updateStatusBar(sym || (key === 'analyze' ? '' : undefined));
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
  if (!el) return;
  el.className = `regime-mini ${r.kind === 'long' ? 'risk-on' : r.kind === 'short' ? 'risk-off' : 'caution'}`;
  const text = `${r.label} · VIX ${(vix?.price || 0).toFixed(1)}`;
  const label = el.querySelector('.regime-text');
  if (label) label.textContent = text;
  el.title = text;
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

  const newestBar = S.universe.map((u) => u.last).filter(Boolean).sort().at(-1);
  $('#dataChip').textContent = `prices ${newestBar || S.model.training.dateRange[1]}`;
  startClock();
  await refreshAuth();
  $('#dataChip').title = `Daily bars through ${newestBar || ''}. The model's newest labelled row is ${S.model.training.dateRange[1]} (labels need 15 forward bars).`;
  setRegimeMini();
  wireSearch();
  if (S.vision?.setAIConfig && S.settings.aiKey) {
    S.vision.setAIConfig({ provider: S.settings.aiProvider, apiKey: S.settings.aiKey, model: S.settings.aiModel || undefined });
  }
  if (!location.hash) location.hash = '#/dashboard';
  await route();
}

main();
