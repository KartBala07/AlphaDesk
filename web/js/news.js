/** news.js — live financial news + curated news-network directory. Dependency-free browser ESM over the GDELT 2.0 DOC API (CORS: `*`), so it works from GitHub Pages / file:// / localhost with no proxy or build step. Absorbs GDELT quirks: ~1 request/5s limit, plain-text errors returned with HTTP 200, punctuation-mangled titles, heavy wire syndication. Never throws. */

export const NEWS_VERSION = '1.0.0';
const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RECORDS = 250; // hard API ceiling
const REQUEST_TIMEOUT_MS = 20000;
const MIN_GAP_MS = 1500; // spacing between GDELT calls from this page
const RETRY_DELAY_MS = 5500; // backoff after 429 / transient failure
const DEFAULT_CONTEXT = ['stock', 'shares', 'earnings'];
const CRYPTO_CONTEXT = ['crypto', 'ETF', 'token'];

/* ---------------------------- network directory --------------------------- */
export const NETWORKS = [
  { id: 'bloomberg', name: 'Bloomberg', url: 'https://www.bloomberg.com/markets', rss: 'https://www.bloomberg.com/feeds/markets/news.rss', category: 'markets', blurb: 'Cross-asset moves, deal flow and macro commentary from the terminal.' },
  { id: 'reuters', name: 'Reuters', url: 'https://www.reuters.com/markets/', rss: '', category: 'markets', blurb: 'Wire-speed global markets coverage; the baseline other outlets cite.' },
  { id: 'cnbc', name: 'CNBC', url: 'https://www.cnbc.com/markets/', rss: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', category: 'markets', blurb: 'US equities, earnings hits and misses, live market commentary.' },
  { id: 'wsj', name: 'WSJ', url: 'https://www.wsj.com/finance', rss: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'markets', blurb: 'Wall Street Journal finance: markets, banking, deals.' },
  { id: 'ft', name: 'Financial Times', url: 'https://www.ft.com/markets', rss: 'https://www.ft.com/rss/home/international', category: 'markets', blurb: 'Global finance and economics from a European vantage point.' },
  { id: 'barrons', name: "Barron's", url: 'https://www.barrons.com/', rss: '', category: 'markets', blurb: 'Investing analysis, fund screens and the weekly market outlook.' },
  { id: 'marketwatch', name: 'MarketWatch', url: 'https://www.marketwatch.com/', rss: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', category: 'markets', blurb: 'Fast consumer-facing market news, quotes and personal finance.' },
  { id: 'yahoo-finance', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/', rss: '', category: 'markets', blurb: 'Free quotes plus syndicated finance headlines and screeners.' },
  { id: 'investing', name: 'Investing.com', url: 'https://www.investing.com/news/', rss: 'https://www.investing.com/rss/news_25.rss', category: 'markets', blurb: 'Global market news, economic calendar and instrument pages.' },
  { id: 'seeking-alpha', name: 'Seeking Alpha', url: 'https://seekingalpha.com/market-news', rss: 'https://seekingalpha.com/market_currents.xml', category: 'markets', blurb: 'Crowd-sourced equity research and earnings-call analysis.' },
  { id: 'benzinga', name: 'Benzinga', url: 'https://www.benzinga.com/news', rss: 'https://www.benzinga.com/feed', category: 'markets', blurb: 'Trading-desk headlines, movers and analyst rating changes.' },
  { id: 'businesswire', name: 'Business Wire', url: 'https://www.businesswire.com/news/home', rss: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpRWQ==', category: 'wire', blurb: 'Company press releases: earnings, M&A, guidance, offerings.' },
  { id: 'prnewswire', name: 'PR Newswire', url: 'https://www.prnewswire.com/news-releases/', rss: 'https://www.prnewswire.com/rss/news-releases-list.rss', category: 'wire', blurb: 'Corporate news releases straight from the source.' },
  { id: 'ap-business', name: 'AP Business', url: 'https://apnews.com/hub/business', rss: '', category: 'wire', blurb: 'Associated Press business wire: plain, fast, widely syndicated.' },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/markets', rss: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'crypto', blurb: 'Crypto markets, regulation and institutional adoption.' },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/', rss: 'https://cointelegraph.com/rss', category: 'crypto', blurb: 'High-volume crypto news across chains, exchanges and policy.' },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/', rss: 'https://www.theblock.co/rss.xml', category: 'crypto', blurb: 'Institutional crypto and digital-asset market structure.' },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/news', rss: 'https://decrypt.co/feed', category: 'crypto', blurb: 'Crypto explainers and consumer-facing Web3 coverage.' },
  { id: 'sec-edgar', name: 'SEC EDGAR', url: 'https://www.sec.gov/edgar/search/', rss: '', category: 'filings', blurb: 'Primary-source filings: 10-K, 10-Q, 8-K, S-1, 13F, Form 4.' },
  { id: 'federal-reserve', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/newsevents.htm', rss: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'macro', blurb: 'FOMC statements, minutes, speeches and press releases.' },
  { id: 'fred', name: 'FRED', url: 'https://fred.stlouisfed.org/', rss: '', category: 'macro', blurb: 'St. Louis Fed data: rates, spreads, employment, inflation.' },
  { id: 'bls', name: 'BLS', url: 'https://www.bls.gov/news.release/', rss: '', category: 'macro', blurb: 'CPI, PPI, payrolls and unemployment — the original releases.' },
  { id: 'cboe', name: 'CBOE', url: 'https://www.cboe.com/', rss: '', category: 'data', blurb: 'Options and volatility complex: VIX, SPX options, market structure.' },
  { id: 'nasdaq', name: 'Nasdaq', url: 'https://www.nasdaq.com/market-activity', rss: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets', category: 'data', blurb: 'Exchange quotes, movers, halts and listing data.' },
  { id: 'tradingview', name: 'TradingView', url: 'https://www.tradingview.com/markets/', rss: 'https://www.tradingview.com/feed/', category: 'data', blurb: 'Charts, screener and aggregated news for every symbol.' },
];

export function networkLinks() {
  return NETWORKS;
}

/* ------------------------------- deep links ------------------------------- */
const COINGECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', DOT: 'polkadot', LINK: 'chainlink', LTC: 'litecoin', BNB: 'binancecoin', SHIB: 'shiba-inu', MATIC: 'matic-network', TON: 'the-open-network', TRX: 'tron', USDT: 'tether', USDC: 'usd-coin' };
const CRYPTO_SYMBOLS = new Set(Object.keys(COINGECKO_IDS));

/** Symbol deep links across networks; CoinGecko is added for crypto tickers. */
export function tickerLinks(symbol, name) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return [];
  const clean = sym.replace(/[^A-Z0-9.-]/g, '');
  const dash = clean.replace(/\./g, '-'); // BRK.B -> BRK-B
  const newsQuery = encodeURIComponent(`${name ? `"${name}" ` : ''}${clean} stock`);
  const links = [
    { id: 'yahoo-finance', name: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${dash}`, kind: 'quote' },
    { id: 'google-finance', name: 'Google Finance', url: `https://www.google.com/finance/quote/${dash}`, kind: 'quote' },
    { id: 'google-news', name: 'Google News', url: `https://news.google.com/search?q=${newsQuery}`, kind: 'search' },
    { id: 'reuters', name: 'Reuters search', url: `https://www.reuters.com/site-search/?query=${encodeURIComponent(clean)}`, kind: 'search' },
    { id: 'cnbc', name: 'CNBC', url: `https://www.cnbc.com/quotes/${dash}`, kind: 'quote' },
    { id: 'marketwatch', name: 'MarketWatch', url: `https://www.marketwatch.com/investing/stock/${clean.toLowerCase().replace(/\./g, '-')}`, kind: 'quote' },
    { id: 'stocktwits', name: 'StockTwits', url: `https://stocktwits.com/symbol/${clean}`, kind: 'search' },
    { id: 'tradingview', name: 'TradingView', url: `https://www.tradingview.com/symbols/${dash}/`, kind: 'quote' },
    { id: 'sec-edgar', name: 'SEC EDGAR', url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(`"${clean}"`)}`, kind: 'filings' },
  ];
  if (COINGECKO_IDS[clean] || CRYPTO_SYMBOLS.has(clean)) {
    links.push({ id: 'coingecko', name: 'CoinGecko', url: `https://www.coingecko.com/en/coins/${COINGECKO_IDS[clean] || clean.toLowerCase()}`, kind: 'crypto' });
  }
  return links;
}

/* ----------------------------- cache (5 min) ------------------------------ */
/** @type {Map<string, {at:number, value:any}>} */
const _cache = new Map();

/** Drop every cached GDELT response. @returns {number} entries cleared */
export function clearCache() {
  const n = _cache.size; _cache.clear(); return n;
}
/** Small stable hash so cache keys stay short (djb2). */
function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  if (_cache.size > 64) { const first = _cache.keys().next(); if (!first.done) _cache.delete(first.value); }
  _cache.set(key, { at: Date.now(), value });
}

/* -------------------------------- helpers --------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialise calls so several page panels don't trip GDELT's limiter. */
let _chain = Promise.resolve();
let _lastCallAt = 0;
function paced(fn) {
  const run = _chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - _lastCallAt);
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { _lastCallAt = Date.now(); }
  });
  _chain = run.catch(() => {});
  return run;
}
function buildUrl(params) {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return `${GDELT_ENDPOINT}?${pairs.join('&')}`;
}

/** GDELT wants bare single tokens; quoting a lone token inside an OR group
 *  errors out ("The specified phrase is too short"). */
function term(s) {
  const t = String(s || '').replace(/["()]/g, ' ').replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /\s/.test(t) ? `"${t}"` : t;
}
function contextFor(symbol, companyName) {
  const crypto = CRYPTO_SYMBOLS.has(String(symbol || '').toUpperCase()) ||
    /bitcoin|ethereum|solana|crypto|dogecoin|ripple|xrp/i.test(String(companyName || ''));
  return crypto ? CRYPTO_CONTEXT : DEFAULT_CONTEXT;
}

/** Name alternatives as one OR group. `term()` never quotes a lone token:
 *  GDELT rejects short quoted phrases ("The specified phrase is too short."). */
function nameGroup(symbol, companyName) {
  const terms = [...new Set([companyName && term(companyName), symbol && term(symbol)].filter(Boolean))];
  return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0] || '';
}

/** Names first, then market-context words; `withContext:false` = fallback query. */
function buildQuery({ symbol, companyName, query, withContext = true, english = true }) {
  if (query && String(query).trim()) {
    const q = String(query).trim();
    return english && !/sourcelang:/i.test(q) ? `${q} sourcelang:english` : q;
  }
  const namePart = nameGroup(symbol, companyName);
  if (!namePart) return '';
  let q = namePart;
  if (withContext) q += ` (${contextFor(symbol, companyName).join(' OR ')})`;
  if (english) q += ' sourcelang:english';
  return q;
}

/* ------------------------------ normalisation ----------------------------- */
/** GDELT injects spaces around punctuation: "$69 , 000" -> "$69,000". */
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s+/g, ' ').replace(/(\d)\s*,\s*(\d)/g, '$1,$2')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2').replace(/\$\s+(\d)/g, '$$$1')
    .replace(/\s+([,.;:!?%)\]])/g, '$1').replace(/([(\[])\s+/g, '$1')
    .replace(/\b([A-Z])\s*\.\s*([A-Z])\s*\./g, '$1.$2.')
    .replace(/\b(ex|non|re|co|pre|post|anti|mid|self|semi|multi|ultra|quasi|one|two|three|four|five|six|seven|eight|nine|ten)\s+-\s+/gi, '$1-')
    .replace(/(\d)\s*-\s*(year|month|day|quarter|week|point)/gi, '$1-$2')
    .trim();
}
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_|s_cid$|cmpid$|ocid$|ns_|taid$|smid$|at_|_hs|yptr)/i;

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/amp\/?$/i, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k))
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${path}${kept ? `?${kept}` : ''}`.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

/** Lowercased alphanumeric fingerprint of the first 12 words. */
function titleFingerprint(title) {
  return String(title || '').toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 12).join(' ');
}
function parseSeen(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

/** Domains seen in live pulls that only republish/rewrite wire copy. */
const BLOCKLIST = [
  'msn.com', 'news.google.com', 'flipboard.com', 'biztoc.com', 'insidermonkey.com',
  'marketbeat.com', 'stocktitan.net', 'dailypolitical.com', 'themarketsdaily.com',
  'tickerreport.com', 'wkrb.com', 'etfdailynews.com', 'defenseworld.net',
  'kalkinemedia.com', 'simplywall.st', 'littleapplepost.com', 'finanznachrichten.de',
  'iheart.com', 'newsrnd.com', 'menafn.com', 'bignewsnetwork.com', 'oneindia.com',
];

/** Tokens that must appear in an article when we drop market context. */
function nameTokens(symbol, companyName) {
  const skip = new Set(['the', 'inc', 'corp', 'corporation', 'company', 'holdings', 'group', 'plc', 'ltd', 'co', 'class', 'common', 'stock']);
  const raw = `${companyName || ''} ${symbol || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return [...new Set(raw.split(' ').filter((t) => t.length >= 2 && !skip.has(t)))];
}

function mentionsAny(title, tokens) {
  if (!tokens.length) return true;
  const padded = ` ${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return tokens.some((tok) => padded.includes(` ${tok} `));
}

function isBlocked(host) {
  const h = String(host || '').toLowerCase();
  return BLOCKLIST.some((d) => h === d || h.endsWith(`.${d}`));
}
function prettySource(host) {
  const core = String(host || '').replace(/^www\./, '').split('.').slice(-2, -1)[0] || '';
  return core.split(/[-_]/).filter(Boolean).map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
function normalizeArticle(a) {
  const title = cleanTitle(a.title);
  const url = String(a.url || a.url_mobile || '').trim();
  if (!title || !url) return null;
  const domain = String(a.domain || '').replace(/^www\./, '').toLowerCase(), ts = parseSeen(a.seendate);
  const published = ts ? new Date(ts).toISOString() : '';
  const tone = naiveTone(title);
  const image = /^https?:\/\//i.test(String(a.socialimage || '')) ? a.socialimage : '';
  return { title, url, domain, source: prettySource(domain), published, language: String(a.language || ''), country: String(a.sourcecountry || ''), tone, image, _ts: ts };
}

/* ---------------------------------- HTTP ---------------------------------- */
async function requestJson(params, attempts = 3) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(buildUrl(params), {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { Accept: 'application/json,text/plain,*/*' },
      credentials: 'omit',
      mode: 'cors',
    });
  } catch (err) {
    // A rate-limited GDELT reply can arrive without CORS headers, which the
    // browser surfaces as a network error rather than a 429 — retry either way.
    if (attempts > 1) { await sleep(RETRY_DELAY_MS); return requestJson(params, attempts - 1); }
    throw new Error(`network error contacting GDELT (${(err && err.message) || 'failed'})`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempts > 1) { await sleep(RETRY_DELAY_MS); return requestJson(params, attempts - 1); }
    throw new Error(`GDELT rate limit (HTTP ${res.status}) — retry in a few seconds`);
  }
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('GDELT returned an empty body');
  if (!text.startsWith('{') && !text.startsWith('[')) throw new Error(`GDELT rejected the query: ${text.slice(0, 160)}`);
  try { return JSON.parse(text); } catch { throw new Error('GDELT returned malformed JSON'); }
}

/* -------------------------------- fetchNews ------------------------------- */
/** Live news for a ticker or free-text query. @returns {Promise<{ok:boolean, items:Array, query:string, fetchedAt:string, warnings:string[], error?:string}>} */
export async function fetchNews(opts = {}) {
  if (!opts || typeof opts !== 'object') opts = typeof opts === 'string' ? { query: opts } : {};
  const symbol = String(opts.symbol || '').trim();
  const companyName = String(opts.companyName || '').trim();
  const timespan = String(opts.timespan || '1d');
  const limit = Math.max(1, Math.min(MAX_RECORDS, Math.round(Number(opts.limit) || 40)));
  const sort = opts.sort === 'datedesc' || opts.sort === 'dateasc' ? opts.sort : 'hybridrel';
  const english = opts.english !== false;
  const warnings = [];
  const fetchedAt = new Date().toISOString();
  if (!symbol && !companyName && !opts.query) return { ok: false, items: [], query: '', fetchedAt, warnings, error: 'fetchNews needs a symbol, companyName or query' };
  const wantedMode = String(opts.mode || 'artlist').toLowerCase();
  if (wantedMode !== 'artlist') warnings.push(`mode "${wantedMode}" unsupported; used artlist`);
  const primary = buildQuery({ symbol, companyName, query: opts.query, english });
  const fallback = buildQuery({ symbol, companyName, english, withContext: false });
  const maxrecords = Math.max(1, Math.min(MAX_RECORDS, Math.max(limit * 3, 60)));
  const tokens = nameTokens(symbol, companyName);
  const run = async (query, tag) => {
    const params = { query, mode: 'artlist', format: 'json', maxrecords, sort, timespan };
    const key = `news|${hashKey(JSON.stringify(params))}`;
    const hit = cacheGet(key);
    if (hit) return { ...hit, items: hit.items.slice(), warnings: [...hit.warnings], cached: true };
    const json = await paced(() => requestJson(params));
    const result = assemble(Array.isArray(json.articles) ? json.articles : [], limit, tag, tokens);
    result.query = query;
    cacheSet(key, { ...result, items: result.items.slice(), warnings: [...result.warnings] });
    return result;
  };

  try {
    let result = await run(primary, 'primary');
    if (!result.items.length && fallback && fallback !== primary) {
      warnings.push('no usable articles for the market-context query; retried without it');
      result = await run(fallback, 'fallback');
    }
    return {
      ok: true, items: result.items, query: result.query, fetchedAt,
      warnings: [...warnings, ...result.warnings], counts: result.counts, cached: !!result.cached,
    };
  } catch (err) {
    if (!fallback || fallback === primary) {
      return { ok: false, items: [], query: primary, fetchedAt, warnings, error: short(err) };
    }
    // One retry with the bare name, mirroring GDELT's "simpler query" advice.
    try {
      const alt = await run(fallback, 'fallback');
      const fbWarnings = [...warnings, `primary query failed (${short(err)}); used bare-symbol query`, ...alt.warnings];
      return { ok: true, items: alt.items, query: alt.query, fetchedAt, warnings: fbWarnings, counts: alt.counts, cached: !!alt.cached };
    } catch (err2) {
      return { ok: false, items: [], query: primary, fetchedAt, warnings, error: short(err2) };
    }
  }
}
const short = (err) => String((err && err.message) || err || 'unknown error').slice(0, 200);

/** Filter blocklist -> dedupe (URL, then title) -> sort desc -> cap. */
function assemble(raw, limit, tag, tokens = []) {
  const warnings = [];
  let blocked = 0, offTopic = 0, duplicates = 0;
  const seenUrl = new Set(), seenTitle = new Set(), out = [];

  for (const a of raw) {
    const item = normalizeArticle(a || {});
    if (!item) continue;
    if (isBlocked(item.domain)) { blocked += 1; continue; }
    if (tag === 'fallback' && !mentionsAny(item.title, tokens)) { offTopic += 1; continue; }
    const u = normalizeUrl(item.url);
    const fp = titleFingerprint(item.title);
    if ((u && seenUrl.has(u)) || (fp && seenTitle.has(fp))) { duplicates += 1; continue; }
    if (u) seenUrl.add(u);
    if (fp) seenTitle.add(fp);
    out.push(item);
  }

  // Prefer on-topic headlines when the cap will drop items, then return in date order.
  const onTopic = (it) => (tokens.length && mentionsAny(it.title, tokens) ? 1 : 0);
  out.sort((a, b) => onTopic(b) - onTopic(a) || (b._ts || 0) - (a._ts || 0));
  const kept = out.slice(0, limit).sort((a, b) => (b._ts || 0) - (a._ts || 0));
  if (blocked) warnings.push(`filtered ${blocked} syndication source${blocked === 1 ? '' : 's'}`);
  if (offTopic) warnings.push(`dropped ${offTopic} off-topic article${offTopic === 1 ? '' : 's'} from the context-free fallback`);
  if (duplicates) warnings.push(`removed ${duplicates} duplicate article${duplicates === 1 ? '' : 's'}`);
  return { items: kept.map(({ _ts, ...rest }) => rest), warnings, counts: { fetched: raw.length, kept: kept.length, blocked, duplicates, offTopic } };
}

/* -------------------------------- sentiment ------------------------------- */
/** Tone for a ticker: GDELT's tone timeline for the aggregate, current articles for the drill-down. @returns {Promise<{ok:boolean,total:number,toneMean:number|null,toneBand:'negative'|'neutral'|'positive',items:Array,series?:Array,warnings:string[],error?:string}>} */
export async function fetchTickerSentiment(symbol, companyName) {
  const warnings = [];
  const sym = String(symbol || '').trim();
  if (!sym && !companyName) return { ok: false, total: 0, toneMean: null, toneBand: 'neutral', items: [], warnings, error: 'a symbol or company name is required' };
  let series = [], toneMean = null;
  try {
    const params = { query: buildQuery({ symbol: sym, companyName, english: true }), mode: 'timelinetone', format: 'json', timespan: '7d' };
    const key = `tone|${hashKey(JSON.stringify(params))}`;
    let json = cacheGet(key);
    if (!json) { json = await paced(() => requestJson(params)); cacheSet(key, json); }
    series = extractToneSeries(json);
    toneMean = mean(series.map((p) => p.value));
    if (toneMean === null) warnings.push('tone timeline returned no data points');
  } catch (err) {
    warnings.push(`tone timeline unavailable (${short(err)})`);
  }
  let items = [];
  try {
    const news = await fetchNews({ symbol: sym, companyName, limit: 40, timespan: '3d' });
    items = news.items;
    if (news.warnings) warnings.push(...news.warnings);
    if (!news.ok) warnings.push(news.error || 'article fetch failed');
  } catch (err) {
    warnings.push(`articles unavailable (${short(err)})`);
  }
  if (toneMean === null) {
    const scores = items.map((i) => i.tone).filter((v) => typeof v === 'number');
    toneMean = scores.length ? mean(scores) : null;
    if (toneMean !== null) warnings.push('tone estimated from headline wording');
  }
  const band = toneMean === null ? 'neutral' : toneMean >= 1 ? 'positive' : toneMean <= -1 ? 'negative' : 'neutral';
  const ok = toneMean !== null || items.length > 0;
  return { ok, total: items.length, toneMean: toneMean === null ? null : Number(toneMean.toFixed(2)), toneBand: band, items, series, warnings };
}

/** GDELT timelinetone: { timeline:[{ series, data:[{date,value}] }] } */
function extractToneSeries(json) {
  const blocks = json && Array.isArray(json.timeline) ? json.timeline : [];
  const block = blocks.find((t) => Array.isArray(t && t.data)) || {};
  return (block.data || []).map((p) => ({ date: String(p.date || ''), value: Number(p.value) }))
    .filter((p) => Number.isFinite(p.value));
}
function mean(nums) {
  const vals = nums.filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/* -------------------------- topics + naive sentiment ---------------------- */
const POSITIVE_WORDS = ['beat', 'beats', 'record', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'upgrade', 'upgrades', 'raises', 'outperform', 'strong', 'growth', 'profit', 'profits', 'approval', 'approved', 'wins', 'boost', 'boosts', 'tops', 'expands', 'buyback', 'bullish', 'higher'];
const NEGATIVE_WORDS = ['miss', 'misses', 'fall', 'falls', 'drop', 'drops', 'plunge', 'plunges', 'slump', 'slumps', 'sink', 'sinks', 'cut', 'cuts', 'layoff', 'layoffs', 'downgrade', 'downgrades', 'lawsuit', 'sued', 'probe', 'investigation', 'fine', 'fined', 'weak', 'loss', 'losses', 'warns', 'warning', 'decline', 'declines', 'selloff', 'bearish', 'lower', 'halt', 'recall'];
const TOPICS = [
  { topic: 'tariff', label: 'Tariffs / trade', words: ['tariff', 'tariffs', 'trade war', 'import duty', 'duties', 'levy', 'protectionism'] },
  { topic: 'earnings', label: 'Earnings', words: ['earnings', 'quarterly results', 'q1', 'q2', 'q3', 'q4', 'revenue', 'profit', 'eps', 'same-store'] },
  { topic: 'guidance', label: 'Guidance / outlook', words: ['guidance', 'outlook', 'forecast', 'forecasts', 'projects', 'sees', 'raises outlook', 'cuts outlook'] },
  { topic: 'layoffs', label: 'Layoffs', words: ['layoff', 'layoffs', 'job cuts', 'jobs cut', 'redundancies', 'workforce reduction', 'hiring freeze'] },
  { topic: 'fed-rates', label: 'Fed / rates', words: ['fed', 'federal reserve', 'fomc', 'rate hike', 'rate cut', 'interest rate', 'interest rates', 'powell', 'yields', 'treasury yields', 'basis points'] },
  { topic: 'inflation', label: 'Inflation / CPI', words: ['inflation', 'cpi', 'ppi', 'consumer price', 'producer price', 'cost of living', 'deflation'] },
  { topic: 'merger', label: 'M&A', words: ['merger', 'mergers', 'acquisition', 'acquire', 'acquires', 'takeover', 'buyout', 'deal to buy', 'stake sale', 'combine'] },
  { topic: 'legal', label: 'Legal / regulatory', words: ['lawsuit', 'sues', 'sued', 'court', 'doj', 'ftc', 'sec ', 'regulator', 'regulators', 'antitrust', 'probe', 'investigation', 'fine', 'settlement'] },
  { topic: 'ai', label: 'AI', words: ['artificial intelligence', ' ai ', 'chatgpt', 'gpu', 'gpus', 'llm', 'machine learning', 'data center', 'data centers', 'copilot', 'inference'] },
  { topic: 'crypto', label: 'Crypto / ETF', words: ['bitcoin', 'crypto', 'ethereum', 'etf', 'etfs', 'blockchain', 'stablecoin', 'token', 'solana', 'spot bitcoin'] },
  { topic: 'buyback', label: 'Buybacks / dividends', words: ['buyback', 'buybacks', 'repurchase', 'share repurchase', 'dividend', 'dividends'] },
  { topic: 'ratings', label: 'Ratings / targets', words: ['downgrade', 'downgrades', 'upgrade', 'upgrades', 'price target', 'initiates', 'rating', 'overweight', 'underweight', 'neutral rating'] },
];

function countWords(haystack, words) {
  const h = ` ${haystack} `;
  let n = 0;
  for (const w of words) {
    const needle = w.startsWith(' ') ? w : ` ${w} `;
    let idx = h.indexOf(needle);
    while (idx !== -1) { n += 1; idx = h.indexOf(needle, idx + needle.length); }
  }
  return n;
}
function naiveTone(title) {
  const text = String(title || '').toLowerCase();
  const pos = countWords(text, POSITIVE_WORDS);
  const neg = countWords(text, NEGATIVE_WORDS);
  return pos || neg ? Number(((pos - neg) / (pos + neg)).toFixed(2)) : 0;
}

/** Deterministic keyword topic extraction over headlines. @param {Array<{title:string}>} items @param {number} [limit=6] @returns {{topic:string,label:string,count:number,items:number[],sentiment:{positive:number,negative:number,score:number},itemSentiment:{index:number,positive:number,negative:number}[]}[]} */
export function summarizeHeadlines(items, limit = 6) {
  const list = Array.isArray(items) ? items : [], buckets = new Map();
  list.forEach((item, index) => {
    const title = ` ${String((item && item.title) || '').toLowerCase()} `;
    for (const spec of TOPICS) {
      if (!countWords(title, spec.words)) continue;
      let bucket = buckets.get(spec.topic);
      if (!bucket) {
        bucket = { topic: spec.topic, label: spec.label, count: 0, items: [], itemSentiment: [] };
        buckets.set(spec.topic, bucket);
      }
      bucket.count += 1;
      bucket.items.push(index);
      bucket.itemSentiment.push({ index, positive: countWords(title, POSITIVE_WORDS), negative: countWords(title, NEGATIVE_WORDS) });
    }
  });

  return [...buckets.values()].map((b) => {
    const positive = b.itemSentiment.reduce((n, s) => n + s.positive, 0);
    const negative = b.itemSentiment.reduce((n, s) => n + s.negative, 0);
    const total = positive + negative;
    return { ...b, sentiment: { positive, negative, score: total ? Number(((positive - negative) / total).toFixed(2)) : 0 } };
  })
    .sort((a, b) => b.count - a.count || a.items[0] - b.items[0] || a.topic.localeCompare(b.topic))
    .slice(0, Math.max(1, Math.min(TOPICS.length, Math.round(Number(limit) || 6))));
}
