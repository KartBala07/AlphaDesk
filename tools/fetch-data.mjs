#!/usr/bin/env node
/* =============================================================================
 * AlphaDesk data fetcher — 10 years of daily OHLCV, three adapters, resumable.
 *
 *   stocks / ETFs / indexes  -> api.nasdaq.com historical (split-adjusted OHLCV)
 *   crypto                   -> api.kraken.com OHLC (paginated daily candles)
 *   ^VIX                     -> cdn.cboe.com daily VIX history CSV
 *
 * Usage:
 *   node tools/fetch-data.mjs                  # fetch everything missing
 *   node tools/fetch-data.mjs --force          # refetch everything
 *   node tools/fetch-data.mjs --only SPY,NVDA  # subset
 *   node tools/fetch-data.mjs --years 10
 * Writes data/raw/<SYMBOL>.json and data/fetch-report.json
 * ========================================================================== */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIVERSE } from './universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const YEARS = Number(argOf('--years', 10));
const FORCE = args.includes('--force');
const ONLY = argOf('--only', '') ? new Set(argOf('--only', '').split(',').map((s) => s.trim().toUpperCase())) : null;

const START = new Date(Date.now() - YEARS * 365.25 * 864e5).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sig = (x) => (Number.isFinite(x) && x > 0 ? Number(x.toPrecision(6)) : null);
const num = (s) => {
  if (typeof s === 'number') return s;
  const v = Number(String(s).replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

async function getJSON(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json,text/csv,*/*', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
async function getText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/* ------------------------------- adapters ---------------------------------- */

const NASDAQ_SYMBOL = { 'BRK-B': 'BRK.B', '^IXIC': 'COMP' };
const nasdaqClass = (cls) => (cls === 'etf' ? 'etf' : cls === 'index' ? 'index' : cls === 'crypto' ? 'crypto' : 'stocks');

async function fetchNasdaq(inst) {
  const base = inst.symbol.replace('-USD', '');
  const sym = NASDAQ_SYMBOL[inst.symbol] || (inst.cls === 'crypto' ? base : inst.symbol);
  const cls = nasdaqClass(inst.cls);
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${cls}&fromdate=${START}&limit=9999`;
  const j = await getJSON(url, { headers: { Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' } });
  const rows = j?.data?.tradesTable?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('nasdaq: no rows');
  const bars = [];
  for (const r of rows) {
    const [mm, dd, yy] = String(r.date).split('/');
    if (!yy) continue;
    const date = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    const o = num(r.open), h = num(r.high), l = num(r.low), c = num(r.close), v = num(r.volume) ?? 0;
    if (![o, h, l, c].every((x) => x !== null && x > 0)) continue;
    bars.push([date, sig(o), sig(h), sig(l), sig(c), Math.round(v)]);
  }
  bars.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { bars, source: 'nasdaq-historical' };
}

const KRAKEN_PAIR = { 'BTC-USD': 'XBTUSD', 'ETH-USD': 'ETHUSD', 'SOL-USD': 'SOLUSD', 'XRP-USD': 'XRPUSD', 'ADA-USD': 'ADAUSD', 'DOGE-USD': 'DOGEUSD', 'AVAX-USD': 'AVAXUSD', 'LINK-USD': 'LINKUSD', 'DOT-USD': 'DOTUSD', 'LTC-USD': 'LTCUSD' };

async function fetchKraken(inst) {
  const pair = KRAKEN_PAIR[inst.symbol] || `${inst.symbol.replace('-USD', '')}USD`;
  const startTs = Math.floor(new Date(START).getTime() / 1000);
  const byDate = new Map();
  let since = startTs;
  for (let page = 0; page < 10; page++) {
    const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440&since=${since}`);
    if (j.error?.length) throw new Error(`kraken: ${j.error[0]}`);
    const key = Object.keys(j.result || {}).find((k) => k !== 'last');
    const rows = j.result?.[key] || [];
    if (!rows.length) break;
    for (const r of rows) {
      const date = new Date(r[0] * 1000).toISOString().slice(0, 10);
      const o = +r[1], h = +r[2], l = +r[3], c = +r[4], v = +r[6];
      if (![o, h, l, c].every((x) => x > 0)) continue;
      byDate.set(date, [date, sig(o), sig(h), sig(l), sig(c), Math.round(v)]);
    }
    const last = j.result.last;
    if (!last || Number(last) <= since / 1000) break;
    since = Number(last);
    if (rows.length && new Date(rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10) >= new Date().toISOString().slice(0, 10)) break;
    await sleep(400);
  }
  const bars = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!bars.length) throw new Error('kraken: no rows');
  return { bars, source: 'kraken-ohlc' };
}

async function fetchCboeVix(inst) {
  const txt = await getText('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv');
  const lines = txt.trim().split(/\r?\n/);
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 5) continue;
    const [mm, dd, yy] = p[0].split('/');
    const date = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    if (date < START) continue;
    const o = +p[1], h = +p[2], l = +p[3], c = +p[4];
    if (![o, h, l, c].every((x) => x > 0)) continue;
    bars.push([date, sig(o), sig(h), sig(l), sig(c), 0]);
  }
  if (!bars.length) throw new Error('cboe: no rows');
  return { bars, source: 'cboe-vix-history' };
}

async function fetchCrypto(inst) {
  // Nasdaq keeps ~7 years of daily crypto; Kraken only ~720 days. Prefer Nasdaq,
  // fall back to Kraken for pairs Nasdaq does not carry (SOL, LINK, AVAX, DOT).
  try {
    const r = await fetchNasdaq(inst);
    if (r.bars.length >= 400) return r;
  } catch { /* fall through to Kraken */ }
  return fetchKraken(inst);
}

function adapterFor(inst) {
  if (inst.symbol === '^VIX') return fetchCboeVix;
  if (inst.cls === 'crypto') return fetchCrypto;
  return fetchNasdaq;
}

/* --------------------------------- runner ---------------------------------- */

async function fetchWithRetry(inst) {
  const fn = adapterFor(inst);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(inst); }
    catch (e) {
      lastErr = e;
      await sleep(800 * attempt + Math.random() * 500);
    }
  }
  throw lastErr;
}

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  const list = UNIVERSE.filter((u) => !ONLY || ONLY.has(u.symbol));
  const t0 = Date.now();
  const failed = [];
  const report = { startedAt: new Date().toISOString(), range: START, ok: 0, skipped: 0, failed };

  for (let i = 0; i < list.length; i++) {
    const inst = list[i];
    const file = path.join(RAW, `${inst.symbol.replace(/[^\w.-]/g, '_')}.json`);
    if (!FORCE) {
      try {
        const existing = JSON.parse(await fs.readFile(file, 'utf8'));
        if (existing.count >= 250 && existing.last >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) {
          report.skipped++;
          process.stdout.write(`\r  [${i + 1}/${list.length}] ${inst.symbol} cached (${existing.count} bars)          `);
          continue;
        }
      } catch { /* not cached */ }
    }
    try {
      const { bars, source } = await fetchWithRetry(inst);
      const out = {
        symbol: inst.symbol, name: inst.name, cls: inst.cls, sector: inst.sector, group: inst.group,
        source, interval: '1d', fetched: new Date().toISOString().slice(0, 10),
        first: bars[0][0], last: bars[bars.length - 1][0], count: bars.length, bars,
      };
      await fs.writeFile(file, JSON.stringify(out));
      report.ok++;
      process.stdout.write(`\r  [${i + 1}/${list.length}] ${inst.symbol.padEnd(9)} ${String(bars.length).padStart(5)} bars ${bars[0][0]} -> ${bars[bars.length - 1][0]}          `);
    } catch (e) {
      failed.push(`${inst.symbol}: ${e.message}`);
      process.stdout.write(`\r  FAIL ${inst.symbol}: ${e.message}\n`);
    }
    await sleep(320 + Math.random() * 250);
  }

  report.seconds = Math.round((Date.now() - t0) / 1000);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(ROOT, 'data', 'fetch-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n\nDONE ok=${report.ok} cached=${report.skipped} failed=${failed.length} in ${report.seconds}s`);
  if (failed.length) console.log('FAILURES:\n  ' + failed.join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
