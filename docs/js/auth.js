/* =============================================================================
 * auth.js — accounts and server-synced journal.
 *
 * Talks to server/server.mjs. Cookies are sent with credentials:'include';
 * the CSRF token rides in a readable cookie and is echoed in a header, which is
 * the double-submit pattern the server enforces.
 * ========================================================================== */

export const DEFAULT_API = 'http://127.0.0.1:8789';

const base = (url) => (url || DEFAULT_API).replace(/\/+$/, '');

const cookie = (name) => {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
};

let csrfReady = null;

async function ensureCsrf(api) {
  if (cookie('ads_csrf')) return cookie('ads_csrf');
  if (!csrfReady) {
    csrfReady = fetch(`${base(api)}/api/csrf`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => j.csrfToken)
      .catch(() => null)
      .finally(() => { setTimeout(() => { csrfReady = null; }, 1000); });
  }
  return csrfReady;
}

async function call(path, { api, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const token = await ensureCsrf(api);
    if (token) headers['X-CSRF-Token'] = token;
  }
  const res = await fetch(`${base(api)}${path}`, {
    method, headers, credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export const health = (api) => call('/api/health', { api });
export const me = (api) => call('/api/auth/me', { api });
export const register = (email, password, api) => call('/api/auth/register', { api, method: 'POST', body: { email, password } });
export const login = (email, password, api) => call('/api/auth/login', { api, method: 'POST', body: { email, password } });
export const logout = (api) => call('/api/auth/logout', { api, method: 'POST' });
export const changePassword = (current, next, api) => call('/api/auth/password', { api, method: 'POST', body: { current, next } });

export const listFills = (api) => call('/api/journal', { api });
export const addFill = (fill, api) => call('/api/journal', { api, method: 'POST', body: fill });
export const updateFill = (id, patch, api) => call(`/api/journal/${id}`, { api, method: 'PATCH', body: patch });
export const deleteFill = (id, api) => call(`/api/journal/${id}`, { api, method: 'DELETE' });
export const auditEvents = (api) => call('/api/audit', { api });

/**
 * Merge server fills into the local journal. Server rows win on id collision;
 * local rows that have never been synced are pushed up (oldest first).
 */
export async function syncJournal(local, api) {
  const server = await listFills(api);
  const remote = server.fills || [];
  const remoteIds = new Set(remote.map((r) => r.id));
  const locals = (local || []).filter((f) => f.id && !remoteIds.has(f.id) && !String(f.id).includes('-srv'));
  const pushed = [];
  for (const f of locals) {
    try {
      const r = await addFill({
        symbol: f.symbol, side: f.side, qty: f.qty, entry: f.entry,
        stop: f.stop, target: f.target, openedAt: f.openedAt, notes: f.notes || '',
      }, api);
      if (r.fill) pushed.push(r.fill);
    } catch { /* keep the local copy if the push fails */ }
  }
  const merged = [...remote, ...(local || []).filter((f) => !remoteIds.has(f.id) && !pushed.find((p) => p.symbol === f.symbol && p.entry === f.entry))];
  return { fills: merged, pushed: pushed.length, remote: remote.length };
}

export const AUTH_VERSION = '1.0.0';

/* ------------------------------ paper trader ------------------------------ */

export const traderStatus = (api) => call('/api/trader', { api });
export const traderSetEnabled = (enabled, api) => call('/api/trader/enable', { api, method: 'POST', body: { enabled } });
export const traderSetConfig = (config, api) => call('/api/trader/config', { api, method: 'POST', body: config });
export const traderRun = (api) => call('/api/trader/run', { api, method: 'POST', body: {} });
export const traderClose = (id, api) => call(`/api/trader/close/${id}`, { api, method: 'POST', body: {} });
export const traderReset = (api) => call('/api/trader/reset', { api, method: 'POST', body: {} });
