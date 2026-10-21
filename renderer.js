const $ = (id) => document.getElementById(id);
const { i18n } = window;
const { t } = i18n;

/** Element with text: data from an API or the OS never goes through innerHTML. */
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

let config = { items: [], refreshMs: 20000, coverTaskbar: true };
let catalogs = { metals: {}, fxCurrencies: [] };
let lastQuotes = {};
let lastSparks = {};
const prevPrices = new Map();
const rowCells = new Map();

const KIND_ORDER = { metal: 0, fx: 1, crypto: 2 };

const keyOf = (it) =>
  it.kind === 'crypto' ? `crypto:${it.binance}`
  : it.kind === 'metal' ? `metal:${it.code}`
  : `fx:${it.from}${it.to}`;

const labelOf = (it) =>
  it.kind === 'metal' ? `${it.code}/USD`
  : it.kind === 'fx' ? `${it.from}/${it.to}`
  : `${it.symbol}/${it.vs}`;

/* ---------------- formatting ---------------- */

// Number formats of the current locale, by number of decimals (cleared when
// the language changes).
const numFormats = new Map();
function num(v, digits) {
  let f = numFormats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numFormats.set(digits, f);
  }
  return f.format(v);
}

/** Byte units of the interface language: B, kB, MB, GB, TB (o, ko, Mo, Go, To in French). */
const units = () => t('units.bytes').split(',');

const fmtTime = (ms, opts) => new Date(ms).toLocaleTimeString(i18n.locale, opts);

function fmtPrice(v) {
  if (v == null) return '--';
  const a = Math.abs(v);
  return num(v, a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6);
}

function fmtChange(c) {
  if (c == null) return '--';
  return `${c >= 0 ? '+' : ''}${num(c, 2)}%`;
}

/** Network totals, in decimal units like the rates. */
function fmtBytes(b) {
  const u = units();
  if (b >= 1e12) return [num(b / 1e12, 2), u[4]];
  if (b >= 1e9) return [num(b / 1e9, 2), u[3]];
  if (b >= 1e6) return [num(b / 1e6, 1), u[2]];
  if (b >= 1e3) return [num(b / 1e3, 0), u[1]];
  return [num(b, 0), u[0]];
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null) return ['--', ''];
  const b = bytesPerSec;
  const [u, s] = [units(), t('units.perSecond')];
  if (b >= 1e6) return [num(b / 1e6, 1), u[2] + s];
  if (b >= 1e3) return [num(b / 1e3, 0), u[1] + s];
  return [num(b, 0), u[0] + s];
}

/** Memory in binary gigabytes, as the OS task managers show it. */
const fmtMem = (bytes) => num(bytes / 2 ** 30, 1);

/* ---------------- fitting small windows ---------------- */

/*
 * Texts always keep the size of the zoom setting. When the window has no room
 * for everything, details are given up, least useful first (SHED), and come
 * back as soon as there is room again. Before that, the date goes from one
 * line to two, and the moon and sun from beside the weather icon to below it.
 */
const SHED = [
  'badgeRows',   // badges past the third row: scrolled
  'monthShort',  // month abbreviated ("19 oct. 2026")
  'year',        // year of the date
  'moonLit',     // "62 % lit"
  'cpuFoot',     // CPU model and thread count
  'feels',       // feels-like temperature
  'gpuName',     // GPU model (fan and temperature stay)
  'ramFree',     // free RAM (used and total stay)
  'netTotals',   // network totals since the last reset
  'wHead',       // weather city and map link (the whole card stays clickable)
  'seconds',     // seconds of the clock
  'ramFoot',     // RAM used and total (the percentage stays)
  'wDesc',       // weather description (the icon stays)
  'netSpark',    // network mini curve
  'vram',        // GPU memory
  'gpuFoot',     // GPU fan and temperature
  'weekday',     // day of the week
  'cores',       // per-core CPU bars (the average stays)
  'stormWind',   // wind and storm (together: a row of stats in a narrow card)
  'dayLength',   // day length
  'moon',        // moon phase
  'sun',         // sunrise, sunset
  'wStats',      // min / max and rain
  'date',        // the whole date (the clock stays)
  'badgeScroll', // badges past the first row: scrolled
];
// Free width (rem) wanted between the one-line date and the time.
const ONE_LINE_ROOM = 1.5;
// Rows of badges kept in view before the weather gives up its details.
const BADGE_ROWS_SHOWN = 3;
// What must not overflow, be cut by an ellipsis or spill out. Rows holding
// weather icons are checked across only: the icons stick out above and below
// on purpose (their drawing only fills the middle of their box).
const TOP_CHECKS = '.topBar, .dateText, .dateDay, .dateFull';
const SYS_CHECKS = '.sys, .cHead, .cFoot, .cFoot span, .netLive, .netCol, .miniRow';
const WEATHER_CHECKS = '.wHead, .wStats, .wDesc, .wLbl, .wVal';
const FIT_CHECKS = `.app, ${TOP_CHECKS}, ${WEATHER_CHECKS}, ${SYS_CHECKS}`;
const FIT_CHECKS_ACROSS = '.weather, .wMain, .wAstroRow';

const app = document.querySelector('.app');

/**
 * Pixels of content past the box, across only or both ways. Across, the
 * smallest excess counts: a fraction of a pixel already brings an ellipsis.
 */
const overflowOf = (e, across = false) => Math.max(0, e.scrollWidth - e.clientWidth)
  + (across ? 0 : Math.max(0, e.scrollHeight - e.clientHeight - 1));
const sumOver = (selector, across) => [...app.querySelectorAll(selector)].reduce((px, e) => px + overflowOf(e, across), 0);

/** Pixels missing for the rows of badges that must be in view (scrolled by hand: none). */
function badgeShortfall() {
  const area = $('mScroll');
  const badges = area.querySelectorAll('.badge');
  if (!badges.length || area.scrollTop > 0) return 0;
  const rows = app.classList.contains('shed-badgeScroll') ? 1 : BADGE_ROWS_SHOWN;
  const last = badges[Math.min(badges.length, rows * 3) - 1];
  return Math.max(0, Math.round(last.getBoundingClientRect().bottom - area.getBoundingClientRect().bottom) - 1);
}

/**
 * Pixels of the weather card's rows past its bottom edge. Not its scroll
 * height: the icon box sticks out of its row, the drawing does not.
 */
function weatherShortfall() {
  const w = $('weather');
  const edge = w.getBoundingClientRect().top + w.clientTop + w.clientHeight;
  const bottom = Math.max(...[...w.children].map((c) => c.getBoundingClientRect().bottom));
  return Math.max(0, Math.round(bottom - edge) - 1);
}

/** Everything that does not fit, in pixels: 0 when the dashboard shows whole. */
const overflow = () => sumOver(FIT_CHECKS) + sumOver(FIT_CHECKS_ACROSS, true) + weatherShortfall() + badgeShortfall();

/** Date on one line when it fits with room to spare, moon and sun beside the icon when they fit there. */
function chooseLayouts() {
  const bar = document.querySelector('.topBar');
  const date = document.querySelector('.dateText');
  date.classList.add('oneLine');
  // The menu button sits in the free space, invisible until hovered.
  const free = $('clockTime').getBoundingClientRect().left - $('menuBtn').getBoundingClientRect().right
    - parseFloat(getComputedStyle(bar).columnGap);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  if (sumOver(TOP_CHECKS) > 0 || free < ONE_LINE_ROOM * rem) date.classList.remove('oneLine');
  const w = $('weather');
  w.classList.remove('astroBelow');
  if (!$('wAstro').hidden && sumOver(FIT_CHECKS_ACROSS, true) > 0) w.classList.add('astroBelow');
}

/** Height of the badge area holding its first `rows` rows. */
function badgeRowsHeight(rows) {
  const area = $('mScroll');
  const last = area.querySelectorAll('.badge')[rows * 3 - 1];
  if (!last) return 'none';
  const pad = parseFloat(getComputedStyle(area.firstElementChild).paddingBottom) || 0;
  return `${last.getBoundingClientRect().bottom - area.getBoundingClientRect().top + area.scrollTop + pad}px`;
}

const setShed = (name, on) => app.classList.toggle(`shed-${name}`, on);

let shedNow = [];
let overAfterFit = 0;

/**
 * Shows as many details as fit, the most useful first: everything is given
 * up, then each detail comes back unless it makes something overflow. What no
 * hiding can help (a text too long for any room) leaves the rest as it is.
 */
function fitAll() {
  for (const name of SHED) setShed(name, false);
  app.style.setProperty('--badgeRows', badgeRowsHeight(BADGE_ROWS_SHOWN));
  app.style.setProperty('--badgeRow', badgeRowsHeight(1));
  chooseLayouts();
  if (overflow() === 0) {
    shedNow = [];
    overAfterFit = 0;
    return;
  }
  for (const name of SHED) setShed(name, true);
  chooseLayouts();
  const least = overflow();
  shedNow = [];
  for (const name of [...SHED].reverse()) {
    setShed(name, false);
    chooseLayouts();
    if (overflow() > least) {
      setShed(name, true);
      chooseLayouts();
      shedNow.unshift(name);
    }
  }
  overAfterFit = overflow();
}

let fitQueued = false;
/** fitAll() and the redraws before the next frame, once however many changes ask for it. */
function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitAll();
    drawWeatherBg();
    drawNetSpark();
    if (LARGE_MQ.matches) drawCardCharts();
  });
}

// The system texts change every second: give up more as soon as they no
// longer fit, bring details back at most once a minute (nothing appearing and
// disappearing back and forth).
let growAt = 0;
function refitOnTick() {
  const over = overflow();
  const worse = over > overAfterFit;
  const retry = (shedNow.length > 0 || over > 0) && Date.now() >= growAt;
  if (!worse && !retry) return;
  growAt = Date.now() + 60000;
  const before = shedNow.join();
  fitAll();
  if (shedNow.join() !== before) {
    drawWeatherBg();
    drawNetSpark();
  }
}

/* ---------------- market badges ---------------- */

function renderMarkets() {
  const wrap = $('mScroll');
  wrap.innerHTML = '';
  rowCells.clear();

  if (!config.items.length) {
    const p = el('p', 'emptyHint', t('markets.empty'));
    p.append(document.createElement('br'), t('markets.emptyHint'));
    wrap.appendChild(p);
    return;
  }

  // One grid without category headers: sorting groups the rows, and each badge
  // already shows its quote currency (Gold, USD, USDT).
  const grid = document.createElement('div');
  grid.className = 'badges';
  const sorted = [...config.items].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
  );
  for (const it of sorted) grid.appendChild(makeBadge(it));
  wrap.appendChild(grid);
  applySparks(lastSparks);
  scheduleFit();
}

async function dropItem(it) {
  config = await window.dash.removeItem(it);
  prevPrices.delete(keyOf(it));
  renderMarkets();
  applyQuotes(lastQuotes);
}

function makeRemoveBtn(it, cls) {
  const rm = document.createElement('button');
  rm.className = cls;
  rm.innerHTML = '&#10005;';
  rm.title = t('markets.remove', { label: labelOf(it) });
  rm.addEventListener('click', (e) => { e.stopPropagation(); dropItem(it); });
  return rm;
}

function makeBadge(it) {
  const b = document.createElement('div');
  b.className = 'badge';

  // A metal is always quoted in USD: "USD" would tell nothing, so its name is
  // shown instead ("XAU  Gold").
  const sym = it.kind === 'metal' ? it.code : it.kind === 'fx' ? it.from : it.symbol;
  const vs =
    it.kind === 'metal' ? t(`metal.${it.code}`)
    : it.kind === 'fx' ? it.to
    : it.vs;

  const top = document.createElement('div');
  top.className = 'bTop';
  top.append(el('span', 'bSym', sym), el('span', 'bVs', vs));
  top.appendChild(makeRemoveBtn(it, 'bRm'));

  const price = document.createElement('div');
  price.className = 'bPrice';
  price.textContent = '--';

  const chg = document.createElement('div');
  chg.className = 'bChg';
  chg.textContent = '--';

  const spark = document.createElement('div');
  spark.className = 'bSpark';

  b.append(top, price, chg, spark);
  b.addEventListener('click', () => openChart(it));
  rowCells.set(keyOf(it), { price, chg, spark, badge: b });
  return b;
}

/**
 * 12-hour sparkline, in the column left free next to the price. Drawn in a
 * 100 x 100 frame stretched to the cell: no redraw on resize, and the colour
 * follows the theme through currentColor.
 */
function drawSpark(box, points) {
  if (!points || points.length < 2) {
    box.innerHTML = '';
    return;
  }
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys);
  const span = Math.max(...ys) - lo || 1;
  const t0 = points[0][0];
  const dt = points[points.length - 1][0] - t0 || 1;
  const line = points
    .map(([t, v]) => `${(((t - t0) / dt) * 100).toFixed(2)},${(96 - ((v - lo) / span) * 92).toFixed(2)}`)
    .join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  box.className = `bSpark ${up ? 'up' : 'down'}`;
  box.innerHTML =
    '<svg viewBox="0 0 100 100" preserveAspectRatio="none">' +
    `<polygon points="0,100 ${line} 100,100" fill="currentColor" fill-opacity=".14"/>` +
    `<polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    '</svg>';
}

function applySparks(sparks) {
  for (const [key, cell] of rowCells) drawSpark(cell.spark, sparks[key]);
}

// A missing series (failing source) keeps the previous curve.
window.dash.onSparks((sparks) => {
  Object.assign(lastSparks, sparks);
  applySparks(lastSparks);
});

let staleMs = 120000;

function applyQuotes(quotes) {
  if (!quotes) return;
  const now = Date.now();
  for (const [key, cell] of rowCells) {
    const q = quotes[key];
    if (!q) continue;

    // Price kept from a previous cycle for lack of answer: greyed out, time in the tooltip.
    const stale = q.at != null && now - q.at > staleMs;
    cell.badge.classList.toggle('stale', stale);
    cell.badge.title = stale ? t('markets.lastQuote', { time: fmtTime(q.at) }) : '';

    cell.price.textContent = fmtPrice(q.price);

    const prev = prevPrices.get(key);
    if (prev != null && q.price != null && q.price !== prev) {
      const cls = q.price > prev ? 'up' : 'down';
      cell.price.classList.add(cls);
      setTimeout(() => cell.price.classList.remove(cls), 650);
    }
    if (q.price != null) prevPrices.set(key, q.price);

    cell.chg.textContent = fmtChange(q.change24h);
    cell.chg.classList.toggle('up', q.change24h > 0);
    cell.chg.classList.toggle('down', q.change24h < 0);

    // The whole badge is tinted: the trend reads without looking for the figure.
    if (cell.badge) {
      cell.badge.classList.toggle('up', q.change24h > 0);
      cell.badge.classList.toggle('down', q.change24h < 0);
    }
  }
}

/* Status dot: green when every source answered, red otherwise; details
   (source, error, time) in its tooltip. */
let lastQuotesEvent = null;

function renderStatusDot(d) {
  const dot = $('statusDot');
  const time = fmtTime(d.updatedAt);
  if (d.errors?.length) {
    dot.className = 'dot error';
    dot.title = `${t('markets.failing', { time })}\n${d.errors.join('\n')}`;
  } else {
    dot.className = 'dot live';
    dot.title = t('markets.ok', { time });
  }
}

window.dash.onQuotes((d) => {
  staleMs = d.staleMs || staleMs;
  lastQuotes = d.quotes;
  lastQuotesEvent = d;
  applyQuotes(d.quotes);
  renderStatusDot(d);
});

/* ---------------- clock ---------------- */

let clockShape = '';
const clockFormats = { locale: null };

/**
 * Nodes of a formatted date or time: the `optional` part, with the separator
 * next to it, in a span of class `cls` (hidden when given up, see SHED);
 * `swap[type]` turns other parts into their own nodes.
 */
function partNodes(parts, optional, cls, swap = {}) {
  const plain = (list) => list.flatMap((p) => swap[p.type]?.(p.value) ?? [p.value]);
  const i = parts.findIndex((p) => p.type === optional);
  if (i < 0) return plain(parts);
  // The separator on the side of the rest: "19 octobre| 2026", "2026年|10月".
  const from = i > 0 && parts[i - 1].type === 'literal' ? i - 1 : i;
  const to = from === i && parts[i + 1]?.type === 'literal' ? i + 1 : i;
  const text = parts.slice(from, to + 1).map((p) => p.value).join('');
  return [...plain(parts.slice(0, from)), el('span', cls, text), ...plain(parts.slice(to + 1))];
}

function tickClock() {
  if (clockFormats.locale !== i18n.locale) {
    clockFormats.locale = i18n.locale;
    clockFormats.time = new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
    clockFormats.day = new Intl.DateTimeFormat(i18n.locale, { weekday: 'long' });
    clockFormats.full = new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'long', year: 'numeric' });
    clockFormats.month = new Intl.DateTimeFormat(i18n.locale, { month: 'short' });
  }
  const d = new Date();
  const time = clockFormats.time.formatToParts(d);
  const day = clockFormats.day.format(d);
  const full = clockFormats.full.formatToParts(d);
  $('clockTime').replaceChildren(...partNodes(time, 'second', 'tSec'));
  $('dateDay').textContent = day;
  // Both forms of the month: the short one shows once the long one is given up.
  const month = (long) => [el('span', 'mLong', long), el('span', 'mShort', clockFormats.month.format(d))];
  $('dateFull').replaceChildren(...partNodes(full, 'year', 'dYear', { month }));
  // A new day or one more digit (9:59 -> 10:00) changes the room they take.
  const shape = `${$('clockTime').textContent.length}|${day}|${$('dateFull').textContent}`;
  if (shape !== clockShape) {
    clockShape = shape;
    scheduleFit();
  }
}
tickClock();
setInterval(tickClock, 1000);

/* ---------------- system panel ---------------- */

let coreEls = [];

function buildCores(n) {
  const wrap = $('cores');
  wrap.innerHTML = '';
  coreEls = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'core';
    const f = document.createElement('div');
    f.className = 'coreFill';
    c.appendChild(f);
    wrap.appendChild(c);
    coreEls.push(f);
  }
  scheduleFit();
}

/** Green -> amber -> red: the colour carries as much as the height. */
function loadColor(pct) {
  if (pct >= 85) return 'var(--down)';
  if (pct >= 55) return 'var(--warn)';
  return 'var(--up)';
}

/* Theme colours read once and cached: getComputedStyle on every sparkline
   draw (once a second) would force a useless style recalculation. */
let themeColors = null;
function palette() {
  if (!themeColors) {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    themeColors = { up: v('--up'), down: v('--down'), accent: v('--accent'), line: v('--line'), faint: v('--faint'), warn: v('--warn') };
  }
  return themeColors;
}

let lastSys = null;

window.dash.onSys((s) => {
  lastSys = s;
  renderSys(s);
  refitOnTick();
  const rate = s.net.rate || { down: null, up: null };
  pushNetHistory(rate.down ?? 0, rate.up ?? 0);
  onHistoryTick();
});

function renderSys(s) {
  // CPU
  if (coreEls.length !== s.cpu.per.length) buildCores(s.cpu.per.length);
  // The colour is only written when it changes band: 32 `background` writes per
  // second would force style recalculations for nothing.
  s.cpu.per.forEach((v, i) => {
    const el = coreEls[i];
    if (!el) return;
    el.style.height = `${v}%`;
    const band = v >= 85 ? 2 : v >= 55 ? 1 : 0;
    if (el._band !== band) {
      el.style.background = loadColor(v);
      el._band = band;
    }
  });
  $('cpuAvg').textContent = `${s.cpu.avg.toFixed(0)}%`;
  // "Intel(R) Core(TM) i9-14900KF" -> "i9-14900KF", "AMD Ryzen 9 7950X 16-Core
  // Processor" -> "Ryzen 9 7950X": at 24 px the brand overflows.
  $('cpuModel').textContent = (s.cpuModel || '')
    .replace(/\b\d+-Core\b|\(R\)|\(TM\)|CPU|Processor|Intel|AMD|Core/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  $('cpuCount').textContent = t('sys.threads', { n: s.cpu.per.length });

  // RAM
  const r = s.ram;
  $('ramPct').textContent = `${r.pct.toFixed(0)}%`;
  const rb = $('ramBar');
  rb.style.width = `${r.pct}%`;
  rb.style.background = loadColor(r.pct);
  // "19.4 / 63.8 GB" rather than "19.37 GB / 63.79 GB": at 24 px the long form
  // takes 355 of 367 available px, and the 2nd decimal tells nothing.
  const gbUnit = units()[3];
  $('ramUsed').textContent = `${fmtMem(r.used)} / ${fmtMem(r.total)} ${gbUnit}`;
  $('ramFree').textContent = t('sys.free', { value: `${fmtMem(r.free)} ${gbUnit}` });

  // GPU
  if (s.gpu) {
    $('gpuCard').style.opacity = '1';
    $('gpuUtil').textContent = s.gpu.util != null ? `${s.gpu.util}%` : '--';
    const gb = $('gpuBar');
    gb.style.width = `${s.gpu.util || 0}%`;
    gb.style.background = loadColor(s.gpu.util || 0);
    const vpct = s.gpu.memTotal ? (s.gpu.memUsed / s.gpu.memTotal) * 100 : 0;
    const vb = $('vramBar');
    vb.style.width = `${vpct}%`;
    vb.style.background = loadColor(vpct);
    // Memory in MiB; no total for memory shared with the system (Apple silicon,
    // Windows without nvidia-smi).
    const mib = 2 ** 20;
    const { memUsed, memTotal } = s.gpu;
    $('vramVal').textContent = memUsed == null ? '--'
      : memTotal ? `${fmtMem(memUsed * mib)} / ${fmtMem(memTotal * mib)} ${gbUnit}`
      : `${fmtMem(memUsed * mib)} ${gbUnit}`;
    $('gpuName').textContent = (s.gpu.name || '').replace(/NVIDIA |GeForce |AMD |Radeon\(TM\) /g, '');
    $('gpuFanTemp').textContent = [
      s.gpu.fan != null ? t('sys.fan', { fan: `${s.gpu.fan}%` }) : null,
      s.gpu.temp != null ? `${s.gpu.temp}°C` : null,
    ].filter(Boolean).join(' · ');
  } else {
    $('gpuCard').style.opacity = '.45';
    $('gpuUtil').textContent = t('sys.na');
    $('gpuName').textContent = t('sys.noGpu');
    $('gpuFanTemp').textContent = '';
  }

  // Network
  // `rate` is null when the counters stop coming: "--" rather than a frozen rate.
  const rate = s.net.rate || { down: null, up: null };
  const [dv, du] = fmtRate(rate.down);
  const [uv2, uu2] = fmtRate(rate.up);
  $('netDown').textContent = dv;
  $('netDownU').textContent = du;
  $('netUp').textContent = uv2;
  $('netUpU').textContent = uu2;
  const [trv, tru] = fmtBytes(s.totals.rx);
  const [ttv, ttu] = fmtBytes(s.totals.tx);
  $('totDown').textContent = `↓ ${trv} ${tru}`;
  $('totUp').textContent = `↑ ${ttv} ${ttu}`;

  // Ping: null when the last answers are missing, or without a ping command.
  const ping = $('pingVal');
  ping.textContent = fmtMs(s.ping, false);
  ping.classList.toggle('warn', s.ping >= 100 && s.ping < 250);
  ping.classList.toggle('alert', s.ping >= 250);
}

/* ---------------- throughput history ---------------- */

const NET_HIST = 90;              // 90 s of history
const netHist = { down: [], up: [] };

function pushNetHistory(down, up) {
  netHist.down.push(down);
  netHist.up.push(up);
  if (netHist.down.length > NET_HIST) { netHist.down.shift(); netHist.up.shift(); }
  drawNetSpark();
}

/* The SVG is built ONCE, then only the `points` attributes change: rebuilding
   it through innerHTML every second would reparse HTML and relayout each tick. */
let spark = null;

function buildSpark(W, H) {
  const p = palette();
  const el = $('netSpark');
  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<polygon fill="${p.up}" fill-opacity=".16"/>` +
    `<polyline fill="none" stroke="${p.up}" stroke-width="1.4"/>` +
    `<polyline fill="none" stroke="${p.accent}" stroke-width="1.4"/>` +
    `<text x="2" y="18" fill="${p.faint}" font-size="20"></text>` +
    `</svg>`;
  const svg = el.firstChild;
  spark = {
    W, H,
    area: svg.children[0],
    down: svg.children[1],
    up: svg.children[2],
    label: svg.children[3],
  };
}

function drawNetSpark() {
  const el = $('netSpark');
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!W || !H || netHist.down.length < 2) return;
  if (!spark || spark.W !== W || spark.H !== H) buildSpark(W, H);

  // One scale for both curves, so they compare at a glance. Floor at 64 kB/s so
  // that background noise stays flat.
  let peak = 64000;
  for (let i = 0; i < netHist.down.length; i++) {
    if (netHist.down[i] > peak) peak = netHist.down[i];
    if (netHist.up[i] > peak) peak = netHist.up[i];
  }

  const n = netHist.down.length;
  const px = (i) => (i / (NET_HIST - 1)) * W;
  const py = (v) => H - (v / peak) * (H - 2) - 1;
  const path = (arr) => arr.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');

  const dPath = path(netHist.down);
  spark.area.setAttribute('points', `0,${H} ${dPath} ${px(n - 1).toFixed(1)},${H}`);
  spark.down.setAttribute('points', dPath);
  spark.up.setAttribute('points', path(netHist.up));
  const [pv, pu] = fmtRate(peak);
  // The value alone in a narrow card, nothing when even that does not fit.
  for (const text of [t('sys.peak', { value: `${pv} ${pu}` }), `${pv} ${pu}`, '']) {
    spark.label.textContent = text;
    if (spark.label.getComputedTextLength() <= W - 4) break;
  }
}

/* ---------------- chart ---------------- */

let chartItem = null;
let chartRange = '1w';
// Number of the latest request: a slower answer for a previous period must not
// replace the chart on screen.
let chartReq = 0;

function drawChart(points, up) {
  const area = $('chartArea');
  area.innerHTML = '';
  if (!points.length) {
    area.replaceChildren(el('div', 'chartMsg', t('chart.empty')));
    return;
  }

  const W = area.clientWidth || 600;
  const H = area.clientHeight || 240;
  // Axis labels are AXIS_FS px: the right gutter must follow, otherwise a 5-digit
  // price overflows.
  const AXIS_FS = 23;
  const pad = { l: 4, r: 132, t: 14, b: 22 };

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = y1 - y0 || 1;

  const px = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const py = (v) => pad.t + (1 - (v - y0) / span) * (H - pad.t - pad.b);

  const line = points.map((p) => `${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
  const area2 = `${pad.l},${py(y0)} ${line} ${px(x1)},${py(y0)}`;
  const pal = palette();
  const col = up ? pal.up : pal.down;

  const gridVals = [y0, y0 + span / 2, y1];
  const grid = gridVals
    .map((v) => {
      const y = py(v).toFixed(1);
      return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="${pal.line}" stroke-width="1"/>
              <text x="${W - pad.r + 8}" y="${+y + AXIS_FS / 3}" fill="${pal.faint}" font-size="${AXIS_FS}">${fmtPrice(v)}</text>`;
    })
    .join('');

  area.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${col}" stop-opacity=".28"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <polygon points="${area2}" fill="url(#g)"/>
      <polyline points="${line}" fill="none" stroke="${col}" stroke-width="1.8"
                stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

async function loadChart() {
  if (!chartItem) return;
  const req = ++chartReq;
  $('chartArea').replaceChildren(el('div', 'chartMsg', t('chart.loading')));
  const res = await window.dash.getChart(chartItem, chartRange);
  if (req !== chartReq) return;
  if (res.error) {
    $('chartArea').replaceChildren(el('div', 'chartMsg', t('chart.error', { message: res.error })));
    return;
  }
  const pts = res.points;
  const up = pts.length > 1 ? pts[pts.length - 1][1] >= pts[0][1] : true;
  drawChart(pts, up);

  if (pts.length > 1) {
    const first = pts[0][1];
    const last = pts[pts.length - 1][1];
    const pct = ((last - first) / first) * 100;
    $('chPrice').textContent = fmtPrice(last);
    const cs = $('chChange');
    cs.textContent = fmtChange(pct);
    cs.className = pct >= 0 ? 'up' : 'down';
  }
}

function openChart(item) {
  chartItem = item;
  chartRange = '1w';
  $('chTitle').textContent = labelOf(item);
  const q = lastQuotes[keyOf(item)];
  $('chPrice').textContent = q ? fmtPrice(q.price) : '--';
  $('chChange').textContent = '';
  document.querySelectorAll('#ranges .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.range === '1w')
  );
  $('chartOv').hidden = false;
  requestAnimationFrame(loadChart);
}

$('ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  chartRange = btn.dataset.range;
  document.querySelectorAll('#ranges .chip').forEach((c) => c.classList.remove('active'));
  btn.classList.add('active');
  loadChart();
});

/* ---------------- overlays ---------------- */

function close(ov) {
  ov.hidden = true;
  $('sdTip').hidden = true;
  if (ov.id === 'sysOv') detail = null;
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => close(b.closest('.ov')))
);
document.querySelectorAll('.ov').forEach((ov) =>
  ov.addEventListener('click', (e) => { if (e.target === ov) close(ov); })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.ov').forEach(close);
});

/* ---------------- panels (tray menu) ---------------- */

async function openSettings() {
  syncSettings();
  buildDisplayList();
  $('setOv').hidden = false;
  // Read from the OS at each opening: the entry may have been disabled from Task
  // Manager in the meantime.
  $('autoTgl').checked = await window.dash.getAutoLaunch();
}

function openAdd() {
  buildMetalPicker();
  $('addOv').hidden = false;
}

window.dash.onOpenPanel((name) => (name === 'add' ? openAdd() : openSettings()));

// Reset in two clicks: the first arms the button for 3 s.
let purgeTimer;
function disarmPurge() {
  clearTimeout(purgeTimer);
  $('purgeBtn').classList.remove('armed');
  $('purgeBtn').textContent = t('sys.reset');
}
$('purgeBtn').addEventListener('click', async (e) => {
  e.stopPropagation();   // the card itself opens the network history
  const b = $('purgeBtn');
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = t('sys.resetConfirm');
    purgeTimer = setTimeout(disarmPurge, 3000);
    return;
  }
  disarmPurge();
  await window.dash.resetNetTotals();
});

/* ---------------- settings ---------------- */

function syncSettings() {
  document.querySelectorAll('#intervals .chip').forEach((c) =>
    c.classList.toggle('active', Number(c.dataset.ms) === config.refreshMs)
  );
  document.querySelectorAll('#zooms .chip').forEach((c) =>
    c.classList.toggle('active', Math.abs(Number(c.dataset.z) - (config.zoom || 1)) < 0.01)
  );
  document.querySelectorAll('#themes .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.theme === (config.theme || 'dark'))
  );
  document.querySelectorAll('#languages .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.lang === (config.language || 'auto'))
  );
  const bw = config.bounds?.width;
  const bh = config.bounds?.height;
  document.querySelectorAll('#resList .chip').forEach((c) =>
    c.classList.toggle('active', Number(c.dataset.w) === bw && Number(c.dataset.h) === bh)
  );
  $('coverTgl').checked = !!config.coverTaskbar;
  $('siteNow').textContent = config.weatherSite?.label || '--';
  $('nightTgl').checked = !!config.night?.enabled;
  document.querySelectorAll('#nightDims .chip').forEach((c) =>
    c.classList.toggle('active', Math.abs(Number(c.dataset.dim) - (config.night?.dim ?? 0.5)) < 0.01)
  );
}

$('themes').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.documentElement.dataset.theme = b.dataset.theme;
  themeColors = null;   // the cached palette is no longer valid
  spark = null;         // the SVG has the old colours hard-coded
  config = await window.dash.setTheme(b.dataset.theme);
  syncSettings();
  drawNetSpark();
  drawWeatherBg();
  if (!$('chartOv').hidden) loadChart();
});

/** Detected screens; a click shows the dashboard full screen on it. */
async function buildDisplayList() {
  const list = $('dispList');
  const displays = await window.dash.getDisplays();
  list.innerHTML = '';
  for (const d of displays) {
    const b = document.createElement('button');
    b.className = 'dispBtn' + (d.current ? ' current' : '');
    const tags = [d.primary ? t('display.primary') : null, d.scaleFactor !== 1 ? `${Math.round(d.scaleFactor * 100)} %` : null]
      .filter(Boolean)
      .join(' · ');
    b.append(el('span', 'dName', d.label), el('span', 'dRes', `${d.width} × ${d.height}${tags ? ' · ' + tags : ''}`));
    b.addEventListener('click', async () => {
      config = await window.dash.snapToDisplay(d.id);
      syncSettings();
      buildDisplayList();
      drawNetSpark();
    });
    list.appendChild(b);
  }
}

$('resList').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  config = await window.dash.setResolution({ width: Number(b.dataset.w), height: Number(b.dataset.h) });
  syncSettings();
  drawNetSpark();
});

$('zooms').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  config = await window.dash.setZoom(Number(b.dataset.z));
  syncSettings();
  scheduleFit();   // the room in CSS px changes with it
  // Zoom changes the viewport size: the SVGs must be redrawn.
  drawNetSpark();
  if (!$('chartOv').hidden) loadChart();
});

$('intervals').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  config = await window.dash.setRefresh(Number(b.dataset.ms));
  syncSettings();
});

$('coverTgl').addEventListener('change', async (e) => {
  config = await window.dash.setCoverTaskbar(e.target.checked);
});

$('autoTgl').addEventListener('change', async (e) => {
  // Set the box back to the state actually applied: if Windows refuses the
  // registry write, it must not stay checked.
  e.target.checked = await window.dash.setAutoLaunch(e.target.checked);
});

/* ---------------- night mode ---------------- */

const hhmm = (ms) => fmtTime(ms, { hour: 'numeric', minute: '2-digit' });
let lastNight = null;

function renderNight({ on, dim, from, until, current }) {
  $('nightVeil').style.opacity = on ? String(dim) : '0';
  const span = from ? `${hhmm(from)} → ${until ? hhmm(until) : '?'}` : t('night.until', { time: hhmm(until) });
  const city = config.weatherSite?.label || t('night.theCity');
  $('nightHint').textContent = until || from
    ? t('night.line', { when: t(current ? 'night.current' : 'night.next'), span, city })
    : t(config.weatherSite ? 'night.unknown' : 'night.noCity');
}

window.dash.onNight((n) => {
  lastNight = n;
  renderNight(n);
});

$('nightTgl').addEventListener('change', async (e) => {
  config = await window.dash.setNight({ enabled: e.target.checked });
  syncSettings();
});

$('nightDims').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  config = await window.dash.setNight({ dim: Number(b.dataset.dim) });
  syncSettings();
});

/* ---------------- weather city ---------------- */

let siteTimer;
$('siteSearch').addEventListener('input', (e) => {
  clearTimeout(siteTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('siteResults').innerHTML = ''; return; }
  siteTimer = setTimeout(async () => {
    const places = await window.dash.searchPlaces(q);
    const ul = $('siteResults');
    ul.innerHTML = '';
    for (const p of places) {
      const li = el('li');
      li.append(el('span', 'rsSym', p.label), el('span', 'rsVs', p.detail));
      li.addEventListener('click', async () => {
        config = await window.dash.setWeatherSite(p);
        $('siteSearch').value = '';
        ul.innerHTML = '';
        syncSettings();
      });
      ul.appendChild(li);
    }
    if (!places.length) ul.appendChild(el('li', 'rsNone', t('settings.noCity')));
  }, 350);
});

/* ---------------- adding rows ---------------- */

$('addTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.querySelectorAll('#addTabs .chip').forEach((c) => c.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.tabPane').forEach((p) => {
    p.hidden = p.dataset.pane !== b.dataset.tab;
  });
});

function alreadyHas(item) {
  return config.items.some((i) => keyOf(i) === keyOf(item));
}

async function addItem(item) {
  config = await window.dash.addItem(item);
  renderMarkets();
  applyQuotes(lastQuotes);
  close($('addOv'));
}

function buildMetalPicker() {
  const grid = $('metalPick');
  grid.innerHTML = '';
  for (const code of Object.keys(catalogs.metals)) {
    const item = { kind: 'metal', code };
    const b = document.createElement('button');
    b.className = 'pickBtn';
    b.append(el('span', 'pCode', code), el('span', 'pLbl', t(`metal.${code}`)));
    b.disabled = alreadyHas(item);
    b.addEventListener('click', () => addItem(item));
    grid.appendChild(b);
  }
}

$('fxAdd').addEventListener('click', () => {
  const from = $('fxFrom').value;
  const to = $('fxTo').value;
  if (from === to) return;
  addItem({ kind: 'fx', from, to });
});

let searchTimer;
$('cSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('cResults').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const list = await window.dash.searchCrypto(q);
    const ul = $('cResults');
    ul.innerHTML = '';
    for (const c of list) {
      const item = { kind: 'crypto', symbol: c.symbol, vs: c.vs, binance: c.binance };
      if (alreadyHas(item)) continue;
      const li = document.createElement('li');
      li.append(el('span', 'rsSym', c.symbol), el('span', 'rsVs', `/ ${c.vs}`), el('span', 'rsAdd', '+'));
      li.addEventListener('click', () => addItem(item));
      ul.appendChild(li);
    }
  }, 280);
});

/* ---------------- startup ---------------- */

/* ---------------- system history ---------------- */

// Same query as the large-screen block of style.css.
const LARGE_MQ = matchMedia('(min-width: 1500px) and (min-height: 850px) and (min-aspect-ratio: 4/5) and (max-aspect-ratio: 12/5)');

const chartFont = () =>
  `${Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.95)}px "Segoe UI", Selawik, sans-serif`;
const chartColors = () => ({ grid: palette().line, text: palette().faint });

const fmtPct = (v) => (Number.isFinite(v) ? `${num(v, 0)}%` : '--');
const fmtRateText = (v) => (Number.isFinite(v) ? fmtRate(v).join(' ') : '--');
const fmtMiB = (v) => (Number.isFinite(v) ? `${fmtMem(v * 2 ** 20)} ${units()[3]}` : '--');
const fmtTemp = (v) => (Number.isFinite(v) ? `${num(v, 0)}°C` : '--');
/** Round trip in ms: one decimal under 10 ms (Windows only gives whole ms). */
function fmtMs(v, unit = true) {
  if (v == null || !Number.isFinite(v)) return '--';
  const text = num(v, v < 10 && v % 1 ? 1 : 0);
  return unit ? `${text} ms` : text;
}
const lastFinite = (a) => { for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i]; return NaN; };
const anyFinite = (a) => a.some(Number.isFinite);
function stats(a) {
  let sum = 0, n = 0, max = NaN;
  for (const v of a) if (Number.isFinite(v)) { sum += v; n++; if (!(v <= max)) max = v; }
  return { avg: n ? sum / n : NaN, max };
}

// One request at a time per consumer: a slow answer is not queued behind another.
function historyFetcher() {
  let busy = false;
  return async (range) => {
    if (busy) return null;
    busy = true;
    try { return await window.dash.getHistory(range); } finally { busy = false; }
  };
}

/* ---- detail view (click on a system card) ---- */

let detail = null;   // { kind, range, data, hover, tick }
const fetchDetail = historyFetcher();

/** Charts of each detail view: label, series of the history, axis format, maximum. */
function detailCharts(kind, data) {
  const p = palette();
  if (kind === 'cpu') return [{ label: t('detail.total'), fmt: fmtPct, max: 100, series: [{ values: data.cpu, color: p.accent, fill: true }] }];
  if (kind === 'ram') return [{ label: t('detail.memory'), fmt: fmtPct, max: 100, series: [{ values: data.ram, color: p.accent, fill: true }] }];
  if (kind === 'gpu') {
    const total = lastSys?.gpu?.memTotal;
    return [
      { label: t('detail.load'), fmt: fmtPct, max: 100, series: [{ values: data.gpu, color: p.accent, fill: true }] },
      { label: t('detail.memory'), fmt: fmtMiB, max: total || undefined, series: [{ values: data.gpuMem, color: p.up, fill: true }] },
      anyFinite(data.gpuTemp) && { label: t('detail.temp'), fmt: fmtTemp, max: 100, series: [{ values: data.gpuTemp, color: p.down }] },
    ].filter(Boolean);
  }
  return [
    {
      label: `${t('detail.down')} / ${t('detail.up')}`, fmt: fmtRateText, floor: 64000,
      series: [{ values: data.down, color: p.up, fill: true }, { values: data.up, color: p.accent }],
    },
    // No curve at all without a ping command or when ICMP is blocked.
    anyFinite(data.ping) && { label: t('detail.ping'), fmt: fmtMs, floor: 20, series: [{ values: data.ping, color: p.warn, fill: true }] },
  ].filter(Boolean);
}

function openDetail(kind) {
  detail = { kind, range: '10m', data: null, hover: null, tick: 0, built: null };
  document.querySelectorAll('#sdRanges .chip').forEach((c) => c.classList.toggle('active', c.dataset.hrange === '10m'));
  $('sysOv').hidden = false;
  $('sdBody').replaceChildren(el('div', 'sdEmpty', t('chart.loading')));
  refreshDetail();
}

async function refreshDetail() {
  if (!detail) return;
  const { kind, range } = detail;
  const data = await fetchDetail(range);
  if (!data || !detail || detail.kind !== kind || detail.range !== range) return;
  detail.data = data;
  renderDetail();
}

/** (Re)builds the canvases when the view or the core count changes, then draws. */
function renderDetail() {
  if (!detail?.data) return;
  const { kind, data } = detail;
  const titles = { cpu: 'CPU', ram: 'RAM', gpu: 'GPU', net: t('sys.network') };
  $('sdTitle').textContent = titles[kind];
  $('sdSub').textContent = detailSubtitle(kind, data);
  if (data.t.length < 2) {
    $('sdBody').replaceChildren(el('div', 'sdEmpty', t('detail.noData')));
    detail.built = null;
    return;
  }
  const defs = detailCharts(kind, data);
  const shape = `${kind}:${defs.length}:${kind === 'cpu' ? data.cores.length : 0}:${i18n.lang}`;
  if (detail.built !== shape) buildDetail(kind, defs, data);
  detail.built = shape;
  drawDetail(defs, data);
}

function detailSubtitle(kind, data) {
  const s = lastSys;
  if (!s) return '';
  if (kind === 'cpu') {
    const per = s.cpu.per;
    const i = per.indexOf(Math.max(...per));
    return `${$('cpuModel').textContent} · ${t('sys.threads', { n: per.length })} · ${t('detail.busiest', { n: i, value: fmtPct(per[i]) })}`;
  }
  if (kind === 'ram') return `${$('ramUsed').textContent} · ${$('ramFree').textContent}`;
  if (kind === 'gpu') return s.gpu ? [s.gpu.name, $('gpuFanTemp').textContent].filter(Boolean).join(' · ') : t('sys.noGpu');
  const [rv, ru] = fmtBytes(s.totals.rx);
  const [tv, tu] = fmtBytes(s.totals.tx);
  return `↓ ${rv} ${ru} · ↑ ${tv} ${tu}`;
}

function buildDetail(kind, defs) {
  const body = $('sdBody');
  body.replaceChildren();
  detail.canvases = defs.map((d) => {
    const box = el('div', 'sdChart');
    const label = el('div', 'sdLabel');
    label.append(el('span', null, d.label), el('span', 'sdNow'));
    const canvas = document.createElement('canvas');
    canvas.className = 'sdHover';
    box.append(label, canvas);
    body.appendChild(box);
    return { canvas, now: label.lastChild };
  });
  if (kind === 'net') {
    detail.stats = el('div', 'sdStats');
    body.appendChild(detail.stats);
  }
  if (kind === 'cpu') {
    const grid = el('div', 'coreGrid');
    const n = detail.data.cores.length;
    const cols = n <= 4 ? n : n <= 16 ? Math.min(8, Math.ceil(n / 2)) : Math.ceil(n / 4);
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    detail.cores = detail.data.cores.map(() => {
      const cell = el('div', 'coreCell');
      const label = el('span');
      const canvas = document.createElement('canvas');
      cell.append(label, canvas);
      grid.appendChild(cell);
      return { label, canvas };
    });
    body.appendChild(grid);
  }
  for (const { canvas } of detail.canvases) {
    canvas.addEventListener('mousemove', (e) => {
      detail.hover = charts.indexAt(canvas, detail.geom, e.clientX);
      drawDetail(detailCharts(detail.kind, detail.data), detail.data, e);
    });
    canvas.addEventListener('mouseleave', () => {
      detail.hover = null;
      $('sdTip').hidden = true;
      drawDetail(detailCharts(detail.kind, detail.data), detail.data);
    });
  }
}

function drawDetail(defs, data, pointer) {
  const font = chartFont();
  const colors = chartColors();
  const fmtT = (ms) => fmtTime(ms, detail.range === '1h' ? { hour: 'numeric', minute: '2-digit' } : undefined);
  const hover = detail.hover;
  const gutter = charts.labelWidth(font, defs.flatMap((d) => charts.axisLabels({ ...d, fmtY: d.fmt })));
  defs.forEach((d, k) => {
    const c = detail.canvases[k];
    if (!c) return;
    const geom = charts.draw(c.canvas, { t: data.t, series: d.series, max: d.max, floor: d.floor, fmtY: d.fmt, fmtT, font, colors, hover, gutter });
    if (k === 0) detail.geom = geom;
    c.now.textContent = d.series.map((s) => d.fmt(hover != null ? s.values[hover] : lastFinite(s.values))).join(' / ');
  });
  if (detail.kind === 'net' && detail.stats) {
    const line = (arrow, label, values, fmt = fmtRateText) => {
      const st = stats(values);
      const span = el('span', null, `${arrow ? `${arrow} ` : ''}${t('detail.labelValue', { label, value: '' }).trimEnd()} `);
      [[t('detail.now'), lastFinite(values)], [t('detail.avg'), st.avg], [t('detail.peak'), st.max]].forEach(([name, v], i) => {
        span.append(`${i ? ' · ' : ''}${name} `, el('b', null, fmt(v)));
      });
      return span;
    };
    detail.stats.replaceChildren(line('↓', t('detail.down'), data.down), line('↑', t('detail.up'), data.up),
      ...(anyFinite(data.ping) ? [line('', 'Ping', data.ping, fmtMs)] : []));
  }
  if (detail.cores) {
    const p = palette();
    detail.cores.forEach((c, i) => {
      const v = data.cores[i];
      c.label.textContent = `#${i} · ${fmtPct(hover != null ? v[hover] : lastFinite(v))}`;
      charts.draw(c.canvas, { t: data.t, series: [{ values: v, color: p.up, fill: true, width: 1 }], max: 100, colors, hover });
    });
  }
  const tip = $('sdTip');
  if (hover != null && pointer) {
    tip.textContent = [fmtTime(data.t[hover]),
      ...defs.map((d) => t('detail.labelValue', { label: d.label, value: d.series.map((s) => d.fmt(s.values[hover])).join(' / ') }))].join('\n');
    tip.hidden = false;
    const x = Math.min(pointer.clientX + 14, innerWidth - tip.offsetWidth - 6);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(6, pointer.clientY - tip.offsetHeight - 10)}px`;
  } else if (!pointer) {
    tip.hidden = true;
  }
}

$('sdRanges').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b || !detail) return;
  detail.range = b.dataset.hrange;
  detail.hover = null;
  document.querySelectorAll('#sdRanges .chip').forEach((c) => c.classList.toggle('active', c === b));
  refreshDetail();
});

for (const card of document.querySelectorAll('[data-detail]')) {
  card.addEventListener('click', () => openDetail(card.dataset.detail));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(card.dataset.detail); }
  });
}

/* ---- history curves in the cards (large screens) ---- */

const fetchCards = historyFetcher();

async function drawCardCharts() {
  const data = await fetchCards('5m');
  if (!data || data.t.length < 2) return;
  const p = palette();
  const font = chartFont();
  const colors = chartColors();
  const opts = { t: data.t, font, colors };
  charts.draw($('cpuChart'), { ...opts, max: 100, fmtY: fmtPct, series: [{ values: data.cpu, color: p.accent, fill: true }] });
  charts.draw($('ramChart'), { ...opts, max: 100, fmtY: fmtPct, series: [{ values: data.ram, color: p.accent, fill: true }] });
  charts.draw($('gpuChart'), { ...opts, max: 100, fmtY: fmtPct, series: [{ values: data.gpu, color: p.accent, fill: true }] });
  charts.draw($('netChart'), { ...opts, floor: 64000, fmtY: fmtRateText,
    series: [{ values: data.down, color: p.up, fill: true }, { values: data.up, color: p.accent }] });
}

/** Every second, with each system sample. */
function onHistoryTick() {
  if (detail && !$('sysOv').hidden) {
    // The hour view moves by 10-second steps.
    if (detail.range !== '1h' || detail.tick++ % 10 === 0) refreshDetail();
  }
  if (LARGE_MQ.matches) drawCardCharts();
}

LARGE_MQ.addEventListener('change', () => {
  fitAll();
  if (LARGE_MQ.matches) { drawCardCharts(); drawWeatherChart(); }
  drawWeatherBg();
});

/* ---------------- language ---------------- */

/** Texts written in index.html, by their data-i18n* attributes. */
function applyStaticTexts() {
  document.documentElement.lang = i18n.lang;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
}

/** Switches the page to `lang`/`locale` and redraws everything from the last data received. */
function applyLanguage({ lang, locale }) {
  i18n.setLanguage(lang, locale);
  numFormats.clear();
  applyStaticTexts();
  tickClock();
  renderMarkets();
  applyQuotes(lastQuotes);
  if (lastQuotesEvent) renderStatusDot(lastQuotesEvent);
  if (lastSys) renderSys(lastSys);
  drawNetSpark();
  if (lastWeather) renderWeatherEvent(lastWeather);
  if (lastNight) renderNight(lastNight);
  if (!$('chartOv').hidden) loadChart();
  if (!$('addOv').hidden) buildMetalPicker();
  if (!$('setOv').hidden) buildDisplayList();
  if (detail) renderDetail();
  if (LARGE_MQ.matches) drawCardCharts();
  drawWeatherBg();
  wxBuilt = null;
  renderWeatherDetail();
  disarmPurge();
  syncSettings();
}

$('languages').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const res = await window.dash.setLanguage(b.dataset.lang);
  config.language = res.setting;
  applyLanguage(res);
});

$('menuBtn').addEventListener('click', () => window.dash.showMenu());

/* ---------------- startup ---------------- */

(async function init() {
  config = await window.dash.getConfig();
  catalogs = await window.dash.getCatalogs();
  applyLanguage(await window.dash.getLanguage());
  document.documentElement.dataset.theme = config.theme || 'dark';
  themeColors = null;

  const opts = catalogs.fxCurrencies.map((c) => `<option value="${c}">${c}</option>`).join('');
  $('fxFrom').innerHTML = opts;
  $('fxTo').innerHTML = opts;
  $('fxFrom').value = 'EUR';
  $('fxTo').value = 'USD';

  $('wSite').textContent = config.weatherSite?.label || '--';
})();

window.addEventListener('resize', () => {
  fitAll();
  if (!$('chartOv').hidden) loadChart();
  if (detail) renderDetail();
  if (LARGE_MQ.matches) { drawCardCharts(); drawWeatherChart(); }
  drawWeatherBg();
  drawNetSpark();
  renderWeatherDetail();
});
// Selawik may load after the first draw and change the room texts take.
document.fonts?.ready.then(() => { fitAll(); drawWeatherBg(); });

/* ---------------- weather ---------------- */

const STORM_CLASS = { low: '', possible: 'warn', high: 'alert' };
let lastWeather = null;

// True until a weather city is picked (first launch).
let needsSite = false;

/** Weather card without a city: invites the user to pick one. */
/** Temperature over the next 24 hours (large screens); the axis shows the city's hours. */
function drawWeatherChart() {
  if (!LARGE_MQ.matches) return;
  const temps = lastHours.map((h) => h.temp);
  if (temps.length < 2) {
    charts.draw($('wChart'), { t: [], series: [] });
    return;
  }
  const lo = Math.floor(Math.min(...temps)) - 2;
  const hi = Math.ceil(Math.max(...temps)) + 2;
  charts.draw($('wChart'), {
    t: temps.map((_, i) => i), min: lo, max: hi,
    series: [{ values: temps, color: palette().warn, fill: true, width: 2 }],
    fmtY: (v) => `${Math.round(v)}°`, fmtT: (i) => cityHour(lastHours[i].hour),
    font: chartFont(), colors: chartColors(),
  });
}

/**
 * Next 24 hours behind the icon and the temperature (all layouts but large
 * screens): faded under them, clear in the space between.
 */
function drawWeatherBg() {
  const canvas = $('wBgChart');
  const temps = lastHours.map((h) => h.temp);
  if (LARGE_MQ.matches || temps.length < 2) {
    charts.draw(canvas, { t: [], series: [] });
    return;
  }
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = Math.max(hi - lo, 4);
  // Margins keep the curve off the card edges and below the header.
  const geom = charts.draw(canvas, {
    t: temps.map((_, i) => i), min: lo - span * 0.35, max: hi + span * 0.3,
    series: [{ values: temps, color: palette().warn, fill: true, width: 2 }],
  });
  if (!geom) return;
  // Screen boxes give the positions; the mask is drawn in the canvas's own
  // units (the card may be shrunk, see fitting).
  const box = canvas.getBoundingClientRect();
  const icon = $('wIcon').getBoundingClientRect();
  const astroBox = $('wAstro').getBoundingClientRect();
  const reading = document.querySelector('.wReading').getBoundingClientRect();
  const at = (px) => Math.min(1, Math.max(0, (px - box.left) / box.width));
  // Faded under the icon (its drawing only fills the middle of its box) and
  // the moon and sun when they sit beside it, clear up to the temperature.
  const astroBeside = astroBox.width && astroBox.top < reading.bottom && astroBox.bottom > reading.top;
  let left = icon.right - icon.width * 0.12;
  if (astroBeside) left = Math.max(left, astroBox.right);
  const a = at(left);
  const b = at(reading.left);
  const LOW = 0.22;
  const HIGH = 0.95;
  // Wide, soft transitions; in a narrow card the gap would only make a bright
  // strip, so the curve stays faded all along.
  const stops = b - a > 0.2
    ? [[0, LOW], [a - 0.02, LOW], [a + 0.1, HIGH], [b - 0.1, HIGH], [b + 0.02, LOW], [1, LOW]]
    : [[0, LOW], [1, LOW]];
  const ctx = canvas.getContext('2d');
  const [w, h] = [canvas.clientWidth, canvas.clientHeight];
  const g = ctx.createLinearGradient(0, 0, w, 0);
  let prev = 0;
  for (const [pos, alpha] of stops) {
    prev = Math.max(prev, Math.min(1, Math.max(0, pos)));
    g.addColorStop(prev, `rgba(0, 0, 0, ${alpha})`);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Moon and sun on their own line: faded behind that line too.
  if (astroBox.width && !astroBeside) {
    const top = Math.min(1, Math.max(0, (astroBox.top - box.top) / box.height));
    const v = ctx.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(0, 0, 0, 1)');
    v.addColorStop(Math.max(0, top - 0.08), 'rgba(0, 0, 0, 1)');
    v.addColorStop(Math.min(1, top + 0.04), `rgba(0, 0, 0, ${LOW})`);
    v.addColorStop(1, `rgba(0, 0, 0, ${LOW})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/* ---- weather detail (click on the 24-hour curve) ---- */

let wxHover = null;
let wxBuilt = null;
let wxCharts = [];

function weatherDefs(hours) {
  const p = palette();
  const col = (k) => hours.map((h) => h[k]);
  const temps = [...col('temp'), ...col('feels')];
  const compass = t('compass').split(',');
  const total = hours.reduce((sum, h) => sum + (h.rain || 0), 0);
  return [
    {
      label: t('detail.temp'), fmt: (v) => `${num(v, 0)}°`,
      min: Math.floor(Math.min(...temps)) - 2, max: Math.ceil(Math.max(...temps)) + 2,
      series: [{ values: col('temp'), color: p.warn, fill: true, width: 2 }, { values: col('feels'), color: p.faint, dash: [5, 4] }],
      value: (h) => `${Math.round(h.temp)}° · ${t('wx.feels', { temp: `${Math.round(h.feels)}°` })}`,
    },
    {
      label: `${t('wx.rainChance')} · ${t('wx.rainTotal', { mm: num(total, total % 1 ? 1 : 0) })}`,
      fmt: (v) => `${num(v, 0)} %`, max: 100,
      series: [{ values: col('rainProb'), color: p.accent, fill: true }],
      value: (h) => `${h.rainProb} % · ${num(h.rain, h.rain % 1 ? 1 : 0)} mm`,
    },
    {
      label: t('weather.wind'), fmt: (v) => `${num(v, 0)} km/h`, floor: 10,
      series: [{ values: col('wind'), color: p.up, fill: true }, { values: col('gusts'), color: p.faint, dash: [5, 4] }],
      value: (h) => `${Math.round(h.wind)} km/h ${compass[Math.round(h.windDeg / 45) % 8]} · ${t('wx.gusts', { gusts: Math.round(h.gusts) })}`,
    },
  ];
}

function openWeatherDetail() {
  if (lastHours.length < 2) return;
  wxHover = null;
  wxBuilt = null;
  $('wxOv').hidden = false;
  renderWeatherDetail();
}

/** Draws the open weather detail from the last forecast (pointer: hover event). */
function renderWeatherDetail(pointer) {
  if ($('wxOv').hidden) return;
  const hours = lastHours;
  if (hours.length < 2) {
    close($('wxOv'));
    return;
  }
  const w = lastWeather?.data;
  const key = `wmo.${w?.code}`;
  $('wxTitle').textContent = `${t('weather.title')} · ${w?.site || ''}`;
  $('wxSub').textContent = w
    ? `${t('wx.next24')} · ${key in i18n.STRINGS.en ? t(key) : t('weather.unknown')}, ${Math.round(w.temp)} °C`
    : t('wx.next24');
  const sun = w?.sun?.[0];
  const moon = astro.moonPhase(Date.now());
  $('wxSun').textContent = [
    sun && Number.isFinite(sun.rise) ? t('wx.sun', { rise: cityTime(sun.rise, w.timezone), set: cityTime(sun.set, w.timezone) }) : null,
    w ? daylightText(w) : null,
    `${t(`moon.${moon.key}`)} (${fmtShare(moon.illumination)})`,
  ].filter(Boolean).join(' · ');

  const defs = weatherDefs(hours);
  const shape = `${hours.length}:${i18n.lang}`;
  if (wxBuilt !== shape) buildWeatherDetail(defs, hours);
  wxBuilt = shape;

  const font = chartFont();
  const colors = chartColors();
  const fmtT = (i) => cityHour(hours[i].hour);
  const gutter = charts.labelWidth(font, defs.flatMap((d) => charts.axisLabels({ ...d, fmtY: d.fmt })));
  let geom = null;
  defs.forEach((d, k) => {
    const c = wxCharts[k];
    const g = charts.draw(c.canvas, { t: hours.map((_, i) => i), series: d.series, min: d.min, max: d.max, floor: d.floor,
      fmtY: d.fmt, fmtT, font, colors, hover: wxHover, gutter });
    c.geom = g;
    if (k === 0) geom = g;
    c.label.firstChild.textContent = d.label;
    c.now.textContent = d.value(hours[wxHover ?? 0]);
  });
  // Icons above the temperature curve, on its hours (every other one when tight).
  if (geom) {
    const stepPx = geom.pw / (hours.length - 1);
    const every = stepPx < 30 ? 2 : 1;
    [...$('wxIcons').children].forEach((img, i) => {
      img.hidden = i % every !== 0;
      img.style.left = `${geom.pad.l + i * stepPx}px`;
    });
  }
  const tip = $('sdTip');
  if (wxHover != null && pointer) {
    const h = hours[wxHover];
    tip.textContent = [cityHour(h.hour), ...defs.map((d) => t('detail.labelValue', { label: d.label.split(' · ')[0], value: d.value(h) }))].join('\n');
    tip.hidden = false;
    tip.style.left = `${Math.min(pointer.clientX + 14, innerWidth - tip.offsetWidth - 6)}px`;
    tip.style.top = `${Math.max(6, pointer.clientY - tip.offsetHeight - 10)}px`;
  } else if (!pointer) {
    tip.hidden = true;
  }
}

function buildWeatherDetail(defs, hours) {
  const body = $('wxBody');
  const icons = el('div', 'wxIcons');
  icons.id = 'wxIcons';
  for (const h of hours) {
    const img = document.createElement('img');
    img.src = `icons/weather/${h.icon}.svg`;
    img.alt = '';
    icons.appendChild(img);
  }
  body.replaceChildren(icons);
  wxCharts = defs.map(() => {
    const box = el('div', 'sdChart');
    const label = el('div', 'sdLabel');
    label.append(el('span'), el('span', 'sdNow'));
    const canvas = document.createElement('canvas');
    box.append(label, canvas);
    body.appendChild(box);
    const entry = { canvas, label, now: label.lastChild, geom: null };
    canvas.addEventListener('mousemove', (e) => {
      wxHover = charts.indexAt(canvas, entry.geom, e.clientX);
      renderWeatherDetail(e);
    });
    canvas.addEventListener('mouseleave', () => {
      wxHover = null;
      renderWeatherDetail();
    });
    return entry;
  });
}

$('wxMap').addEventListener('click', () => window.dash.openWeatherMap());

function renderNoSite() {
  lastHours = [];
  drawWeatherChart();
  drawWeatherBg();
  $('wHourly').replaceChildren();
  $('wIcon').hidden = true;
  $('wAstro').hidden = true;
  $('wSite').textContent = '--';
  $('wTemp').textContent = '--';
  $('wDesc').textContent = t('weather.pickCity');
  $('wFeels').textContent = t('weather.clickToSearch');
  for (const id of ['wMinMax', 'wRain', 'wWind', 'wStorm']) $(id).textContent = '--';
  $('wStorm').className = 'wVal';
}

function renderWeather(d) {
  const key = `wmo.${d.code}`;
  const desc = key in i18n.STRINGS.en ? t(key) : t('weather.unknown');
  const icon = $('wIcon');
  icon.src = `icons/weather/${d.icon}.svg`;
  icon.alt = desc;
  icon.hidden = false;
  $('wSite').textContent = d.site;
  $('wTemp').textContent = Math.round(d.temp);
  $('wDesc').textContent = desc;
  $('wFeels').textContent = t('weather.feels', { temp: Math.round(d.feels) });
  $('wMinMax').textContent = `${Math.round(d.min)}° · ${Math.round(d.max)}°`;
  $('wRain').textContent = `${num(d.rainSum, d.rainSum % 1 ? 1 : 0)} mm`;
  $('wRainLbl').textContent = t('weather.rainProb', { prob: d.rainProb });
  const compass = t('compass').split(',');
  $('wWind').textContent = `${d.wind} ${compass[Math.round(d.windDeg / 45) % 8]}`;
  $('wWindLbl').textContent = t('weather.windGusts', { gusts: d.gusts });
  const storm = $('wStorm');
  storm.textContent = t(`storm.${d.storm}`);
  storm.className = `wVal ${STORM_CLASS[d.storm] || ''}`;
  renderAstro(d);
  renderHourly(d.hourly || []);
}

/* ---- moon and sun, next to the weather icon ---- */

/** Hours and minutes in the city's time zone (the system one when unknown). */
function cityTime(ms, timeZone) {
  try {
    return fmtTime(ms, { hour: 'numeric', minute: '2-digit', timeZone });
  } catch {
    return hhmm(ms);   // zone name unknown to this system
  }
}

/** Share (0 to 1) as a percentage of the locale: "58%", « 58 % ». */
const fmtShare = (v) => new Intl.NumberFormat(i18n.locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);

/** Day length of the city today, from Open-Meteo (polar day and night included). */
function daylightText(d) {
  const sun = d.sun?.[0];
  const secs = sun?.daylight ?? (Number.isFinite(sun?.set - sun?.rise) ? (sun.set - sun.rise) / 1000 : null);
  if (secs == null) return null;
  const mins = Math.round(secs / 60);
  return t('sun.daylight', { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, '0') });
}

function renderAstro(d) {
  // Drawn lit on the right (waxing, seen from the north): mirrored when
  // waning, and once more south of the equator, where the Moon looks flipped.
  const moon = astro.moonPhase(Date.now());
  const south = (config.weatherSite?.lat ?? 0) < 0;
  $('wMoonLit').setAttribute('d', astro.litPath(moon.elongation, 28, 32));
  $('wMoon').classList.toggle('mirror', !moon.waxing !== south);
  $('wMoonName').textContent = t(`moon.${moon.key}`);
  $('wMoonLitPct').textContent = t('moon.lit', { pct: fmtShare(moon.illumination) });
  const sun = d.sun?.[0];
  const known = Number.isFinite(sun?.rise) && Number.isFinite(sun?.set);
  $('wSunTimes').textContent = known ? `↑ ${cityTime(sun.rise, d.timezone)}\u2003↓ ${cityTime(sun.set, d.timezone)}` : '↑ --\u2003↓ --';
  $('wDayLen').textContent = daylightText(d) || '--';
  $('wAstro').hidden = false;
}

// "4 h" rather than "04 h": French CLDR pads the hour even in numeric form.
const cityHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(i18n.locale, { hour: 'numeric' }).replace(/^0(\d)/, '$1');
let lastHours = [];

/** Next 12 hours (large screens): hour of the city, icon, temperature, rain chance. */
function renderHourly(hours) {
  lastHours = hours;
  drawWeatherChart();
  drawWeatherBg();
  renderWeatherDetail();
  $('wHourly').replaceChildren(...hours.slice(0, 12).map((h) => {
    const cell = el('div', 'wHour');
    const img = document.createElement('img');
    img.className = 'wHourI';
    img.src = `icons/weather/${h.icon}.svg`;
    img.alt = '';
    cell.append(el('span', 'wHourT', cityHour(h.hour)), img, el('span', 'wHourV', `${Math.round(h.temp)}°`),
      el('span', 'wHourR', h.rainProb > 0 ? `${h.rainProb} %` : ''));
    return cell;
  }));
}

function renderWeatherEvent({ data, error, needsSite: noSite }) {
  needsSite = !!noSite;
  $('weather').title = t(needsSite ? 'weather.pickCityTitle' : 'weather.openMap');
  document.querySelector('.wOpen').hidden = needsSite;
  if (needsSite) renderNoSite();
  else if (data) renderWeather(data);
  else if (error) $('wDesc').textContent = t('weather.unavailable');
  scheduleFit();
}

window.dash.onWeather((w) => {
  // An error keeps the last weather on screen, only its description changes.
  if (w.data || w.needsSite) lastWeather = w;
  renderWeatherEvent(w);
});

async function openWeather() {
  if (!needsSite) {
    window.dash.openWeatherMap();
    return;
  }
  await openSettings();
  $('siteSearch').scrollIntoView({ block: 'center' });
  $('siteSearch').focus();
}
$('weather').addEventListener('click', openWeather);
for (const id of ['wMain', 'wChart']) {
  $(id).addEventListener('click', (e) => {
    if (needsSite || lastHours.length < 2) return;   // the card handler picks a city
    e.stopPropagation();
    openWeatherDetail();
  });
}
$('weather').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWeather(); }
});
