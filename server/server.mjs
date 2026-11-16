#!/usr/bin/env node
/**
 * AlphaDesk API — accounts, sessions, and the trade journal.
 *
 * Zero dependencies: node:sqlite for storage, node:crypto for passwords.
 *
 *   node server/server.mjs                 # http://127.0.0.1:8789
 *   PORT=8789 COOKIE_SECURE=true ALLOWED_ORIGINS=https://you.github.io node server/server.mjs
 *
 * Security posture (what it does, and what it cannot promise):
 *   · passwords hashed with scrypt (N=32768, r=8, p=1), 16-byte per-user salt
 *   · opaque 256-bit session tokens, stored only as SHA-256 digests, in an
 *     HttpOnly + SameSite=Lax cookie (Secure when COOKIE_SECURE=true)
 *   · double-submit CSRF token required on every state-changing request
 *   · per-IP rate limits, per-account lockout after repeated failures,
 *     uniform error messages so accounts cannot be enumerated by timing
 *   · parameterised SQL everywhere, strict input validation, 32 KB body cap
 *   · CSP/deny-framing/nosniff/HSTS headers on every response
 *   · append-only audit trail for auth events and journal changes
 *
 * None of that makes a system "unhackable" — it removes the cheap attacks
 * (credential stuffing, session theft via JS, CSRF, SQL injection). The rest is
 * operational: keep the box patched, terminate TLS at the edge, back up the DB,
 * and never commit the data directory.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { ensureTables as ensureTraderTables, getStatus as traderStatus, setEnabled as traderEnable, setConfig as traderConfig, runCycle as traderRun, closePosition as traderClose, placeManualOrder as traderOrder, resetAccount as traderReset } from './trader.mjs';

const scrypt = promisify(crypto.scrypt);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'server', 'data');
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const SESSION_DAYS = 30;
const BODY_LIMIT = 32 * 1024;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://kartbala07.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'alphadesk.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry REAL NOT NULL,
  stop REAL,
  target REAL,
  opened_at TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT,
  ip TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_user ON journal(user_id, status);
`);

ensureTraderTables(db);

/* -------------------------------- helpers -------------------------------- */

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (bytes = 32) => b64url(crypto.randomBytes(bytes));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-^]{0,11}$/;

function sanitizeEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}
function checkPassword(v) {
  const p = String(v || '');
  if (p.length < 10) return 'Password must be at least 10 characters.';
  if (p.length > 200) return 'Password must be 200 characters or fewer.';
  if (/^\s+$/.test(p)) return 'Password cannot be only whitespace.';
  return null;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash: key.toString('hex'), salt: salt.toString('hex') };
}
/** Constant-ish work for unknown accounts, so login timing does not leak existence. */
const DUMMY = { hash: '0'.repeat(128), salt: '0'.repeat(32) };

function audit(event, userId, ip, detail) {
  try {
    db.prepare('INSERT INTO audit (ts, event, user_id, ip, detail) VALUES (?,?,?,?,?)')
      .run(now(), event, userId || null, ip || null, detail ? String(detail).slice(0, 300) : null);
  } catch { /* auditing must never break a request */ }
}

/* ------------------------------ rate limits ------------------------------ */

const buckets = new Map();
function rateLimit(key, limit, windowSec) {
  const t = now();
  const b = buckets.get(key);
  if (!b || b.reset <= t) { buckets.set(key, { count: 1, reset: t + windowSec }); return true; }
  b.count += 1;
  return b.count <= limit;
}
setInterval(() => {
  const t = now();
  for (const [k, v] of buckets) if (v.reset <= t) buckets.delete(k);
}, 60_000).unref?.();

/* -------------------------------- responses ------------------------------- */

function originAllowed(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function baseHeaders(origin) {
  const allow = originAllowed(origin);
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
  if (COOKIE_SECURE) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (allow) {
    h['Access-Control-Allow-Origin'] = allow;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-CSRF-Token';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
    h.Vary = 'Origin';
  }
  return h;
}

function send(res, status, payload, origin, extraHeaders = {}) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, { ...baseHeaders(origin), 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge = SESSION_DAYS * 86400, httpOnly = true } = {}) {
  const sameSite = COOKIE_SECURE ? 'None' : 'Lax';   // None requires Secure; Lax is right for same-site dev
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`, `Max-Age=${maxAge}`];
  if (httpOnly) bits.push('HttpOnly');
  if (COOKIE_SECURE) bits.push('Secure');
  return bits.join('; ');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
  .toString().split(',')[0].trim();

/* -------------------------------- sessions -------------------------------- */

function createSession(userId, req) {
  const raw = token(32);
  const id = sha256(raw);
  const t = now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?)')
    .run(id, userId, t, t + SESSION_DAYS * 86400, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  return raw;
}

function currentUser(req) {
  const raw = parseCookies(req).ads_session;
  if (!raw) return null;
  const row = db.prepare(`SELECT s.id AS sid, s.expires_at, u.id, u.email, u.created_at
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sha256(raw));
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
    return null;
  }
  return { id: row.id, email: row.email, created_at: row.created_at, sessionId: row.sid };
}

function requireUser(req, res, origin) {
  const user = currentUser(req);
  if (!user) send(res, 401, { ok: false, error: 'Sign in to continue.' }, origin);
  return user;
}

/* ---------------------------------- CSRF ---------------------------------- */

function csrfGuard(req, res, origin, cookies) {
  const cookieToken = cookies.ads_csrf;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length
      || !crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
    send(res, 403, { ok: false, error: 'CSRF token missing or invalid. Reload the page.' }, origin);
    return false;
  }
  return true;
}


/* ------------------------------ static site ------------------------------- */

const WEB_ROOT = path.join(ROOT, 'docs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://api.gdeltproject.org https://api.coingecko.com https://api.twelvedata.com https://api.openai.com https://api.anthropic.com https://generativelanguage.googleapis.com http://127.0.0.1:8788 http://localhost:8788",
  "font-src 'self' data:",
  /* The chart window embeds TradingView's official widget. Their full app sets
     frame-ancestors 'none', the widget is the embeddable surface. */
  "frame-src 'self' https://s.tradingview.com https://*.tradingview.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(WEB_ROOT, rel));
  if (!target.startsWith(WEB_ROOT)) {           // traversal guard
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden');
  }
  fs.stat(target, (err, st) => {
    const notFound = err || !st.isFile();
    const file = notFound && !path.extname(rel) ? path.join(WEB_ROOT, 'index.html') : target;
    fs.readFile(file, (e2, buf) => {
      if (e2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': SITE_CSP,
        'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
        ...(COOKIE_SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
        // No build step, so code must revalidate: a 5-minute max-age served stale
        // JS after every edit during development.
        'Cache-Control': ['.html', '.js', '.mjs', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(buf);
    });
  });
}

/* --------------------------------- routes --------------------------------- */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const ip = clientIp(req);
  const cookies = parseCookies(req);

  if (method === 'OPTIONS') {
    res.writeHead(204, baseHeaders(origin));
    return res.end();
  }
  if (origin && !originAllowed(origin)) {
    return send(res, 403, { ok: false, error: 'Origin not allowed.' }, null);
  }

  if (!route.startsWith('/api')) return serveStatic(req, res, url);

  try {
    /* ------------------------------ public ------------------------------ */
    if (route === '/api/health') {
      return send(res, 200, { ok: true, service: 'alphadesk-api', time: new Date().toISOString(), secureCookies: COOKIE_SECURE }, origin);
    }

    if (route === '/api/csrf') {
      const t = token(24);
      return send(res, 200, { ok: true, csrfToken: t }, origin, {
        'Set-Cookie': cookie('ads_csrf', t, { httpOnly: false, maxAge: 86400 }),
      });
    }

    if (route === '/api/auth/register' && method === 'POST') {
      if (!rateLimit(`reg:${ip}`, 8, 3600)) return send(res, 429, { ok: false, error: 'Too many attempts. Try again later.' }, origin);
      if (!csrfGuard(req, res, origin, cookies)) return;
      const body = await readBody(req);
      const email = sanitizeEmail(body.email);
      const pwErr = checkPassword(body.password);
      if (!email) return send(res, 400, { ok: false, error: 'Enter a valid email address.' }, origin);
      if (pwErr) return send(res, 400, { ok: false, error: pwErr }, origin);

      const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (exists) {
        audit('register_conflict', null, ip, email);
        return send(res, 409, { ok: false, error: 'That email is already registered.' }, origin);
      }
      const { hash, salt } = await hashPassword(String(body.password));
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, created_at) VALUES (?,?,?,?,?)')
        .run(id, email, hash, salt, now());
      const raw = createSession(id, req);
      audit('register', id, ip, email);
      return send(res, 200, { ok: true, user: { id, email } }, origin, {
        'Set-Cookie': [cookie('ads_session', raw), cookie('ads_csrf', cookies.ads_csrf || token(24), { httpOnly: false, maxAge: 86400 })],
      });
    }

    if (route === '/api/auth/login' && method === 'POST') {
      if (!rateLimit(`login:${ip}`, 20, 600)) return send(res, 429, { ok: false, error: 'Too many attempts. Try again in a few minutes.' }, origin);
      if (!csrfGuard(req, res, origin, cookies)) return;
      const body = await readBody(req);
      const email = sanitizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || !password) return send(res, 400, { ok: false, error: 'Email and password are required.' }, origin);

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user) {
        await hashPassword(password, DUMMY.salt);          // equalise timing
        audit('login_failed', null, ip, 'no such account');
        return send(res, 401, { ok: false, error: 'Invalid email or password.' }, origin);
      }
      if (user.locked_until > now()) {
        audit('login_locked', user.id, ip, null);
        return send(res, 423, { ok: false, error: 'Account temporarily locked after repeated failures.' }, origin);
      }
      const attempt = await hashPassword(password, user.pw_salt);
      const same = attempt.hash.length === user.pw_hash.length
        && crypto.timingSafeEqual(Buffer.from(attempt.hash, 'hex'), Buffer.from(user.pw_hash, 'hex'));
      if (!same) {
        const failed = user.failed_count + 1;
        const lock = failed >= 8 ? now() + 900 : 0;
        db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?').run(failed, lock, user.id);
        audit('login_failed', user.id, ip, `${failed} failures${lock ? ' — locked 15m' : ''}`);
        return send(res, 401, { ok: false, error: 'Invalid email or password.' }, origin);
      }
      db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').run(user.id);
      const raw = createSession(user.id, req);
      audit('login', user.id, ip, null);
      return send(res, 200, { ok: true, user: { id: user.id, email: user.email } }, origin, {
        'Set-Cookie': [cookie('ads_session', raw), cookie('ads_csrf', cookies.ads_csrf || token(24), { httpOnly: false, maxAge: 86400 })],
      });
    }

    if (route === '/api/auth/logout' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const raw = cookies.ads_session;
      if (raw) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(raw));
      audit('logout', null, ip, null);
      return send(res, 200, { ok: true }, origin, {
        'Set-Cookie': [cookie('ads_session', '', { maxAge: 0 }), cookie('ads_csrf', '', { httpOnly: false, maxAge: 0 })],
      });
    }

    if (route === '/api/auth/me') {
      const user = currentUser(req);
      if (!user) return send(res, 200, { ok: true, user: null }, origin);
      const count = db.prepare("SELECT COUNT(*) AS n FROM journal WHERE user_id = ? AND status = 'open'").get(user.id);
      return send(res, 200, { ok: true, user: { id: user.id, email: user.email, created_at: user.created_at }, openFills: count.n }, origin);
    }

    if (route === '/api/auth/password' && method === 'POST') {
      if (!rateLimit(`pw:${ip}`, 10, 3600)) return send(res, 429, { ok: false, error: 'Too many attempts.' }, origin);
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      const body = await readBody(req);
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      const attempt = await hashPassword(String(body.current || ''), row.pw_salt);
      const same = attempt.hash.length === row.pw_hash.length
        && crypto.timingSafeEqual(Buffer.from(attempt.hash, 'hex'), Buffer.from(row.pw_hash, 'hex'));
      if (!same) { audit('password_change_failed', user.id, ip, null); return send(res, 401, { ok: false, error: 'Current password is wrong.' }, origin); }
      const pwErr = checkPassword(body.next);
      if (pwErr) return send(res, 400, { ok: false, error: pwErr }, origin);
      const { hash, salt } = await hashPassword(String(body.next));
      db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);   // sign out everywhere
      audit('password_changed', user.id, ip, null);
      return send(res, 200, { ok: true, error: null, signedOut: true }, origin, {
        'Set-Cookie': [cookie('ads_session', '', { maxAge: 0 })],
      });
    }

    /* -------------------------------- trader ------------------------------ */
    if (route === '/api/trader' && method === 'GET') {
      const user = requireUser(req, res, origin);
      if (!user) return;
      return send(res, 200, { ok: true, ...traderStatus(db, user.id) }, origin);
    }

    if (route === '/api/trader/enable' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      const body = await readBody(req);
      const on = !!body.enabled;
      audit(on ? 'trader_enabled' : 'trader_disabled', user.id, ip, null);
      return send(res, 200, { ok: true, ...traderEnable(db, user.id, on) }, origin);
    }

    if (route === '/api/trader/config' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      const body = await readBody(req);
      audit('trader_config', user.id, ip, JSON.stringify(body).slice(0, 200));
      return send(res, 200, { ok: true, ...traderConfig(db, user.id, body) }, origin);
    }

    if (route === '/api/trader/run' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      if (!rateLimit(`traderrun:${user.id}`, 30, 3600)) return send(res, 429, { ok: false, error: 'Too many run requests.' }, origin);
      const result = traderRun(db, user.id);
      audit('trader_run', user.id, ip, JSON.stringify(result).slice(0, 200));
      return send(res, 200, { ok: true, result, ...traderStatus(db, user.id) }, origin);
    }

    if (route === '/api/trader/order' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      if (!rateLimit(`traderorder:${user.id}`, 60, 3600)) return send(res, 429, { ok: false, error: 'Too many orders.' }, origin);
      const body = await readBody(req);
      try {
        const result = traderOrder(db, user.id, { symbol: body.symbol, side: body.side });
        audit('trader_manual_order', user.id, ip, `${body.symbol}:${result.side}x${result.qty}`);
        return send(res, 200, { ok: true, result }, origin);
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message }, origin);
      }
    }

    if (route === '/api/trader/reset' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      audit('trader_reset', user.id, ip, null);
      return send(res, 200, { ok: true, ...traderReset(db, user.id) }, origin);
    }

    const tclose = route.match(/^\/api\/trader\/close\/([0-9a-fA-F-]{36})$/);
    if (tclose && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      const next = traderClose(db, user.id, tclose[1]);
      if (!next) return send(res, 404, { ok: false, error: 'Position not found.' }, origin);
      audit('trader_manual_close', user.id, ip, tclose[1]);
      return send(res, 200, { ok: true, ...next }, origin);
    }

    /* ------------------------------- journal ------------------------------ */
    if (route === '/api/journal' && method === 'GET') {
      const user = requireUser(req, res, origin);
      if (!user) return;
      const rows = db.prepare('SELECT * FROM journal WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(user.id);
      return send(res, 200, { ok: true, fills: rows }, origin);
    }

    if (route === '/api/journal' && method === 'POST') {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      if (!rateLimit(`journal:${user.id}`, 120, 3600)) return send(res, 429, { ok: false, error: 'Too many writes.' }, origin);
      const body = await readBody(req);
      const symbol = String(body.symbol || '').toUpperCase();
      const side = String(body.side || '').toLowerCase();
      const num = (v) => (Number.isFinite(+v) ? +v : null);
      if (!SYMBOL_RE.test(symbol)) return send(res, 400, { ok: false, error: 'Invalid symbol.' }, origin);
      if (!['long', 'short'].includes(side)) return send(res, 400, { ok: false, error: 'Side must be long or short.' }, origin);
      const qty = num(body.qty), entry = num(body.entry), stop = num(body.stop), target = num(body.target);
      if (!(qty > 0) || !(entry > 0)) return send(res, 400, { ok: false, error: 'Quantity and entry must be positive numbers.' }, origin);
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO journal (id, user_id, symbol, side, qty, entry, stop, target, opened_at, notes, status, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, user.id, symbol, side, qty, entry, stop, target,
             String(body.openedAt || new Date().toISOString().slice(0, 10)).slice(0, 10),
             String(body.notes || '').slice(0, 500), 'open', now());
      audit('journal_add', user.id, ip, `${symbol} ${side} ${qty}`);
      const row = db.prepare('SELECT * FROM journal WHERE id = ?').get(id);
      return send(res, 200, { ok: true, fill: row }, origin);
    }

    const jm = route.match(/^\/api\/journal\/([0-9a-fA-F-]{36})$/);
    if (jm) {
      if (!csrfGuard(req, res, origin, cookies)) return;
      const user = requireUser(req, res, origin);
      if (!user) return;
      const row = db.prepare('SELECT * FROM journal WHERE id = ? AND user_id = ?').get(jm[1], user.id);
      if (!row) return send(res, 404, { ok: false, error: 'Fill not found.' }, origin);
      if (method === 'DELETE') {
        db.prepare('DELETE FROM journal WHERE id = ?').run(jm[1]);
        audit('journal_delete', user.id, ip, row.symbol);
        return send(res, 200, { ok: true }, origin);
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const status = body.status === 'closed' ? 'closed' : 'open';
        db.prepare('UPDATE journal SET status = ?, notes = ? WHERE id = ?')
          .run(status, String(body.notes ?? row.notes ?? '').slice(0, 500), jm[1]);
        audit('journal_update', user.id, ip, `${row.symbol} -> ${status}`);
        return send(res, 200, { ok: true, fill: db.prepare('SELECT * FROM journal WHERE id = ?').get(jm[1]) }, origin);
      }
      return send(res, 405, { ok: false, error: 'Method not allowed.' }, origin);
    }

    if (route === '/api/audit' && method === 'GET') {
      const user = requireUser(req, res, origin);
      if (!user) return;
      const rows = db.prepare('SELECT ts, event, ip, detail FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id);
      return send(res, 200, { ok: true, events: rows }, origin);
    }

    if (route === '/' ) {
      return send(res, 200, { ok: true, service: 'alphadesk-api', endpoints: ['/api/health', '/api/csrf', '/api/auth/register', '/api/auth/login', '/api/auth/me', '/api/journal'] }, origin);
    }

    return send(res, 404, { ok: false, error: 'Not found.' }, origin);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) console.error('[api]', err);
    return send(res, status, { ok: false, error: status >= 500 ? 'Server error.' : err.message }, origin);
  }
});

// Paper engine ticker. Only accounts with enabled = 1 move; the cycle itself
// enforces position caps, cooldowns and the daily-loss kill switch.
setInterval(() => {
  try {
    const rows = db.prepare('SELECT user_id FROM trader_account WHERE enabled = 1').all();
    for (const r of rows) {
      try { traderRun(db, r.user_id); } catch (e) { console.error('[trader] cycle failed:', e.message); }
    }
  } catch (e) { console.error('[trader] ticker:', e.message); }
}, 15 * 60_000).unref?.();

server.listen(PORT, HOST, () => {
  console.log(`\n  AlphaDesk API — http://${HOST}:${PORT}`);
  console.log(`  data: ${path.join(DATA_DIR, 'alphadesk.db')}`);
  console.log(`  cookies ${COOKIE_SECURE ? 'Secure (HTTPS only)' : 'insecure — local development'}`);
  console.log(`  site: http://${HOST}:${PORT}/  (served from docs/)`);
  console.log(`  CORS: ${ALLOWED_ORIGINS.join(', ')} + localhost\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { db.close(); } catch {} console.log('\n  api stopped'); process.exit(0); });
}
