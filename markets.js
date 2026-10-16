/**
 * Market sources, all free and keyless. Everything runs in the main process:
 * Yahoo sends no CORS header.
 *
 *   crypto  quote+chg : Binance  /ticker/24hr   (one call for all pairs, then
 *                       pair by pair if one of them is rejected)
 *   crypto  chart     : Binance  /klines
 *   metals  quote     : gold-api.com           (real spot, not the future)
 *   metals  chg       : Yahoo spark GC=F...    (one call shared with forex)
 *   metals  chart     : Yahoo chart, rescaled to the spot (~1 % future premium)
 *   forex   quote+chg : Yahoo spark EURUSD=X...
 *   forex   chart     : Yahoo chart
 */

const { version } = require('./package.json');
const { t } = require('./i18n');

const UA = `Klakboard/${version}`; // Yahoo blocks curl/python, not custom user agents
const YQ = 'https://query1.finance.yahoo.com';
// Public market data only: unlike api.binance.com, this domain is not blocked
// in countries where Binance does not operate.
const BINANCE = 'https://data-api.binance.vision/api/v3';

/* ---------------- metals catalog ---------------- */

// Names are in i18n.js (metal.<code>).
const METALS = {
  XAU: { yahoo: 'GC=F' },
  XAG: { yahoo: 'SI=F' },
  XPT: { yahoo: 'PL=F' },
  XPD: { yahoo: 'PA=F' },
  HG: { yahoo: 'HG=F' },
};

const keyOf = (it) =>
  it.kind === 'crypto' ? `crypto:${it.binance}`
  : it.kind === 'metal' ? `metal:${it.code}`
  : `fx:${it.from}${it.to}`;

/* ---------------- helpers ---------------- */

// Without a timeout, a request that never answers would block the refresh
// cycle forever.
const TIMEOUT_MS = 10000;

async function getJson(url, opts = {}) {
  const host = new URL(url).hostname;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...opts,
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(t('err.timeout', { host }));
    throw new Error(t('err.unreachable', { host }));
  }
  if (!res.ok) {
    const err = new Error(t('err.http', { status: res.status, host }));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const yahooSymbolOf = (it) =>
  it.kind === 'metal' ? METALS[it.code]?.yahoo : `${it.from}${it.to}=X`;

/** Zips timestamps/closes, dropping nulls (Yahoo returns some regularly). */
function zipYahoo(result) {
  const ts = result.timestamp || [];
  const cl = result.indicators?.quote?.[0]?.close || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] != null) pts.push([ts[i] * 1000, cl[i]]);
  }
  return pts;
}

/* ---------------- quote + 24 h change ---------------- */

async function fetchCrypto(items, out, errors) {
  if (!items.length) return;
  const symbols = JSON.stringify(items.map((i) => i.binance));
  let data;
  try {
    data = await getJson(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`);
  } catch (err) {
    // A single unknown pair (delisted) makes Binance reject the whole batch
    // (HTTP 400): retry pair by pair so the other pairs stay up to date.
    if (err.status !== 400 || items.length === 1) throw err;
    data = [];
    await Promise.all(items.map(async (it) => {
      try {
        data.push(await getJson(`${BINANCE}/ticker/24hr?symbol=${encodeURIComponent(it.binance)}`));
      } catch (e) {
        errors.push(t('err.source', { source: `Binance (${it.symbol}/${it.vs})`, message: e.message }));
      }
    }));
  }
  const bySym = new Map(data.map((d) => [d.symbol, d]));
  for (const it of items) {
    const d = bySym.get(it.binance);
    out[keyOf(it)] = d
      ? { price: parseFloat(d.lastPrice), change24h: parseFloat(d.priceChangePercent) }
      : { price: null, change24h: null };
  }
}

/** One spark call covers metals AND currencies. */
async function fetchYahooSpark(items, out) {
  if (!items.length) return;
  const symbols = items.map(yahooSymbolOf).filter(Boolean);
  if (!symbols.length) return;

  const url = `${YQ}/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=5m`;
  const data = await getJson(url);
  const results = data.spark?.result || data.result || [];
  const bySym = new Map(results.map((r) => [r.symbol, r.response?.[0]?.meta]));

  for (const it of items) {
    const m = bySym.get(yahooSymbolOf(it));
    if (!m) { out[keyOf(it)] = { price: null, change24h: null }; continue; }
    const price = m.regularMarketPrice ?? null;
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    out[keyOf(it)] = {
      price,
      change24h: price != null && prev ? ((price - prev) / prev) * 100 : null,
    };
  }
}

/**
 * Yahoo quotes the FUTURE (GC=F ~1 % above spot): its 24 h change is kept but
 * the price is replaced by the gold-api spot.
 */
async function overlayMetalSpot(items, out, errors) {
  await Promise.all(
    items.map(async (it) => {
      try {
        const d = await getJson(`https://api.gold-api.com/price/${it.code}`);
        if (typeof d.price === 'number') {
          const k = keyOf(it);
          out[k] = { ...(out[k] || { change24h: null }), price: d.price };
        }
      } catch (err) {
        // Yahoo's future price stays on screen as a fallback (~1 % above spot).
        errors.push(t('err.source', { source: `gold-api (${it.code})`, message: err.message }));
      }
    })
  );
}

/**
 * Returns { quotes, errors }: a failing source does not stop the others, and
 * its error is reported instead of swallowed.
 */
async function getQuotes(items) {
  const out = {};
  const errors = [];
  const crypto = items.filter((i) => i.kind === 'crypto');
  const metals = items.filter((i) => i.kind === 'metal');
  const fx = items.filter((i) => i.kind === 'fx');

  await Promise.all([
    fetchCrypto(crypto, out, errors)
      .catch((err) => errors.push(t('err.source', { source: 'Binance', message: err.message }))),
    fetchYahooSpark([...metals, ...fx], out)
      .catch((err) => errors.push(t('err.source', { source: 'Yahoo', message: err.message }))),
  ]);
  await overlayMetalSpot(metals, out, errors);

  for (const it of items) {
    if (!out[keyOf(it)]) out[keyOf(it)] = { price: null, change24h: null };
  }
  return { quotes: out, errors };
}

/* ---------------- charts ---------------- */

const H = 3600e3;
const D = 864e5;

/**
 * Chart periods. Binance takes an interval and a candle count, so the window is
 * exact. Yahoo only takes a fixed list of `range` values: request the smallest
 * one that COVERS the period, then clip to `ms`. Yahoo limits: 1m data only for
 * the last 7 days, intraday intervals only for the last 60 days.
 */
const PERIODS = {
  '1h':  { ms: H,        binance: ['1m', 60],   yahoo: ['1d', '1m'] },
  '3h':  { ms: 3 * H,    binance: ['1m', 180],  yahoo: ['1d', '1m'] },
  '6h':  { ms: 6 * H,    binance: ['5m', 72],   yahoo: ['1d', '2m'] },
  '12h': { ms: 12 * H,   binance: ['5m', 144],  yahoo: ['1d', '5m'] },
  '24h': { ms: 24 * H,   binance: ['5m', 288],  yahoo: ['5d', '5m'] },
  '3d':  { ms: 3 * D,    binance: ['15m', 288], yahoo: ['5d', '15m'] },
  '1w':  { ms: 7 * D,    binance: ['1h', 168],  yahoo: ['7d', '1h'] },
  '30d': { ms: 30 * D,   binance: ['4h', 180],  yahoo: ['1mo', '1h'] },
  '60d': { ms: 60 * D,   binance: ['8h', 180],  yahoo: ['3mo', '1d'] },
  '90d': { ms: 90 * D,   binance: ['12h', 180], yahoo: ['3mo', '1d'] },
  '6m':  { ms: 182 * D,  binance: ['1d', 182],  yahoo: ['6mo', '1d'] },
  '1y':  { ms: 365 * D,  binance: ['1d', 365],  yahoo: ['1y', '1d'] },
  '3y':  { ms: 1095 * D, binance: ['3d', 365],  yahoo: ['5y', '1wk'] },
  '5y':  { ms: 1825 * D, binance: ['1w', 260],  yahoo: ['5y', '1wk'] },
};

const periodOf = (range) => PERIODS[range] || PERIODS['1w'];

/** Keeps the points inside the requested window. */
function clip(points, ms) {
  const cutoff = Date.now() - ms;
  const kept = points.filter((p) => p[0] >= cutoff);
  // A period shorter than the quote step (market closed over the weekend, for
  // instance) would empty the chart: return the last raw points instead.
  return kept.length >= 2 ? kept : points.slice(-2);
}

async function chartCrypto(item, range) {
  const [interval, limit] = periodOf(range).binance;
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(item.binance)}&interval=${interval}&limit=${limit}`;
  const rows = await getJson(url);
  return rows.map((k) => [k[0], parseFloat(k[4])]); // openTime ms, close
}

async function chartYahoo(item, range) {
  const p = periodOf(range);
  const [yRange, interval] = p.yahoo;
  const sym = yahooSymbolOf(item);
  const url = `${YQ}/v8/finance/chart/${encodeURIComponent(sym)}?range=${yRange}&interval=${interval}`;
  const data = await getJson(url);
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(t('err.yahooEmpty'));
  return clip(zipYahoo(result), p.ms);
}

async function getChart(item, range) {
  if (item.kind === 'crypto') return { points: await chartCrypto(item, range) };

  const points = await chartYahoo(item, range);
  if (!points.length) return { points };

  // Rescales the future curve to the real spot, otherwise the axis does not match
  // the displayed price.
  if (item.kind === 'metal') {
    try {
      const d = await getJson(`https://api.gold-api.com/price/${item.code}`);
      const last = points[points.length - 1][1];
      if (typeof d.price === 'number' && last) {
        const factor = d.price / last;
        return { points: points.map(([t, v]) => [t, v * factor]), rebased: true };
      }
    } catch {
      /* raw future curve */
    }
  }
  return { points };
}

/* ---------------- badge sparklines (12 h) ---------------- */

const SPARK_MS = 12 * H;

/**
 * The last 12 hours of TRADING, not the last 12 hours: when the market is
 * closed (weekend), the curve shows the end of the last session.
 */
function lastTradingHours(points, ms) {
  if (!points.length) return points;
  const end = points[points.length - 1][0];
  return points.filter((p) => p[0] >= end - ms);
}

/** One Yahoo call for all metals and currencies (5 days at 15 min, to cover a weekend). */
async function sparkYahoo(items, out) {
  const symbols = [...new Set(items.map(yahooSymbolOf).filter(Boolean))];
  if (!symbols.length) return;
  const url = `${YQ}/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=5d&interval=15m`;
  const data = await getJson(url);
  const bySym = new Map((data.spark?.result || []).map((r) => [r.symbol, r.response?.[0]]));
  for (const it of items) {
    const r = bySym.get(yahooSymbolOf(it));
    if (r) out[keyOf(it)] = lastTradingHours(zipYahoo(r), SPARK_MS);
  }
}

/** Binance: one call per pair, 48 candles of 15 min. */
async function sparkCrypto(items, out) {
  await Promise.all(items.map(async (it) => {
    try {
      const rows = await getJson(`${BINANCE}/klines?symbol=${encodeURIComponent(it.binance)}&interval=15m&limit=48`);
      out[keyOf(it)] = rows.map((k) => [k[0], parseFloat(k[4])]);
    } catch {
      /* no curve for this pair, the others remain */
    }
  }));
}

/**
 * 12-hour series per row ({ key: [[t, price], ...] }). Metals stay on the
 * Yahoo future: curves are normalised when drawn, so a constant factor (premium
 * over spot) does not change their shape.
 */
async function getSparks(items) {
  const out = {};
  await Promise.all([
    sparkCrypto(items.filter((i) => i.kind === 'crypto'), out),
    sparkYahoo(items.filter((i) => i.kind !== 'crypto'), out).catch(() => {}),
  ]);
  return out;
}

/* ---------------- catalogs for adding rows ---------------- */

let binanceSymbolsCache = null;

async function listCryptoSymbols() {
  if (binanceSymbolsCache) return binanceSymbolsCache;
  const rows = await getJson(`${BINANCE}/ticker/price`);
  binanceSymbolsCache = rows.map((r) => r.symbol);
  return binanceSymbolsCache;
}

/** Splits BTCUSDT into base BTC / quote USDT, trying the known quotes. */
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'TUSD', 'BUSD', 'EUR', 'TRY', 'BTC', 'ETH', 'BNB'];

async function searchCrypto(query) {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const symbols = await listCryptoSymbols();
  const hits = [];
  for (const s of symbols) {
    if (!s.includes(q)) continue;
    const quote = QUOTES.find((x) => s.endsWith(x));
    if (!quote) continue;
    const base = s.slice(0, -quote.length);
    if (!base) continue;
    hits.push({ binance: s, symbol: base, vs: quote });
  }
  // USDT pairs first, then the shortest bases (BTC before BTCDOWN).
  hits.sort((a, b) => {
    if ((a.vs === 'USDT') !== (b.vs === 'USDT')) return a.vs === 'USDT' ? -1 : 1;
    return a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol);
  });
  return hits.slice(0, 30);
}

const FX_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD',
  'SGD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'MXN', 'BRL',
  'ZAR', 'INR', 'KRW', 'RUB', 'THB', 'ILS',
];

// Letters and digits of any script: Binance also lists « 币安人生USDT ».
const SYMBOL_RE = /^[\p{L}\p{N}]{1,20}$/u;

/**
 * Tracked row reduced to its known fields, or null when invalid. Rows come
 * from the page and end up in the config and in URLs.
 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.kind === 'metal') return METALS[it.code] ? { kind: 'metal', code: it.code } : null;
  if (it.kind === 'fx') {
    const ok = FX_CURRENCIES.includes(it.from) && FX_CURRENCIES.includes(it.to) && it.from !== it.to;
    return ok ? { kind: 'fx', from: it.from, to: it.to } : null;
  }
  if (it.kind === 'crypto') {
    const ok = [it.symbol, it.vs, it.binance].every((s) => typeof s === 'string' && SYMBOL_RE.test(s));
    return ok ? { kind: 'crypto', symbol: it.symbol, vs: it.vs, binance: it.binance } : null;
  }
  return null;
}

module.exports = {
  METALS,
  FX_CURRENCIES,
  PERIODS,
  keyOf,
  normalizeItem,
  getQuotes,
  getChart,
  getSparks,
  searchCrypto,
};
