#!/usr/bin/env node
/**
 * Build the training dataset from data/raw/*.json.
 * Feature math is imported from web/js/engine.js so training and live inference
 * cannot drift apart.
 *
 * Outputs (gitignored build artifacts):
 *   data/tmp/dataset.f32      Float32 rows x nFeatures, standardisation applied later
 *   data/tmp/dataset.csv      row,symbol,barIndex,date,yLong,yShort,atr,close
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseBars, buildFeatures, buildContext, tripleBarrier, FEATURES, WARMUP, HORIZON } from '../docs/js/engine.js';
import { UNIVERSE } from './universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const TMP = path.join(ROOT, 'data', 'tmp');
const F = FEATURES.length;

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const files = (await fs.readdir(RAW)).filter((f) => f.endsWith('.json')).sort();
  const raw = new Map();
  for (const f of files) {
    const j = JSON.parse(await fs.readFile(path.join(RAW, f), 'utf8'));
    raw.set(j.symbol, j);
  }
  const spy = raw.get('SPY'), vix = raw.get('^VIX');
  if (!spy || !vix) throw new Error('SPY and ^VIX are required to build context features');
  const ctx = buildContext({ spy, vix });

  const rows = [];       // meta rows
  const chunks = [];     // Float32Array chunks
  const classCount = { longWin: 0, longLoss: 0, longTimeout: 0, shortWin: 0, shortLoss: 0, shortTimeout: 0 };
  const perSymbol = [];

  for (const inst of UNIVERSE) {
    const j = raw.get(inst.symbol);
    if (!j) continue;
    const bars = normaliseBars(j);
    if (!bars || bars.c.length < WARMUP + HORIZON + 5) { perSymbol.push([inst.symbol, 0, 0]); continue; }
    const feats = buildFeatures({ ...bars, cls: inst.cls }, ctx);
    const flat = new Float32Array(feats.X.length * F);
    let kept = 0;
    for (let k = 0; k < feats.X.length; k++) {
      const i = feats.raw[k].i;
      const yL = tripleBarrier(bars, i, feats.atr[k], 1);
      const yS = tripleBarrier(bars, i, feats.atr[k], -1);
      if (yL === 3 || yS === 3) continue;
      flat.set(feats.X[k], kept * F);
      rows.push({ row: kept, symbol: inst.symbol, barIndex: i, date: feats.dates[k], yLong: yL, yShort: yS, atr: feats.atr[k], close: feats.close[k], cls: inst.cls });
      kept++;
      if (yL === 0) classCount.longWin++; else if (yL === 1) classCount.longLoss++; else classCount.longTimeout++;
      if (yS === 0) classCount.shortWin++; else if (yS === 1) classCount.shortLoss++; else classCount.shortTimeout++;
    }
    if (kept) chunks.push(flat.subarray(0, kept * F));
    perSymbol.push([inst.symbol, bars.c.length, kept]);
    process.stdout.write(`\r  ${inst.symbol.padEnd(9)} bars=${String(bars.c.length).padStart(5)} rows=${String(kept).padStart(5)}      `);
  }

  const total = rows.length;
  const buffer = Buffer.allocUnsafe(total * F * 4);
  let off = 0;
  for (const c of chunks) { Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(buffer, off); off += c.byteLength; }
  await fs.writeFile(path.join(TMP, 'dataset.f32'), buffer);

  const csv = ['row,symbol,barIndex,date,yLong,yShort,atr,close'];
  for (const r of rows) csv.push(`${r.row},${r.symbol},${r.barIndex},${r.date},${r.yLong},${r.yShort},${r.atr},${r.close}`);
  await fs.writeFile(path.join(TMP, 'dataset.csv'), csv.join('\n'));

  const summary = {
    builtAt: new Date().toISOString(),
    rows: total, features: FEATURES.length, horizon: HORIZON,
    dateRange: [rows[0]?.date, rows[rows.length - 1]?.date],
    classes: classCount,
    baseRates: {
      longWin: classCount.longWin / total, longLoss: classCount.longLoss / total, timeout: classCount.longTimeout / total,
      shortWin: classCount.shortWin / total,
    },
    perSymbol,
  };
  await fs.writeFile(path.join(TMP, 'dataset-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n\nrows=${total} features=${F} bytes=${(buffer.length / 1e6).toFixed(1)}MB`);
  console.log('long   win/loss/timeout %:', (100 * classCount.longWin / total).toFixed(1), (100 * classCount.longLoss / total).toFixed(1), (100 * classCount.longTimeout / total).toFixed(1));
  console.log('short  win/loss/timeout %:', (100 * classCount.shortWin / total).toFixed(1), (100 * classCount.shortLoss / total).toFixed(1), (100 * classCount.shortTimeout / total).toFixed(1));
}

main().catch((e) => { console.error(e); process.exit(1); });
