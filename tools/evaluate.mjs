#!/usr/bin/env node
/**
 * Out-of-sample evaluator + information analysis.
 *
 * Walk-forward folds: each fold's weights are replayed over the year that fold
 * never saw. Three questions are answered separately, because they are
 * different questions:
 *
 *   1. Ranking  — does the model sort opportunities correctly? (rank IC)
 *   2. Selection — is the top of that ranking profitable? (decile table + top-K portfolio)
 *   3. Breadth  — what does taking every qualifying signal earn? (gate statistics)
 *
 * The top-K portfolio is the honest analogue of a person following this desk:
 * one position per instrument, five concurrent positions, 1% of equity risked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normaliseBars, buildFeatures, buildContext, predictHead, simulateTrades, metrics,
  TP_MULT, SL_MULT, HORIZON, BREAKEVEN_P,
} from '../docs/js/engine.js';
import { UNIVERSE } from './universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const MODEL = path.join(ROOT, 'docs', 'data', 'model.json');
const OUT = path.join(ROOT, 'docs', 'data', 'backtest.json');

const COST = 0.0005;
const MIN_EDGE = 0.10;
const P_FLOOR = Math.round(BREAKEVEN_P * 1e4) / 1e4;
const TOP_K = 5;
const BLEND = Number(process.env.BLEND || 0); // 0 = pure model ranking
const RISK_PCT = 1;
const SENSITIVITY = [0.10, 0.15, 0.20, 0.25, 0.30];

const round = (x, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i;
  return r;
}
function spearman(a, b) {
  if (a.length < 8) return null;
  const ra = ranks(a), rb = ranks(b);
  const n = a.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

function stripMetrics(m) {
  if (!m || !m.trades) return { trades: 0 };
  const gapped = Array.isArray(m.trades) ? m.trades.filter((t) => t.gapped).length : 0;
  return {
    trades: m.trades, winRate: round(m.winRate, 4), avgWinR: round(m.avgWinR), avgLossR: round(m.avgLossR),
    expectancyR: round(m.expectancyR, 4),
    profitFactor: Number.isFinite(m.profitFactor) ? round(m.profitFactor) : null,
    totalR: round(m.totalR, 1), maxDrawdownR: round(m.maxDrawdownR, 1),
    sharpePerTrade: round(m.sharpePerTrade), timeoutShare: round(m.timeoutShare), longShare: round(m.longShare),
    gappedShare: round(m.trades ? gapped / m.trades : 0),
  };
}

/**
 * Top-K portfolio: chronological, max K open positions, best edge first.
 */
function topKPortfolio(candidates, { k = TOP_K, minEdge = MIN_EDGE, riskPct = RISK_PCT } = {}) {
  const byDate = new Map();
  for (const t of candidates) {
    if (!(t.edge >= minEdge)) continue;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }
  const dates = [...byDate.keys()].sort();
  let equity = 1, peak = 1, maxDD = 0;
  const open = [];
  const closed = [];
  const curve = [];
  for (const d of dates) {
    // close positions that exited on or before this date
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitDate <= d) {
        const pos = open.splice(i, 1)[0];
        equity += pos.riskCash * pos.netR;
        closed.push({ ...pos, equityAfter: equity });
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
      }
    }
    const slots = k - open.length;
    if (slots <= 0) continue;
    const taken = new Set(open.map((p) => p.symbol));
    const picks = byDate.get(d)
      .filter((t) => !taken.has(t.symbol))
      .sort((a, b) => b.edge - a.edge)
      .slice(0, slots * 2)
      .slice(0, slots);
    for (const p of picks) {
      open.push({ ...p, riskCash: equity * (riskPct / 100) });
    }
    curve.push({ x: d, y: round((equity - 1) * 100, 2) });
  }
  for (const pos of open) { equity += pos.riskCash * pos.netR; closed.push({ ...pos, equityAfter: equity }); }
  curve.push({ x: dates[dates.length - 1], y: round((equity - 1) * 100, 2) });

  const rets = closed.map((p) => (p.netR * (p.riskCash / Math.max(1e-9, equity))));
  const m = metrics(closed);
  const years = closed.length ? (new Date(closed[closed.length - 1].exitDate) - new Date(closed[0].date)) / (365.25 * 864e5) : 0;
  const perTradeRet = closed.map((p) => p.netR * (riskPct / 100));
  return {
    trades: closed.length,
    winRate: round(m.winRate, 4),
    expectancyR: round(m.expectancyR, 4),
    profitFactor: Number.isFinite(m.profitFactor) ? round(m.profitFactor) : null,
    totalReturnPct: round((equity - 1) * 100, 1),
    cagrPct: years > 0.5 ? round(((equity ** (1 / years)) - 1) * 100, 1) : null,
    maxDrawdownPct: round(maxDD * 100, 1),
    sharpe: std(perTradeRet) > 0 ? round((mean(perTradeRet) / std(perTradeRet)) * Math.sqrt(Math.max(1, closed.length / Math.max(0.5, years))), 2) : null,
    avgHoldDays: round(mean(closed.map((p) => p.barsHeld)), 1),
    years: round(years, 1),
    curve,
    byYear: (() => {
      const out = {};
      for (const p of closed) {
        const y = p.date.slice(0, 4);
        out[y] = out[y] || { trades: 0, r: 0, wins: 0, retPct: 0 };
        out[y].trades++;
        out[y].r += p.netR;
        out[y].retPct += p.netR * riskPct;
        if (p.netR > 0) out[y].wins++;
      }
      for (const y of Object.keys(out)) { out[y].r = round(out[y].r, 1); out[y].retPct = round(out[y].retPct, 2); out[y].winRate = round(out[y].wins / out[y].trades, 3); }
      return out;
    })(),
    firstDate: closed[0]?.date || null,
    lastDate: closed[closed.length - 1]?.exitDate || null,
  };
}

async function main() {
  const model = JSON.parse(await fs.readFile(MODEL, 'utf8'));
  const files = (await fs.readdir(RAW)).filter((f) => f.endsWith('.json'));
  const raw = new Map();
  for (const f of files) {
    const j = JSON.parse(await fs.readFile(path.join(RAW, f), 'utf8'));
    raw.set(j.symbol, j);
  }
  const ctx = buildContext({ spy: raw.get('SPY'), vix: raw.get('^VIX') });

  const series = [];
  for (const inst of UNIVERSE) {
    const j = raw.get(inst.symbol);
    if (!j) continue;
    const bars = normaliseBars(j);
    if (!bars || bars.c.length < 290) continue;
    series.push({ inst, bars, feats: buildFeatures({ ...bars, cls: inst.cls }, ctx) });
  }
  console.log(`series prepared: ${series.length}`);

  // ---- candidates for every fold year -------------------------------------
  const foldCandidates = [];
  const icRows = [];
  const decileBuckets = Array.from({ length: 10 }, () => []);

  for (const fold of model.folds) {
    const Y = String(fold.year);
    const cands = [];
    for (const s of series) {
      const keep = [];
      for (let k = 0; k < s.feats.X.length; k++) if (s.feats.dates[k].slice(0, 4) === Y) keep.push(k);
      if (keep.length < 10) continue;
      const sub = {
        dates: keep.map((k) => s.feats.dates[k]), X: keep.map((k) => s.feats.X[k]),
        close: keep.map((k) => s.feats.close[k]), atr: keep.map((k) => s.feats.atr[k]), raw: keep.map((k) => s.feats.raw[k]),
      };
      const probs = sub.X.map((row) => ({
        long: predictHead(row, fold.heads.long, fold.mean, fold.std),
        short: predictHead(row, fold.heads.short, fold.mean, fold.std),
      }));
      // every bar becomes a candidate (gate applied later by the consumer)
      const trades = simulateTrades({ bars: s.bars, feats: sub, probs, threshold: 0, minEdge: -99, costPct: COST });
      const byDate = new Map();
      for (const t of trades) {
        if (byDate.has(t.date)) continue;
        byDate.set(t.date, t);
      }
      // forward 15-bar return for information analysis (independent of barriers)
      for (let k = 0; k < sub.X.length; k++) {
        const i = sub.raw[k].i;
        const j2 = Math.min(i + HORIZON, s.bars.c.length - 1);
        const fwd = (s.bars.c[j2] / sub.close[k] - 1) * 100;
        const a = sub.atr[k];
        const eL = TP_MULT * probs[k].long.win - probs[k].long.loss;
        const eS = TP_MULT * probs[k].short.win - probs[k].short.loss;
        icRows.push({ date: sub.dates[k], edge: Math.max(eL, eS), dir: eL >= eS ? 1 : -1, fwdAtr: (fwd / 100) * (sub.close[k] / a) });
      }
      const momByDate = new Map();
      for (let k = 0; k < sub.X.length; k++) momByDate.set(sub.dates[k], sub.X[k][17]);
      for (const t of byDate.values()) cands.push({ ...t, symbol: s.inst.symbol, mom: momByDate.get(t.date) });
    }
    foldCandidates.push({ year: fold.year, candidates: cands });
    const m = metrics(cands.filter((t) => t.edge >= MIN_EDGE && t.pWin >= P_FLOOR));
    console.log(`  ${Y}: ${cands.length} candidates, ${trades_ok(cands)} pass gate, per-signal exp ${isNum(m.expectancyR) ? m.expectancyR.toFixed(3) : '—'}R`);
  }

  function trades_ok(c) { return c.filter((t) => t.edge >= MIN_EDGE && t.pWin >= P_FLOOR).length; }
  function isNum(x) { return Number.isFinite(x); }

  const allCandidates = foldCandidates.flatMap((f) => f.candidates);
  if (BLEND > 0) {
    // Blend the model edge with 20-day momentum, both z-scored within each date,
    // to test whether the model adds anything on top of plain momentum.
    const zByDate = new Map();
    for (const c of allCandidates) {
      if (!zByDate.has(c.date)) zByDate.set(c.date, []);
      zByDate.get(c.date).push(c);
    }
    for (const [, rows] of zByDate) {
      const es = rows.map((r) => r.edge), ms = rows.map((r) => r.mom ?? 0);
      const em = mean(es), esd = std(es) || 1, mm = mean(ms), msd = std(ms) || 1;
      for (const r of rows) r.edge = (1 - BLEND) * ((r.edge - em) / esd) + BLEND * (((r.mom ?? 0) - mm) / msd);
    }
    console.log(`ranking blended: ${(1 - BLEND) * 100}% model / ${BLEND * 100}% momentum`);
  }
  const gated = allCandidates.filter((t) => t.edge >= MIN_EDGE && t.pWin >= P_FLOOR);
  const gateMetrics = metrics(gated);

  // ---- rank IC -----------------------------------------------------------
  const byDate = new Map();
  for (const r of icRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const icSeries = [];
  for (const [d, rows] of byDate) {
    if (rows.length < 20) continue;
    const ic = spearman(rows.map((r) => r.edge), rows.map((r) => r.fwdAtr * r.dir));
    if (ic !== null) icSeries.push({ date: d, ic, n: rows.length });
  }
  const icVals = icSeries.map((x) => x.ic);
  const icMean = mean(icVals);
  const icStd = std(icVals);
  const icIR = icStd > 0 ? (icMean / icStd) * Math.sqrt(icVals.length / Math.max(1, icVals.length / 252)) : 0;
  const icHit = icVals.filter((x) => x > 0).length / Math.max(1, icVals.length);

  // ---- deciles -----------------------------------------------------------
  const sortedForDecile = [...icRows].sort((a, b) => a.edge - b.edge);
  sortedForDecile.forEach((r, i) => {
    const b = Math.min(9, Math.floor((i / sortedForDecile.length) * 10));
    decileBuckets[b].push(r.fwdAtr * r.dir);
  });
  const deciles = decileBuckets.map((vals, i) => ({
    decile: i + 1,
    meanFwdAtr: round(mean(vals), 4),
    medianFwdAtr: round(vals.length ? [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)] : null, 4),
    n: vals.length,
  }));

  // ---- portfolios --------------------------------------------------------
  const portfolio = topKPortfolio(allCandidates);
  const holdoutPortfolio = topKPortfolio(foldCandidates.filter((f) => f.year >= 2024).flatMap((f) => f.candidates));
  const selectionPortfolio = topKPortfolio(foldCandidates.filter((f) => f.year <= 2023).flatMap((f) => f.candidates));
  const naive = [];
  for (const s of series) {
    const probs = s.feats.X.map(() => ({ long: { win: 0.5, loss: 0.5, timeout: 0 }, short: { win: 0.5, loss: 0.5, timeout: 0 } }));
    naive.push(...simulateTrades({ bars: s.bars, feats: s.feats, probs, threshold: 0, minEdge: -99, costPct: COST, alwaysSide: 1 }));
  }
  const naiveMetrics = metrics(naive);

  // Momentum benchmark: same portfolio mechanics, but ranked by 20-day momentum
  // instead of the model. If the model cannot beat this, it adds nothing.
  const momCandidates = [];
  for (const s of series) {
    const momByDate = new Map();
    for (let k = 0; k < s.feats.X.length; k++) momByDate.set(s.feats.dates[k], s.feats.X[k][17]);
    const probs = s.feats.X.map(() => ({ long: { win: 0.5, loss: 0.5, timeout: 0 }, short: { win: 0.5, loss: 0.5, timeout: 0 } }));
    const tr = simulateTrades({ bars: s.bars, feats: s.feats, probs, threshold: 0, minEdge: -99, costPct: COST, alwaysSide: 1 });
    for (const t of tr) {
      const m = momByDate.get(t.date);
      if (Number.isFinite(m)) momCandidates.push({ ...t, symbol: s.inst.symbol, edge: m });
    }
  }
  const momentumPortfolio = topKPortfolio(momCandidates, { minEdge: -99 });

  // Buy-and-hold SPY over exactly the window the portfolio traded, so the
  // comparison is apples to apples rather than a different decade.
  function buyAndHold(fromDate, toDate) {
    const spy = series.find((s) => s.inst.symbol === 'SPY');
    if (!spy || !fromDate) return null;
    const bars = spy.bars;
    let start = bars.date.findIndex((d) => d >= fromDate);
    let end = bars.date.length - 1;
    for (let i = bars.date.length - 1; i >= 0; i--) if (bars.date[i] <= toDate) { end = i; break; }
    if (start < 0 || end <= start) return null;
    const eq = bars.c.slice(start, end + 1);
    const years = (new Date(bars.date[end]) - new Date(bars.date[start])) / (365.25 * 864e5);
    let peak = eq[0], maxDD = 0;
    for (const v of eq) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, (peak - v) / peak); }
    const total = eq[eq.length - 1] / eq[0] - 1;
    return {
      from: bars.date[start], to: bars.date[end], years: round(years, 1),
      totalReturnPct: round(total * 100, 1),
      cagrPct: years > 0.5 ? round(((1 + total) ** (1 / years) - 1) * 100, 1) : null,
      maxDrawdownPct: round(maxDD * 100, 1),
      source: 'SPY split-adjusted closes, price return only (no dividends)',
    };
  }
  const buyHold = buyAndHold(portfolio.firstDate, portfolio.lastDate);

  const holdoutGate = metrics(allCandidates.filter((t) => t.date.slice(0, 4) >= '2024' && t.edge >= MIN_EDGE && t.pWin >= P_FLOOR));

  const sensitivity = SENSITIVITY.map((edge) => {
    const sub = allCandidates.filter((t) => t.edge >= edge);
    const p = topKPortfolio(sub);
    return {
      minEdgeR: edge,
      signals: sub.length,
      perSignal: stripMetrics(metrics(sub)),
      portfolio: { trades: p.trades, cagrPct: p.cagrPct, totalReturnPct: p.totalReturnPct, maxDrawdownPct: p.maxDrawdownPct, winRate: p.winRate, expectancyR: p.expectancyR },
    };
  });

  // ---- calibration -------------------------------------------------------
  const buckets = new Map();
  for (const s of series) {
    for (let k = 0; k < s.feats.X.length; k += 2) {
      const y = Number(s.feats.dates[k].slice(0, 4));
      const fold = model.folds.find((f) => f.year === y);
      if (!fold) continue;
      const p = predictHead(s.feats.X[k], fold.heads.long, fold.mean, fold.std);
      const i = s.feats.raw[k].i;
      const b = s.bars;
      const entry = b.c[i], up = entry + TP_MULT * s.feats.atr[k], dn = entry - SL_MULT * s.feats.atr[k];
      let outcome = 2;
      for (let j = 1; j <= HORIZON; j++) {
        if (i + j >= b.c.length) break;
        if (b.l[i + j] <= dn) { outcome = 1; break; }
        if (b.h[i + j] >= up) { outcome = 0; break; }
      }
      const key = Math.min(9, Math.max(2, Math.floor(p.win * 10)));
      const cur = buckets.get(key) || { predicted: key / 10, n: 0, wins: 0, resolved: 0 };
      cur.n++;
      if (outcome !== 2) { cur.resolved++; if (outcome === 0) cur.wins++; }
      buckets.set(key, cur);
    }
  }
  const calibration = [...buckets.values()].sort((a, b) => a.predicted - b.predicted)
    .map((b) => ({ predicted: b.predicted, observed: b.resolved ? round(b.wins / b.resolved, 4) : null, n: b.n, resolved: b.resolved }));

  const byYear = {};
  for (const f of foldCandidates) {
    const sub = f.candidates.filter((t) => t.edge >= MIN_EDGE && t.pWin >= P_FLOOR);
    const m = metrics(sub);
    byYear[f.year] = { signals: sub.length, trades: m.trades || 0, r: round(m.totalR || 0, 1), expectancyR: round(m.expectancyR || 0, 3), winRate: round(m.winRate || 0, 4) };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    rule: {
      pWinFloor: P_FLOOR, minEdgeR: MIN_EDGE, tpMult: TP_MULT, slMult: SL_MULT, horizon: HORIZON,
      breakevenHitRate: round(BREAKEVEN_P, 4), topK: TOP_K, riskPct: RISK_PCT,
      note: 'Signals need P(target before stop) at or above the break-even hit rate and expectancy above +0.10R after costs. The portfolio takes the five best edges across the universe, one position per instrument, 1% of equity risked each.',
    },
    threshold: P_FLOOR,
    selectionYears: '2020-2023',
    holdoutYears: '2024-2026',
    assumptions: {
      costPctPerSide: COST,
      entry: 'signal bar close',
      exit: 'barrier price when touched, the open when a bar gaps through it, else the close after the 15-bar horizon',
      note: 'Gate statistics count every qualifying signal, including overlapping ones. The portfolio simulation holds at most five positions at once and applies 1% of current equity as risk per trade.',
    },
    oos: { ...stripMetrics(gateMetrics), byYear, curve: portfolio.curve },
    portfolio: { ...portfolio, curve: undefined },
    portfolioCurve: portfolio.curve,
    holdout: { gate: stripMetrics(holdoutGate), portfolio: { ...holdoutPortfolio, curve: undefined } },
    selection: { portfolio: { ...selectionPortfolio, curve: undefined } },
    information: {
      rankIC: round(icMean, 4), icStd: round(icStd, 4), icIR: round(icIR, 2),
      positiveShare: round(icHit, 3), days: icVals.length,
      note: 'Rank IC is the daily Spearman correlation between the model edge ranking and realised directional return. Above roughly 0.03 with a stable sign, the ranking carries usable information.',
    },
    deciles,
    baseline: { buyEveryBar: stripMetrics(naiveMetrics), momentumTopK: { ...momentumPortfolio, curve: undefined }, buyAndHoldSPY: buyHold },
    sweep: sensitivity.map((s) => ({
      minEdgeR: s.minEdgeR, threshold: s.minEdgeR,
      selection: { ...s.perSignal, trades: s.perSignal.trades },
      verify: { ...s.portfolio },
      portfolio: s.portfolio,
    })),
    calibration,
    folds: foldCandidates.map((f) => {
      const sub = f.candidates.filter((t) => t.edge >= MIN_EDGE && t.pWin >= P_FLOOR);
      return { year: f.year, ...stripMetrics(metrics(sub)) };
    }),
    sampleTrades: gated.slice(-60).map((t) => ({
      date: t.date, exitDate: t.exitDate, side: t.side, symbol: t.symbol,
      entry: round(t.entry, 4), exit: round(t.exit, 4), outcome: t.outcome, netR: round(t.netR), barsHeld: t.barsHeld, edge: round(t.edge, 3),
    })),
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out, null, 1));

  console.log(`\ngate: ${gated.length} signals | exp ${gateMetrics.expectancyR.toFixed(3)}R | PF ${gateMetrics.profitFactor?.toFixed(2)} | win ${(gateMetrics.winRate * 100).toFixed(1)}%`);
  console.log(`rank IC mean ${icMean.toFixed(4)} (IR ${icIR.toFixed(2)}, positive ${(icHit * 100).toFixed(0)}% of ${icVals.length} days)`);
  console.log('deciles (mean forward return, ATR units):', deciles.map((d) => d.meanFwdAtr.toFixed(2)).join(' '));
  console.log(`portfolio top-${TOP_K}: ${portfolio.trades} trades | ${portfolio.totalReturnPct}% total | CAGR ${portfolio.cagrPct}% | maxDD ${portfolio.maxDrawdownPct}% | win ${(portfolio.winRate * 100).toFixed(1)}%`);
  console.log(`selection 2020-2023: ${selectionPortfolio.trades} trades ${selectionPortfolio.cagrPct}% CAGR | holdout 2024-2026: ${holdoutPortfolio.trades} trades ${holdoutPortfolio.cagrPct}% CAGR, maxDD ${holdoutPortfolio.maxDrawdownPct}%`);
  console.log(`baseline buy-every-bar: ${naiveMetrics.trades} trades exp ${naiveMetrics.expectancyR.toFixed(3)}R PF ${naiveMetrics.profitFactor?.toFixed(2)}`);
  console.log(`baseline momentum top-${TOP_K}: ${momentumPortfolio.trades} trades | CAGR ${momentumPortfolio.cagrPct}% | maxDD ${momentumPortfolio.maxDrawdownPct}% | win ${(momentumPortfolio.winRate * 100).toFixed(1)}%`);
  if (buyHold) console.log(`baseline buy & hold SPY   : ${buyHold.from} -> ${buyHold.to} | CAGR ${buyHold.cagrPct}% | maxDD ${buyHold.maxDrawdownPct}% | total ${buyHold.totalReturnPct}%`);
  console.log(`wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
