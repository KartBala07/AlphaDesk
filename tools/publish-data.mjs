#!/usr/bin/env node
/**
 * Publish the site's data layer from the trained model + raw bars.
 *
 *   web/data/universe.json    instrument metadata
 *   web/data/signals.json     the model's current read on all instruments
 *   web/data/bars/<SYM>.json  full daily history, loaded on demand
 *
 * Everything here is generated; never hand-edit web/data/bars or signals.json.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, buildContext, normaliseBars, WARMUP } from '../docs/js/engine.js';
import { UNIVERSE } from './universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const WEB = path.join(ROOT, 'docs', 'data');
const BARS = path.join(WEB, 'bars');
const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const safe = (s) => s.replace(/^\^/, '').replace(/[^\w.-]/g, '_');  // '^VIX' -> 'VIX.json' (Jekyll skips leading underscores)

async function main() {
  const model = JSON.parse(await fs.readFile(path.join(WEB, 'model.json'), 'utf8'));
  const backtest = JSON.parse(await fs.readFile(path.join(WEB, 'backtest.json'), 'utf8'));
  await fs.mkdir(BARS, { recursive: true });

  const raw = new Map();
  for (const f of (await fs.readdir(RAW)).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(await fs.readFile(path.join(RAW, f), 'utf8'));
    raw.set(j.symbol, j);
  }
  const ctx = buildContext({ spy: raw.get('SPY'), vix: raw.get('^VIX') });
  const threshold = backtest.rule?.pWinFloor ?? 0.3333;
  const minEdge = backtest.rule?.minEdgeR ?? 0.10;

  const universe = [];
  const signals = [];

  for (const inst of UNIVERSE) {
    const j = raw.get(inst.symbol);
    if (!j) { console.warn('  missing', inst.symbol); continue; }
    const bars = normaliseBars(j);
    if (!bars || bars.c.length < WARMUP + 30) { console.warn('  too short', inst.symbol, bars?.c.length); continue; }

    // full history for on-demand charts
    await fs.writeFile(path.join(BARS, `${safe(inst.symbol)}.json`), JSON.stringify({
      symbol: inst.symbol, name: inst.name, cls: inst.cls, sector: inst.sector, group: inst.group,
      source: j.source, interval: '1d', fetched: j.fetched, first: j.first, last: j.last, count: j.count,
      bars: j.bars,
    }));

    universe.push({
      symbol: inst.symbol, name: inst.name, cls: inst.cls, sector: inst.sector, group: inst.group,
      first: j.first, last: j.last, count: j.count, barsFile: `${safe(inst.symbol)}.json`,
    });

    const a = analyze({ bars, ctx, model, inst, accountSize: 25000, riskPct: 1, threshold, minEdge });
    if (!a.ok) { console.warn('  analyse failed', inst.symbol, a.error); continue; }
    const side = a.signal;
    const prob = side === 'short' ? a.probs.short : a.probs.long;
    signals.push({
      symbol: inst.symbol, name: inst.name, cls: inst.cls, sector: inst.sector, group: inst.group,
      date: a.asOf, price: round(a.price, 4), change: round(a.change, 3), atr: round(a.atr, 4), atrPct: round(a.atrPct, 3),
      side, conviction: a.conviction, edgeR: round(a.edgeR, 4), directionProb: round(a.directionProb, 4),
      pWin: round(prob.win, 4), pLose: round(prob.loss, 4), pTimeout: round(prob.timeout, 4),
      longP: round(a.probs.long.win, 4), shortP: round(a.probs.short.win, 4),
      stop: a.trade ? a.trade.stop : null, target: a.trade ? a.trade.target : null, tp1: a.trade ? a.trade.tp1 : null,
      rsi: a.context.rsi !== null ? round(a.context.rsi, 1) : null,
      adx: a.context.adx !== null ? round(a.context.adx, 1) : null,
      ema50: round(a.context.ema50, 4), ema200: round(a.context.ema200, 4),
      spyTrend: round(a.context.spyTrend, 3), vix: round(a.context.vix, 2),
      high52: a.levels.high52, low52: a.levels.low52,
      spark: bars.c.slice(-40).map((x) => round(x, 4)),
      drivers: a.drivers.slice(0, 6),
      flags: a.flags.length,
      bars: bars.c.length, first: j.first, last: j.last,
    });
  }

  // rank by edge so the UI can say "#3 of 139"
  const order = [...signals].sort((a, b) => b.edgeR - a.edgeR);
  order.forEach((s, i) => { s.rank = i + 1; });

  await fs.writeFile(path.join(WEB, 'universe.json'), JSON.stringify(universe));
  await fs.writeFile(path.join(WEB, 'signals.json'), JSON.stringify(signals));

  const counts = signals.reduce((acc, s) => { acc[s.side] = (acc[s.side] || 0) + 1; return acc; }, {});
  const dir = path.join(ROOT, 'docs', 'data');
  const sizes = await fs.readdir(dir);
  const bytes = (await Promise.all(sizes.map(async (f) => {
    const st = await fs.stat(path.join(dir, f));
    return st.isDirectory() ? 0 : st.size;
  }))).reduce((a, b) => a + b, 0);
  const barBytes = (await Promise.all((await fs.readdir(BARS)).map(async (f) => (await fs.stat(path.join(BARS, f))).size))).reduce((a, b) => a + b, 0);

  console.log(`\nuniverse ${universe.length} · signals ${signals.length} (${JSON.stringify(counts)})`);
  console.log(`json ${(bytes / 1024).toFixed(0)} KB + bars ${(barBytes / 1e6).toFixed(1)} MB across ${signals.length} files`);
  console.log(`gate: pWin >= ${threshold}, edge > ${minEdge}R`);
  console.log('top 5 by edge:', order.slice(0, 5).map((s) => `${s.symbol} ${s.side} ${s.edgeR}R`).join(' | '));
}

main().catch((e) => { console.error(e); process.exit(1); });
