// AlphaDesk universe — single source of truth for symbol metadata.
// Consumed by tools/fetch-data.mjs (node) and exported to web/data/universe.json.

/** @typedef {{symbol:string,name:string,cls:'equity'|'etf'|'crypto'|'index'|'future',sector:string,group:string}} Instrument */

export const UNIVERSE = /** @type {Instrument[]} */ ([
  // ---- Benchmarks & broad ETFs ----
  { symbol: 'SPY',  name: 'SPDR S&P 500 ETF',        cls: 'etf', sector: 'Broad Market', group: 'core' },
  { symbol: 'QQQ',  name: 'Invesco Nasdaq 100 ETF',  cls: 'etf', sector: 'Broad Market', group: 'core' },
  { symbol: 'IWM',  name: 'iShares Russell 2000',    cls: 'etf', sector: 'Broad Market', group: 'core' },
  { symbol: 'DIA',  name: 'SPDR Dow Jones Industrials', cls: 'etf', sector: 'Broad Market', group: 'core' },
  { symbol: 'VTI',  name: 'Vanguard Total Market',   cls: 'etf', sector: 'Broad Market', group: 'core' },
  { symbol: 'EEM',  name: 'iShares Emerging Markets',cls: 'etf', sector: 'International', group: 'core' },
  { symbol: 'EFA',  name: 'iShares EAFE',            cls: 'etf', sector: 'International', group: 'core' },
  { symbol: 'TLT',  name: 'iShares 20+ Yr Treasury', cls: 'etf', sector: 'Rates', group: 'macro' },
  { symbol: 'IEF',  name: 'iShares 7-10 Yr Treasury',cls: 'etf', sector: 'Rates', group: 'macro' },
  { symbol: 'HYG',  name: 'iShares High Yield Credit',cls:'etf', sector: 'Credit', group: 'macro' },
  { symbol: 'GLD',  name: 'SPDR Gold Shares',        cls: 'etf', sector: 'Commodities', group: 'macro' },
  { symbol: 'SLV',  name: 'iShares Silver Trust',    cls: 'etf', sector: 'Commodities', group: 'macro' },
  { symbol: 'USO',  name: 'United States Oil Fund',  cls: 'etf', sector: 'Commodities', group: 'macro' },
  { symbol: 'UUP',  name: 'Invesco Dollar Bullish',  cls: 'etf', sector: 'Currencies', group: 'macro' },
  { symbol: 'SMH',  name: 'VanEck Semiconductor ETF',cls: 'etf', sector: 'Sector', group: 'sector' },
  { symbol: 'ARKK', name: 'ARK Innovation ETF',      cls: 'etf', sector: 'Sector', group: 'sector' },
  { symbol: 'XLE',  name: 'Energy Select Sector',    cls: 'etf', sector: 'Energy', group: 'sector' },
  { symbol: 'XLF',  name: 'Financial Select Sector', cls: 'etf', sector: 'Financials', group: 'sector' },
  { symbol: 'XLK',  name: 'Technology Select Sector',cls: 'etf', sector: 'Technology', group: 'sector' },
  { symbol: 'XLV',  name: 'Health Care Select Sector',cls:'etf', sector: 'Health Care', group: 'sector' },
  { symbol: 'XLY',  name: 'Consumer Disc Select',    cls: 'etf', sector: 'Consumer', group: 'sector' },
  { symbol: 'XLP',  name: 'Consumer Staples Select', cls: 'etf', sector: 'Consumer', group: 'sector' },
  { symbol: 'XLI',  name: 'Industrial Select Sector',cls: 'etf', sector: 'Industrials', group: 'sector' },
  { symbol: 'XLB',  name: 'Materials Select Sector', cls: 'etf', sector: 'Materials', group: 'sector' },
  { symbol: 'XLU',  name: 'Utilities Select Sector', cls: 'etf', sector: 'Utilities', group: 'sector' },
  { symbol: 'XLRE', name: 'Real Estate Select Sector',cls:'etf', sector: 'Real Estate', group: 'sector' },

  // ---- Mega cap technology ----
  { symbol: 'AAPL', name: 'Apple Inc.',              cls: 'equity', sector: 'Technology', group: 'megacap' },
  { symbol: 'MSFT', name: 'Microsoft Corp.',         cls: 'equity', sector: 'Technology', group: 'megacap' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.',            cls: 'equity', sector: 'Semiconductors', group: 'megacap' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.',         cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'GOOGL',name: 'Alphabet Inc. Class A',   cls: 'equity', sector: 'Technology', group: 'megacap' },
  { symbol: 'META', name: 'Meta Platforms Inc.',     cls: 'equity', sector: 'Technology', group: 'megacap' },
  { symbol: 'TSLA', name: 'Tesla Inc.',              cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'AVGO', name: 'Broadcom Inc.',           cls: 'equity', sector: 'Semiconductors', group: 'megacap' },
  { symbol: 'BRK-B',name: 'Berkshire Hathaway B',    cls: 'equity', sector: 'Financials', group: 'megacap' },
  { symbol: 'JPM',  name: 'JPMorgan Chase & Co.',    cls: 'equity', sector: 'Financials', group: 'megacap' },
  { symbol: 'V',    name: 'Visa Inc.',               cls: 'equity', sector: 'Financials', group: 'megacap' },
  { symbol: 'MA',   name: 'Mastercard Inc.',         cls: 'equity', sector: 'Financials', group: 'megacap' },
  { symbol: 'LLY',  name: 'Eli Lilly & Co.',         cls: 'equity', sector: 'Health Care', group: 'megacap' },
  { symbol: 'UNH',  name: 'UnitedHealth Group',      cls: 'equity', sector: 'Health Care', group: 'megacap' },
  { symbol: 'XOM',  name: 'Exxon Mobil Corp.',       cls: 'equity', sector: 'Energy', group: 'megacap' },
  { symbol: 'WMT',  name: 'Walmart Inc.',            cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'PG',   name: 'Procter & Gamble',        cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'COST', name: 'Costco Wholesale',        cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'HD',   name: 'Home Depot Inc.',         cls: 'equity', sector: 'Consumer', group: 'megacap' },
  { symbol: 'JNJ',  name: 'Johnson & Johnson',       cls: 'equity', sector: 'Health Care', group: 'megacap' },

  // ---- Semiconductors & hardware ----
  { symbol: 'AMD',  name: 'Advanced Micro Devices',  cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'INTC', name: 'Intel Corp.',             cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'MU',   name: 'Micron Technology',       cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'QCOM', name: 'Qualcomm Inc.',           cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'TXN',  name: 'Texas Instruments',       cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'AMAT', name: 'Applied Materials',       cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'LRCX', name: 'Lam Research',            cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'ASML', name: 'ASML Holding',            cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'ARM',  name: 'Arm Holdings',            cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'MRVL', name: 'Marvell Technology',      cls: 'equity', sector: 'Semiconductors', group: 'tech' },
  { symbol: 'SMCI', name: 'Super Micro Computer',    cls: 'equity', sector: 'Hardware', group: 'tech' },
  { symbol: 'DELL', name: 'Dell Technologies',       cls: 'equity', sector: 'Hardware', group: 'tech' },
  { symbol: 'HPQ',  name: 'HP Inc.',                 cls: 'equity', sector: 'Hardware', group: 'tech' },

  // ---- Software / internet ----
  { symbol: 'ADBE', name: 'Adobe Inc.',              cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'CRM',  name: 'Salesforce Inc.',         cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'ORCL', name: 'Oracle Corp.',            cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'NOW',  name: 'ServiceNow Inc.',         cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'SNOW', name: 'Snowflake Inc.',          cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'PLTR', name: 'Palantir Technologies',   cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'PANW', name: 'Palo Alto Networks',      cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'CRWD', name: 'CrowdStrike Holdings',    cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'CSCO', name: 'Cisco Systems',           cls: 'equity', sector: 'Hardware', group: 'tech' },
  { symbol: 'IBM',  name: 'IBM Corp.',               cls: 'equity', sector: 'Software', group: 'tech' },
  { symbol: 'NFLX', name: 'Netflix Inc.',            cls: 'equity', sector: 'Media', group: 'tech' },
  { symbol: 'DIS',  name: 'Walt Disney Co.',         cls: 'equity', sector: 'Media', group: 'tech' },
  { symbol: 'UBER', name: 'Uber Technologies',       cls: 'equity', sector: 'Platforms', group: 'tech' },
  { symbol: 'ABNB', name: 'Airbnb Inc.',             cls: 'equity', sector: 'Platforms', group: 'tech' },
  { symbol: 'SHOP', name: 'Shopify Inc.',            cls: 'equity', sector: 'Platforms', group: 'tech' },
  { symbol: 'SPOT', name: 'Spotify Technology',      cls: 'equity', sector: 'Media', group: 'tech' },

  // ---- Financials / fintech ----
  { symbol: 'BAC',  name: 'Bank of America',         cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'WFC',  name: 'Wells Fargo & Co.',       cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'GS',   name: 'Goldman Sachs Group',     cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'MS',   name: 'Morgan Stanley',          cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'C',    name: 'Citigroup Inc.',          cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'SCHW', name: 'Charles Schwab',          cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'BLK',  name: 'BlackRock Inc.',          cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'AXP',  name: 'American Express',        cls: 'equity', sector: 'Financials', group: 'finance' },
  { symbol: 'PYPL', name: 'PayPal Holdings',         cls: 'equity', sector: 'Fintech', group: 'finance' },
  { symbol: 'COIN', name: 'Coinbase Global',         cls: 'equity', sector: 'Fintech', group: 'finance' },
  { symbol: 'HOOD', name: 'Robinhood Markets',       cls: 'equity', sector: 'Fintech', group: 'finance' },
  { symbol: 'XYZ',  name: 'Block Inc. (formerly SQ)', cls: 'equity', sector: 'Fintech', group: 'finance' },
  { symbol: 'SOFI', name: 'SoFi Technologies',       cls: 'equity', sector: 'Fintech', group: 'finance' },

  // ---- Industrials / energy / materials ----
  { symbol: 'BA',   name: 'Boeing Co.',              cls: 'equity', sector: 'Industrials', group: 'industrial' },
  { symbol: 'CAT',  name: 'Caterpillar Inc.',        cls: 'equity', sector: 'Industrials', group: 'industrial' },
  { symbol: 'DE',   name: 'Deere & Co.',             cls: 'equity', sector: 'Industrials', group: 'industrial' },
  { symbol: 'HON',  name: 'Honeywell International', cls: 'equity', sector: 'Industrials', group: 'industrial' },
  { symbol: 'GE',   name: 'GE Aerospace',            cls: 'equity', sector: 'Industrials', group: 'industrial' },
  { symbol: 'LMT',  name: 'Lockheed Martin',         cls: 'equity', sector: 'Defense', group: 'industrial' },
  { symbol: 'RTX',  name: 'RTX Corp.',               cls: 'equity', sector: 'Defense', group: 'industrial' },
  { symbol: 'UNP',  name: 'Union Pacific',           cls: 'equity', sector: 'Transport', group: 'industrial' },
  { symbol: 'UPS',  name: 'United Parcel Service',   cls: 'equity', sector: 'Transport', group: 'industrial' },
  { symbol: 'FDX',  name: 'FedEx Corp.',             cls: 'equity', sector: 'Transport', group: 'industrial' },
  { symbol: 'DAL',  name: 'Delta Air Lines',         cls: 'equity', sector: 'Transport', group: 'industrial' },
  { symbol: 'UAL',  name: 'United Airlines',         cls: 'equity', sector: 'Transport', group: 'industrial' },
  { symbol: 'F',    name: 'Ford Motor Co.',          cls: 'equity', sector: 'Autos', group: 'industrial' },
  { symbol: 'GM',   name: 'General Motors',          cls: 'equity', sector: 'Autos', group: 'industrial' },
  { symbol: 'RIVN', name: 'Rivian Automotive',       cls: 'equity', sector: 'Autos', group: 'industrial' },
  { symbol: 'CVX',  name: 'Chevron Corp.',           cls: 'equity', sector: 'Energy', group: 'industrial' },
  { symbol: 'COP',  name: 'ConocoPhillips',          cls: 'equity', sector: 'Energy', group: 'industrial' },
  { symbol: 'SLB',  name: 'SLB (Schlumberger)',      cls: 'equity', sector: 'Energy', group: 'industrial' },
  { symbol: 'OXY',  name: 'Occidental Petroleum',    cls: 'equity', sector: 'Energy', group: 'industrial' },
  { symbol: 'FCX',  name: 'Freeport-McMoRan',        cls: 'equity', sector: 'Materials', group: 'industrial' },
  { symbol: 'LIN',  name: 'Linde plc',               cls: 'equity', sector: 'Materials', group: 'industrial' },

  // ---- Health care / consumer ----
  { symbol: 'PFE',  name: 'Pfizer Inc.',             cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'MRK',  name: 'Merck & Co.',             cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'ABBV', name: 'AbbVie Inc.',             cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'TMO',  name: 'Thermo Fisher Scientific',cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'ISRG', name: 'Intuitive Surgical',      cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'VRTX', name: 'Vertex Pharmaceuticals',  cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'GILD', name: 'Gilead Sciences',         cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'MRNA', name: 'Moderna Inc.',            cls: 'equity', sector: 'Health Care', group: 'consumer' },
  { symbol: 'KO',   name: 'Coca-Cola Co.',           cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'PEP',  name: 'PepsiCo Inc.',            cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'MCD',  name: "McDonald's Corp.",        cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'SBUX', name: 'Starbucks Corp.',         cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'NKE',  name: 'Nike Inc.',               cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'LULU', name: 'Lululemon Athletica',     cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'TGT',  name: 'Target Corp.',            cls: 'equity', sector: 'Consumer', group: 'consumer' },
  { symbol: 'LOW',  name: "Lowe's Companies",        cls: 'equity', sector: 'Consumer', group: 'consumer' },

  // ---- Crypto ----
  { symbol: 'BTC-USD', name: 'Bitcoin',              cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'ETH-USD', name: 'Ethereum',             cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'SOL-USD', name: 'Solana',               cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'XRP-USD', name: 'XRP',                  cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'ADA-USD', name: 'Cardano',              cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'DOGE-USD',name: 'Dogecoin',             cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'AVAX-USD',name: 'Avalanche',            cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'LINK-USD',name: 'Chainlink',            cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'DOT-USD', name: 'Polkadot',             cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'LTC-USD', name: 'Litecoin',             cls: 'crypto', sector: 'Crypto', group: 'crypto' },
  { symbol: 'MSTR', name: 'Strategy (MicroStrategy)', cls: 'equity', sector: 'Fintech', group: 'finance' },
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust',   cls: 'etf', sector: 'Crypto', group: 'crypto' },

  // ---- Macro gauges ----
  { symbol: '^VIX',  name: 'CBOE Volatility Index',  cls: 'index', sector: 'Volatility', group: 'macro' },
  { symbol: '^IXIC', name: 'Nasdaq Composite',       cls: 'index', sector: 'Broad Market', group: 'core' },
]);

export const BY_SYMBOL = new Map(UNIVERSE.map((u) => [u.symbol, u]));

/** Normalise user input like "btc", "brk.b", "aapl " into a universe symbol. */
export function resolveSymbol(input) {
  if (!input) return null;
  const raw = String(input).trim().toUpperCase().replace(/\s+/g, '');
  if (BY_SYMBOL.has(raw)) return raw;
  const withDash = raw.replace(/\./g, '-');
  if (BY_SYMBOL.has(withDash)) return withDash;
  if (/^[A-Z]{2,6}$/.test(raw) && BY_SYMBOL.has(`${raw}-USD`)) return `${raw}-USD`;
  return null;
}

/** Symbols used for market-regime context features. */
export const CONTEXT_SYMBOLS = ['SPY', '^VIX', '^TNX', 'QQQ'];
