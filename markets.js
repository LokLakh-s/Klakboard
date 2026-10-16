/**
 * Sources de marche, toutes gratuites et sans cle API.
 * Tout part du main process : Yahoo n'envoie aucun header CORS.
 *
 *   crypto  spot+var : Binance  /ticker/24hr   (1 appel pour toutes les paires,
 *                      paire par paire si l'une d'elles est refusee)
 *   crypto  courbe   : Binance  /klines
 *   metaux  spot     : gold-api.com           (vrai spot, pas le future)
 *   metaux  var      : Yahoo spark GC=F...    (1 appel groupe avec le forex)
 *   metaux  courbe   : Yahoo chart, renormalisee sur le spot (prime future ~1 %)
 *   forex   spot+var : Yahoo spark EURUSD=X...
 *   forex   courbe   : Yahoo chart
 */

const { version } = require('./package.json');

const UA = `Klakboard/${version}`; // Yahoo bloque curl/python, pas les UA custom
const YQ = 'https://query1.finance.yahoo.com';
// Domaine des seules donnees de marche publiques : contrairement a api.binance.com,
// il n'est pas bloque dans les pays ou Binance n'opere pas.
const BINANCE = 'https://data-api.binance.vision/api/v3';

/* ---------------- catalogue metaux ---------------- */

const METALS = {
  XAU: { label: 'Or', yahoo: 'GC=F' },
  XAG: { label: 'Argent', yahoo: 'SI=F' },
  XPT: { label: 'Platine', yahoo: 'PL=F' },
  XPD: { label: 'Palladium', yahoo: 'PA=F' },
  HG: { label: 'Cuivre', yahoo: 'HG=F' },
};

const keyOf = (it) =>
  it.kind === 'crypto' ? `crypto:${it.binance}`
  : it.kind === 'metal' ? `metal:${it.code}`
  : `fx:${it.from}${it.to}`;

/* ---------------- utilitaires ---------------- */

// Sans delai maximum, une requete qui ne repond jamais bloquait le cycle de
// rafraichissement indefiniment.
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
    if (err.name === 'TimeoutError') throw new Error(`délai dépassé sur ${host}`);
    throw new Error(`${host} injoignable`);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} sur ${host}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const yahooSymbolOf = (it) =>
  it.kind === 'metal' ? METALS[it.code]?.yahoo : `${it.from}${it.to}=X`;

/** Zippe timestamps/closes en filtrant les null (Yahoo en renvoie regulierement). */
function zipYahoo(result) {
  const ts = result.timestamp || [];
  const cl = result.indicators?.quote?.[0]?.close || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] != null) pts.push([ts[i] * 1000, cl[i]]);
  }
  return pts;
}

/* ---------------- spot + variation 24 h ---------------- */

async function fetchCrypto(items, out, errors) {
  if (!items.length) return;
  const symbols = JSON.stringify(items.map((i) => i.binance));
  let data;
  try {
    data = await getJson(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`);
  } catch (err) {
    // Une seule paire inconnue (retiree de la cote) fait refuser tout le lot
    // (HTTP 400) : on repasse paire par paire pour que les autres restent a jour.
    if (err.status !== 400 || items.length === 1) throw err;
    data = [];
    await Promise.all(items.map(async (it) => {
      try {
        data.push(await getJson(`${BINANCE}/ticker/24hr?symbol=${encodeURIComponent(it.binance)}`));
      } catch (e) {
        errors.push(`Binance (${it.symbol}/${it.vs}) : ${e.message}`);
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

/** Un seul appel spark couvre metaux ET devises. */
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
 * Yahoo cote le FUTURE (GC=F a ~+1 % sur le spot). On garde sa variation 24 h
 * mais on remplace le prix par le vrai spot gold-api.
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
        // Le prix future de Yahoo reste affiche en repli (~1 % au-dessus du spot).
        errors.push(`gold-api (${it.code}) : ${err.message}`);
      }
    })
  );
}

/**
 * Renvoie { quotes, errors } : une source en panne n'empeche pas les autres de
 * repondre, mais son erreur remonte au lieu d'etre avalee.
 */
async function getQuotes(items) {
  const out = {};
  const errors = [];
  const crypto = items.filter((i) => i.kind === 'crypto');
  const metals = items.filter((i) => i.kind === 'metal');
  const fx = items.filter((i) => i.kind === 'fx');

  await Promise.all([
    fetchCrypto(crypto, out, errors).catch((err) => errors.push(`Binance : ${err.message}`)),
    fetchYahooSpark([...metals, ...fx], out).catch((err) => errors.push(`Yahoo : ${err.message}`)),
  ]);
  await overlayMetalSpot(metals, out, errors);

  for (const it of items) {
    if (!out[keyOf(it)]) out[keyOf(it)] = { price: null, change24h: null };
  }
  return { quotes: out, errors };
}

/* ---------------- courbes ---------------- */

const H = 3600e3;
const D = 864e5;

/**
 * Periodes proposees. Binance accepte un interval + un nombre de bougies, donc
 * la fenetre est exacte. Yahoo n'accepte qu'une liste fermee de `range` : on
 * demande le plus petit qui COUVRE la periode, puis on tronque sur `ms`.
 * Contraintes Yahoo respectees ici : 1m limite aux 7 derniers jours, et tout
 * intervalle infra-journalier limite a 60 jours.
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

/** Ne garde que ce qui tombe dans la fenetre demandee. */
function clip(points, ms) {
  const cutoff = Date.now() - ms;
  const kept = points.filter((p) => p[0] >= cutoff);
  // Une periode plus courte que le pas de cotation (marche ferme le week-end,
  // par exemple) viderait la courbe : on rend alors les derniers points bruts.
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
  if (!result) throw new Error('série Yahoo vide');
  return clip(zipYahoo(result), p.ms);
}

async function getChart(item, range) {
  if (item.kind === 'crypto') return { points: await chartCrypto(item, range) };

  const points = await chartYahoo(item, range);
  if (!points.length) return { points };

  // Recale la courbe du future sur le spot reel, sinon l'axe ne colle pas au prix affiche.
  if (item.kind === 'metal') {
    try {
      const d = await getJson(`https://api.gold-api.com/price/${item.code}`);
      const last = points[points.length - 1][1];
      if (typeof d.price === 'number' && last) {
        const factor = d.price / last;
        return { points: points.map(([t, v]) => [t, v * factor]), rebased: true };
      }
    } catch {
      /* courbe future brute */
    }
  }
  return { points };
}

/* ---------------- mini-courbes des badges (12 h) ---------------- */

const SPARK_MS = 12 * H;

/**
 * Les 12 dernieres heures de COTATION, et non les 12 dernieres heures tout
 * court : marche ferme (week-end), la courbe montre la fin de la derniere seance.
 */
function lastTradingHours(points, ms) {
  if (!points.length) return points;
  const end = points[points.length - 1][0];
  return points.filter((p) => p[0] >= end - ms);
}

/** Un seul appel Yahoo pour tous les metaux et devises (5 jours en 15 min, pour couvrir un week-end). */
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

/** Binance : un appel par paire, 48 bougies de 15 min. */
async function sparkCrypto(items, out) {
  await Promise.all(items.map(async (it) => {
    try {
      const rows = await getJson(`${BINANCE}/klines?symbol=${encodeURIComponent(it.binance)}&interval=15m&limit=48`);
      out[keyOf(it)] = rows.map((k) => [k[0], parseFloat(k[4])]);
    } catch {
      /* courbe absente pour cette paire, les autres restent */
    }
  }));
}

/**
 * Series 12 h par ligne ({ cle: [[t, prix], ...] }). Les metaux restent sur le
 * future Yahoo : la courbe est normalisee a l'affichage, un facteur constant
 * (prime sur le spot) n'en change pas la forme.
 */
async function getSparks(items) {
  const out = {};
  await Promise.all([
    sparkCrypto(items.filter((i) => i.kind === 'crypto'), out),
    sparkYahoo(items.filter((i) => i.kind !== 'crypto'), out).catch(() => {}),
  ]);
  return out;
}

/* ---------------- catalogues pour l'ajout ---------------- */

let binanceSymbolsCache = null;

async function listCryptoSymbols() {
  if (binanceSymbolsCache) return binanceSymbolsCache;
  const rows = await getJson(`${BINANCE}/ticker/price`);
  binanceSymbolsCache = rows.map((r) => r.symbol);
  return binanceSymbolsCache;
}

/** Decoupe BTCUSDT -> base BTC / quote USDT, en testant les quotes connues. */
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
  // Les paires en USDT d'abord, puis les bases les plus courtes (BTC avant BTCDOWN).
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

// Lettres et chiffres de toute ecriture : Binance cote aussi « 币安人生USDT ».
const SYMBOL_RE = /^[\p{L}\p{N}]{1,20}$/u;

/**
 * Ligne suivie reduite a ses champs connus, ou null si elle est invalide. Les
 * lignes arrivent de la page : elles finissent dans la config et dans des URL.
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
