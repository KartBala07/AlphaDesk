/* =============================================================================
 * chart-pro.js — an interactive charting engine for AlphaDesk.
 *
 * TradingView-style behaviour, hand-rolled on canvas with no dependencies:
 *   · pan / zoom (wheel anchored at the cursor, drag to pan, dbl-click to reset)
 *   · intervals (1D / 1W / 1M) aggregated from daily bars
 *   · chart types: candles, hollow candles, OHLC bars, line, area, Heikin-Ashi
 *   · overlays: EMA/SMA, Bollinger Bands; sub-panes: volume, RSI, MACD
 *   · drawing tools: trendline, horizontal line, rectangle, Fibonacci, measure
 *   · crosshair with axis tags and an OHLC readout callback
 *   · model levels (entry / stop / target) drawn as price lines
 * ========================================================================== */

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------- indicators ------------------------------- */

function sma(values, p) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= p) sum -= values[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function ema(values, p) {
  const out = new Array(values.length).fill(null);
  if (values.length < p) return out;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let i = 0; i < p; i++) prev += values[i];
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function stdev(values, p) {
  const out = new Array(values.length).fill(null);
  for (let i = p - 1; i < values.length; i++) {
    let s = 0, s2 = 0;
    for (let j = i - p + 1; j <= i; j++) { s += values[j]; s2 += values[j] * values[j]; }
    const m = s / p;
    out[i] = Math.sqrt(Math.max(0, s2 / p - m * m));
  }
  return out;
}
function rsiSeries(values, p = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < p + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = values[i] - values[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (p - 1) + Math.max(0, d)) / p;
    al = (al * (p - 1) + Math.max(0, -d)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function macdSeries(values, fast = 12, slow = 26, sig = 9) {
  const f = ema(values, fast), s = ema(values, slow);
  const line = values.map((_, i) => (isNum(f[i]) && isNum(s[i]) ? f[i] - s[i] : null));
  const dense = line.filter(isNum);
  const sigDense = ema(dense, sig);
  const signal = new Array(values.length).fill(null);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (isNum(line[i])) signal[i] = sigDense[k++];
  const hist = values.map((_, i) => (isNum(line[i]) && isNum(signal[i]) ? line[i] - signal[i] : null));
  return { line, signal, hist };
}

/* ------------------------------- aggregation ------------------------------ */

function aggregate(bars, interval) {
  if (interval === '1D' || !interval) return bars;
  const out = { date: [], o: [], h: [], l: [], c: [], v: [] };
  let key = null, cur = null;
  for (let i = 0; i < bars.c.length; i++) {
    const d = bars.date[i];
    let k;
    if (interval === '1W') {
      const dt = new Date(`${d}T00:00:00Z`);
      const day = (dt.getUTCDay() + 6) % 7;         // Monday = 0
      dt.setUTCDate(dt.getUTCDate() - day);
      k = dt.toISOString().slice(0, 10);
    } else {
      k = d.slice(0, 7);                              // YYYY-MM
    }
    if (k !== key) {
      if (cur) { out.date.push(cur.date); out.o.push(cur.o); out.h.push(cur.h); out.l.push(cur.l); out.c.push(cur.c); out.v.push(cur.v); }
      key = k;
      cur = { date: d, o: bars.o[i], h: bars.h[i], l: bars.l[i], c: bars.c[i], v: bars.v[i] };
    } else {
      cur.h = Math.max(cur.h, bars.h[i]);
      cur.l = Math.min(cur.l, bars.l[i]);
      cur.c = bars.c[i];
      cur.v += bars.v[i];
      cur.date = d;                                   // bar is stamped with the last day of the period
    }
  }
  if (cur) { out.date.push(cur.date); out.o.push(cur.o); out.h.push(cur.h); out.l.push(cur.l); out.c.push(cur.c); out.v.push(cur.v); }
  return out;
}

function heikinAshi(bars) {
  const o = [], h = [], l = [], c = [];
  for (let i = 0; i < bars.c.length; i++) {
    const close = (bars.o[i] + bars.h[i] + bars.l[i] + bars.c[i]) / 4;
    const open = i === 0 ? (bars.o[i] + bars.c[i]) / 2 : (o[i - 1] + c[i - 1]) / 2;
    o.push(open); c.push(close);
    h.push(Math.max(bars.h[i], open, close));
    l.push(Math.min(bars.l[i], open, close));
  }
  return { date: bars.date, o, h, l, c, v: bars.v };
}

/* --------------------------------- helper -------------------------------- */

const RANGES = { '1M': 21, '3M': 63, '6M': 126, 'YTD': 0, '1Y': 252, '2Y': 504, '5Y': 1260, 'MAX': 1e9 };

function fmtPrice(v) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}
const fmtVol = (n) => {
  if (!isNum(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

/* --------------------------------- engine -------------------------------- */

export class ProChart {
  /**
   * @param {HTMLElement} el
   * @param {object} opts {onCrosshair, onDrawingsChange, symbol}
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = {
      type: 'candles', interval: '1D', range: '1Y',
      overlays: ['ema20', 'ema50', 'ema200'], panes: ['volume'],
      padRight: 62, padBottom: 22, padTop: 8,
      ...opts,
    };
    this.el.classList.add('pchart');
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = Math.min(3, window.devicePixelRatio || 1);

    this.bars = { date: [], o: [], h: [], l: [], c: [], v: [] };
    this.view = { from: 0, count: 252 };
    this.cross = null;
    this.draft = null;
    this.tool = 'cursor';
    this.drawings = [];
    this.levels = [];
    this.drag = null;
    this.hoverDrawing = -1;
    this.dirty = true;

    this.#bind();
    this.ro = new ResizeObserver(() => { this.dirty = true; });
    this.ro.observe(this.el);
    this.#startLoop();
  }

  /* ------------------------------ public api ----------------------------- */

  setData({ symbol, bars }) {
    this.symbol = symbol;
    this.daily = bars;
    this.labels = bars.date;
    this.#rebuild();
    this.fit();
    return this;
  }

  setInterval(interval) { this.opts.interval = interval; this.#rebuild(); this.fit(); return this; }
  setType(type) { this.opts.type = type; this.dirty = true; return this; }
  setRange(range) {
    this.opts.range = range;
    this.fit();
    return this;
  }
  setOverlays(arr) { this.opts.overlays = arr; this.dirty = true; return this; }
  setPanes(arr) { this.opts.panes = arr; this.dirty = true; return this; }
  setModelLevels(levels) { this.levels = levels || []; this.dirty = true; return this; }
  setTool(tool) { this.tool = tool; this.el.style.cursor = tool === 'cursor' ? 'crosshair' : 'crosshair'; return this; }

  setDrawings(list) { this.drawings = Array.isArray(list) ? list : []; this.dirty = true; return this; }
  getDrawings() { return this.drawings; }
  clearDrawings() { this.drawings = []; this.#emit(); this.dirty = true; return this; }
  undoDrawing() { this.drawings.pop(); this.#emit(); this.dirty = true; return this; }

  fit() {
    const n = this.bars.c.length;
    if (!n) return this;
    let count;
    const perDay = this.opts.interval === '1W' ? 5 : this.opts.interval === '1M' ? 21 : 1;
    if (this.opts.range === 'YTD') {
      const y = new Date().getUTCFullYear();
      const first = this.bars.date.findIndex((d) => d.startsWith(String(y)));
      count = Math.max(8, n - (first < 0 ? n - 60 : first));
    } else {
      count = Math.min(Math.round((RANGES[this.opts.range] || 252) / perDay), n);
    }
    this.view = { from: Math.max(0, n - count), count: Math.max(8, count) };
    this.dirty = true;
    return this;
  }

  zoom(factor, anchorIdx = null) {
    const n = this.bars.c.length;
    const { from, count } = this.view;
    const anchor = anchorIdx == null ? from + count / 2 : anchorIdx;
    const next = clamp(count * factor, 12, Math.max(20, n));
    const ratio = (anchor - from) / count;
    let nf = anchor - ratio * next;
    nf = clamp(nf, 0, Math.max(0, n - next));
    this.view = { from: nf, count: next };
    this.dirty = true;
    return this;
  }

  pan(barsDelta) {
    const n = this.bars.c.length;
    this.view.from = clamp(this.view.from + barsDelta, 0, Math.max(0, n - this.view.count));
    this.dirty = true;
    return this;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this._raf);
    clearInterval(this._timer);
    document.removeEventListener('visibilitychange', this._onVis);
    this.ro?.disconnect();
    this.el.removeEventListener('wheel', this._wheel);
    this.el.innerHTML = '';
  }

  /* ------------------------------- internals ----------------------------- */

  #rebuild() {
    this.bars = this.opts.interval === '1D' ? this.daily : aggregate(this.daily, this.opts.interval);
    const closes = this.bars.c;
    this.ind = {
      ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200),
      sma20: sma(closes, 20), sma50: sma(closes, 50),
      bbMid: sma(closes, 20), bbUp: null, bbLo: null,
      rsi: rsiSeries(closes, 14), macd: macdSeries(closes),
    };
    const sd = stdev(closes, 20);
    this.ind.bbUp = closes.map((_, i) => (isNum(this.ind.bbMid[i]) && isNum(sd[i]) ? this.ind.bbMid[i] + 2 * sd[i] : null));
    this.ind.bbLo = closes.map((_, i) => (isNum(this.ind.bbMid[i]) && isNum(sd[i]) ? this.ind.bbMid[i] - 2 * sd[i] : null));
    this.display = this.opts.type === 'heikin' ? heikinAshi(this.bars) : this.bars;
    this.dirty = true;
  }

  #emit() {
    this.opts.onDrawingsChange?.(this.drawings);
  }

  #bind() {
    const el = this.el;
    el.tabIndex = 0;
    el.addEventListener('mousedown', (e) => this.#down(e));
    el.addEventListener('mousemove', (e) => this.#move(e));
    window.addEventListener('mouseup', (e) => this.#up(e));
    el.addEventListener('mouseleave', () => { this.cross = null; this.dirty = true; });
    el.addEventListener('dblclick', () => this.fit());
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = this.#hitDrawing(this.#pos(e));
      if (idx >= 0) { this.drawings.splice(idx, 1); this.#emit(); this.dirty = true; }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { this.pan(-this.view.count * 0.05); e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.pan(this.view.count * 0.05); e.preventDefault(); }
      if (e.key === '+' || e.key === '=') { this.zoom(0.9); e.preventDefault(); }
      if (e.key === '-') { this.zoom(1.1); e.preventDefault(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.hoverDrawing >= 0) {
        this.drawings.splice(this.hoverDrawing, 1); this.hoverDrawing = -1; this.#emit(); this.dirty = true;
      }
    });
    this._wheel = (e) => {
      e.preventDefault();
      const pos = this.#pos(e);
      const idx = this.#idxAt(pos.x);
      this.zoom(e.deltaY > 0 ? 1.12 : 0.89, idx);
      this.cross = { x: pos.x, y: pos.y, ...this.#dataAt(pos) };
    };
    el.addEventListener('wheel', this._wheel, { passive: false });
  }

  #pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #geom() {
    const w = this.el.clientWidth || this.el.parentElement?.clientWidth || 600;
    const h = this.el.clientHeight || this.el.parentElement?.clientHeight || 400;
    const padR = this.opts.padRight, padB = this.opts.padBottom, padT = this.opts.padTop;
    const plotW = Math.max(40, w - padR);
    const panes = [{ key: 'main' }];
    const subH = [];
    let used = 0;
    for (const p of this.opts.panes) {
      const hh = p === 'volume' ? 0.14 : p === 'rsi' ? 0.17 : 0.17;
      subH.push(Math.round(h * hh));
      used += subH[subH.length - 1];
    }
    const gaps = Math.max(0, this.opts.panes.length) * 6;
    const mainH = Math.max(90, h - padB - padT - used - gaps);
    let y = padT;
    panes[0].top = y; panes[0].height = mainH; y += mainH;
    this.opts.panes.forEach((key, i) => {
      y += 6;
      panes.push({ key, top: y, height: subH[i] });
      y += subH[i];
    });
    return { w, h, plotW, padR, padB, padT, panes };
  }

  #xScale(g) {
    const { from, count } = this.view;
    const bw = g.plotW / count;
    return { bw, x: (i) => (i - from + 0.5) * bw, iAt: (px) => from + (px / bw) - 0.5 };
  }

  #priceScale(g) {
    const { from, count } = this.view;
    let lo = Infinity, hi = -Infinity;
    const a = Math.max(0, Math.floor(from)), b = Math.min(this.display.c.length - 1, Math.ceil(from + count));
    for (let i = a; i <= b; i++) {
      lo = Math.min(lo, this.display.l[i]);
      hi = Math.max(hi, this.display.h[i]);
      for (const k of this.opts.overlays) {
        const series = this.ind[k.replace('bb', 'bb')];
        if (k === 'bb') {
          if (isNum(this.ind.bbUp[i])) { hi = Math.max(hi, this.ind.bbUp[i]); lo = Math.min(lo, this.ind.bbLo[i]); }
        } else if (series && isNum(series[i])) { hi = Math.max(hi, series[i]); lo = Math.min(lo, series[i]); }
      }
    }
    for (const lv of this.levels) if (isNum(lv.price)) { hi = Math.max(hi, lv.price); lo = Math.min(lo, lv.price); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) { lo = (lo || 1) * 0.99; hi = (hi || 1) * 1.01; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const pane = g.panes[0];
    const y = (p) => pane.top + pane.height - ((p - lo) / (hi - lo)) * pane.height;
    const priceAt = (py) => lo + ((pane.top + pane.height - py) / pane.height) * (hi - lo);
    return { lo, hi, y, priceAt };
  }

  #idxAt(px) {
    const g = this.#geom();
    return clamp(this.#xScale(g).iAt(px), 0, this.bars.c.length - 1);
  }

  #dataAt(pos) {
    const g = this.#geom();
    const sc = this.#priceScale(g);
    return { idx: this.#idxAt(pos.x), price: sc.priceAt(pos.y) };
  }

  #tick() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  #flush() {
    if (this.destroyed) return;
    this.dirty = false;
    try { this.draw(); } catch (e) { console.error('chart draw failed', e); }
  }

  /**
   * Repaint on the next frame for smooth pan/zoom, plus a timer as a safety net:
   * background tabs throttle requestAnimationFrame, and a chart that only paints
   * on rAF can sit blank until the tab is focused again.
   */
  #startLoop() {
    const step = () => {
      if (this.destroyed) return;
      if (this.dirty) this.#flush();
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
    this._timer = setInterval(() => { if (this.dirty) this.#flush(); }, 120);
    this._onVis = () => { if (!document.hidden) this.#flush(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  draw() {
    const g = this.#geom();
    const ctx = this.ctx;
    const W = Math.max(1, Math.round(g.w * this.dpr));
    const H = Math.max(1, Math.round(g.h * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.canvas.style.width = `${g.w}px`;
    this.canvas.style.height = `${g.h}px`;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    const up = cssVar('--long', '#2ee6a8');
    const down = cssVar('--short', '#ff5d6c');
    const line = cssVar('--line', '#202834');
    const dim = cssVar('--dim', '#6a7484');
    const muted = cssVar('--muted', '#9aa5b5');
    const text = cssVar('--text', '#e9eef5');
    const panel = cssVar('--panel', '#0f1318');

    if (!this.bars.c.length) return;
    const xs = this.#xScale(g);
    const ps = this.#priceScale(g);
    const from = Math.max(0, Math.floor(this.view.from));
    const to = Math.min(this.bars.c.length - 1, Math.ceil(this.view.from + this.view.count));

    /* grid */
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.strokeStyle = line;
    ctx.globalAlpha = 0.5;
    for (let i = 0; i <= 5; i++) {
      const p = ps.lo + ((ps.hi - ps.lo) * i) / 5;
      const y = ps.y(p);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
    }
    const wantCols = Math.max(3, Math.floor(g.plotW / 110));
    const stepBars = Math.max(1, Math.round(this.view.count / wantCols));
    ctx.globalAlpha = 0.28;
    for (let i = Math.ceil(from / stepBars) * stepBars; i <= to; i += stepBars) {
      const x = xs.x(i);
      ctx.beginPath(); ctx.moveTo(x, g.padT); ctx.lineTo(x, g.h - g.padB); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* price axis */
    ctx.fillStyle = dim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const p = ps.lo + ((ps.hi - ps.lo) * i) / 5;
      ctx.fillText(fmtPrice(p), g.plotW + 7, ps.y(p));
    }

    /* time axis */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastLabel = -1e9;
    for (let i = Math.ceil(from / stepBars) * stepBars; i <= to; i += stepBars) {
      const x = xs.x(i);
      if (x < 26 || x > g.plotW - 26) continue;
      if (x - lastLabel < 62) continue;
      lastLabel = x;
      const d = this.bars.date[i] || '';
      const label = this.opts.interval === '1M' ? d.slice(0, 7) : d.slice(2);
      ctx.fillText(label, x, g.h - g.padB + 6);
    }

    /* volume + indicator panes */
    const paneOf = (key) => g.panes.find((p) => p.key === key);
    if (paneOf('volume')) this.#drawVolume(ctx, g, paneOf('volume'), xs, from, to, up, down, dim, line);
    if (paneOf('rsi')) this.#drawRsi(ctx, g, paneOf('rsi'), xs, from, to, dim, line, muted, cssVar('--accent', '#5aa9ff'));
    if (paneOf('macd')) this.#drawMacd(ctx, g, paneOf('macd'), xs, from, to, dim, line, up, down);

    /* bollinger */
    if (this.opts.overlays.includes('bb')) {
      this.#band(ctx, g, xs, this.ind.bbUp, this.ind.bbLo, from, to, cssVar('--accent', '#5aa9ff'));
    }

    /* price series */
    const d = this.display;
    const bodyW = Math.max(1, Math.min(14, xs.bw * 0.66));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, g.panes[0].top, g.plotW, g.panes[0].height);
    ctx.clip();

    if (this.opts.type === 'line' || this.opts.type === 'area') {
      if (this.opts.type === 'area') {
        const grad = ctx.createLinearGradient(0, g.panes[0].top, 0, g.panes[0].top + g.panes[0].height);
        grad.addColorStop(0, 'rgba(46,230,168,.24)');
        grad.addColorStop(1, 'rgba(46,230,168,0)');
        ctx.beginPath();
        ctx.moveTo(xs.x(from), ps.y(d.c[from]));
        for (let i = from + 1; i <= to; i++) ctx.lineTo(xs.x(i), ps.y(d.c[i]));
        ctx.lineTo(xs.x(to), g.panes[0].top + g.panes[0].height);
        ctx.lineTo(xs.x(from), g.panes[0].top + g.panes[0].height);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const x = xs.x(i), y = ps.y(d.c[i]);
        if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = up;
      ctx.lineWidth = 1.7;
      ctx.stroke();
    } else if (this.opts.type === 'bars') {
      ctx.lineWidth = 1;
      for (let i = from; i <= to; i++) {
        const x = xs.x(i);
        const col = d.c[i] >= d.o[i] ? up : down;
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(x, ps.y(d.h[i])); ctx.lineTo(x, ps.y(d.l[i])); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - bodyW / 2, ps.y(d.o[i])); ctx.lineTo(x, ps.y(d.o[i])); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, ps.y(d.c[i])); ctx.lineTo(x + bodyW / 2, ps.y(d.c[i])); ctx.stroke();
      }
    } else if (this.opts.type === 'hollow') {
      for (let i = from; i <= to; i++) {
        const x = xs.x(i), rising = d.c[i] >= d.o[i];
        const col = rising ? up : down;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, ps.y(d.h[i])); ctx.lineTo(x, ps.y(d.l[i])); ctx.stroke();
        const yO = ps.y(d.o[i]), yC = ps.y(d.c[i]);
        const top = Math.min(yO, yC), hh = Math.max(1, Math.abs(yC - yO));
        if (rising) { ctx.strokeRect(x - bodyW / 2, top, bodyW, hh); }
        else ctx.fillRect(x - bodyW / 2, top, bodyW, hh);
      }
    } else {
      for (let i = from; i <= to; i++) {
        const x = xs.x(i);
        const rising = d.c[i] >= d.o[i];
        const col = rising ? up : down;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, ps.y(d.h[i])); ctx.lineTo(x, ps.y(d.l[i])); ctx.stroke();
        const yO = ps.y(d.o[i]), yC = ps.y(d.c[i]);
        const top = Math.min(yO, yC), hh = Math.max(1, Math.abs(yC - yO));
        ctx.fillRect(x - bodyW / 2, top, bodyW, hh);
      }
    }

    /* overlays: moving averages */
    const OVERLAY_COLORS = { ema20: '#a78bfa', ema50: '#5aa9ff', ema200: '#ffb84d', sma20: '#94a3b8', sma50: '#f472b6' };
    for (const key of this.opts.overlays) {
      if (key === 'bb') continue;
      const series = this.ind[key];
      if (!series) continue;
      ctx.beginPath();
      let started = false;
      for (let i = from; i <= to; i++) {
        const v = series[i];
        if (!isNum(v)) { started = false; continue; }
        const x = xs.x(i), y = ps.y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = OVERLAY_COLORS[key] || muted;
      ctx.lineWidth = 1.35;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.restore();

    /* model levels */
    const visible = this.levels.filter((lv) => isNum(lv.price) && ps.y(lv.price) >= g.panes[0].top - 2 && ps.y(lv.price) <= g.panes[0].top + g.panes[0].height + 2)
      .sort((a2, b2) => b2.price - a2.price);
    let lastTagY = -Infinity;
    for (const lv of visible) {
      const y = ps.y(lv.price);
      ctx.strokeStyle = lv.color; ctx.lineWidth = 1.1;
      ctx.setLineDash(lv.dash || [5, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      if (!lv.label) continue;
      ctx.font = '9.5px ui-monospace, monospace';
      const tw = ctx.measureText(lv.label).width + 8;
      const labelY = Math.min(Math.max(y, lastTagY + 15), g.panes[0].top + g.panes[0].height - 6);
      lastTagY = labelY;
      if (Math.abs(labelY - y) > 1) {
        ctx.globalAlpha = 0.5; ctx.strokeStyle = lv.color;
        ctx.beginPath(); ctx.moveTo(3, y); ctx.lineTo(6, labelY); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = lv.color; ctx.globalAlpha = 0.18;
      ctx.fillRect(2, labelY - 7, tw, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = lv.color;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(lv.label, 6, labelY);
    }

    /* drawings */
    this.#drawDrawings(ctx, g, xs, ps, dim);

    /* last price tag */
    const lastC = this.bars.c[this.bars.c.length - 1];
    const lastY = ps.y(lastC);
    const rising = this.bars.c[this.bars.c.length - 1] >= this.bars.o[this.bars.o.length - 1];
    if (lastY > g.panes[0].top && lastY < g.panes[0].top + g.panes[0].height) {
      ctx.strokeStyle = rising ? up : down;
      ctx.globalAlpha = 0.6; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, lastY); ctx.lineTo(g.plotW, lastY); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const tag = fmtPrice(lastC);
      ctx.font = '10.5px ui-monospace, monospace';
      const tw = Math.max(48, ctx.measureText(tag).width + 12);
      ctx.fillStyle = rising ? up : down;
      ctx.fillRect(g.plotW + 1, lastY - 8, tw, 16);
      ctx.fillStyle = panel;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(tag, g.plotW + 7, lastY);
    }

    /* watermark */
    ctx.font = '600 44px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = text;
    ctx.globalAlpha = 0.045;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.symbol || '', g.plotW / 2, g.panes[0].top + g.panes[0].height / 2);
    ctx.globalAlpha = 1;

    /* crosshair */
    if (this.cross) {
      const { x, y } = this.cross;
      const idx = clamp(Math.round(this.#idxAt(x)), 0, this.bars.c.length - 1);
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.42;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xs.x(idx), g.padT); ctx.lineTo(xs.x(idx), g.h - g.padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // axis tags
      ctx.font = '10.5px ui-monospace, monospace';
      const price = ps.priceAt(y);
      const ptxt = fmtPrice(price);
      const pw = ctx.measureText(ptxt).width + 12;
      ctx.fillStyle = cssVar('--panel-3', '#171e26');
      ctx.fillRect(g.plotW + 1, y - 8, pw, 16);
      ctx.fillStyle = text;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(ptxt, g.plotW + 7, y);

      const dtxt = this.bars.date[idx] || '';
      const dw = ctx.measureText(dtxt).width + 12;
      ctx.fillStyle = cssVar('--panel-3', '#171e26');
      ctx.fillRect(xs.x(idx) - dw / 2, g.h - g.padB + 1, dw, 16);
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.fillText(dtxt, xs.x(idx), g.h - g.padB + 9);

      this.opts.onCrosshair?.({
        idx, date: dtxt, price,
        o: this.display.o[idx], h: this.display.h[idx], l: this.display.l[idx], c: this.display.c[idx],
        v: this.bars.v[idx],
      });
    } else {
      this.opts.onCrosshair?.(null);
    }
  }

  #band(ctx, g, xs, upper, lower, from, to, color) {
    ctx.beginPath();
    let started = false;
    for (let i = from; i <= to; i++) {
      if (!isNum(upper[i])) { started = false; continue; }
      const x = xs.x(i), y = this.#priceScale(g).y(upper[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    for (let i = to; i >= from; i--) {
      if (!isNum(lower[i])) continue;
      ctx.lineTo(xs.x(i), this.#priceScale(g).y(lower[i]));
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.07;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  #drawVolume(ctx, g, pane, xs, from, to, up, down, dim, line) {
    const bars = this.bars;
    let maxV = 1;
    for (let i = from; i <= to; i++) maxV = Math.max(maxV, bars.v[i] || 0);
    ctx.strokeStyle = line; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(0, pane.top); ctx.lineTo(g.plotW, pane.top); ctx.stroke();
    ctx.globalAlpha = 1;
    for (let i = from; i <= to; i++) {
      const x = xs.x(i);
      const hgt = ((bars.v[i] || 0) / maxV) * (pane.height - 4);
      ctx.fillStyle = bars.c[i] >= bars.o[i] ? up : down;
      ctx.globalAlpha = 0.32;
      ctx.fillRect(x - Math.min(5, xs.bw * 0.33), pane.top + pane.height - hgt, Math.min(10, xs.bw * 0.66), hgt);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = dim;
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`Vol ${fmtVol(bars.v[to])}`, 4, pane.top + 2);
  }

  #drawRsi(ctx, g, pane, xs, from, to, dim, line, muted, accent) {
    const y = (v) => pane.top + pane.height - (v / 100) * pane.height;
    ctx.strokeStyle = line; ctx.globalAlpha = 0.6;
    for (const lvl of [30, 50, 70]) {
      ctx.setLineDash(lvl === 50 ? [2, 3] : [4, 4]);
      ctx.beginPath(); ctx.moveTo(0, y(lvl)); ctx.lineTo(g.plotW, y(lvl)); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = dim; ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('RSI 14', 4, pane.top + 2);
    ctx.textAlign = 'right';
    ctx.fillText('70', g.plotW + 58, y(70) - 5);
    ctx.fillText('30', g.plotW + 58, y(30) - 5);
    ctx.beginPath();
    let started = false;
    for (let i = from; i <= to; i++) {
      const v = this.ind.rsi[i];
      if (!isNum(v)) { started = false; continue; }
      const px = xs.x(i), py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.stroke();
  }

  #drawMacd(ctx, g, pane, xs, from, to, dim, line, up, down) {
    let lo = 0, hi = 0;
    for (let i = from; i <= to; i++) {
      for (const s of [this.ind.macd.line[i], this.ind.macd.signal[i], this.ind.macd.hist[i]]) {
        if (isNum(s)) { lo = Math.min(lo, s); hi = Math.max(hi, s); }
      }
    }
    const pad = (hi - lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    const y = (v) => pane.top + pane.height - ((v - lo) / (hi - lo)) * pane.height;
    ctx.strokeStyle = line; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(g.plotW, y(0)); ctx.stroke();
    ctx.globalAlpha = 1;
    for (let i = from; i <= to; i++) {
      const v = this.ind.macd.hist[i];
      if (!isNum(v)) continue;
      const x = xs.x(i);
      const y0 = y(0), y1 = y(v);
      ctx.fillStyle = v >= 0 ? up : down;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x - Math.min(3, xs.bw * 0.25), Math.min(y0, y1), Math.min(6, xs.bw * 0.5), Math.abs(y1 - y0) || 1);
    }
    ctx.globalAlpha = 1;
    for (const [series, color] of [[this.ind.macd.line, '#5aa9ff'], [this.ind.macd.signal, '#ffb84d']]) {
      ctx.beginPath();
      let started = false;
      for (let i = from; i <= to; i++) {
        const v = series[i];
        if (!isNum(v)) { started = false; continue; }
        const px = xs.x(i), py = y(v);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
    }
    ctx.fillStyle = dim; ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('MACD 12 26 9', 4, pane.top + 2);
  }

  /* ------------------------------ drawings ------------------------------- */

  #drawDrawings(ctx, g, xs, ps, dim) {
    const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
    all.forEach((dr, i) => {
      const hot = i === this.hoverDrawing;
      const color = dr.color || (dr.tool === 'rect' ? 'rgba(90,169,255,.9)' : cssVar('--accent', '#5aa9ff'));
      ctx.strokeStyle = color;
      ctx.lineWidth = hot ? 2.2 : 1.4;
      const p1 = dr.p1, p2 = dr.p2 || dr.p1;
      if (dr.tool === 'trend') {
        ctx.beginPath(); ctx.moveTo(xs.x(p1.i), ps.y(p1.p)); ctx.lineTo(xs.x(p2.i), ps.y(p2.p)); ctx.stroke();
        ctx.fillStyle = color;
        for (const p of [p1, p2]) { ctx.beginPath(); ctx.arc(xs.x(p.i), ps.y(p.p), hot ? 3.6 : 2.6, 0, Math.PI * 2); ctx.fill(); }
        if (dr.tool === 'trend' && p2.i !== p1.i) {
          const rr = (p2.p - p1.p) / Math.max(1e-9, p2.i - p1.i);
          ctx.font = '9.5px ui-monospace, monospace';
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText(`${((Math.pow(1 + Math.abs(rr) / Math.max(1e-9, p1.p), 1) - 1) * 100 * ((p2.i - p1.i) / Math.max(1, p2.i - p1.i))).toFixed(1)}%`, xs.x(p2.i) + 4, ps.y(p2.p) - 4);
        }
      } else if (dr.tool === 'hline') {
        ctx.setLineDash(hot ? [] : [6, 4]);
        ctx.beginPath(); ctx.moveTo(0, ps.y(p1.p)); ctx.lineTo(g.plotW, ps.y(p1.p)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '9.5px ui-monospace, monospace';
        const label = fmtPrice(p1.p);
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = color;
        ctx.fillRect(g.plotW - tw - 2, ps.y(p1.p) - 7, tw, 14);
        ctx.fillStyle = '#08120e';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, g.plotW - tw + 2, ps.y(p1.p));
      } else if (dr.tool === 'rect') {
        const x1 = xs.x(p1.i), x2 = xs.x(p2.i), y1 = ps.y(p1.p), y2 = ps.y(p2.p);
        ctx.fillStyle = 'rgba(90,169,255,.10)';
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        if (Math.abs(x2 - x1) > 60) {
          ctx.font = '9.5px ui-monospace, monospace';
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          const pct = ((p2.p - p1.p) / Math.max(1e-9, p1.p)) * 100;
          ctx.fillText(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, Math.min(x1, x2) + 4, Math.min(y1, y2) - 4);
        }
      } else if (dr.tool === 'fib') {
        const ratio = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const x1 = xs.x(p1.i), x2 = xs.x(p2.i);
        const yTop = ps.y(Math.max(p1.p, p2.p)), yBot = ps.y(Math.min(p1.p, p2.p));
        ctx.fillStyle = 'rgba(90,169,255,.05)';
        ctx.fillRect(Math.min(x1, x2), yTop, Math.abs(x2 - x1), yBot - yTop || 1);
        ratio.forEach((r2, k) => {
          const yy = yTop + (yBot - yTop) * r2;
          ctx.strokeStyle = k === 0 || k === ratio.length - 1 ? color : 'rgba(90,169,255,.55)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(Math.min(x1, x2), yy); ctx.lineTo(Math.max(x1, x2), yy); ctx.stroke();
          const lvl = p1.p + (p2.p - p1.p) * r2;
          ctx.font = '9px ui-monospace, monospace';
          ctx.fillStyle = dim; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(`${r2.toFixed(3)}  ${fmtPrice(lvl)}`, Math.max(x1, x2) + 4, yy);
        });
      } else if (dr.tool === 'measure') {
        const x1 = xs.x(p1.i), x2 = xs.x(p2.i), y1 = ps.y(p1.p), y2 = ps.y(p2.p);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) || 1, Math.abs(y2 - y1) || 1);
        ctx.setLineDash([]);
        const pct = ((p2.p - p1.p) / Math.max(1e-9, p1.p)) * 100;
        const bars = Math.round(p2.i - p1.i);
        const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  ${bars} bars`;
        ctx.font = '600 11px ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 12;
        const lx = clamp((x1 + x2) / 2 - tw / 2, 2, g.plotW - tw - 2);
        ctx.fillStyle = pct >= 0 ? cssVar('--long', '#2ee6a8') : cssVar('--short', '#ff5d6c');
        ctx.globalAlpha = 0.9;
        ctx.fillRect(lx, Math.min(y1, y2) - 22, tw, 17);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#08120e';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 6, Math.min(y1, y2) - 13);
      }
    });
  }

  #hitDrawing(pos) {
    const g = this.#geom();
    const xs = this.#xScale(g);
    const ps = this.#priceScale(g);
    let best = -1, bestD = 10;
    this.drawings.forEach((dr, i) => {
      const p1 = dr.p1, p2 = dr.p2 || dr.p1;
      let d = Infinity;
      if (dr.tool === 'hline') d = Math.abs(ps.y(p1.p) - pos.y);
      else if (dr.tool === 'trend') d = distToSegment(pos.x, pos.y, xs.x(p1.i), ps.y(p1.p), xs.x(p2.i), ps.y(p2.p));
      else {
        const x1 = Math.min(xs.x(p1.i), xs.x(p2.i)), x2 = Math.max(xs.x(p1.i), xs.x(p2.i));
        const y1 = Math.min(ps.y(p1.p), ps.y(p2.p)), y2 = Math.max(ps.y(p1.p), ps.y(p2.p));
        if (pos.x >= x1 - 4 && pos.x <= x2 + 4 && pos.y >= y1 - 4 && pos.y <= y2 + 4) {
          d = Math.min(Math.abs(pos.x - x1), Math.abs(pos.x - x2), Math.abs(pos.y - y1), Math.abs(pos.y - y2));
        }
      }
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /* ------------------------------- pointer ------------------------------- */

  #down(e) {
    if (e.button !== 0) return;
    const pos = this.#pos(e);
    const data = this.#dataAt(pos);
    this.el.focus();
    if (this.tool !== 'cursor') {
      const p1 = { i: data.idx, p: data.price };
      this.draft = { tool: this.tool, p1, p2: p1 };
      return;
    }
    const hit = this.#hitDrawing(pos);
    if (hit >= 0) { this.hoverDrawing = hit; this.dirty = true; return; }
    this.drag = { x: pos.x, from: this.view.from };
  }

  #move(e) {
    const pos = this.#pos(e);
    if (this.draft) {
      const data = this.#dataAt(pos);
      this.draft.p2 = { i: data.idx, p: data.price };
    } else if (this.drag) {
      const g = this.#geom();
      const bw = g.plotW / this.view.count;
      const n = this.bars.c.length;
      this.view.from = clamp(this.drag.from - (pos.x - this.drag.x) / bw, 0, Math.max(0, n - this.view.count));
    } else {
      this.hoverDrawing = this.#hitDrawing(pos);
    }
    this.cross = { x: pos.x, y: pos.y };
    this.dirty = true;
  }

  #up() {
    if (this.draft) {
      const d = this.draft;
      const same = d.tool === 'hline' || (d.p2 && (Math.abs(d.p2.i - d.p1.i) > 0.05 || Math.abs(d.p2.p - d.p1.p) > 1e-9));
      if (same && isNum(d.p1.p)) {
        this.drawings.push({ tool: d.tool, p1: { ...d.p1 }, p2: d.p2 ? { ...d.p2 } : null });
        this.#emit();
      } else if (d.tool === 'hline' && isNum(d.p1.p)) {
        this.drawings.push({ tool: 'hline', p1: { ...d.p1 }, p2: null });
        this.#emit();
      }
      this.draft = null;
      this.tool = 'cursor';
      this.opts.onToolChange?.('cursor');
      this.dirty = true;
    }
    this.drag = null;
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export { fmtPrice, fmtVol, RANGES };
