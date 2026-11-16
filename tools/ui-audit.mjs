#!/usr/bin/env node
/**
 * UI audit — measurable checks for the rules in jakubkrehel/skills.
 * Prints exact numbers so fixes can be verified rather than asserted.
 *
 *   node tools/ui-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'docs', 'css', 'app.css'), 'utf8');

/* ------------------------------ token parsing ----------------------------- */

function block(selector) {
  const i = CSS.indexOf(selector);
  if (i < 0) return {};
  const open = CSS.indexOf('{', i);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  const out = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const dark = block(':root {');
const light = { ...dark, ...block('[data-theme="light"]') };

function parseColor(v) {
  v = String(v).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lum = ({ r, g, b }) => {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };

/* ------------------------------- the checks ------------------------------- */

function contrastReport(themeName, vars) {
  const bg = parseColor(vars.bg);
  const panel = parseColor(vars.panel);
  const panel2 = parseColor(vars['panel-2']);
  const panel3 = parseColor(vars['panel-3']);
  const pairs = [
    ['body text on page', vars.text, bg, 4.5],
    ['muted on page', vars.muted, bg, 4.5],
    ['dim on page', vars.dim, bg, 4.5],
    ['muted on panel', vars.muted, panel, 4.5],
    ['dim on panel', vars.dim, panel, 4.5],
    ['dim on panel-2', vars.dim, panel2, 4.5],
    ['muted on panel-3', vars.muted, panel3, 4.5],
    ['long on page', vars.long, bg, 4.5],
    ['short on page', vars.short, bg, 4.5],
    ['warn on page', vars.warn, bg, 4.5],
    ['accent on page', vars.accent, bg, 4.5],
    ['long on panel', vars.long, panel, 4.5],
    ['short on panel', vars.short, panel, 4.5],
  ];
  const rows = pairs.map(([label, fgv, bgv, need]) => {
    const fg = parseColor(fgv);
    if (!fg || !bgv) return { label, value: null, need, pass: null };
    const solid = over(fg, bgv);
    const r = ratio(solid, bgv);
    return { label, value: r, need, pass: r >= need };
  });
  console.log(`\n  ${themeName} contrast (WCAG AA normal text needs 4.5:1)`);
  for (const r of rows) {
    const v = r.value == null ? 'n/a' : r.value.toFixed(2);
    console.log(`    ${r.pass === null ? '  ?' : r.pass ? ' ok' : 'FAIL'}  ${String(v).padStart(5)}:1  ${r.label}${r.pass === false ? `  (needs ${r.need})` : ''}`);
  }
  return rows;
}

function typeScale() {
  const raw = [...CSS.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => +m[1]);
  const toks = [...CSS.matchAll(/font-size:\s*var\((--fs-[\w-]+)\)/g)].map((m) => m[1]);
  const uniqTok = [...new Set(toks)];
  const declared = [...CSS.matchAll(/--fs-[\w-]+:\s*([\d.]+)px/g)].map((m) => +m[1]).sort((a, b) => a - b);
  console.log(`\n  Type scale`);
  console.log(`    raw px sizes: ${raw.length ? raw.join(', ') : 'none (all tokenised)'}`);
  console.log(`    tokens in use: ${uniqTok.length} of ${declared.length} declared  →  ${declared.join(', ')}px`);
  const vars = [...CSS.matchAll(/--fs-[\w-]+/g)].map((m) => m[0]);
  console.log(`    scale tokens defined: ${vars.length ? [...new Set(vars)].join(', ') : 'NONE'}`);
}

function rules() {
  const has = (re) => re.test(CSS);
  console.log(`\n  Interaction and safety rules`);
  const checks = [
    ['visible focus ring (:focus-visible)', has(/:focus-visible/)],
    ['inline link underline (not colour-only)', has(/text-decoration:\s*underline/)],
    ['hover gated to hover-capable pointers', has(/@media\s*\(hover:\s*(hover|none)\)/)],
    ['reduced-motion guard', has(/prefers-reduced-motion/)],
    ['tabular numbers on figures', has(/tabular-nums/)],
    ['type scale tokens', has(/--fs-/)],
    ['spacing scale tokens', has(/--sp-/)],
    ['text-wrap balance/pretty', has(/text-wrap:\s*(balance|pretty)/)],
    ['measure cap (ch)', has(/\d+ch/)],
  ];
  for (const [label, ok] of checks) console.log(`    ${ok ? ' ok' : 'MISS'}  ${label}`);
}

const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'docs', 'js', 'app.js'), 'utf8');
function markup() {
  console.log(`\n  Markup`);
  const iconOnly = [...html.matchAll(/<button[^>]*class="[^"]*icon-btn[^"]*"[^>]*>/g)].map((m) => m[0]);
  const unlabelled = iconOnly.filter((b) => !/aria-label=/.test(b));
  console.log(`    icon-only buttons: ${iconOnly.length}, without aria-label: ${unlabelled.length}`);
  console.log(`    toast live region: ${/role="status"/.test(html) || /role="status"/.test(app) ? 'ok' : 'MISS'}`);
  console.log(`    skip link: ${/skip/i.test(html) ? 'ok' : 'MISS'}`);
  console.log(`    modal focus management (inert / focus restore): ${/inert/.test(app) ? 'ok' : 'MISS'}`);
}

console.log('AlphaDesk UI audit');
contrastReport('dark', dark);
contrastReport('light', light);
typeScale();
rules();
markup();
