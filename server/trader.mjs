#!/usr/bin/env node
/**
 * Paper execution engine.
 *
 * The model produces a side, an entry, a stop and a target. This module turns
 * those into bracket orders against a simulated account, keeps the book, and
 * enforces the limits that stop a bad day from becoming a bad month.
 *
 * It is deliberately NOT connected to a live broker. `placeOrder()` in the
 * Alpaca adapter below is the only code that could touch real money and it is
 * unused unless ALPACA_KEY_ID / ALPACA_SECRET are set AND you call it yourself.
 *
 * Every fill is stamped with the date of the signal snapshot it came from, so
 * the forward record is auditable rather than a backtest dressed up as live.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const BARS = path.join(DATA, 'bars');

const DEFAULTS = {
  startEquity: 100_000,
  riskPct: 1,            // % of equity risked per trade
  maxPositions: 5,
  maxNotionalPct: 25,    // max % of equity in one position
  maxDailyLossPct: 3,    // auto-disable past this
  minEdgeR: 0.10,        // must clear the model's gate
  cooldownDays: 1,
};

/* ------------------------------- data access ------------------------------ */

let cache = { signals: null, universe: null, model: null, at: 0, bars: new Map() };

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadSignals() {
  const t = Date.now();
  if (!cache.signals || t - cache.at > 5 * 60_000) {
    cache.signals = readJSON(path.join(DATA, 'signals.json'));
    cache.universe = readJSON(path.join(DATA, 'universe.json'));
    cache.model = readJSON(path.join(DATA, 'model.json'));
    cache.at = t;
  }
  return { signals: cache.signals, universe: cache.universe, model: cache.model };
}

function readBars(symbol) {
  if (cache.bars.has(symbol)) return cache.bars.get(symbol);
  const uni = cache.universe || loadSignals().universe;
  const row = uni.find((u) => u.symbol === symbol);
  const file = path.join(BARS, row?.barsFile || `${symbol}.json`);
  let out = null;
  try {
    const j = readJSON(file);
    const n = j.bars.length;
    const last = j.bars[n - 1];
    out = { date: last[0], o: last[1], h: last[2], l: last[3], c: last[4], v: last[5] };
  } catch { out = null; }
  cache.bars.set(symbol, out);
  return out;
}

const snapshotDate = () => (loadSignals().signals[0]?.date) || new Date().toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const round = (x, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const uuid = () => crypto.randomUUID();

/* --------------------------------- schema --------------------------------- */

export function ensureTables(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS trader_account (
    user_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    equity REAL NOT NULL,
    start_equity REAL NOT NULL,
    day_start_equity REAL NOT NULL,
    day TEXT NOT NULL,
    risk_pct REAL NOT NULL,
    max_positions INTEGER NOT NULL,
    max_notional_pct REAL NOT NULL,
    max_daily_loss_pct REAL NOT NULL,
    cooldown_days INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS trader_positions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    entry REAL NOT NULL,
    stop REAL NOT NULL,
    target REAL NOT NULL,
    risk_cash REAL NOT NULL,
    edge_r REAL,
    source TEXT,
    signal_date TEXT,
    opened_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    exit_price REAL,
    closed_at TEXT,
    exit_reason TEXT,
    r_multiple REAL,
    pnl REAL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trader_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    position_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    type TEXT NOT NULL,
    limit_price REAL,
    stop_price REAL,
    target_price REAL,
    status TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trader_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    candidates INTEGER,
    opened INTEGER,
    skipped INTEGER,
    closed INTEGER,
    equity REAL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pos_user ON trader_positions(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_runs_user ON trader_runs(user_id, started_at);
  `);
}

/* -------------------------------- account -------------------------------- */

function ensureAccount(db, userId) {
  const row = db.prepare('SELECT * FROM trader_account WHERE user_id = ?').get(userId);
  if (row) return row;
  const t = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO trader_account
    (user_id, enabled, equity, start_equity, day_start_equity, day, risk_pct, max_positions,
     max_notional_pct, max_daily_loss_pct, cooldown_days, created_at, updated_at, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(userId, 0, DEFAULTS.startEquity, DEFAULTS.startEquity, DEFAULTS.startEquity, today(),
      DEFAULTS.riskPct, DEFAULTS.maxPositions, DEFAULTS.maxNotionalPct, DEFAULTS.maxDailyLossPct,
      DEFAULTS.cooldownDays, t, t, 'paper account created');
  return db.prepare('SELECT * FROM trader_account WHERE user_id = ?').get(userId);
}

/** Roll the daily baseline so the loss guard is per-session. */
function rollDay(db, acct) {
  if (acct.day === today()) return acct;
  const equity = currentEquity(db, acct.user_id);
  db.prepare('UPDATE trader_account SET day = ?, day_start_equity = ?, updated_at = ? WHERE user_id = ?')
    .run(today(), equity, Math.floor(Date.now() / 1000), acct.user_id);
  return db.prepare('SELECT * FROM trader_account WHERE user_id = ?').get(acct.user_id);
}

function marketPrice(symbol) {
  const b = readBars(symbol);
  return b ? b.c : null;
}

function realizedPnL(db, userId) {
  const r = db.prepare("SELECT COALESCE(SUM(pnl), 0) AS p FROM trader_positions WHERE user_id = ? AND status = 'closed'").get(userId);
  return r?.p || 0;
}

function currentEquity(db, userId) {
  const acct = db.prepare('SELECT * FROM trader_account WHERE user_id = ?').get(userId);
  if (!acct) return DEFAULTS.startEquity;
  const open = db.prepare("SELECT * FROM trader_positions WHERE user_id = ? AND status = 'open'").all(userId);
  let unreal = 0;
  for (const p of open) {
    const px = marketPrice(p.symbol);
    if (px == null) continue;
    unreal += (p.side === 'long' ? px - p.entry : p.entry - px) * p.qty;
  }
  return acct.start_equity + realizedPnL(db, userId) + unreal;
}

/* -------------------------------- strategy -------------------------------- */

function candidates(db, userId, acct) {
  const { signals } = loadSignals();
  const open = new Set(db.prepare("SELECT symbol FROM trader_positions WHERE user_id = ? AND status = 'open'").all(userId).map((r) => r.symbol));
  const cooldown = new Set(db.prepare(
    `SELECT symbol FROM trader_positions WHERE user_id = ? AND opened_at >= date('now', ?)`)
    .all(userId, `-${Math.max(0, acct.cooldown_days)} day`).map((r) => r.symbol));

  return signals
    .filter((s) => s.side !== 'flat')
    .filter((s) => (s.edgeR ?? 0) >= acct.risk_pct * 0 + DEFAULTS.minEdgeR)
    .filter((s) => Number.isFinite(s.stop) && Number.isFinite(s.target) && s.stop > 0 && s.target > 0)
    .filter((s) => !open.has(s.symbol) && !cooldown.has(s.symbol))
    .sort((a, b) => b.edgeR - a.edgeR);
}

function sizePosition(acct, equity, price, stop) {
  const riskCash = equity * (acct.risk_pct / 100);
  const perShare = Math.abs(price - stop);
  if (!(perShare > 0)) return null;
  let qty = Math.floor(riskCash / perShare);
  const cap = equity * (acct.max_notional_pct / 100);
  if (qty * price > cap) qty = Math.floor(cap / price);
  if (qty < 1) return null;
  return { qty, riskCash: qty * perShare };
}

/** Close anything that traded through its stop or target on the latest bar. */
function settlePositions(db, userId) {
  const open = db.prepare("SELECT * FROM trader_positions WHERE user_id = ? AND status = 'open'").all(userId);
  let closed = 0;
  for (const p of open) {
    const b = readBars(p.symbol);
    if (!b) continue;
    let exit = null, reason = null;
    if (p.side === 'long') {
      if (b.l <= p.stop) { exit = p.stop; reason = 'stop'; }
      else if (b.h >= p.target) { exit = p.target; reason = 'target'; }
    } else {
      if (b.h >= p.stop) { exit = p.stop; reason = 'stop'; }
      else if (b.l <= p.target) { exit = p.target; reason = 'target'; }
    }
    if (exit == null) continue;
    const pnl = (p.side === 'long' ? exit - p.entry : p.entry - exit) * p.qty;
    const rMult = p.risk_cash ? pnl / p.risk_cash : 0;
    db.prepare(`UPDATE trader_positions SET status='closed', exit_price=?, closed_at=?, exit_reason=?, r_multiple=?, pnl=? WHERE id=?`)
      .run(round(exit), b.date, reason, round(rMult, 3), round(pnl, 2), p.id);
    db.prepare('INSERT INTO trader_orders (id, user_id, position_id, symbol, side, qty, type, limit_price, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(uuid(), userId, p.id, p.symbol, p.side === 'long' ? 'sell' : 'buy', p.qty, 'market', round(exit), 'filled', `exit: ${reason}`, Math.floor(Date.now() / 1000));
    closed++;
  }
  return closed;
}

/**
 * One full cycle: settle exits, then open the best available candidates.
 * @returns {{opened:number, closed:number, skipped:number, candidates:number}}
 */
export function runCycle(db, userId, { dryRun = false } = {}) {
  ensureTables(db);
  let acct = rollDay(db, ensureAccount(db, userId));
  const runId = uuid();
  const t = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO trader_runs (id, user_id, started_at) VALUES (?,?,?)').run(runId, userId, t);

  const closed = settlePositions(db, userId);
  let equity = currentEquity(db, userId);

  // daily loss guard
  const dayLossPct = acct.day_start_equity ? ((acct.day_start_equity - equity) / acct.day_start_equity) * 100 : 0;
  if (dayLossPct >= acct.max_daily_loss_pct && acct.enabled) {
    db.prepare("UPDATE trader_account SET enabled = 0, note = ?, updated_at = ? WHERE user_id = ?")
      .run(`auto-disabled: daily loss ${dayLossPct.toFixed(2)}% hit the ${acct.max_daily_loss_pct}% limit`, t, userId);
    acct = db.prepare('SELECT * FROM trader_account WHERE user_id = ?').get(userId);
  }

  const cands = candidates(db, userId, acct);
  const openCount = db.prepare("SELECT COUNT(*) AS n FROM trader_positions WHERE user_id = ? AND status = 'open'").get(userId).n;
  const slots = Math.max(0, acct.max_positions - openCount);
  let opened = 0, skipped = 0;

  if (acct.enabled && slots > 0) {
    for (const c of cands) {
      if (opened >= slots) break;
      const px = c.price;
      const size = sizePosition(acct, equity, px, c.stop);
      if (!size) { skipped++; continue; }
      const id = uuid();
      const sd = c.date || snapshotDate();
      if (!dryRun) {
        db.prepare(`INSERT INTO trader_positions
          (id, user_id, symbol, side, qty, entry, stop, target, risk_cash, edge_r, source, signal_date, opened_at, status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, userId, c.symbol, c.side, size.qty, px, c.stop, c.target, round(size.riskCash, 2),
            c.edgeR ?? null, 'snapshot', sd, sd, 'open', t);
        db.prepare(`INSERT INTO trader_orders (id, user_id, position_id, symbol, side, qty, type, limit_price, stop_price, target_price, status, note, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(uuid(), userId, id, c.symbol, c.side === 'long' ? 'buy' : 'sell', size.qty, 'bracket',
            px, c.stop, c.target, 'filled', `entry on ${sd} close; stop ${c.stop}; target ${c.target}`, t);
      }
      opened++;
    }
  } else if (!acct.enabled) {
    skipped = cands.length;
  }

  equity = currentEquity(db, userId);
  db.prepare('UPDATE trader_runs SET finished_at=?, candidates=?, opened=?, skipped=?, closed=?, equity=?, note=? WHERE id=?')
    .run(Math.floor(Date.now() / 1000), cands.length, opened, skipped, closed, round(equity, 2),
      acct.enabled ? null : 'engine disabled — no new entries', runId);

  return { opened, closed, skipped, candidates: cands.length, equity: round(equity, 2), enabled: !!acct.enabled, runId, dryRun };
}

/* -------------------------------- reporting ------------------------------- */

export function getStatus(db, userId) {
  ensureTables(db);
  const acct = rollDay(db, ensureAccount(db, userId));
  const positions = db.prepare("SELECT * FROM trader_positions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC").all(userId);
  const closed = db.prepare("SELECT * FROM trader_positions WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 50").all(userId);
  const runs = db.prepare('SELECT * FROM trader_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 15').all(userId);
  const equity = currentEquity(db, userId);

  const marked = positions.map((p) => {
    const px = marketPrice(p.symbol) ?? p.entry;
    const pnl = (p.side === 'long' ? px - p.entry : p.entry - px) * p.qty;
    return { ...p, mark: round(px), unrealized: round(pnl, 2), r: p.risk_cash ? round(pnl / p.risk_cash, 2) : 0 };
  });

  const realized = realizedPnL(db, userId);
  const wins = closed.filter((c) => (c.pnl || 0) > 0).length;
  return {
    enabled: !!acct.enabled,
    equity: round(equity, 2),
    startEquity: acct.start_equity,
    realized: round(realized, 2),
    returnPct: round(((equity / acct.start_equity) - 1) * 100, 2),
    openCount: positions.length,
    closedCount: closed.length,
    winRate: closed.length ? round(wins / closed.length, 3) : null,
    avgR: closed.length ? round(closed.reduce((s, c) => s + (c.r_multiple || 0), 0) / closed.length, 3) : null,
    positions: marked,
    closed,
    runs,
    settings: {
      riskPct: acct.risk_pct, maxPositions: acct.max_positions, maxNotionalPct: acct.max_notional_pct,
      maxDailyLossPct: acct.max_daily_loss_pct, cooldownDays: acct.cooldown_days, minEdgeR: DEFAULTS.minEdgeR,
    },
    note: acct.note,
    snapshotDate: snapshotDate(),
    today: today(),
    paper: true,
  };
}

export function setEnabled(db, userId, enabled) {
  ensureTables(db);
  const acct = ensureAccount(db, userId);
  const t = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE trader_account SET enabled = ?, note = ?, updated_at = ? WHERE user_id = ?')
    .run(enabled ? 1 : 0, enabled ? 'enabled by user' : 'disabled by user', t, userId);
  return getStatus(db, userId);
}

export function setConfig(db, userId, patch) {
  ensureTables(db);
  const acct = ensureAccount(db, userId);
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const riskPct = Math.max(0.1, Math.min(5, num(patch.riskPct, acct.risk_pct)));
  const maxPositions = Math.max(1, Math.min(20, Math.round(num(patch.maxPositions, acct.max_positions))));
  const maxNotionalPct = Math.max(5, Math.min(100, num(patch.maxNotionalPct, acct.max_notional_pct)));
  const maxDailyLossPct = Math.max(0.5, Math.min(20, num(patch.maxDailyLossPct, acct.max_daily_loss_pct)));
  const cooldownDays = Math.max(0, Math.min(10, Math.round(num(patch.cooldownDays, acct.cooldown_days))));
  db.prepare(`UPDATE trader_account SET risk_pct=?, max_positions=?, max_notional_pct=?, max_daily_loss_pct=?, cooldown_days=?, updated_at=? WHERE user_id=?`)
    .run(riskPct, maxPositions, maxNotionalPct, maxDailyLossPct, cooldownDays, Math.floor(Date.now() / 1000), userId);
  return getStatus(db, userId);
}

export function closePosition(db, userId, id) {
  const p = db.prepare('SELECT * FROM trader_positions WHERE id = ? AND user_id = ? AND status = ?').get(id, userId, 'open');
  if (!p) return null;
  const px = marketPrice(p.symbol) ?? p.entry;
  const pnl = (p.side === 'long' ? px - p.entry : p.entry - px) * p.qty;
  db.prepare(`UPDATE trader_positions SET status='closed', exit_price=?, closed_at=?, exit_reason=?, r_multiple=?, pnl=? WHERE id=?`)
    .run(round(px), today(), 'manual', round(p.risk_cash ? pnl / p.risk_cash : 0, 3), round(pnl, 2), id);
  return getStatus(db, userId);
}

export function resetAccount(db, userId) {
  ensureTables(db);
  db.prepare('DELETE FROM trader_positions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM trader_orders WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM trader_runs WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM trader_account WHERE user_id = ?').run(userId);
  return getStatus(db, userId);
}

/* --------------------------- live broker adapter -------------------------- */

/**
 * Alpaca paper-trading adapter. Official API, free, no scraping.
 *
 * Not exercised by this build: there are no keys on this machine, and I will
 * not place orders with credentials found on disk. Set ALPACA_KEY_ID and
 * ALPACA_SECRET (paper keys from app.alpaca.markets) and call this explicitly.
 *
 * @param {{symbol:string, side:'long'|'short', qty:number, entry:number, stop:number, target:number}} order
 */
export async function placeAlpacaBracket(order) {
  const key = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET;
  const base = process.env.ALPACA_BASE || 'https://paper-api.alpaca.markets';
  if (!key || !secret) throw new Error('ALPACA_KEY_ID / ALPACA_SECRET are not set — staying in paper mode.');
  if (!String(base).includes('paper-api')) throw new Error('Refusing to send orders to a non-paper Alpaca endpoint.');

  const body = {
    symbol: order.symbol,
    qty: String(Math.floor(order.qty)),
    side: order.side === 'long' ? 'buy' : 'sell',
    type: 'limit',
    time_in_force: 'day',
    limit_price: String(round(order.entry, 2)),
    order_class: 'bracket',
    take_profit: { limit_price: String(round(order.target, 2)) },
    stop_loss: { stop_price: String(round(order.stop, 2)) },
  };
  const res = await fetch(`${base}/v2/orders`, {
    method: 'POST',
    headers: {
      'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${json.message || 'order rejected'}`);
  return json;
}

export const TRADER_DEFAULTS = DEFAULTS;
