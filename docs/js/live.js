/* =============================================================================
 * live.js — optional live data layer.
 *
 * The app is fully functional on the bundled 10-year snapshot. This module adds
 * genuinely live prices where a public CORS-enabled source exists:
 *   crypto  -> CoinGecko public API (no key, CORS enabled)
 *   stocks  -> Twelve Data free tier (bring-your-own key, CORS enabled)
 * Everything degrades to the snapshot when a source is unavailable.
 * ========================================================================== */

export const LIVE_VERSION = '1.0.0';

const CG_IDS = {
  'BTC-USD': 'bitcoin', 'ETH-USD': 'ethereum', 'SOL-USD': 'solana', 'XRP-USD': 'ripple',
  'ADA-USD': 'cardano', 'DOGE-USD': 'dogecoin', 'AVAX-USD': 'avalanche-2', 'LINK-USD': 'chainlink',
  'DOT-USD': 'polkadot', 'LTC-USD': 'litecoin',
};

const cache = new Map();
const TTL = 45_000;

async function jsonFetch(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
};

export const isCrypto = (symbol) => !!CG_IDS[symbol];

/** Live crypto prices + 24h change from CoinGecko. */
export async function cryptoQuotes(symbols) {
  const ids = symbols.map((s) => CG_IDS[s]).filter(Boolean);
  if (!ids.length) return {};
  return cached(`cg:${ids.join(',')}`, async () => {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
    const j = await jsonFetch(url);
    const out = {};
    for (const [sym, id] of Object.entries(CG_IDS)) {
      if (j[id]) out[sym] = { price: j[id].usd, changePct: j[id].usd_24h_change, at: j[id].last_updated_at, source: 'coingecko' };
    }
    return out;
  });
}

/** Twelve Data quote. Free key from twelvedata.com (8 requests/minute). */
export async function quote(symbol, apiKey) {
  if (!apiKey) throw new Error('Add a Twelve Data API key in Settings to pull live equity quotes.');
  const tdSym = symbol.replace('-USD', '/USD').replace('^', '');
  return cached(`td:q:${tdSym}:${apiKey.slice(-4)}`, async () => {
    const u = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdSym)}&apikey=${encodeURIComponent(apiKey)}`;
    const j = await jsonFetch(u);
    if (j.status === 'error' || j.code) throw new Error(j.message || 'Twelve Data error');
    return {
      symbol, price: Number(j.close ?? j.price), changePct: Number(j.percent_change), at: j.timestamp,
      name: j.name, exchange: j.exchange, source: 'twelvedata',
    };
  });
}

/**
 * Daily bars for any symbol via Twelve Data, normalised to the engine's bar
 * format. Used to analyse tickers that are not part of the bundled dataset.
 */
export async function dailyBars(symbol, apiKey, outputsize = 1200) {
  if (!apiKey) throw new Error('A Twelve Data API key is required to fetch history for symbols outside the bundled dataset.');
  const tdSym = symbol.replace('-USD', '/USD').replace('^', '');
  return cached(`td:b:${tdSym}:${outputsize}:${apiKey.slice(-4)}`, async () => {
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym)}&interval=1day&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;
    const j = await jsonFetch(u, { timeoutMs: 20000 });
    if (j.status === 'error' || j.code) throw new Error(j.message || 'Twelve Data error');
    const bars = (j.values || []).slice().reverse().map((v) => [
      String(v.datetime).slice(0, 10), +v.open, +v.high, +v.low, +v.close, +(v.volume || 0),
    ]).filter((b) => b.slice(1, 5).every((x) => Number.isFinite(x) && x > 0));
    if (bars.length < 300) throw new Error(`Only ${bars.length} daily bars returned; the model needs 290+.`);
    return { symbol, name: j.meta?.symbol || symbol, bars, source: 'twelvedata' };
  });
}

export function clearLiveCache() { cache.clear(); }
