#!/usr/bin/env node
/**
 * AlphaDesk ⇄ Robinhood bridge.
 *
 * Robinhood has no public API and their legacy login endpoint (/api-token-auth/)
 * now returns 404, so there is no honest way for a static web page to sign in to
 * your account. What *does* work without credentials is their market data:
 * quotes, daily historicals, instruments and market hours. This bridge exposes
 * those to the browser on your own machine.
 *
 *   node tools/robinhood-bridge.mjs [--port 8788]
 *
 * It binds to 127.0.0.1 only, holds no credentials, and cannot place orders.
 * Order execution stays in the Robinhood app — AlphaDesk hands you a ticket.
 *
 * Endpoints (all GET, all CORS-open to localhost and the GitHub Pages origin):
 *   /health
 *   /quotes?symbols=AAPL,MSFT
 *   /history?symbol=AAPL&span=year|5year&interval=day|week
 *   /instrument?symbol=AAPL
 *   /hours?exchange=XNAS&date=2026-11-16
 */

import http from 'node:http';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 8788));
const HOST = '127.0.0.1';
const UPSTREAM = 'https://api.robinhood.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const ALLOWED_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/kartbala07\.github\.io$/,
];

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some((re) => re.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function upstreamJSON(pathname, query = '') {
  const url = `${UPSTREAM}${pathname}${query ? `?${query}` : ''}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: 'non-JSON response', sample: text.slice(0, 200) }; }
    return { status: res.status, body };
  } finally { clearTimeout(timer); }
}

const send = (res, status, payload, headers) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (route === '/' || route === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'alphadesk-robinhood-bridge',
        upstream: UPSTREAM,
        authenticated: false,
        capabilities: ['quotes', 'history', 'instrument', 'hours'],
        orders: false,
        note: 'Market data only. No credentials are accepted and no orders can be placed from here.',
        time: new Date().toISOString(),
      }, cors);
    }

    if (route === '/quotes') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) return send(res, 400, { error: 'symbols query parameter is required, e.g. ?symbols=AAPL,MSFT' }, cors);
      if (symbols.length > 40) return send(res, 400, { error: 'at most 40 symbols per request' }, cors);
      const { status, body } = await upstreamJSON('/quotes/', `symbols=${encodeURIComponent(symbols.join(','))}`);
      if (status !== 200) return send(res, 502, { error: `Robinhood returned ${status}`, detail: body }, cors);
      const quotes = (body.results || []).map((q) => ({
        symbol: q.symbol,
        last: Number(q.last_trade_price ?? q.last_extended_hours_trade_price) || null,
        bid: Number(q.bid_price) || null,
        ask: Number(q.ask_price) || null,
        previousClose: Number(q.previous_close) || null,
        updatedAt: q.updated_at || q.venue_last_trade_time || null,
        state: q.state || null,
      }));
      return send(res, 200, { ok: true, quotes, count: quotes.length, source: 'robinhood' }, cors);
    }

    if (route === '/history') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
      if (!symbol) return send(res, 400, { error: 'symbol query parameter is required' }, cors);
      // Robinhood's vocabulary: interval = candle size, span = lookback window.
      const interval = (url.searchParams.get('interval') || 'day').toLowerCase();
      const span = (url.searchParams.get('span') || 'year').toLowerCase();
      if (!['day', 'week', 'month', '3month', 'year', '5year'].includes(span)) {
        return send(res, 400, { error: 'span must be one of day, week, month, 3month, year, 5year' }, cors);
      }
      if (!['5minute', '10minute', 'day', 'week'].includes(interval)) {
        return send(res, 400, { error: 'interval must be one of day or week for this bridge' }, cors);
      }
      const { status, body } = await upstreamJSON(`/marketdata/historicals/${encodeURIComponent(symbol)}/`, `interval=${interval}&span=${span}&bounds=regular`);
      if (status !== 200) return send(res, 502, { error: `Robinhood returned ${status}`, detail: body }, cors);
      const bars = (body.historicals || []).map((h) => [
        String(h.begins_at).slice(0, 10),
        Number(h.open_price), Number(h.high_price), Number(h.low_price), Number(h.close_price), Number(h.volume) || 0,
      ]).filter((b) => b.slice(1, 5).every((x) => Number.isFinite(x) && x > 0));
      return send(res, 200, { ok: true, symbol: body.symbol || symbol, interval, span, bars, count: bars.length, source: 'robinhood' }, cors);
    }

    if (route === '/instrument') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
      if (!symbol) return send(res, 400, { error: 'symbol query parameter is required' }, cors);
      const { status, body } = await upstreamJSON('/instruments/', `symbol=${encodeURIComponent(symbol)}`);
      if (status !== 200) return send(res, 502, { error: `Robinhood returned ${status}`, detail: body }, cors);
      const inst = (body.results || [])[0];
      if (!inst) return send(res, 404, { error: `Robinhood has no instrument for ${symbol}` }, cors);
      return send(res, 200, {
        ok: true,
        symbol: inst.symbol, name: inst.name, type: inst.type, exchange: inst.exchange,
        tradable: inst.tradeable, fractional: inst.fractional_tradability,
        source: 'robinhood',
      }, cors);
    }

    if (route === '/hours') {
      const exchange = (url.searchParams.get('exchange') || 'XNAS').toUpperCase();
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const { status, body } = await upstreamJSON(`/markets/${encodeURIComponent(exchange)}/hours/${date}/`);
      if (status !== 200) return send(res, 502, { error: `Robinhood returned ${status}`, detail: body }, cors);
      return send(res, 200, {
        ok: true, exchange, date: body.date, isOpen: body.is_open,
        opensAt: body.opens_at, closesAt: body.closes_at,
        previousOpen: body.previous_open, nextOpen: body.next_open, source: 'robinhood',
      }, cors);
    }

    return send(res, 404, { error: `unknown route ${route}`, routes: ['/health', '/quotes', '/history', '/instrument', '/hours'] }, cors);
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Robinhood did not answer within 9s' : String(err?.message || err);
    return send(res, 502, { error: msg, hint: 'Check network access to api.robinhood.com' }, cors);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  AlphaDesk ⇄ Robinhood bridge`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`\n  Market data only — no credentials, no orders.`);
  console.log(`  In AlphaDesk: Settings → Robinhood → Connect.`);
  console.log(`\n  Try:`);
  console.log(`    curl http://${HOST}:${PORT}/health`);
  console.log(`    curl "http://${HOST}:${PORT}/quotes?symbols=AAPL,MSFT"`);
  console.log(`    curl "http://${HOST}:${PORT}/history?symbol=AAPL&span=year&interval=day"`);
  console.log(`\n  Ctrl-C to stop.\n`);
});

process.on('SIGINT', () => { console.log('\n  bridge stopped'); process.exit(0); });
