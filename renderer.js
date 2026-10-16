const $ = (id) => document.getElementById(id);

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

function fmtPrice(v) {
  if (v == null) return '--';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(v);
}

function fmtChange(c) {
  if (c == null) return '--';
  return `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;
}

function fmtBytes(b) {
  if (b >= 1e12) return [(b / 1e12).toFixed(2), 'TB'];
  if (b >= 1e9) return [(b / 1e9).toFixed(2), 'GB'];
  if (b >= 1e6) return [(b / 1e6).toFixed(1), 'MB'];
  if (b >= 1e3) return [(b / 1e3).toFixed(0), 'kB'];
  return [String(Math.round(b)), 'B'];
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null) return ['--', ''];
  const b = bytesPerSec;
  if (b >= 1e6) return [(b / 1e6).toFixed(1), 'MB/s'];
  if (b >= 1e3) return [(b / 1e3).toFixed(0), 'kB/s'];
  return [b.toFixed(0), 'B/s'];
}

/* ---------------- market badges ---------------- */

function renderMarkets() {
  const wrap = $('mScroll');
  wrap.innerHTML = '';
  rowCells.clear();

  if (!config.items.length) {
    wrap.innerHTML = '<p class="emptyHint">Aucune ligne suivie.<br>Clic droit sur l’icône Klakboard → Ajouter une ligne…</p>';
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
  rm.title = `Retirer ${labelOf(it)}`;
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
    it.kind === 'metal' ? (catalogs.metals[it.code]?.label || 'USD')
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
    cell.badge.title = stale ? `Dernière cotation à ${new Date(q.at).toLocaleTimeString('fr-FR')}` : '';

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
window.dash.onQuotes((d) => {
  staleMs = d.staleMs || staleMs;
  lastQuotes = d.quotes;
  applyQuotes(d.quotes);
  const dot = $('statusDot');
  const at = new Date(d.updatedAt).toLocaleTimeString('fr-FR');
  if (d.errors?.length) {
    dot.className = 'dot error';
    dot.title = `Marchés (${at}) — en panne :\n${d.errors.join('\n')}`;
  } else {
    dot.className = 'dot live';
    dot.title = `Marchés à jour — ${at}`;
  }
});

/* ---------------- clock ---------------- */

function tickClock() {
  const d = new Date();
  $('clockTime').textContent = d.toLocaleTimeString('fr-FR');
  $('dateDay').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long' });
  $('dateFull').textContent = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
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
    themeColors = { up: v('--up'), down: v('--down'), accent: v('--accent'), line: v('--line'), faint: v('--faint') };
  }
  return themeColors;
}

window.dash.onSys((s) => {
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
  $('cpuCount').textContent = `${s.cpu.per.length} threads`;

  // RAM
  const r = s.ram;
  $('ramPct').textContent = `${r.pct.toFixed(0)}%`;
  const rb = $('ramBar');
  rb.style.width = `${r.pct}%`;
  rb.style.background = loadColor(r.pct);
  // "19.4 / 68.5 GB" rather than "19.37 GB / 68.46 GB": at 24 px the long form
  // takes 355 of 367 available px, and the 2nd decimal tells nothing.
  const g = (b) => (b / 1e9).toFixed(1);
  $('ramUsed').textContent = `${g(r.used)} / ${g(r.total)} GB`;
  $('ramFree').textContent = `${g(r.free)} GB libres`;

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
    $('vramVal').textContent = `${(s.gpu.memUsed / 1024).toFixed(1)} / ${(s.gpu.memTotal / 1024).toFixed(1)} Go`;
    $('gpuName').textContent = (s.gpu.name || '').replace(/NVIDIA |GeForce /g, '');
    const fan = s.gpu.fan != null ? `${s.gpu.fan}%` : 'n/a';
    $('gpuFanTemp').textContent = `vent. ${fan} · ${s.gpu.temp ?? '--'}°C`;
  } else {
    $('gpuCard').style.opacity = '.45';
    $('gpuUtil').textContent = 'n/a';
    $('gpuName').textContent = 'aucun GPU NVIDIA';
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

  pushNetHistory(rate.down ?? 0, rate.up ?? 0);
});

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
  spark.label.textContent = `pic ${pv} ${pu}`;
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
    area.innerHTML = '<div class="chartMsg">Pas de données pour cette période</div>';
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
  $('chartArea').innerHTML = '<div class="chartMsg">chargement...</div>';
  const res = await window.dash.getChart(chartItem, chartRange);
  if (req !== chartReq) return;
  if (res.error) {
    $('chartArea').replaceChildren(el('div', 'chartMsg', `erreur : ${res.error}`));
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

function close(el) { el.hidden = true; }

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

$('purgeBtn').addEventListener('click', async () => {
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
    const tags = [d.primary ? 'principal' : null, d.scaleFactor !== 1 ? `${Math.round(d.scaleFactor * 100)} %` : null]
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

const hhmm = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

window.dash.onNight(({ on, dim, from, until, current }) => {
  $('nightVeil').style.opacity = on ? String(dim) : '0';
  const span = from ? `${hhmm(from)} → ${until ? hhmm(until) : '?'}` : `jusqu'à ${hhmm(until)}`;
  $('nightHint').textContent = until || from
    ? `${current ? 'Nuit en cours' : 'Prochaine nuit'} : ${span}, d'après le soleil à ${config.weatherSite?.label || 'la ville météo'}.`
    : config.weatherSite
      ? 'Heures du soleil pas encore connues (météo indisponible).'
      : 'Choisir une ville météo : la nuit suit son coucher et son lever du soleil.';
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
    if (!places.length) ul.innerHTML = '<li class="rsNone">Aucune ville trouvée</li>';
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
  for (const [code, meta] of Object.entries(catalogs.metals)) {
    const item = { kind: 'metal', code };
    const b = document.createElement('button');
    b.className = 'pickBtn';
    b.innerHTML = `<span class="pCode">${code}</span><span class="pLbl">${meta.label}</span>`;
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

(async function init() {
  config = await window.dash.getConfig();
  catalogs = await window.dash.getCatalogs();
  document.documentElement.dataset.theme = config.theme || 'dark';
  themeColors = null;

  const opts = catalogs.fxCurrencies.map((c) => `<option value="${c}">${c}</option>`).join('');
  $('fxFrom').innerHTML = opts;
  $('fxTo').innerHTML = opts;
  $('fxFrom').value = 'EUR';
  $('fxTo').value = 'USD';

  $('wSite').textContent = config.weatherSite?.label || '--';
  renderMarkets();
  syncSettings();
})();

window.addEventListener('resize', () => {
  if (!$('chartOv').hidden) loadChart();
});

/* ---------------- weather ---------------- */

const STORM_CLASS = { faible: '', possible: 'warn', fort: 'alert' };

// True until a weather city is picked (first launch).
let needsSite = false;

/** Weather card without a city: invites the user to pick one. */
function renderNoSite() {
  $('wIcon').hidden = true;
  $('wSite').textContent = '--';
  $('wTemp').textContent = '--';
  $('wDesc').textContent = 'Choisir une ville';
  $('wFeels').textContent = 'Cliquer pour rechercher';
  for (const id of ['wMinMax', 'wRain', 'wWind', 'wStorm']) $(id).textContent = '--';
  $('wStorm').className = 'wVal';
}

function renderWeather(d) {
  const icon = $('wIcon');
  icon.src = `icons/weather/${d.icon}.svg`;
  icon.alt = d.desc;
  icon.hidden = false;
  $('wSite').textContent = d.site;
  $('wTemp').textContent = Math.round(d.temp);
  $('wDesc').textContent = d.desc;
  $('wFeels').textContent = `Ressenti ${Math.round(d.feels)} °C`;
  $('wMinMax').textContent = `${Math.round(d.min)}° · ${Math.round(d.max)}°`;
  $('wRain').textContent = `${d.rainSum} mm`;
  $('wRainLbl').textContent = `Pluie · ${d.rainProb} %`;
  $('wWind').textContent = `${d.wind} ${d.windDir}`;
  $('wWindLbl').textContent = `Vent · raf. ${d.gusts}`;
  const storm = $('wStorm');
  storm.textContent = d.storm;
  storm.className = `wVal ${STORM_CLASS[d.storm]}`;
}

window.dash.onWeather(({ data, error, needsSite: noSite }) => {
  needsSite = !!noSite;
  $('weather').title = needsSite ? 'Choisir la ville météo' : 'Ouvrir la carte météo';
  document.querySelector('.wOpen').hidden = needsSite;
  if (needsSite) renderNoSite();
  else if (data) renderWeather(data);
  else if (error) $('wDesc').textContent = 'Météo indisponible';
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
$('weather').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWeather(); }
});
