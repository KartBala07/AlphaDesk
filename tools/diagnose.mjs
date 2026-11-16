#!/usr/bin/env node
/** Diagnostic: probability distribution per fold + how many signals each gate produces. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseBars, buildFeatures, buildContext, predictHead } from '../docs/js/engine.js';
import { UNIVERSE } from './universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(await fs.readFile(path.join(ROOT, 'web/data/model.json'), 'utf8'));
const files = (await fs.readdir(path.join(ROOT, 'data/raw'))).filter((f) => f.endsWith('.json'));
const raw = new Map();
for (const f of files) { const j = JSON.parse(await fs.readFile(path.join(ROOT, 'data/raw', f), 'utf8')); raw.set(j.symbol, j); }
const ctx = buildContext({ spy: raw.get('SPY'), vix: raw.get('^VIX') });

const series = [];
for (const inst of UNIVERSE) {
  const j = raw.get(inst.symbol); if (!j) continue;
  const bars = normaliseBars(j); if (!bars || bars.c.length < 290) continue;
  series.push({ inst, bars, feats: buildFeatures({ ...bars, cls: inst.cls }, ctx) });
}

const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };

console.log('year | nRows | pWinL q10/50/90 | pLossL q50 | dirP q50/q90 | pass@0.40/0.55 (dirP>=.55) | pass@0.38 (dirP>=.48)');
for (const fold of model.folds) {
  const winsL = [], winsS = [], dirs = [];
  let pass40 = 0, pass55 = 0, pass38 = 0, n = 0;
  const year = String(fold.year);
  for (const s of series) {
    for (let k = 0; k < s.feats.X.length; k++) {
      if (s.feats.dates[k].slice(0, 4) !== year) continue;
      n++;
      const L = predictHead(s.feats.X[k], fold.heads.long, fold.mean, fold.std);
      const S = predictHead(s.feats.X[k], fold.heads.short, fold.mean, fold.std);
      const dL = L.win / Math.max(1e-9, L.win + L.loss), dS = S.win / Math.max(1e-9, S.win + S.loss);
      winsL.push(L.win); winsS.push(S.win);
      dirs.push(Math.max(dL, dS));
      if ((L.win >= 0.40 && dL >= 0.55) || (S.win >= 0.40 && dS >= 0.55)) pass40++;
      if ((L.win >= 0.55 && dL >= 0.55) || (S.win >= 0.55 && dS >= 0.55)) pass55++;
      if ((L.win >= 0.38 && dL >= 0.48 && L.win > L.loss * 0.5) || (S.win >= 0.38 && dS >= 0.48)) pass38++;
    }
  }
  console.log(`${year} | ${String(n).padStart(6)} | ${q(winsL, 0.1).toFixed(3)}/${q(winsL, 0.5).toFixed(3)}/${q(winsL, 0.9).toFixed(3)} | ${q(winsS, 0.5).toFixed(3)} | ${q(dirs, 0.5).toFixed(3)}/${q(dirs, 0.9).toFixed(3)} | ${pass40}/${pass55} | ${pass38}`);
}

// Latest bar cross-section with deployed weights
const latest = [];
for (const s of series) {
  const k = s.feats.X.length - 1;
  const L = predictHead(s.feats.X[k], model.heads.long, model.mean, model.std);
  const S = predictHead(s.feats.X[k], model.heads.short, model.mean, model.std);
  const dL = L.win / Math.max(1e-9, L.win + L.loss), dS = S.win / Math.max(1e-9, S.win + S.loss);
  const eL = 2 * L.win - L.loss, eS = 2 * S.win - S.loss;
  latest.push({ sym: s.inst.symbol, d: s.feats.dates[k], L, S, dL, dS, eL, eS });
}
console.log('\nLATEST BAR cross-section (n=' + latest.length + '):');
console.log('  dates:', [...new Set(latest.map((x) => x.d))].sort().slice(-5).join(', '));
const eL = latest.map((x) => x.eL), eS = latest.map((x) => x.eS);
console.log('  expectancy long  q10/50/90:', q(eL, 0.1).toFixed(3), q(eL, 0.5).toFixed(3), q(eL, 0.9).toFixed(3));
console.log('  expectancy short q10/50/90:', q(eS, 0.1).toFixed(3), q(eS, 0.5).toFixed(3), q(eS, 0.9).toFixed(3));
for (const gate of [0.15, 0.2, 0.25]) {
  const longs = latest.filter((x) => x.eL > gate && x.dL >= 0.5).length;
  const shorts = latest.filter((x) => x.eS > gate && x.dS >= 0.5 && x.eS > x.eL).length;
  console.log(`  gate exp>${gate} dirP>=0.5 -> ${longs} long, ${shorts} short`);
}
const top = [...latest].sort((a, b) => Math.max(b.eL, b.eS) - Math.max(a.eL, a.eS)).slice(0, 10);
console.log('  top now:', top.map((x) => `${x.sym} ${(Math.max(x.eL, x.eS)).toFixed(2)}R`).join(' | '));
