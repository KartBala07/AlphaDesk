/* =============================================================================
 * charts.js — dependency-free canvas renderers (candles, equity curves, bars).
 * Theme-aware: colours are read from CSS custom properties at draw time.
 * ========================================================================== */

const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

function setupCanvas(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 260));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const fmtPrice = (v) => {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
};

/* --------------------------------- candles -------------------------------- */

export class CandleChart {
  /**
   * @param {HTMLElement} container
   * @param {object} data {date,o,h,l,c,v}
   * @param {object} opts {overlays, levels, zones, height, showVolume}
   */
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = { height: 340, showVolume: true, padding: 2.2, ...opts };
    this.data = null;
    this.hover = -1;
    this.el.classList.add('chart-box');
    this.canvas = document.createElement('canvas');
    this.canvas.style.height = `${this.opts.height}px`;
    this.el.appendChild(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.el.appendChild(this.tip);

    this.canvas.addEventListener('mousemove', (e) => this.#onMove(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = -1; this.tip.classList.remove('on'); this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  setData(data, opts = {}) {
    this.data = data;
    this.opts = { ...this.opts, ...opts };
    this.draw();
    return this;
  }

  destroy() { this.ro?.disconnect(); this.el.innerHTML = ''; }

  #geom() {
    const { ctx, w, h } = setupCanvas(this.canvas);
    const d = this.data;
    const padL = 8, padR = 56, padT = 12, padB = 20;
    const volH = this.opts.showVolume ? Math.round((h - padT - padB) * 0.18) : 0;
    const priceTop = padT + 6, priceBottom = h - padB - volH - (volH ? 8 : 0);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < d.c.length; i++) { lo = Math.min(lo, d.l[i]); hi = Math.max(hi, d.h[i]); }
    for (const ov of this.opts.overlays || []) for (const v of ov.values || []) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (const lv of this.opts.levels || []) if (Number.isFinite(lv.price)) { lo = Math.min(lo, lv.price); hi = Math.max(hi, lv.price); }
    const pad = (hi - lo) * 0.06 || hi * 0.02;
    lo -= pad; hi += pad;
    const n = d.c.length;
    const innerW = w - padL - padR;
    const bw = innerW / Math.max(1, n);
    const x = (i) => padL + bw * (i + 0.5);
    const y = (p) => priceBottom - ((p - lo) / (hi - lo || 1)) * (priceBottom - priceTop);
    return { ctx, w, h, padL, padR, padT, padB, volH, priceTop, priceBottom, lo, hi, n, bw, x, y };
  }

  draw() {
    if (!this.data || !this.data.c?.length) return;
    const g = this.#geom();
    const { ctx, w, h, padL, padR, n, bw, x, y, priceTop, priceBottom, lo, hi, volH } = g;
    const d = this.data;
    const up = cssVar('--long', '#2ee6a8');
    const down = cssVar('--short', '#ff5d6c');
    const line = cssVar('--line', '#202834');
    const dim = cssVar('--dim', '#6a7484');
    const muted = cssVar('--muted', '#9aa5b5');
    const panel = cssVar('--panel', '#0f1318');

    // horizontal grid + price axis
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const p = lo + ((hi - lo) * i) / ticks;
      const yy = y(p);
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = dim;
      ctx.fillText(fmtPrice(p), w - padR + 7, yy);
    }

    // date axis
    const labelCount = Math.max(2, Math.min(7, Math.floor((w - padL - padR) / 96)));
    ctx.fillStyle = dim;
    ctx.textAlign = 'center';
    for (let i = 0; i <= labelCount; i++) {
      const idx = Math.min(n - 1, Math.round((i * (n - 1)) / labelCount));
      const label = (d.date?.[idx] || '').slice(2);
      ctx.fillText(label, x(idx), h - 6);
    }

    // zones (entry/stop/target bands)
    for (const z of this.opts.zones || []) {
      const y1 = y(z.from), y2 = y(z.to);
      ctx.fillStyle = z.color;
      ctx.fillRect(padL, Math.min(y1, y2), w - padL - padR, Math.abs(y2 - y1));
    }

    // candles
    const bodyW = Math.max(1, Math.min(9, bw * 0.66));
    for (let i = 0; i < n; i++) {
      const o = d.o[i], c = d.c[i], hh = d.h[i], ll = d.l[i];
      const rising = c >= o;
      const col = rising ? up : down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      const cx = x(i);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, y(hh)); ctx.lineTo(cx, y(ll)); ctx.stroke();
      const yO = y(o), yC = y(c);
      const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
      if (bodyW >= 3) {
        ctx.globalAlpha = rising ? 0.9 : 0.9;
        ctx.fillRect(cx - bodyW / 2, top, bodyW, hgt);
        ctx.globalAlpha = 1;
      }
    }

    // overlays
    for (const ov of this.opts.overlays || []) {
      if (!ov.values?.length) continue;
      ctx.strokeStyle = ov.color || accentFor(ov.name);
      ctx.lineWidth = ov.width || 1.4;
      ctx.setLineDash(ov.dash || []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = ov.values[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // horizontal levels — labels are nudged apart so close levels stay readable
    const levels = (this.opts.levels || []).filter((lv) => Number.isFinite(lv.price) && y(lv.price) >= priceTop - 2 && y(lv.price) <= priceBottom + 2)
      .sort((a, b) => b.price - a.price);
    let lastLabelY = -Infinity;
    for (const lv of levels) {
      const yy = y(lv.price);
      ctx.strokeStyle = lv.color;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(lv.dash || [4, 3]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.setLineDash([]);
      if (!lv.label) continue;
      ctx.font = '9.5px ui-monospace, monospace';
      const tw = ctx.measureText(lv.label).width + 8;
      let labelY = Math.max(yy, lastLabelY + 14);
      labelY = Math.min(labelY, priceBottom - 6);
      lastLabelY = labelY;
      if (Math.abs(labelY - yy) > 1) {
        ctx.strokeStyle = lv.color;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(padL + 1, yy); ctx.lineTo(padL + 4, labelY); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = lv.color;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(padL + 2, labelY - 7, tw, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = lv.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(lv.label, padL + 6, labelY);
    }

    // volume
    if (volH) {
      const vTop = h - 14 - volH;
      const maxV = Math.max(...d.v, 1);
      for (let i = 0; i < n; i++) {
        const vh = (d.v[i] / maxV) * volH;
        ctx.fillStyle = d.c[i] >= d.o[i] ? up : down;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(x(i) - bodyW / 2, vTop + (volH - vh), bodyW, vh);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = line;
      ctx.beginPath(); ctx.moveTo(padL, vTop); ctx.lineTo(w - padR, vTop); ctx.stroke();
    }

    // last price line
    const lastC = d.c[n - 1];
    const yy = y(lastC);
    const lastUp = d.c[n - 1] >= d.o[n - 1];
    ctx.strokeStyle = lastUp ? up : down;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = lastUp ? up : down;
    const tag = fmtPrice(lastC);
    ctx.font = '10.5px ui-monospace, monospace';
    const tw = ctx.measureText(tag).width + 10;
    ctx.fillRect(w - padR + 2, yy - 8, tw, 16);
    ctx.fillStyle = panel;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, w - padR + 7, yy);

    // crosshair
    if (this.hover >= 0 && this.hover < n) {
      const cx = x(this.hover);
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, priceTop); ctx.lineTo(cx, h - 14); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  #onMove(e) {
    if (!this.data) return;
    const rect = this.canvas.getBoundingClientRect();
    const g = { padL: 8, padR: 56, w: rect.width };
    const innerW = g.w - g.padL - g.padR;
    const rel = (e.clientX - rect.left) - g.padL;
    const idx = Math.max(0, Math.min(this.data.c.length - 1, Math.floor((rel / innerW) * this.data.c.length)));
    this.hover = idx;
    this.draw();
    const d = this.data;
    const chg = idx > 0 ? ((d.c[idx] / d.c[idx - 1] - 1) * 100) : 0;
    this.tip.innerHTML = `<b>${d.date[idx]}</b> &nbsp;O ${fmtPrice(d.o[idx])} H ${fmtPrice(d.h[idx])} L ${fmtPrice(d.l[idx])} C ${fmtPrice(d.c[idx])}
      <span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>
      ${d.v?.[idx] ? `<span class="dim">vol ${shortNum(d.v[idx])}</span>` : ''}`;
    this.tip.classList.add('on');
    const cx = e.clientX - rect.left;
    const cw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.max(4, Math.min(rect.width - cw - 4, cx - cw / 2))}px`;
    this.tip.style.top = '6px';
  }
}

function accentFor(name = '') {
  if (/200/.test(name)) return '#ffb84d';
  if (/50/.test(name)) return '#5aa9ff';
  if (/21/.test(name)) return '#a78bfa';
  if (/20/.test(name)) return '#5aa9ff';
  return '#9aa5b5';
}
const shortNum = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};

/* ---------------------------------- line ---------------------------------- */

export class LineChart {
  constructor(container, opts = {}) {
    this.el = container;
    this.opts = { height: 220, fill: true, zero: true, yFormat: null, xTicks: 6, ...opts };
    this.el.classList.add('chart-box');
    this.canvas = document.createElement('canvas');
    this.canvas.style.height = `${this.opts.height}px`;
    this.el.appendChild(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.el.appendChild(this.tip);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
    this.canvas.addEventListener('mousemove', (e) => this.#move(e));
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.classList.remove('on'); this.draw(); });
  }

  setData(points, opts = {}) {
    this.points = points;
    this.opts = { ...this.opts, ...opts };
    this.draw();
    return this;
  }

  destroy() { this.ro?.disconnect(); this.el.innerHTML = ''; }

  draw() {
    const pts = this.points || [];
    const { ctx, w, h } = setupCanvas(this.canvas);
    if (pts.length < 2) return;
    const padL = 14, padR = 54, padT = 10, padB = 20;
    let lo = Math.min(...pts.map((p) => p.y)), hi = Math.max(...pts.map((p) => p.y));
    if (this.opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;
    const X = (i) => padL + (i / (pts.length - 1)) * (w - padL - padR);
    const Y = (v) => h - padB - ((v - lo) / (hi - lo)) * (h - padT - padB);
    const lineCol = this.opts.color || cssVar('--long', '#2ee6a8');
    const grid = cssVar('--line', '#202834');
    const dim = cssVar('--dim', '#6a7484');

    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const yy = Y(v);
      ctx.strokeStyle = grid; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = dim; ctx.textAlign = 'left';
      const label = this.opts.yFormat ? this.opts.yFormat(v) : Math.round(v);
      ctx.fillText(String(label), w - padR + 7, yy);
    }

    if (this.opts.zero && lo < 0 && hi > 0) {
      ctx.strokeStyle = dim; ctx.globalAlpha = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(w - padR, Y(0)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    // area
    if (this.opts.fill) {
      const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
      grad.addColorStop(0, hexA(lineCol, 0.28));
      grad.addColorStop(1, hexA(lineCol, 0));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(i), Y(pts[i].y));
      ctx.lineTo(X(pts.length - 1), Y(Math.max(lo, this.opts.zero ? 0 : lo)));
      ctx.lineTo(X(0), Y(Math.max(lo, this.opts.zero ? 0 : lo)));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.strokeStyle = lineCol;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    for (let i = 0; i < pts.length; i++) {
      const xx = X(i), yy = Y(pts[i].y);
      if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();

    // x labels
    ctx.fillStyle = dim; ctx.textAlign = 'center';
    const ticks = Math.min(this.opts.xTicks, pts.length);
    for (let i = 0; i < ticks; i++) {
      const idx = Math.round((i * (pts.length - 1)) / Math.max(1, ticks - 1));
      ctx.fillText(String(pts[idx].x).slice(0, 7), X(idx), h - 6);
    }

    if (this.hover != null && pts[this.hover]) {
      const p = pts[this.hover];
      ctx.strokeStyle = dim; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(X(this.hover), padT); ctx.lineTo(X(this.hover), h - padB); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = lineCol;
      ctx.beginPath(); ctx.arc(X(this.hover), Y(p.y), 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  #move(e) {
    const pts = this.points || [];
    if (!pts.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const padL = 14, padR = 54;
    const rel = e.clientX - rect.left - padL;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((rel / (rect.width - padL - padR)) * (pts.length - 1))));
    this.hover = i;
    this.draw();
    this.tip.textContent = `${pts[i].x}  ${this.opts.yFormat ? this.opts.yFormat(pts[i].y) : pts[i].y}`;
    this.tip.classList.add('on');
    this.tip.style.left = `${Math.max(4, Math.min(rect.width - this.tip.offsetWidth - 4, e.clientX - rect.left - this.tip.offsetWidth / 2))}px`;
    this.tip.style.top = '6px';
  }
}

/* ---------------------------------- bars ---------------------------------- */

export function barChart(container, items, opts = {}) {
  container.classList.add('chart-box');
  const canvas = document.createElement('canvas');
  const height = opts.height || 180;
  canvas.style.height = `${height}px`;
  container.appendChild(canvas);
  const draw = () => {
    const { ctx, w, h } = setupCanvas(canvas);
    const padB = 26, padT = 14, padL = 4, padR = 8;
    const n = items.length;
    if (!n) return;
    const gap = 8;
    const bw = (w - padL - padR - gap * (n - 1)) / n;
    const vals = items.map((it) => it.value);
    const max = Math.max(...vals.map(Math.abs), 1e-9);
    const zeroY = opts.split ? (h - padB + padT) / 2 : h - padB;
    const ctxUp = cssVar('--long', '#2ee6a8');
    const ctxDown = cssVar('--short', '#ff5d6c');
    const dim = cssVar('--dim', '#6a7484');
    const grid = cssVar('--line', '#202834');

    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
    ctx.font = '10px ui-monospace, monospace';
    items.forEach((it, i) => {
      const v = it.value;
      const scale = opts.split ? (h - padB - padT) / 2 : h - padB - padT;
      const bh = (Math.abs(v) / max) * scale;
      const x = padL + i * (bw + gap);
      const y = v >= 0 ? zeroY - bh : zeroY;
      ctx.fillStyle = it.color || (v >= 0 ? ctxUp : ctxDown);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      const r = Math.min(3, bw / 2);
      roundRect(ctx, x, y, bw, Math.max(1, bh), r);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.fillText(String(it.label), x + bw / 2, h - 8);
      if (opts.showValues) {
        ctx.fillStyle = cssVar('--muted', '#9aa5b5');
        ctx.fillText(it.display ?? String(v), x + bw / 2, v >= 0 ? y - 4 : y + bh + 10);
      }
    });
  };
  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(container);
  return { draw, destroy: () => { ro.disconnect(); container.innerHTML = ''; } };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

/* -------------------------------- sparkline -------------------------------- */

export function sparkline(values, { color, width = 92, height = 26 } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  cv.width = width * dpr; cv.height = height * dpr;
  cv.style.width = `${width}px`; cv.style.height = `${height}px`;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  if (!values || values.length < 2) return cv;
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = (i) => (i / (values.length - 1)) * (width - 2) + 1;
  const Y = (v) => height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4);
  ctx.beginPath();
  ctx.moveTo(X(0), Y(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(X(i), Y(values[i]));
  ctx.strokeStyle = color || (values[values.length - 1] >= values[0] ? cssVar('--long', '#2ee6a8') : cssVar('--short', '#ff5d6c'));
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
  return cv;
}

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  return `rgba(${r},${g},${b},${a})`;
}

export { fmtPrice };
