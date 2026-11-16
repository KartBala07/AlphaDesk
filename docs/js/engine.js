/* =============================================================================
 * AlphaDesk engine — indicators, feature construction, inference, backtesting.
 * Pure ESM, no DOM, no dependencies. Imported by both tools/train.mjs (node)
 * and the browser app, so training and live inference share identical math.
 * ========================================================================== */

export const ENGINE_VERSION = '1.0.0';
export const TP_MULT = 2.0;   // take-profit distance in ATR
export const SL_MULT = 1.0;   // stop-loss distance in ATR
export const HORIZON = 15;    // vertical barrier, trading days
export const WARMUP = 260;    // bars needed before features are valid
/** Hit rate at which a 2.0:1.0 target/stop trade breaks even before costs. */
export const BREAKEVEN_P = 1 / (1 + TP_MULT / SL_MULT);

/* ------------------------------- utilities -------------------------------- */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function normaliseBars(raw) {
  if (!raw) return null;
  // Accept {bars:[[date,o,h,l,c,v]...]} (fetch format) or {date[],o[],h[],l[],c[],v[]}
  if (Array.isArray(raw.bars)) {
    const date = [], o = [], h = [], l = [], c = [], v = [];
    for (const b of raw.bars) {
      date.push(String(b[0])); o.push(+b[1]); h.push(+b[2]); l.push(+b[3]); c.push(+b[4]); v.push(+(b[5] || 0));
    }
    return { date, o, h, l, c, v };
  }
  if (Array.isArray(raw.c) && Array.isArray(raw.date)) {
    return { date: raw.date.map(String), o: raw.o.map(Number), h: raw.h.map(Number), l: raw.l.map(Number), c: raw.c.map(Number), v: (raw.v || raw.c.map(() => 0)).map(Number) };
  }
  return null;
}

export function sma(arr, p) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

export function ema(arr, p) {
  const out = new Array(arr.length).fill(null);
  if (arr.length < p) return out;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let i = 0; i < p; i++) prev += arr[i];
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export function rma(arr, p) {
  const out = new Array(arr.length).fill(null);
  let prev = 0, n = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (!isNum(x)) continue;
    if (n < p) { prev += x; n++; if (n === p) out[i] = prev / p; }
    else { prev = (prev * (p - 1) + x) / p; out[i] = prev; }
  }
  return out;
}

export function rollingStd(arr, p) {
  const out = new Array(arr.length).fill(null);
  for (let i = p - 1; i < arr.length; i++) {
    let s = 0, s2 = 0, n = 0;
    for (let j = i - p + 1; j <= i; j++) { const x = arr[j]; if (isNum(x)) { s += x; s2 += x * x; n++; } }
    if (n > 1) { const m = s / n; out[i] = Math.sqrt(Math.max(0, s2 / n - m * m)); }
  }
  return out;
}

export function rsi(closes, p = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < p + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / p, al = loss / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(0, d)) / p;
    al = (al * (p - 1) + Math.max(0, -d)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function trueRange(b) {
  const tr = new Array(b.c.length).fill(null);
  for (let i = 0; i < b.c.length; i++) {
    if (i === 0) { tr[i] = b.h[i] - b.l[i]; continue; }
    tr[i] = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
  }
  return tr;
}

export function atr(b, p = 14) { return rma(trueRange(b), p); }

export function macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => (isNum(f[i]) && isNum(s[i]) ? f[i] - s[i] : null));
  const valid = line.filter(isNum);
  const signalValid = ema(valid, sig);
  const signal = new Array(closes.length).fill(null);
  let k = 0;
  for (let i = 0; i < closes.length; i++) if (isNum(line[i])) signal[i] = signalValid[k++];
  const hist = closes.map((_, i) => (isNum(line[i]) && isNum(signal[i]) ? line[i] - signal[i] : null));
  return { line, signal, hist };
}

export function bollinger(closes, p = 20, mult = 2) {
  const mid = sma(closes, p), sd = rollingStd(closes, p);
  const upper = closes.map((_, i) => (isNum(mid[i]) && isNum(sd[i]) ? mid[i] + mult * sd[i] : null));
  const lower = closes.map((_, i) => (isNum(mid[i]) && isNum(sd[i]) ? mid[i] - mult * sd[i] : null));
  return { mid, upper, lower };
}

export function adx(b, p = 14) {
  const n = b.c.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = b.h[i] - b.h[i - 1], dn = b.l[i - 1] - b.l[i];
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = rma(trueRange(b), p), pdi = rma(plusDM, p), mdi = rma(minusDM, p);
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!isNum(tr[i]) || tr[i] === 0) continue;
    plusDI[i] = (100 * pdi[i]) / tr[i];
    minusDI[i] = (100 * mdi[i]) / tr[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }
  const validDx = dx.filter(isNum);
  const smoothed = rma(validDx, p);
  const out = new Array(n).fill(null);
  let k = 0;
  for (let i = 0; i < n; i++) if (isNum(dx[i])) out[i] = smoothed[k++];
  return { adx: out, plusDI, minusDI };
}

export function stochastic(b, p = 14, smooth = 3) {
  const n = b.c.length;
  const k = new Array(n).fill(null);
  for (let i = p - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) { hh = Math.max(hh, b.h[j]); ll = Math.min(ll, b.l[j]); }
    k[i] = hh === ll ? 50 : ((b.c[i] - ll) / (hh - ll)) * 100;
  }
  const kk = k.filter(isNum), dValid = sma(kk, smooth);
  const d = new Array(n).fill(null);
  let idx = 0;
  for (let i = 0; i < n; i++) if (isNum(k[i])) d[i] = dValid[idx++];
  return { k, d };
}

export function obv(b) {
  const out = new Array(b.c.length).fill(0);
  for (let i = 1; i < b.c.length; i++) {
    const prev = out[i - 1];
    out[i] = prev + (b.c[i] > b.c[i - 1] ? b.v[i] : b.c[i] < b.c[i - 1] ? -b.v[i] : 0);
  }
  return out;
}

/** Least-squares slope of y over the window ending at i. */
export function slopeAt(y, i, p) {
  if (i < p - 1) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let j = 0; j < p; j++) {
    const x = j, v = y[i - p + 1 + j];
    if (!isNum(v)) return null;
    sx += x; sy += v; sxy += x * v; sxx += x * x;
  }
  const d = p * sxx - sx * sx;
  return d === 0 ? 0 : (p * sxy - sx * sy) / d;
}

function rollingExtreme(arr, p, fn) {
  const out = new Array(arr.length).fill(null);
  for (let i = p - 1; i < arr.length; i++) {
    let m = arr[i - p + 1];
    for (let j = i - p + 2; j <= i; j++) m = fn(m, arr[j]);
    out[i] = m;
  }
  return out;
}

/* ------------------------------ feature spec ------------------------------- */

export const FEATURES = [
  'rsi14', 'rsi2', 'macdHist', 'ema8_21', 'ema21_50', 'ema50_200', 'close_ema200',
  'adx14', 'diDiff', 'atrPct', 'atrRatio', 'bbPctB', 'bbWidth', 'stochK', 'stochKD',
  'volZ', 'mom5', 'mom20', 'mom60', 'mom120', 'dist52wHigh', 'dist52wLow',
  'rvolRatio', 'obvSlope', 'spyTrend', 'spyRsi', 'vixLevel', 'vixChg5',
  'gap', 'body', 'isCrypto', 'isEtf',
  // Self-normalised versions: each instrument's own trailing-252-day z-score.
  // Without these the model sees similar inputs for every symbol in a given
  // regime and cannot rank opportunities against each other.
  'z_mom20', 'z_mom60', 'z_rsi14', 'z_dist52wHigh', 'z_atrPct', 'z_volZ', 'z_ema50_200', 'z_bbPctB',
];

export const FEATURE_LABELS = {
  rsi14: 'RSI(14)', rsi2: 'RSI(2)', macdHist: 'MACD histogram', ema8_21: 'EMA 8-21 spread',
  ema21_50: 'EMA 21-50 spread', ema50_200: 'EMA 50-200 spread', close_ema200: 'Price vs EMA 200',
  adx14: 'ADX(14)', diDiff: 'DI+ minus DI-', atrPct: 'ATR % of price', atrRatio: 'ATR expansion',
  bbPctB: 'Bollinger %B', bbWidth: 'Bollinger width', stochK: 'Stochastic %K', stochKD: '%K minus %D',
  volZ: 'Volume z-score', mom5: '5-day momentum', mom20: '20-day momentum', mom60: '60-day momentum',
  mom120: '120-day momentum', dist52wHigh: 'Distance from 52w high', dist52wLow: 'Distance from 52w low',
  rvolRatio: 'Vol 20d vs 60d', obvSlope: 'On-balance volume slope', spyTrend: 'S&P 500 trend',
  spyRsi: 'S&P 500 RSI', vixLevel: 'VIX level', vixChg5: 'VIX 5-day change', gap: 'Overnight gap',
  body: 'Candle body', isCrypto: 'Crypto asset', isEtf: 'ETF / fund',
  z_mom20: 'Momentum 20d (own history)', z_mom60: 'Momentum 60d (own history)',
  z_rsi14: 'RSI vs own norm', z_dist52wHigh: 'Distance from high (own norm)',
  z_atrPct: 'Volatility vs own norm', z_volZ: 'Volume surge (own norm)',
  z_ema50_200: 'Trend spread (own norm)', z_bbPctB: 'Bollinger %B (own norm)',
};

/** Trailing z-score using the window ending at i-1 (no lookahead). */
function trailingZ(values, i, window = 252) {
  const start = Math.max(0, i - window);
  const end = i; // exclusive
  const n = end - start;
  if (n < 60) return 0;
  let s = 0, s2 = 0, cnt = 0;
  for (let j = start; j < end; j++) {
    const v = values[j];
    if (isNum(v)) { s += v; s2 += v * v; cnt++; }
  }
  if (cnt < 60) return 0;
  const mean = s / cnt;
  const sd = Math.sqrt(Math.max(1e-12, s2 / cnt - mean * mean));
  const x = values[i];
  if (!isNum(x)) return 0;
  return Math.max(-4, Math.min(4, (x - mean) / sd));
}

/**
 * Build the full feature matrix for a symbol.
 * @returns {{dates:string[], X:Float64Array[], close:number[], atr:number[], raw:Object[]}}
 */
export function buildFeatures(bars, ctx = {}) {
  const b = bars;
  const n = b.c.length;
  const closes = b.c;
  const atr14 = atr(b, 14);
  const atr50 = atr(b, 50);
  const rsi14 = rsi(closes, 14);
  const rsi2 = rsi(closes, 2);
  const m = macd(closes);
  const e8 = ema(closes, 8), e21 = ema(closes, 21), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const ad = adx(b, 14);
  const bb = bollinger(closes, 20, 2);
  const st = stochastic(b, 14, 3);
  const ob = obv(b);
  const volMa = sma(b.v, 20), volSd = rollingStd(b.v, 20);
  const hh252 = rollingExtreme(b.h, 252, Math.max), ll252 = rollingExtreme(b.l, 252, Math.min);
  const logret = closes.map((c, i) => (i === 0 ? 0 : Math.log(c / closes[i - 1])));
  const sd20 = rollingStd(logret, 20), sd60 = rollingStd(logret, 60);
  const spyTrend = alignCtx(b.date, ctx.spy?.date, ctx.spy?.trend, 0);
  const spyRsiA = alignCtx(b.date, ctx.spy?.date, ctx.spy?.rsi, 50);
  const vixA = alignCtx(b.date, ctx.vix?.date, ctx.vix?.close, 18);
  const vixMaA = alignCtx(b.date, ctx.vix?.date, ctx.vix?.ma20, 18);

  // Arrays needed for the self-normalised (trailing z-score) features
  const arrMom20 = new Array(n), arrMom60 = new Array(n), arrDistHigh = new Array(n);
  const arrAtrPct = new Array(n), arrVolZ = new Array(n), arrEmaSp = new Array(n), arrBb = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = atr14[i], c = closes[i];
    arrMom20[i] = isNum(a) && a > 0 && i >= 20 ? (c - closes[i - 20]) / a : null;
    arrMom60[i] = isNum(a) && a > 0 && i >= 60 ? (c - closes[i - 60]) / a : null;
    arrDistHigh[i] = isNum(a) && a > 0 && isNum(hh252[i]) ? (hh252[i] - c) / a : null;
    arrAtrPct[i] = isNum(a) && a > 0 ? (a / c) * 100 : null;
    arrVolZ[i] = isNum(volMa[i]) && volMa[i] > 0 ? (b.v[i] - volMa[i]) / Math.max(volSd[i] || 0, volMa[i] * 0.15) : null;
    arrEmaSp[i] = isNum(e50[i]) && isNum(e200[i]) && isNum(a) && a > 0 ? (e50[i] - e200[i]) / a : null;
    arrBb[i] = isNum(bb.upper[i]) && bb.upper[i] > bb.lower[i] ? (c - bb.lower[i]) / (bb.upper[i] - bb.lower[i]) : null;
  }

  const dates = [], X = [], closeOut = [], atrOut = [], raw = [];
  for (let i = WARMUP; i < n; i++) {
    if (!isNum(atr14[i]) || atr14[i] <= 0 || !isNum(rsi14[i]) || !isNum(e200[i]) || !isNum(hh252[i])) continue;
    const a = atr14[i], c = closes[i];
    const lo14 = ll252[i];
    const row = new Array(FEATURES.length);
    const spyT = spyTrend[i], spyR = spyRsiA[i], vx = vixA[i], vxMa = vixMaA[i];
    row[0] = rsi14[i] / 100;
    row[1] = isNum(rsi2[i]) ? rsi2[i] / 100 : 0.5;
    row[2] = isNum(m.hist[i]) ? m.hist[i] / a : 0;
    row[3] = isNum(e8[i]) && isNum(e21[i]) ? (e8[i] - e21[i]) / a : 0;
    row[4] = isNum(e21[i]) && isNum(e50[i]) ? (e21[i] - e50[i]) / a : 0;
    row[5] = isNum(e50[i]) ? (e50[i] - e200[i]) / a : 0;
    row[6] = (c - e200[i]) / a;
    row[7] = isNum(ad.adx[i]) ? ad.adx[i] / 100 : 0.2;
    row[8] = isNum(ad.plusDI[i]) && isNum(ad.minusDI[i]) ? (ad.plusDI[i] - ad.minusDI[i]) / 100 : 0;
    row[9] = (a / c) * 100;
    row[10] = isNum(atr50[i]) && atr50[i] > 0 ? a / atr50[i] : 1;
    row[11] = isNum(bb.upper[i]) && bb.upper[i] > bb.lower[i] ? (c - bb.lower[i]) / (bb.upper[i] - bb.lower[i]) : 0.5;
    row[12] = isNum(bb.upper[i]) ? (bb.upper[i] - bb.lower[i]) / a : 2;
    row[13] = isNum(st.k[i]) ? st.k[i] / 100 : 0.5;
    row[14] = isNum(st.k[i]) && isNum(st.d[i]) ? (st.k[i] - st.d[i]) / 100 : 0;
    row[15] = isNum(volMa[i]) && volMa[i] > 0 ? (b.v[i] - volMa[i]) / Math.max(volSd[i] || 0, volMa[i] * 0.15) : 0;
    row[16] = i >= 5 ? (c - closes[i - 5]) / a : 0;
    row[17] = i >= 20 ? (c - closes[i - 20]) / a : 0;
    row[18] = i >= 60 ? (c - closes[i - 60]) / a : 0;
    row[19] = i >= 120 ? (c - closes[i - 120]) / a : 0;
    row[20] = (hh252[i] - c) / a;
    row[21] = isNum(lo14) ? (c - lo14) / a : 0;
    row[22] = isNum(sd60[i]) && sd60[i] > 0 && isNum(sd20[i]) ? (sd20[i] * Math.sqrt(252)) / (sd60[i] * Math.sqrt(252)) : 1;
    row[23] = (() => { const s = slopeAt(ob, i, 20); return s === null ? 0 : (s * 20) / Math.max(volMa[i] || 1, 1); })();
    row[24] = spyT;
    row[25] = spyR / 100;
    row[26] = vx / 30;
    row[27] = isNum(vx) && isNum(vxMa) ? (vx - vxMa) / 30 : 0;
    row[28] = i > 0 ? (b.o[i] - closes[i - 1]) / a : 0;
    row[29] = (c - b.o[i]) / a;
    row[30] = b.cls === 'crypto' ? 1 : 0;
    row[31] = b.cls === 'etf' || b.cls === 'index' ? 1 : 0;
    row[32] = trailingZ(arrMom20, i);
    row[33] = trailingZ(arrMom60, i);
    row[34] = trailingZ(rsi14, i);
    row[35] = trailingZ(arrDistHigh, i);
    row[36] = trailingZ(arrAtrPct, i);
    row[37] = trailingZ(arrVolZ, i);
    row[38] = trailingZ(arrEmaSp, i);
    row[39] = trailingZ(arrBb, i);
    // Winsorise: a handful of crashed microcaps produce 4,000-sigma outliers that
    // overflow float32 gradients without adding information.
    for (let k = 0; k < row.length; k++) {
      if (!isNum(row[k])) row[k] = 0;
      else if (row[k] > 20) row[k] = 20;
      else if (row[k] < -20) row[k] = -20;
    }
    dates.push(b.date[i]); X.push(row); closeOut.push(c); atrOut.push(a);
    raw.push({ i, rsi: rsi14[i], adx: ad.adx[i], ema50: e50[i], ema200: e200[i], hh252: hh252[i], ll252: lo14, atrPct: (a / c) * 100, macdHist: m.hist[i], bbPctB: row[11], stochK: st.k[i] });
  }
  return { dates, X, close: closeOut, atr: atrOut, raw, indexOffset: WARMUP };
}

/** Forward-fill a context series onto the symbol's date axis. */
function alignCtx(dates, ctxDates, ctxVals, fallback) {
  const out = new Array(dates.length).fill(fallback);
  if (!ctxDates || !ctxVals || !ctxDates.length) return out;
  let p = 0, last = fallback;
  for (let i = 0; i < dates.length; i++) {
    while (p < ctxDates.length && ctxDates[p] <= dates[i]) {
      if (isNum(ctxVals[p])) last = ctxVals[p];
      p++;
    }
    out[i] = last;
  }
  return out;
}

/** Build SPY/VIX context features from raw series (node + browser). */
export function buildContext(series) {
  const out = {};
  if (series.spy) {
    const b = normaliseBars(series.spy);
    const e50 = ema(b.c, 50), a = atr(b, 14), r = rsi(b.c, 14);
    out.spy = {
      date: b.date,
      trend: b.c.map((c, i) => (isNum(e50[i]) && isNum(a[i]) && a[i] > 0 ? (c - e50[i]) / a[i] : 0)),
      rsi: r.map((x) => (isNum(x) ? x : 50)),
    };
  }
  if (series.vix) {
    const b = normaliseBars(series.vix);
    const ma = sma(b.c, 20);
    out.vix = { date: b.date, close: b.c, ma20: ma.map((x) => (isNum(x) ? x : b.c[0])) };
  }
  return out;
}

/* ------------------------------ inference --------------------------------- */

function softmax(z) {
  const m = Math.max(z[0], z[1], z[2]);
  const e = [Math.exp(z[0] - m), Math.exp(z[1] - m), Math.exp(z[2] - m)];
  const s = e[0] + e[1] + e[2];
  return [e[0] / s, e[1] / s, e[2] / s];
}

export function predictHead(row, head, mean, std) {
  // head.W is 3 x F weights, head.b is 3 biases
  const z = [0, 0, 0];
  const F = row.length;
  let dot0 = 0, dot1 = 0, dot2 = 0;
  const W = head.W;
  for (let k = 0; k < F; k++) {
    // clamp matches the trainer's clip, so inference sees the same distribution
    const x = Math.max(-8, Math.min(8, (row[k] - mean[k]) / std[k]));
    dot0 += W[0][k] * x; dot1 += W[1][k] * x; dot2 += W[2][k] * x;
  }
  z[0] = dot0 + head.b[0]; z[1] = dot1 + head.b[1]; z[2] = dot2 + head.b[2];
  const p = softmax(z);
  return { win: p[0], loss: p[1], timeout: p[2] };
}

export function predict(row, model) {
  const long = predictHead(row, model.heads.long, model.mean, model.std);
  const short = predictHead(row, model.heads.short, model.mean, model.std);
  return { long, short };
}

/** Expected R multiple for a side, net of estimated costs. */
export function expectancy(probs, costR = 0, rr = TP_MULT / SL_MULT) {
  return probs.win * rr - probs.loss * 1 - costR;
}

/* --------------------------- trade construction ---------------------------- */

const round = (x, d = 2) => {
  if (!isNum(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function swingLevels(bars, lookback = 90) {
  const b = bars;
  const n = b.c.length;
  const start = Math.max(2, n - lookback);
  const highs = [], lows = [];
  for (let i = start; i < n - 2; i++) {
    if (b.h[i] > b.h[i - 1] && b.h[i] > b.h[i - 2] && b.h[i] >= b.h[i + 1] && b.h[i] >= b.h[i + 2]) highs.push({ price: b.h[i], i });
    if (b.l[i] < b.l[i - 1] && b.l[i] < b.l[i - 2] && b.l[i] <= b.l[i + 1] && b.l[i] <= b.l[i + 2]) lows.push({ price: b.l[i], i });
  }
  const price = b.c[n - 1];
  const res = highs.filter((h) => h.price > price).sort((a, c) => a.price - c.price).slice(0, 3);
  const sup = lows.filter((l) => l.price < price).sort((a, c) => c.price - a.price).slice(0, 3);
  return { supports: sup, resistances: res, high52: Math.max(...b.h.slice(-252)), low52: Math.min(...b.l.slice(-252)) };
}

export function riskFlags(bars, inst, raw) {
  const b = bars;
  const n = b.c.length;
  const price = b.c[n - 1];
  const dollarVol = b.c.slice(-20).reduce((s, c, idx) => s + c * b.v.slice(-20)[idx], 0) / 20;
  const flags = [];
  if (raw.atrPct > 6) flags.push({ level: 'high', text: `Volatility is extreme — ATR is ${raw.atrPct.toFixed(1)}% of price. Halve normal position size.` });
  else if (raw.atrPct > 3.5) flags.push({ level: 'med', text: `Elevated volatility — ATR is ${raw.atrPct.toFixed(1)}% of price.` });
  if (inst?.cls === 'equity') flags.push({ level: 'info', text: 'Single stocks can gap through stops on earnings. Check the earnings date before sizing.' });
  if (inst?.cls === 'crypto') flags.push({ level: 'med', text: 'Crypto trades 24/7 with no circuit breakers; overnight-equity risk rules do not apply.' });
  if (dollarVol < 20e6) flags.push({ level: 'med', text: `Thin liquidity: about $${(dollarVol / 1e6).toFixed(1)}M traded per day. Expect slippage.` });
  if (price < 1) flags.push({ level: 'high', text: 'Sub-$1 price — spreads and delisting risk distort every technical signal.' });
  if (raw.adx !== null && raw.adx < 15) flags.push({ level: 'info', text: 'ADX below 15 means no trend is in force; mean-reversion failure is common here.' });
  return flags;
}

/**
 * Full analysis for one symbol: signal, trade plan, levels, explanation.
 * @param {object} p {bars, ctx, model, inst, accountSize, riskPct, costPct, minEdge}
 */
export function analyze({ bars, ctx, model, inst, accountSize = 25000, riskPct = 1, costPct = 0.0005, minEdge = 0.15, threshold = 0.42, minDirProb = 0.55 }) {
  const b = normaliseBars(bars);
  if (!b || b.c.length < WARMUP + 30) return { ok: false, error: `Need at least ${WARMUP + 30} daily bars; got ${b ? b.c.length : 0}.` };
  const feats = buildFeatures({ ...b, cls: inst?.cls }, ctx);
  const last = feats.X.length - 1;
  if (last < 0) return { ok: false, error: 'Not enough valid history to compute features.' };
  const row = feats.X[last];
  const probs = predict(row, model);
  const price = feats.close[last];
  const a = feats.atr[last];
  const raw = feats.raw[last];
  const costR = (2 * costPct * price) / (a * SL_MULT);
  const expLong = expectancy(probs.long, costR);
  const expShort = expectancy(probs.short, costR);
  const dirLong = probs.long.win / Math.max(1e-9, probs.long.win + probs.long.loss);
  const dirShort = probs.short.win / Math.max(1e-9, probs.short.win + probs.short.loss);

  // Identical gate to the one used in the backtest: probability above the
  // break-even hit rate for a 2:1 target/stop, and positive expectancy after
  // costs. Directional odds (p_win / (p_win + p_loss)) are reported but are not
  // used as a filter — with a 2:1 target they sit near 1/3 by construction.
  const passL = probs.long.win >= threshold && expLong > minEdge;
  const passS = probs.short.win >= threshold && expShort > minEdge;
  let side = 'flat';
  if (passL && (!passS || expLong >= expShort)) side = 'long';
  else if (passS) side = 'short';
  else if (!passL && !passS) side = 'flat';

  const edge = side === 'long' ? expLong : side === 'short' ? expShort : Math.max(expLong, expShort);
  const dirProb = side === 'short' ? dirShort : dirLong;

  const dir = side === 'long' ? 1 : -1;
  const stop = side === 'flat' ? null : price - dir * a * SL_MULT;
  const target = side === 'flat' ? null : price + dir * a * TP_MULT;
  const tp1 = side === 'flat' ? null : price + dir * a * 1.0;
  const riskPerShare = side === 'flat' ? a * SL_MULT : Math.abs(price - stop);
  const riskCash = (accountSize * riskPct) / 100;
  const shares = riskPerShare > 0 ? Math.floor(riskCash / riskPerShare) : 0;
  const notional = shares * price;

  // Feature attribution: contribution of each standardized feature to the chosen class
  const head = side === 'short' ? model.heads.short : model.heads.long;
  const cls = side === 'flat' ? 0 : 0; // class 0 = win
  const contrib = FEATURES.map((name, k) => {
    const z = (row[k] - model.mean[k]) / model.std[k];
    return { name, label: FEATURE_LABELS[name] || name, z, value: row[k], push: head.W[cls][k] * z };
  }).filter((c) => Math.abs(c.push) > 0.02).sort((x, y) => Math.abs(y.push) - Math.abs(x.push));

  const levels = swingLevels(b, 120);
  const volatilityBand = raw.atrPct > 5 ? 'extreme' : raw.atrPct > 3 ? 'high' : raw.atrPct > 1.5 ? 'normal' : 'low';
  const trendScore = clamp01(0.5 + 0.15 * row[5] + 0.1 * row[4] + 0.08 * row[6]);
  const momentumScore = clamp01(0.5 + 0.12 * row[17] + 0.06 * row[19] + 0.05 * row[2]);
  const reversionScore = clamp01(1 - Math.abs(row[0] - 0.5) * 2 * 0.5 - Math.max(0, row[11] - 1) * 0.25);
  const volumeScore = clamp01(0.5 + 0.2 * Math.max(-1, Math.min(1, row[15] / 2)) + 0.2 * Math.max(-1, Math.min(1, row[23])));
  const marketScore = clamp01(0.5 + 0.2 * Math.max(-1, Math.min(1, row[24])) - 0.1 * Math.max(0, row[26] - 0.6));

  const conviction = side === 'flat' ? 'No edge' : edge > 0.35 ? 'Strong' : edge > 0.22 ? 'Moderate' : 'Weak';

  return {
    ok: true, version: ENGINE_VERSION,
    symbol: inst?.symbol, name: inst?.name, cls: inst?.cls, sector: inst?.sector,
    asOf: feats.dates[last], price, atr: a, atrPct: raw.atrPct,
    change: b.c.length > 1 ? ((b.c[b.c.length - 1] / b.c[b.c.length - 2] - 1) * 100) : 0,
    signal: side, conviction, edgeR: edge, directionProb: dirProb,
    probs: { long: probs.long, short: probs.short },
    expectancy: { long: expLong, short: expShort },
    trade: side === 'flat' ? null : {
      side, entry: price, stop: round(stop, 4), target: round(target, 4), tp1: round(tp1, 4),
      riskPerShare: round(riskPerShare, 4), rewardPerShare: round(riskPerShare * (TP_MULT / SL_MULT), 4),
      rr: TP_MULT / SL_MULT, stopDistancePct: round((riskPerShare / price) * 100, 2),
      shares, notional: round(notional, 2), riskCash: round(riskCash, 2),
      riskReward: `1 : ${(TP_MULT / SL_MULT).toFixed(1)}`,
      invalidation: side === 'long'
        ? `A daily close below ${round(stop, 2)} voids the setup; below ${round(price - 2 * a, 2)} the trend structure is broken.`
        : `A daily close above ${round(stop, 2)} voids the setup; above ${round(price + 2 * a, 2)} the downtrend structure is broken.`,
    },
    context: {
      trend: trendScore, momentum: momentumScore, reversion: reversionScore, volume: volumeScore, market: marketScore,
      label: raw.rsi !== null ? (raw.rsi > 70 ? 'Overbought' : raw.rsi < 30 ? 'Oversold' : 'Neutral') : 'n/a',
      adx: raw.adx, rsi: raw.rsi, volatilityBand,
      spyTrend: row[24], vix: row[26] * 30,
      ema50: raw.ema50, ema200: raw.ema200,
    },
    levels: {
      supports: levels.supports.map((s) => round(s.price, 2)),
      resistances: levels.resistances.map((s) => round(s.price, 2)),
      high52: round(levels.high52, 2), low52: round(levels.low52, 2),
    },
    drivers: contrib.slice(0, 8).map((c) => ({ label: c.label, z: round(c.z, 2), push: round(c.push, 3) })),
    flags: riskFlags(b, inst, raw),
    meta: { bars: b.c.length, featureDate: feats.dates[last], costR: round(costR, 4), minEdge, accountSize, riskPct },
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/* ------------------------------- backtest --------------------------------- */

/**
 * Simulate the model's trades over a feature matrix.
 * @param {object} p {bars, feats, probs:[{long,short}], costPct, threshold, side?}
 */
export function simulateTrades({ bars, feats, probs, threshold = BREAKEVEN_P, costPct = 0.0005, tpMult = TP_MULT, slMult = SL_MULT, horizon = HORIZON, alwaysSide = 0, minEdge = 0.10 }) {
  const b = bars;
  const trades = [];
  for (let k = 0; k < probs.length; k++) {
    const p = probs[k];
    const i = feats.raw[k].i;
    if (!p) continue;
    const price = feats.close[k], a = feats.atr[k];
    const costR = (2 * costPct * price) / (a * slMult);
    const eL = p.long.win * (tpMult / slMult) - p.long.loss - costR;
    const eS = p.short.win * (tpMult / slMult) - p.short.loss - costR;
    let side = 0;
    // The gate is economic, not cosmetic: probability above the break-even hit
    // rate for this reward:risk geometry, and positive expectancy after costs.
    if (alwaysSide) side = alwaysSide;
    else if (eL > eS && eL > minEdge && p.long.win >= threshold) side = 1;
    else if (eS >= eL && eS > minEdge && p.short.win >= threshold) side = -1;
    if (!side) continue;
    const entry = price;
    const isLong = side === 1;
    // Barrier geometry is side-aware: the 2.0 ATR target sits in the direction of
    // the trade and the 1.0 ATR stop against it. Getting this backwards makes a
    // short look far better than it is, so it is computed from `side` explicitly.
    const tpLevel = isLong ? entry + tpMult * a : entry - tpMult * a;
    const slLevel = isLong ? entry - slMult * a : entry + slMult * a;
    let outcome = 'timeout', exit = null, barsHeld = horizon, gapped = false;
    for (let j = 1; j <= horizon; j++) {
      const ii = i + j;
      if (ii >= b.c.length) { barsHeld = j - 1; break; }
      const hitTp = isLong ? b.h[ii] >= tpLevel : b.l[ii] <= tpLevel;
      const hitSl = isLong ? b.l[ii] <= slLevel : b.h[ii] >= slLevel;
      const open = b.o[ii];
      if (hitSl) {
        // A bar that opens beyond the stop fills at the open, not at the stop.
        exit = isLong ? Math.min(slLevel, open) : Math.max(slLevel, open);
        gapped = isLong ? open < slLevel : open > slLevel;
        outcome = 'loss'; barsHeld = j; break;
      }
      if (hitTp) {
        // A bar that gaps through a resting target fills at the open (better fill).
        exit = isLong ? Math.max(tpLevel, open) : Math.min(tpLevel, open);
        outcome = 'win'; barsHeld = j; break;
      }
    }
    if (outcome === 'timeout') {
      const ii = Math.min(i + horizon, b.c.length - 1);
      exit = b.c[ii];
    }
    const exitIdx = Math.min(i + Math.max(1, barsHeld), b.c.length - 1);
    const grossR = ((exit - entry) / (a * slMult)) * side;
    const netR = grossR - costR;
    trades.push({
      date: feats.dates[k], exitDate: b.date[exitIdx] || feats.dates[k], side: side === 1 ? 'long' : 'short',
      entry, exit, outcome, barsHeld, netR, edge: side === 1 ? eL : eS,
      pWin: side === 1 ? p.long.win : p.short.win, atr: a, price, gapped,
    });
  }
  return trades;
}

export function metrics(trades) {
  if (!trades.length) return { trades: 0 };
  const wins = trades.filter((t) => t.netR > 0), losses = trades.filter((t) => t.netR <= 0);
  const sum = trades.reduce((s, t) => s + t.netR, 0);
  const grossWin = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netR, 0);
  let eq = 0, peak = 0, dd = 0;
  const curve = [{ x: trades[0].date, y: 0 }];
  for (const t of trades) { eq += t.netR; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); curve.push({ x: t.date, y: eq }); }
  const mean = sum / trades.length;
  const variance = trades.reduce((s, t) => s + (t.netR - mean) ** 2, 0) / Math.max(1, trades.length - 1);
  const sd = Math.sqrt(variance);
  const byYear = {};
  for (const t of trades) { const y = t.date.slice(0, 4); byYear[y] = byYear[y] || { trades: 0, r: 0, wins: 0 }; byYear[y].trades++; byYear[y].r += t.netR; if (t.netR > 0) byYear[y].wins++; }
  return {
    trades: trades.length,
    winRate: wins.length / trades.length,
    avgWinR: wins.length ? grossWin / wins.length : 0,
    avgLossR: losses.length ? -grossLoss / losses.length : 0,
    expectancyR: mean,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    totalR: sum,
    maxDrawdownR: dd,
    sharpePerTrade: sd > 0 ? mean / sd : 0,
    timeoutShare: trades.filter((t) => t.outcome === 'timeout').length / trades.length,
    longShare: trades.filter((t) => t.side === 'long').length / trades.length,
    curve, byYear,
  };
}

export const DISCLAIMER = 'AlphaDesk is a research and education tool. Its model is a statistical estimator trained on historical prices; it does not know the future, it cannot read news events in real time, and its output is not investment advice. Backtested results are hypothetical, exclude taxes and financing, and are subject to overfitting and regime change. Never risk money you cannot afford to lose.';

/* ------------------------ walk-forward backtest (browser) ------------------ */

/**
 * Replay one symbol using only the fold that was trained before each year.
 * This is the same out-of-sample discipline used to build the published
 * performance numbers, so the per-symbol result is not an in-sample fit.
 */
export function backtestWalkForward({ bars, ctx, model, inst, costPct = 0.0005, threshold = 0.42 }) {
  const b = normaliseBars(bars);
  if (!b || b.c.length < WARMUP + 40) return { trades: [], metrics: { trades: 0 }, feats: null };
  const feats = buildFeatures({ ...b, cls: inst?.cls }, ctx);
  const trades = [];
  const years = [...new Set(feats.dates.map((d) => d.slice(0, 4)))];
  let usedFolds = 0;
  for (const y of years) {
    const fold = (model.folds || []).find((f) => String(f.year) === y);
    if (!fold) continue;
    const keep = [];
    for (let k = 0; k < feats.X.length; k++) if (feats.dates[k].slice(0, 4) === y) keep.push(k);
    if (keep.length < 10) continue;
    const sub = {
      dates: keep.map((k) => feats.dates[k]), X: keep.map((k) => feats.X[k]),
      close: keep.map((k) => feats.close[k]), atr: keep.map((k) => feats.atr[k]), raw: keep.map((k) => feats.raw[k]),
    };
    const probs = sub.X.map((row) => ({
      long: predictHead(row, fold.heads.long, fold.mean, fold.std),
      short: predictHead(row, fold.heads.short, fold.mean, fold.std),
    }));
    trades.push(...simulateTrades({ bars: b, feats: sub, probs, threshold, costPct }));
    usedFolds++;
  }
  return { trades, metrics: metrics(trades), feats, foldsUsed: usedFolds };
}

/* ---------------------------- label generation ---------------------------- */

/**
 * Triple-barrier label for bar i, entering at that bar's close.
 * Barriers: +tpMult*ATR (take profit) and -slMult*ATR (stop) for a long.
 * When both barriers are touched in the same bar the ADVERSE one is assumed
 * first, which keeps labels pessimistic rather than optimistic.
 * @returns {0|1|2|3} 0 = TP first, 1 = SL first, 2 = timeout, 3 = insufficient data
 */
export function tripleBarrier(bars, i, atrVal, side = 1, tpMult = TP_MULT, slMult = SL_MULT, horizon = HORIZON) {
  const b = bars;
  const n = b.c.length;
  const entry = b.c[i];
  if (!isNum(entry) || !isNum(atrVal) || atrVal <= 0) return 3;
  const isLong = side === 1;
  const tpLevel = isLong ? entry + tpMult * atrVal : entry - tpMult * atrVal;
  const slLevel = isLong ? entry - slMult * atrVal : entry + slMult * atrVal;
  for (let j = 1; j <= horizon; j++) {
    const k = i + j;
    if (k >= n) return 3;
    const hitTp = isLong ? b.h[k] >= tpLevel : b.l[k] <= tpLevel;
    const hitSl = isLong ? b.l[k] <= slLevel : b.h[k] >= slLevel;
    if (hitSl) return 1;
    if (hitTp) return 0;
  }
  return 2;
}
