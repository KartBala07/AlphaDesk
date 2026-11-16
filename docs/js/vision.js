/**
 * AlphaDesk · vision.js — dependency-free chart screenshot analysis.
 *
 * Layer 1 (pixels, no network): find the plot area, group candle bodies by hue,
 * fit a trend on log-price proxies, detect support/resistance, estimate
 * volatility. `localAnalysis` never throws.
 * Layer 2 (optional BYO-key LLM): OpenAI / Anthropic / Google multimodal call.
 * Keys stay in the browser; `analyzeChartImage` degrades to pixel-only on error.
 *
 * Import-safe for Node: nothing touches document/window at module scope and
 * decoding falls back to a zlib PNG decoder when DOM APIs are absent.
 *
 * Limits (deliberate): single price pane (a volume sub-pane can inflate
 * volatility); linear price axis, mapped to the detected candle envelope since
 * axis padding is unreadable without OCR; charts must show coloured or
 * high-contrast neutral bodies; pixel confidence is capped at 0.6.
 * @version 1.0.0
 */

export const VISION_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_AI_SIDE = 1568; // downscale before upload: keeps tokens/bytes sane
const MAX_PIXELS = 30000000;
const UP_DEFAULT = '#26a69a';
const DOWN_DEFAULT = '#ef5350';

/* ------------------------------- utils ---------------------------------- */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const msg = (e) => (e && e.message ? String(e.message) : String(e));

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
function toHex(r, g, b) {
  const h = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/** Errors carry `.code` so callers can branch without parsing messages. */
class VisionError extends Error {
  constructor(message, code = 'vision_error') { super(message); this.name = 'VisionError'; this.code = code; }
}

/* ------------------------------- base64 --------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0, n = bytes.length; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < n ? B64[c & 63] : '=');
  }
  return out;
}

function base64ToBytes(str) {
  const s = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.max(0, Math.floor((s.length * 3) / 4) - pad));
  let p = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64.indexOf(s[i]), b = B64.indexOf(s[i + 1]), c = B64.indexOf(s[i + 2]), d = B64.indexOf(s[i + 3]);
    if (a < 0 || b < 0) break;
    out[p++] = (a << 2) | (b >> 4);
    if (c >= 0 && p < out.length) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0 && p < out.length) out[p++] = ((c & 3) << 6) | d;
  }
  return out;
}

/* --------------------------------- PNG ---------------------------------- */
// Node path only, loaded lazily so browsers never resolve "node:zlib".

let _zlibPromise = null;
function loadZlib() {
  if (!_zlibPromise) {
    const spec = 'node:zlib'; // variable spec: bundlers cannot statically resolve it
    _zlibPromise = import(spec).catch(() => {
      _zlibPromise = null;
      throw new VisionError('PNG decoding here needs Node zlib (use a browser or pass raw RGBA)', 'no_zlib');
    });
  }
  return _zlibPromise;
}

const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Read sample `i` of a scanline: 8/16-bit, or 1/2/4-bit packed indices. */
function sampleAt(buf, off, i, depth) {
  if (depth === 8) return buf[off + i];
  if (depth === 16) return buf[off + i * 2]; // high byte is plenty for analysis
  const bit = i * depth;
  return (buf[off + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

async function decodePng(input) {
  const zlib = await loadZlib(), b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33) throw new VisionError('PNG is truncated', 'bad_png');
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new VisionError('not a PNG file', 'bad_png');

  let p = 8, w = 0, h = 0, depth = 8, color = 6, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = u32be(b, p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const start = p + 8, end = start + len;
    if (end + 4 > b.length) throw new VisionError('PNG chunk overruns file', 'bad_png');
    if (type === 'IHDR') {
      w = u32be(b, start); h = u32be(b, start + 4); depth = b[start + 8]; color = b[start + 9];
      if (b[start + 10] !== 0) throw new VisionError('unsupported PNG compression', 'bad_png');
      interlace = b[start + 12];
    } else if (type === 'PLTE') palette = b.subarray(start, end);
    else if (type === 'tRNS') trns = b.subarray(start, end);
    else if (type === 'IDAT') idat.push(b.subarray(start, end));
    else if (type === 'IEND') break;
    p = end + 4;
  }
  if (!w || !h) throw new VisionError('PNG has no usable IHDR', 'bad_png');
  if (interlace === 1) throw new VisionError('interlaced PNG is not supported', 'bad_png');
  if (!idat.length) throw new VisionError('PNG has no image data', 'bad_png');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new VisionError(`unsupported PNG colour type ${color}`, 'bad_png');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new VisionError(`unsupported PNG bit depth ${depth}`, 'bad_png');

  const packed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) { packed.set(c, off); off += c.length; }
  let inf;
  try { inf = new Uint8Array(zlib.inflateSync(packed)); }
  catch { throw new VisionError('PNG image data is corrupt (inflate failed)', 'bad_png'); }

  const bpp = Math.max(1, Math.ceil((channels * depth) / 8)); // filter unit
  const stride = Math.ceil((w * channels * depth) / 8);
  if (inf.length < (stride + 1) * h) throw new VisionError('PNG scanlines are short', 'bad_png');

  // Undo scanline filters: 0 none, 1 sub, 2 up, 3 average, 4 paeth.
  const raw = new Uint8Array(stride * h);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const ft = inf[src++], ro = y * stride, po = ro - stride;
    for (let x = 0; x < stride; x++) {
      const v = inf[src + x], a = x >= bpp ? raw[ro + x - bpp] : 0;
      const u = y > 0 ? raw[po + x] : 0, c = x >= bpp && y > 0 ? raw[po + x - bpp] : 0;
      let o;
      if (ft === 0) o = v; else if (ft === 1) o = v + a; else if (ft === 2) o = v + u;
      else if (ft === 3) o = v + ((a + u) >> 1);
      else if (ft === 4) {
        const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c);
        o = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c);
      } else throw new VisionError(`bad PNG filter ${ft}`, 'bad_png');
      raw[ro + x] = o & 255;
    }
    src += stride;
  }

  const rgba = new Uint8ClampedArray(w * h * 4), maxv = depth === 16 ? 255 : (1 << depth) - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ro = y * stride, o = (y * w + x) * 4, si = x * channels;
      if (color === 0 || color === 4) {
        const g = sampleAt(raw, ro, si, depth);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = depth === 16 ? g : Math.round((g * 255) / maxv);
        rgba[o + 3] = color === 4 ? sampleAt(raw, ro, si + 1, depth) : 255;
      } else if (color === 2 || color === 6) {
        rgba[o] = sampleAt(raw, ro, si, depth); rgba[o + 1] = sampleAt(raw, ro, si + 1, depth);
        rgba[o + 2] = sampleAt(raw, ro, si + 2, depth);
        rgba[o + 3] = color === 6 ? sampleAt(raw, ro, si + 3, depth) : 255;
      } else {
        const idx = sampleAt(raw, ro, si, depth);
        if (!palette || idx * 3 + 2 >= palette.length) throw new VisionError('PNG palette index out of range', 'bad_png');
        rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { width: w, height: h, data: rgba };
}

/* ------------------------------ PNG encoder ------------------------------ */

let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  return null;
}

/** RGBA -> PNG bytes: canvas when available, zlib otherwise. */
async function encodePng(rgba, w, h) {
  const canvas = makeCanvas(w, h);
  if (canvas) {
    const ctx = canvas.getContext('2d'), id = ctx.createImageData(w, h);
    id.data.set(rgba); ctx.putImageData(id, 0, 0);
    if (typeof canvas.convertToBlob === 'function') return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    return base64ToBytes(String(canvas.toDataURL('image/png')).split(',')[1] || '');
  }
  const zlib = await loadZlib(), stride = w * 4 + 1, raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1); }
  const comp = new Uint8Array(zlib.deflateSync(raw, { level: 6 }));
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', comp), pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* --------------------------- image normalisation ------------------------ */

function fromRaw(data, width, height, channels) {
  const w = Math.floor(width), h = Math.floor(height), n = w * h;
  if (!(w > 0 && h > 0)) throw new VisionError('raw image has invalid dimensions', 'bad_image');
  const ch = channels || (data.length === n * 4 ? 4 : data.length === n * 3 ? 3 : 1);
  if (data.length < n * ch) throw new VisionError('raw pixel buffer is too short', 'bad_image');
  if (ch === 4 && data instanceof Uint8ClampedArray) return { width: w, height: h, data };
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4, s = i * ch;
    if (ch === 4) { out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = data[s + 3]; }
    else if (ch === 3) { out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = 255; }
    else { out[o] = out[o + 1] = out[o + 2] = data[s]; out[o + 3] = 255; }
  }
  return { width: w, height: h, data: out };
}

function readCanvas(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) throw new VisionError('canvas is empty', 'bad_image');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new VisionError('cannot get a 2d canvas context', 'bad_image');
  try {
    const id = ctx.getImageData(0, 0, w, h);
    return { width: id.width, height: id.height, data: id.data };
  } catch { throw new VisionError('canvas is not readable (tainted by cross-origin content)', 'bad_image'); }
}

async function drawToCanvas(src) {
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) throw new VisionError('image has no dimensions (is it loaded yet?)', 'bad_image');
  const canvas = makeCanvas(w, h);
  if (!canvas) throw new VisionError('no canvas available to rasterise the image', 'bad_image');
  canvas.getContext('2d').drawImage(src, 0, 0);
  return readCanvas(canvas);
}

function sniff(b) {
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  if (b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  return 'unknown';
}

async function decodeBytes(bytes, opts = {}) {
  const kind = sniff(bytes);
  // Browser first: createImageBitmap handles PNG/JPEG/WebP natively. Only if it
  // is unavailable (Node) do we fall back to the zlib PNG decoder below.
  if (typeof createImageBitmap === 'function' && typeof Blob !== 'undefined') {
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: `image/${kind === 'unknown' ? 'png' : kind}` }));
      try { return await drawToCanvas(bmp); } finally { if (typeof bmp.close === 'function') bmp.close(); }
    } catch { /* corrupt or unsupported: let the JS decoder produce the real error */ }
  }
  if (kind === 'png') return decodePng(bytes);
  if (kind !== 'unknown') throw new VisionError(`decoding ${kind} needs a browser; send raw RGBA or PNG`, 'unsupported_format');
  if (isNum(opts.width) && isNum(opts.height)) return fromRaw(bytes, opts.width, opts.height, opts.channels);
  throw new VisionError('unrecognised image format', 'unsupported_format');
}

/**
 * Accepts ImageData-like objects, ImageBitmap, canvas, <img>, File/Blob,
 * ArrayBuffer/TypedArray (PNG, or raw RGBA with opts.width/height), data URLs.
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>}
 */
async function normalizeImage(input, opts = {}) {
  if (!input) throw new VisionError('no image supplied', 'no_input');
  if (typeof input === 'string') {
    const m = /^data:([^;,]+);base64,(.*)$/is.exec(input);
    if (!m) throw new VisionError('string input must be a base64 data URL', 'bad_image');
    return decodeBytes(base64ToBytes(m[2]), opts);
  }
  if (typeof input === 'object' && isNum(input.width) && isNum(input.height) && input.data) {
    return fromRaw(input.data, input.width, input.height, input.channels || 4);
  }
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) return drawToCanvas(input);
  if (typeof input === 'object' && typeof input.getContext === 'function') return readCanvas(input);
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete) await new Promise((res, rej) => { input.onload = res; input.onerror = () => rej(new VisionError('image failed to load', 'bad_image')); });
    return drawToCanvas(input);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(input);
      try { return await drawToCanvas(bmp); } finally { if (typeof bmp.close === 'function') bmp.close(); }
    }
    return decodeBytes(new Uint8Array(await input.arrayBuffer()), opts);
  }
  if (input instanceof ArrayBuffer) return decodeBytes(new Uint8Array(input), opts);
  if (ArrayBuffer.isView(input)) return decodeBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength), opts);
  throw new VisionError('unsupported image input type', 'bad_image');
}

/* ----------------------------- pixel analysis --------------------------- */

function emptyPixel() {
  return {
    width: 0, height: 0, candles: { bullish: 0, bearish: 0, bullRatio: 0 },
    colors: { up: UP_DEFAULT, down: DOWN_DEFAULT, detected: [] },
    trend: { direction: 'sideways', slopePctPerBar: 0, r2: 0 },
    levels: { supports: [], resistances: [], lastPrice: null },
    volatility: { regime: 'normal', atrPctPx: 0 }, confidence: 0, notes: [],
  };
}

/** Modal colour of a sparse grid sample — the pane background, usually. */
function sampleBackground(d, w, h) {
  const buckets = new Map(), step = Math.max(2, Math.round(Math.min(w, h) / 160));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    if (d[o + 3] < 32) continue;
    const key = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++; b.r += d[o]; b.g += d[o + 1]; b.b += d[o + 2];
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n } : { r: 255, g: 255, b: 255 };
}

/**
 * Classify every pixel: +1 bullish hue (green→teal→cyan), -1 bearish hue
 * (magenta→red→orange-red), +2 high-contrast neutral (white candles on a dark
 * theme), 0 background/grid/text. Covers TradingView/Binance-style palettes on
 * light and dark themes.
 */
function buildMasks(d, w, h) {
  const cls = new Int8Array(w * h), bg = sampleBackground(d, w, h);
  const bgV = Math.max(bg.r, bg.g, bg.b) / 255;
  for (let i = 0, p = 0, n = w * h; i < n; i++, p += 4) {
    if (d[p + 3] < 40) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2];
    if (Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b) < 26) continue;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const dv = max - min, v = max / 255;
    if (dv * 3 >= max && v > 0.1) {
      let hue = max === r ? (g - b) / dv : max === g ? (b - r) / dv + 2 : (r - g) / dv + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
      if (hue >= 70 && hue <= 200) cls[i] = 1;
      else if (hue >= 285 || hue <= 22) cls[i] = -1;
    } else if (dv * 6 < max && Math.abs(v - bgV) > 0.38) cls[i] = 2; // thin text drops out later
  }
  return { cls, bg };
}

/** Keep only horizontally thick runs: bodies yes, 1-2px text/gridlines no. */
function buildBodyMask(cls, w, h, minRun) {
  const body = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let x = 0;
    while (x < w) {
      if (!cls[o + x]) { x++; continue; }
      const s = x;
      while (x < w && cls[o + x]) x++;
      if (x - s >= minRun) body.fill(1, o + s, o + x);
    }
  }
  return body;
}

/** Longest run of columns/bins scoring >= th, tolerating gaps <= maxGap. */
function largestBand(scores, n, th, maxGap) {
  let best = null, start = -1, end = -1, gap = 0;
  for (let i = 0; i < n; i++) {
    if (scores[i] >= th) { if (start < 0) start = i; end = i; gap = 0; }
    else if (start >= 0 && ++gap > maxGap) {
      if (!best || end - start > best[1] - best[0]) best = [start, end];
      start = end = -1; gap = 0;
    }
  }
  if (start >= 0 && (!best || end - start > best[1] - best[0])) best = [start, end];
  return best;
}

/** Trim `frac` of the pixel mass from each end of a 1-D score profile. */
function percentileBand(scores, n, frac) {
  let total = 0;
  for (let i = 0; i < n; i++) total += scores[i];
  if (total <= 0) return [0, n - 1];
  const lo = total * frac;
  let acc = 0, a = 0, b = n - 1;
  for (let i = 0; i < n; i++) { acc += scores[i]; if (acc >= lo) { a = i; break; } }
  acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += scores[i]; if (acc >= lo) { b = i; break; } }
  return a <= b ? [a, b] : [0, n - 1];
}

/** Volume sub-panes sit below a blank gap and share one baseline; cut them. */
function trimVolumePane(cls, row, w, x0, x1, y0, y1) {
  const from = y0 + Math.floor((y1 - y0) * 0.45);
  let bestStart = -1, bestLen = 0, run = 0;
  for (let y = from; y <= y1; y++) {
    if (row[y] === 0) run++;
    else { if (run > bestLen) { bestLen = run; bestStart = y - run; } run = 0; }
  }
  if (run > bestLen) { bestLen = run; bestStart = y1 - run + 1; }
  if (bestLen < 3 || bestStart < 0) return y1;
  // Bars in a volume pane all end on the same baseline; candles do not.
  const top = bestStart + bestLen;
  let active = 0, aligned = 0;
  for (let x = x0; x <= x1; x++) {
    let bottom = -1;
    for (let y = y1; y >= top; y--) if (cls[y * w + x]) { bottom = y; break; }
    if (bottom < 0) continue;
    active++;
    if (y1 - bottom <= 2) aligned++;
  }
  return active >= 10 && aligned / active > 0.6 ? bestStart - 1 : y1;
}

/** Densest column band, then row percentiles inside it. */
function findPlotArea(cls, w, h) {
  const col = new Uint32Array(w);
  let maxCol = 0;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) if (cls[o + x] && ++col[x] > maxCol) maxCol = col[x];
  }
  if (maxCol < 3) return null;
  // Threshold near 1: chroma excludes grid/text, and thin bodies can score only
  // 1-2px per column. Gap tolerance bridges normal inter-candle spacing.
  const band = largestBand(col, w, Math.max(1, Math.round(maxCol * 0.02)), Math.max(3, Math.round(w * 0.01)));
  if (!band) return null;
  let [x0, x1] = band;
  while (x0 < x1 && col[x0] === 0) x0++;
  while (x1 > x0 && col[x1] === 0) x1--;
  if (x1 - x0 < 8) return null;
  const row = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = x0; x <= x1; x++) if (cls[o + x]) row[y]++;
  }
  const [y0, y1] = percentileBand(row, h, 0.004);
  if (y1 - y0 < 8) return null;
  const cut = trimVolumePane(cls, row, w, x0, x1, y0, y1);
  const bottom = cut > y0 + 8 ? cut : y1;
  return bottom - y0 < 8 ? null : { x0, y0, x1, y1: bottom, w: x1 - x0 + 1, h: bottom - y0 + 1 };
}

function measureCandle(cls, body, plot, w, xa, xb) {
  let top = -1, bottom = -1, bull = 0, bear = 0, neutral = 0;
  for (let y = plot.y0; y <= plot.y1; y++) {
    const o = y * w;
    for (let x = xa; x <= xb; x++) {
      if (!body[o + x]) continue;
      if (top < 0) top = y;
      bottom = y;
      const c = cls[o + x];
      if (c === 1) bull++; else if (c === -1) bear++; else neutral++;
    }
  }
  if (top < 0) return null;
  // Wicks: walk up/down the middle of the body through the full colour mask.
  const inset = Math.max(0, Math.floor((xb - xa) * 0.3)), mx0 = xa + inset, mx1 = Math.max(mx0, xb - inset);
  let hi = top, lo = bottom;
  for (let x = mx0; x <= mx1; x++) {
    let y = top - 1;
    while (y >= plot.y0 && cls[y * w + x]) hi = Math.min(hi, y--);
    y = bottom + 1;
    while (y <= plot.y1 && cls[y * w + x]) lo = Math.max(lo, y++);
  }
  return {
    x: (xa + xb) / 2, top, bottom, mid: (top + bottom) / 2, high: hi, low: lo,
    cls: bull > bear && bull >= neutral ? 1 : bear > bull && bear >= neutral ? -1 : 0,
  };
}

function extractCandles(cls, body, plot, w) {
  const W = plot.x1 - plot.x0 + 1, colCount = new Int32Array(W);
  for (let y = plot.y0; y <= plot.y1; y++) {
    const o = y * w;
    for (let x = plot.x0; x <= plot.x1; x++) if (body[o + x]) colCount[x - plot.x0]++;
  }
  const runs = [];
  for (let i = 0; i < W; i++) {
    if (colCount[i] <= 0) continue;
    const s = i;
    while (i + 1 < W && colCount[i + 1] > 0) i++;
    runs.push([s, i]);
  }
  if (!runs.length) return [];
  // Most bodies are one run wide; the 35th percentile resists merged pairs.
  const widths = runs.map((r) => r[1] - r[0] + 1).filter((v) => v >= 2).sort((a, b) => a - b);
  const unit = widths.length ? Math.max(2, widths[Math.floor(widths.length * 0.35)]) : 3;
  const out = [];
  for (const [a, b] of runs) {
    const rw = b - a + 1, n = clamp(Math.round(rw / unit), 1, 8);
    for (let k = 0; k < n; k++) {
      const ca = a + Math.round((k * rw) / n), cb = a + Math.round(((k + 1) * rw) / n) - 1;
      if (cb < ca) continue;
      const c = measureCandle(cls, body, plot, w, plot.x0 + ca, plot.x0 + cb);
      if (c) out.push(c);
    }
  }
  return out;
}

function regress(ys) {
  const n = ys.length;
  if (n < 3) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const den = n * sxx - sx * sx;
  if (!den) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / den, intercept = (sy - slope * sx) / n, mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (intercept + slope * i);
    ssRes += e * e; ssTot += (ys[i] - mean) ** 2;
  }
  return { slope, r2: ssTot > 1e-9 ? clamp01(1 - ssRes / ssTot) : 0 };
}

/** Greedy 1-D clustering with a tolerance; returns centre + support count. */
function clusterValues(vals, tol) {
  const clusters = [];
  for (const v of vals.slice().sort((a, b) => a - b)) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.max <= tol) { last.max = v; last.sum += v; last.n++; }
    else clusters.push({ min: v, max: v, sum: v, n: 1 });
  }
  return clusters.map((c) => ({ y: c.sum / c.n }));
}

function dominantColors(d, cls, body, plot, w) {
  const buckets = new Map();
  for (let y = plot.y0; y <= plot.y1; y++) for (let x = plot.x0; x <= plot.x1; x++) {
    const o = y * w + x, c = body[o] ? cls[o] : 0;
    if (!c) continue;
    const p = o * 4;
    const key = (c + 1) * 4096 + ((d[p] >> 4) << 8) + ((d[p + 1] >> 4) << 4) + (d[p + 2] >> 4);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0, cls: c }));
    b.n++; b.r += d[p]; b.g += d[p + 1]; b.b += d[p + 2];
  }
  const list = [...buckets.values()].sort((a, b) => b.n - a.n);
  const up = list.find((c) => c.cls === 1), down = list.find((c) => c.cls === -1);
  return {
    up: up ? toHex(up.r / up.n, up.g / up.n, up.b / up.n) : UP_DEFAULT,
    down: down ? toHex(down.r / down.n, down.g / down.n, down.b / down.n) : DOWN_DEFAULT,
    detected: list.slice(0, 6).map((c) => toHex(c.r / c.n, c.g / c.n, c.b / c.n)),
  };
}

/** Core deterministic analysis. Throws on unusable input; caller catches. */
function analyzePixels(img, opts, warnings) {
  const { width: w, height: h, data } = img;
  if (w < 32 || h < 32) throw new VisionError('image too small for chart analysis (min 32x32)', 'too_small');
  if (w * h > MAX_PIXELS) throw new VisionError('image too large (max 30 MP)', 'too_large');

  const { cls, bg } = buildMasks(data, w, h), theme = luminance(bg) > 0.5 ? 'light' : 'dark';
  // Chroma-only for layout: neutral text/UI chrome must not stretch the box.
  const chroma = new Uint8Array(w * h);
  for (let i = 0; i < cls.length; i++) if (cls[i] === 1 || cls[i] === -1) chroma[i] = 1;
  const plot = findPlotArea(chroma, w, h) || findPlotArea(cls, w, h);
  if (!plot) throw new VisionError('no candlestick colours found — is this a chart screenshot?', 'no_candles');

  let body = buildBodyMask(cls, w, h, 3), candles = extractCandles(cls, body, plot, w);
  if (candles.length < 5) { // zoomed-out charts: bodies can be 1-2px wide
    body = buildBodyMask(cls, w, h, 1);
    candles = extractCandles(cls, body, plot, w);
    if (candles.length) warnings.push('narrow candles: used full colour mask instead of body runs');
  }
  if (!candles.length) throw new VisionError('could not locate candle columns', 'no_candles');
  if (candles.length > 400) warnings.push(`${candles.length} candle columns detected; trend may be noise-dominated`);

  const prIn = opts.priceRange;
  let priceRange = null;
  if (prIn) {
    if (isNum(prIn.low) && isNum(prIn.high) && prIn.high > prIn.low) priceRange = { low: prIn.low, high: prIn.high };
    else warnings.push('priceRange ignored: needs finite low < high');
  }
  const toPrice = (y) => priceRange
    ? round(priceRange.high - ((y - plot.y0) / Math.max(1, plot.h - 1)) * (priceRange.high - priceRange.low), 4) : null;

  // Trend: least squares on log-price proxies (y inverted). Without a price
  // axis the pane is treated as spanning 100..200 so %/bar stays sane.
  const useLogPrice = !!priceRange && priceRange.low > 0;
  const logYs = candles.map((c) => useLogPrice
    ? Math.log(Math.max(1e-6, toPrice(c.mid)))
    : Math.log(100 + (100 * (plot.y1 - c.mid)) / Math.max(1, plot.h - 1)));
  const fit = regress(logYs), slopePct = (Math.exp(fit.slope) - 1) * 100;
  let direction = 'sideways';
  if (candles.length >= 6 && fit.r2 >= 0.1 && Math.abs(slopePct) >= 0.06) direction = slopePct > 0 ? 'up' : 'down';

  const bullish = candles.filter((c) => c.cls === 1).length, bearish = candles.filter((c) => c.cls === -1).length;
  const colored = bullish + bearish, colors = dominantColors(data, cls, body, plot, w);

  // Support/resistance: histogram body edges into tolerance clusters (peaks),
  // require >= 2 touches, then NMS so nearby clusters do not duplicate levels.
  const tol = Math.max(1.5, median(candles.map((c) => c.low - c.high + 1)) * 0.45);
  const last = candles[candles.length - 1];
  const closeY = last.cls === 1 ? last.top : last.cls === -1 ? last.bottom : last.mid;
  const scored = clusterValues(candles.flatMap((c) => [c.top, c.bottom]), tol).map((cl) => {
    let touches = 0;
    for (const c of candles) if (Math.abs(c.top - cl.y) <= tol || Math.abs(c.bottom - cl.y) <= tol) touches++;
    return { y: cl.y, touches };
  }).filter((l) => l.touches >= 2).sort((a, b) => b.touches - a.touches || a.y - b.y);
  const picked = [];
  for (const lv of scored) {
    if (picked.length >= 12) break;
    if (picked.every((p) => Math.abs(p.y - lv.y) > tol)) picked.push(lv);
  }
  const level = (lv) => ({ y: Math.round(lv.y), price: toPrice(lv.y), touches: lv.touches });
  const supports = picked.filter((l) => l.y > closeY + tol * 0.5).slice(0, 5).map(level);
  const resistances = picked.filter((l) => l.y < closeY - tol * 0.5).slice(0, 5).map(level);
  const lastPrice = toPrice(closeY);

  const atrPctPx = round((median(candles.map((c) => c.low - c.high + 1)) / plot.h) * 100, 2);
  const regime = atrPctPx < 2 ? 'low' : atrPctPx > 6.5 ? 'high' : 'normal';

  // Confidence: sample size + fit + colour contrast, hard cap 0.6 for pixels.
  const contrast = clamp01(colored / candles.length);
  let conf = 0.26 + Math.min(0.16, candles.length / 250) + clamp01(fit.r2) * 0.14 + 0.05 * contrast;
  if (bearish && bullish) conf += 0.02;
  if (candles.length < 8) conf -= 0.1;
  conf *= 0.75 + 0.25 * contrast; // neutral-only charts carry less colour evidence
  conf = round(clamp(conf, 0.05, 0.6), 3);

  const notes = [
    `plot ${plot.w}x${plot.h}px at (${plot.x0},${plot.y0}) on a ${theme} theme`,
    `${candles.length} candles (${bullish} bullish / ${bearish} bearish)`,
    priceRange ? `linear y->price map from priceRange ${priceRange.low}..${priceRange.high}`
      : 'no priceRange supplied: y pixels only, price fields are null',
    `trend ${direction}, ${round(slopePct, 3)}%/bar, R^2 ${round(fit.r2, 3)}`,
    `${supports.length} support / ${resistances.length} resistance level candidates`,
  ];
  if (fit.r2 < 0.25) notes.push('low R^2: trend is weak or the chart is choppy');
  if (contrast < 0.5) notes.push('many neutral (white/hollow) bodies: direction relies on geometry');

  return {
    width: w, height: h, candles: { bullish, bearish, bullRatio: colored ? round(bullish / colored, 3) : 0 },
    colors, trend: { direction, slopePctPerBar: round(slopePct, 3), r2: round(fit.r2, 3) },
    levels: { supports, resistances, lastPrice }, volatility: { regime, atrPctPx }, confidence: conf, notes,
  };
}

/* ------------------------------- local API ------------------------------ */

async function runLocalAnalysis(input, opts) {
  const t0 = now(), warnings = [], o = opts && typeof opts === 'object' ? opts : {};
  try {
    const pixel = analyzePixels(await normalizeImage(input, o), o, warnings);
    return { ok: true, pixel, ai: null, meta: { elapsedMs: Math.round(now() - t0), usedAI: false, warnings } };
  } catch (e) {
    warnings.push(msg(e));
    return { ok: false, error: msg(e), pixel: emptyPixel(), ai: null, meta: { elapsedMs: Math.round(now() - t0), usedAI: false, warnings } };
  }
}

/**
 * Pixel-only analysis. Never throws, never touches the network.
 * @param {*} input any supported image source
 * @param {{priceRange?:{low:number,high:number}}} [opts]
 * @returns {Promise<object>} { ok, error?, pixel, ai:null, meta }
 */
export function localAnalysis(input, opts = {}) { return runLocalAnalysis(input, opts); }

/* -------------------------------- AI layer ------------------------------ */

const PROVIDERS = {
  openai: { defaultModel: 'gpt-4o-mini', label: 'OpenAI' },
  anthropic: { defaultModel: 'claude-3-5-sonnet-latest', label: 'Anthropic' },
  google: { defaultModel: 'gemini-2.0-flash', label: 'Google' },
};
let _aiConfig = null;

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const provider = String(cfg.provider || '').toLowerCase().trim();
  if (!PROVIDERS[provider]) return null;
  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (!apiKey) return null;
  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : PROVIDERS[provider].defaultModel;
  return { provider, apiKey, model };
}

/** Store the BYO-key config. @returns {boolean} true when it was valid. */
export function setAIConfig(cfg) {
  const normal = normalizeConfig(cfg);
  _aiConfig = normal ? Object.freeze({ ...normal }) : null;
  return !!normal;
}
/** @returns {{provider:string,apiKey:string,model:string}|null} a copy */
export function getAIConfig() { return _aiConfig ? { ..._aiConfig } : null; }
/** @returns {boolean} whether a usable provider + key pair is configured */
export function aiConfigured(cfg) { return !!normalizeConfig(cfg === undefined ? _aiConfig : cfg); }

const clampTimeout = (v) => (isNum(v) ? Math.round(clamp(v, 2000, 120000)) : DEFAULT_TIMEOUT_MS);

function resizeRgba(data, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4), xr = w / nw, yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * yr), sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * xr), sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) * xr)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * w + sx) * 4;
        r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]; n++;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/** Decode + downscale + PNG-encode so every provider gets a small data URL. */
async function prepareImageForAI(input, maxSide = MAX_AI_SIDE) {
  const img = await normalizeImage(input);
  const limit = Math.round(clamp(isNum(maxSide) ? maxSide : MAX_AI_SIDE, 256, 4096));
  let { width: w, height: h, data } = img;
  if (Math.max(w, h) > limit) {
    const s = limit / Math.max(w, h), nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    data = resizeRgba(data, w, h, nw, nh);
    w = nw; h = nh;
  }
  return { base64: bytesToBase64(await encodePng(data, w, h)), mediaType: 'image/png', width: w, height: h };
}

function buildPrompt(opts = {}) {
  const lines = [
    'You are a senior technical analyst reviewing one candlestick chart screenshot.',
    'Return ONLY a single JSON object (no markdown fences, no text around it) with exactly these keys:',
    '{"bias":"long"|"short"|"neutral","confidence":0..1,"trend":string,',
    ' "keyLevels":[{"price":number|null,"kind":"support"|"resistance"|"invalidation","note":string}],',
    ' "patterns":string[],"reasoning":string,"invalidation":string,"uncertainty":string}',
    '',
    'Rules:',
    '- Describe only what is visible. Do not invent indicators, news, volume values or timeframes you cannot see.',
    '- If price-axis labels are absent or unreadable, set every "price" to null and refer to levels by chart position ("prior swing high"). Never guess numbers.',
    '- confidence reflects how certain you are, not how large a move might be. Prefer "neutral" when the chart is ambiguous.',
    '- reasoning: 2-5 sentences citing specific visible evidence (structure, swings, candle behaviour).',
    '- invalidation: the price action that would prove this view wrong.',
    '- uncertainty: state explicitly what this image does not let you determine.',
  ];
  if (opts.symbol) lines.push(`- Instrument label supplied by the app (may not match the image): ${opts.symbol}.`);
  if (opts.priceRange) lines.push(`- The app knows the visible axis spans ${opts.priceRange.low} to ${opts.priceRange.high}; anchor your prices to that range.`);
  else lines.push('- The app has no price-axis calibration for this image.');
  if (opts.context) lines.push(`- A pixel pre-analysis reported: ${opts.context}. Treat it as a hint to verify, not ground truth.`);
  return lines.join('\n');
}

async function postJson(url, headers, body, timeoutMs, label) {
  if (typeof fetch !== 'function') throw new VisionError('fetch is unavailable in this environment', 'no_fetch');
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal }); }
    catch (e) {
      throw new VisionError(ctrl.signal.aborted ? `${label} request timed out after ${timeoutMs}ms` : `${label} network error: ${msg(e)}`,
        ctrl.signal.aborted ? 'timeout' : 'network');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let detail = text.slice(0, 280);
      try { const j = JSON.parse(text); detail = j?.error?.message || j?.message || detail; } catch { /* raw snippet */ }
      throw new VisionError(`${label} HTTP ${res.status}: ${detail}`, `http_${res.status}`);
    }
    try { return JSON.parse(text); } catch { throw new VisionError(`${label} returned a non-JSON response`, 'bad_response'); }
  } finally { clearTimeout(timer); }
}

const openAIJsonMode = (m) => /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-1106|gpt-3\.5-turbo-1106|chatgpt-4o)/i.test(m);

/** One request per provider; returns the raw assistant text. */
async function callProvider(cfg, img, prompt, timeoutMs) {
  const { apiKey, model, provider } = cfg, url64 = `data:${img.mediaType};base64,${img.base64}`;
  if (provider === 'openai') {
    const body = { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: url64, detail: 'high' } }] }] };
    if (/^o[1-4]/i.test(model)) body.max_completion_tokens = 1200;
    else {
      body.max_tokens = 1200; body.temperature = 0.2;
      if (openAIJsonMode(model)) body.response_format = { type: 'json_object' };
    }
    const json = await postJson('https://api.openai.com/v1/chat/completions',
      { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body, timeoutMs, 'OpenAI');
    const c = json?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : '';
  }
  if (provider === 'anthropic') {
    const json = await postJson('https://api.anthropic.com/v1/messages',
      { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      { model, max_tokens: 1200, temperature: 0.2, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
      ] }] }, timeoutMs, 'Anthropic');
    return Array.isArray(json?.content) ? json.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n') : '';
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const json = await postJson(url, { 'content-type': 'application/json' }, {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: img.mediaType, data: img.base64 } }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: 'application/json' },
  }, timeoutMs, 'Google');
  return Array.isArray(json?.candidates?.[0]?.content?.parts) ? json.candidates[0].content.parts.map((p) => p?.text || '').join('') : '';
}

/** Pull the first JSON object out of a model reply (fences, prose, junk). */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = s.slice(start, end + 1);
  try { return JSON.parse(body); } catch { /* try trailing-comma repair */ }
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

function normalizeAIResult(obj, meta) {
  const biasRaw = String(obj.bias ?? obj.signal ?? obj.direction ?? '').toLowerCase();
  let bias = 'neutral';
  if (/(long|bull|buy|up)/.test(biasRaw)) bias = 'long';
  else if (/(short|bear|sell|down)/.test(biasRaw)) bias = 'short';

  let confidence = Number(obj.confidence ?? obj.conviction);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  confidence = round(clamp01(confidence), 3);

  const keyLevels = [];
  for (const lv of Array.isArray(obj.keyLevels) ? obj.keyLevels : []) {
    if (!lv || typeof lv !== 'object') continue;
    // Number(null) === 0 and Number('') === 0: reject blanks before coercion.
    if (lv.price === null || lv.price === undefined || (typeof lv.price === 'string' && !lv.price.trim())) continue;
    const price = Number(lv.price);
    if (!Number.isFinite(price)) continue; // never fabricate a price the model could not read
    const k = String(lv.kind || '').toLowerCase();
    const kind = k.includes('invalid') ? 'invalidation' : k.includes('resist') ? 'resistance' : k.includes('support') ? 'support' : null;
    if (!kind) continue;
    keyLevels.push({ price, kind, ...(lv.note ? { note: String(lv.note).slice(0, 300) } : {}) });
  }
  let patterns = obj.patterns;
  if (typeof patterns === 'string') patterns = patterns.split(/[;,]\s*/);
  if (!Array.isArray(patterns)) patterns = [];
  let reasoning = String(obj.reasoning || obj.analysis || '').slice(0, 2000);
  if (obj.uncertainty) reasoning += (reasoning ? '\n\n' : '') + `Uncertainty: ${String(obj.uncertainty).slice(0, 600)}`;

  return {
    provider: meta.provider, model: meta.model, bias, confidence, trend: String(obj.trend || '').slice(0, 400),
    keyLevels: keyLevels.slice(0, 12), patterns: patterns.map((p) => String(p).trim()).filter(Boolean).slice(0, 12),
    reasoning, invalidation: String(obj.invalidation || '').slice(0, 600), raw: String(meta.raw || '').slice(0, 4000),
  };
}

function resolveConfig(explicit) {
  if (explicit !== undefined && explicit !== null) {
    const cfg = normalizeConfig(explicit);
    if (!cfg) throw new VisionError('Invalid AI config: provider must be openai|anthropic|google and apiKey must be non-empty', 'bad_config');
    return cfg;
  }
  const cfg = normalizeConfig(_aiConfig);
  if (!cfg) throw new VisionError('No AI provider configured: call setAIConfig() first', 'no_config');
  return cfg;
}

/**
 * Multimodal LLM layer. Rejects on network/auth/parse failures — use
 * `analyzeChartImage` to have those swallowed into warnings.
 * @param {*} input image source (same accepted types as localAnalysis)
 * @param {{provider:'openai'|'anthropic'|'google',apiKey:string,model?:string}|null} aiConfig
 * @param {{timeoutMs?:number,symbol?:string,priceRange?:object,context?:string,maxSide?:number}} [opts]
 * @returns {Promise<object>} ai result object
 */
export async function aiAnalysis(input, aiConfig, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const cfg = resolveConfig(aiConfig), timeoutMs = clampTimeout(o.timeoutMs);
  const img = await prepareImageForAI(input, o.maxSide);
  const prompt = buildPrompt({ symbol: o.symbol, priceRange: o.priceRange, context: o.context });
  const text = await callProvider(cfg, img, prompt, timeoutMs);
  if (!text || !text.trim()) throw new VisionError(`${PROVIDERS[cfg.provider].label} returned an empty reply`, 'empty_response');
  const obj = extractJson(text);
  if (!obj) throw new VisionError('model reply did not contain a JSON object', 'bad_response');
  return normalizeAIResult(obj, { provider: cfg.provider, model: cfg.model, raw: text });
}

/** Compact one-line pixel summary, fed to the model as a prior. */
function pixelSummary(pixel) {
  try {
    const p = pixel || emptyPixel();
    return `${p.candles.bullish + p.candles.bearish} candles, trend ${p.trend.direction} ` +
      `(${p.trend.slopePctPerBar}%/bar, R2=${p.trend.r2}), ${p.levels.supports.length} support / ` +
      `${p.levels.resistances.length} resistance candidates, volatility ${p.volatility.regime}. Pixel confidence ${p.confidence}.`;
  } catch { return 'pixel analysis unavailable'; }
}

/* ---------------------------- combined entry point ---------------------- */

/**
 * Analyse a chart screenshot: deterministic pixels first, optional AI second.
 * Never throws. `ok` reflects the pixel layer; AI failures become warnings.
 * @param {*} input image source
 * @param {{priceRange?:{low:number,high:number},symbol?:string,ai?:object,timeoutMs?:number}} [opts]
 * @returns {Promise<object>} { ok, error?, pixel, ai, meta }
 */
export async function analyzeChartImage(input, opts = {}) {
  const t0 = now(), o = opts && typeof opts === 'object' ? opts : {}, warnings = [];
  let pixel = emptyPixel(), ok = true, error;

  const local = await runLocalAnalysis(input, o);
  pixel = local.pixel;
  for (const w of local.meta.warnings) if (!warnings.includes(w)) warnings.push(w);
  if (!local.ok) { ok = false; error = local.error || 'pixel analysis failed'; }

  const explicit = o.ai && typeof o.ai === 'object' ? o.ai : null;
  const hasConfig = !!normalizeConfig(explicit) || !!normalizeConfig(_aiConfig);
  let ai = null, usedAI = false;
  if (hasConfig) {
    try { ai = await aiAnalysis(input, explicit || undefined, { ...o, context: pixelSummary(pixel) }); usedAI = true; }
    catch (e) { warnings.push(`AI analysis failed: ${msg(e)}`); }
  } else if (explicit) warnings.push('AI analysis skipped: provider must be openai|anthropic|google and apiKey non-empty');

  const result = { ok, pixel, ai, meta: { elapsedMs: Math.round(now() - t0), usedAI, warnings } };
  if (!ok) result.error = error;
  return result;
}
