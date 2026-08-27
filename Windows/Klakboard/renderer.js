const $ = (id) => document.getElementById(id);

let config = { items: [], refreshMs: 20000, coverTaskbar: true };
let catalogs = { metals: {}, fxCurrencies: [] };
let lastQuotes = {};
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

/* ---------------- formatage ---------------- */

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
  const bits = bytesPerSec;
  if (bits >= 1e6) return [(bits / 1e6).toFixed(1), 'MB/s'];
  if (bits >= 1e3) return [(bits / 1e3).toFixed(0), 'kB/s'];
  return [bits.toFixed(0), 'B/s'];
}

/* ---------------- tableau des marches ---------------- */

function renderMarkets() {
  const wrap = $('mScroll');
  wrap.innerHTML = '';
  rowCells.clear();

  if (!config.items.length) {
    wrap.innerHTML = '<p class="emptyHint">Aucune ligne suivie.<br>Touchez + pour en ajouter.</p>';
    return;
  }

  // Une seule grille, sans en-tetes de categorie : le tri suffit a regrouper
  // et chaque badge porte deja sa cotation (Or, USD, USDT).
  const grid = document.createElement('div');
  grid.className = 'badges';
  const sorted = [...config.items].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
  );
  for (const it of sorted) grid.appendChild(makeBadge(it));
  wrap.appendChild(grid);
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

  // Un metal est toujours cote en USD : afficher "USD" n'apprendrait rien,
  // on met son nom francais a la place ("XAU  Or").
  const sym = it.kind === 'metal' ? it.code : it.kind === 'fx' ? it.from : it.symbol;
  const vs =
    it.kind === 'metal' ? (catalogs.metals[it.code]?.label || 'USD')
    : it.kind === 'fx' ? it.to
    : it.vs;

  const top = document.createElement('div');
  top.className = 'bTop';
  top.innerHTML = `<span class="bSym">${sym}</span><span class="bVs">${vs}</span>`;
  top.appendChild(makeRemoveBtn(it, 'bRm'));

  const price = document.createElement('div');
  price.className = 'bPrice';
  price.textContent = '--';

  const chg = document.createElement('div');
  chg.className = 'bChg';
  chg.textContent = '--';

  b.append(top, price, chg);
  b.addEventListener('click', () => openChart(it));
  rowCells.set(keyOf(it), { price, chg, badge: b });
  return b;
}

function applyQuotes(quotes) {
  if (!quotes) return;
  for (const [key, cell] of rowCells) {
    const q = quotes[key];
    if (!q) continue;

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

    // Le badge entier se teinte : la tendance se lit sans chercher le chiffre.
    if (cell.badge) {
      cell.badge.classList.toggle('up', q.change24h > 0);
      cell.badge.classList.toggle('down', q.change24h < 0);
    }
  }
}

/* L'heure de mise a jour des marches migre sur l'infobulle de la pastille :
   le bandeau affiche desormais la date et l'heure courantes. */
window.dash.onQuotes((d) => {
  const dot = $('statusDot');
  if (d.error) {
    dot.className = 'dot error';
    dot.title = `Erreur marchés : ${d.error}`;
    return;
  }
  lastQuotes = d.quotes;
  applyQuotes(d.quotes);
  dot.className = 'dot live';
  dot.title = `Marchés à jour — ${new Date(d.updatedAt).toLocaleTimeString('fr-FR')}`;
});

/* ---------------- horloge ---------------- */

function tickClock() {
  const d = new Date();
  const date = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  $('stamp').textContent = `${date} · ${d.toLocaleTimeString('fr-FR')}`;
}
tickClock();
setInterval(tickClock, 1000);

/* ---------------- panneau systeme ---------------- */

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

/** Vert -> ambre -> rouge : la couleur porte l'info autant que la hauteur. */
function loadColor(pct) {
  if (pct >= 85) return 'var(--down)';
  if (pct >= 55) return 'var(--warn)';
  return 'var(--up)';
}

/* Couleurs du theme lues une fois et memorisees : getComputedStyle a chaque
   trace de sparkline (1x/s) provoquerait un recalcul de style inutile. */
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
  // La couleur n'est reecrite que lorsqu'elle change vraiment de palier :
  // 32 affectations de `background` par seconde declenchaient un recalcul de
  // style pour rien.
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
  // "Intel(R) Core(TM) i9-14900KF" -> "i9-14900KF" : a 24 px la marque deborde.
  $('cpuModel').textContent = (s.cpuModel || '')
    .replace(/\(R\)|\(TM\)|CPU|Processor|Intel|AMD|Core/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  $('cpuCount').textContent = `${s.cpu.per.length} threads`;

  // RAM
  const r = s.ram;
  $('ramPct').textContent = `${r.pct.toFixed(0)}%`;
  const rb = $('ramBar');
  rb.style.width = `${r.pct}%`;
  rb.style.background = loadColor(r.pct);
  // "19.4 / 68.5 GB" et non "19.37 GB / 68.46 GB" : a 24 px la version longue
  // mesure 355 px pour 367 disponibles, et la 2e decimale n'apprend rien.
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

  // Reseau
  const [dv, du] = fmtRate(s.net.rate.down);
  const [uv2, uu2] = fmtRate(s.net.rate.up);
  $('netDown').textContent = dv;
  $('netDownU').textContent = du;
  $('netUp').textContent = uv2;
  $('netUpU').textContent = uu2;
  const [trv, tru] = fmtBytes(s.totals.rx);
  const [ttv, ttu] = fmtBytes(s.totals.tx);
  $('totDown').textContent = `↓ ${trv} ${tru}`;
  $('totUp').textContent = `↑ ${ttv} ${ttu}`;

  pushNetHistory(s.net.rate.down, s.net.rate.up);
});

/* ---------------- historique de debit ---------------- */

const NET_HIST = 90;              // 90 s d'historique
const netHist = { down: [], up: [] };

function pushNetHistory(down, up) {
  netHist.down.push(down);
  netHist.up.push(up);
  if (netHist.down.length > NET_HIST) { netHist.down.shift(); netHist.up.shift(); }
  drawNetSpark();
}

/* Le SVG est construit UNE fois puis seuls les attributs `points` changent :
   reconstruire l'arbre via innerHTML chaque seconde forcait un reparse HTML
   et une nouvelle mise en page a chaque tick. */
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

  // Echelle commune aux deux courbes, sinon on ne peut pas les comparer d'un
  // coup d'oeil. Plancher a 64 ko/s pour que le bruit de fond reste plat.
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

/* ---------------- courbe ---------------- */

let chartItem = null;
let chartRange = '7d';

function drawChart(points, up) {
  const area = $('chartArea');
  area.innerHTML = '';
  if (!points.length) {
    area.innerHTML = '<div class="chartMsg">Pas de données pour cette période</div>';
    return;
  }

  const W = area.clientWidth || 600;
  const H = area.clientHeight || 240;
  // Les libelles d'axe sont a AXIS_FS px : la gouttiere droite doit suivre,
  // sinon un prix a 5 chiffres deborde du cadre.
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
  $('chartArea').innerHTML = '<div class="chartMsg">chargement...</div>';
  const res = await window.dash.getChart(chartItem, chartRange);
  if (res.error) {
    $('chartArea').innerHTML = `<div class="chartMsg">erreur : ${res.error}</div>`;
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
  chartRange = '7d';
  $('chTitle').textContent = labelOf(item);
  const q = lastQuotes[keyOf(item)];
  $('chPrice').textContent = q ? fmtPrice(q.price) : '--';
  $('chChange').textContent = '';
  document.querySelectorAll('#ranges .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.range === '7d')
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

/* ---------------- barre du haut ---------------- */

$('refreshBtn').addEventListener('click', (e) => {
  e.currentTarget.classList.add('spin');
  setTimeout(() => e.currentTarget.classList.remove('spin'), 700);
  window.dash.forceRefresh();
});

$('quitBtn').addEventListener('click', () => window.dash.hide());
$('setBtn').addEventListener('click', async () => {
  syncSettings();
  buildDisplayList();
  $('setOv').hidden = false;
  // Relu depuis l'OS a chaque ouverture : l'entree a pu etre desactivee
  // entre-temps depuis le Gestionnaire des taches.
  $('autoTgl').checked = await window.dash.getAutoLaunch();
});
$('addBtn').addEventListener('click', () => { buildMetalPicker(); $('addOv').hidden = false; });

$('purgeBtn').addEventListener('click', async () => {
  await window.dash.resetNetTotals();
});

/* ---------------- reglages ---------------- */

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
}

$('themes').addEventListener('click', async (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  document.documentElement.dataset.theme = b.dataset.theme;
  themeColors = null;   // la palette memorisee n'est plus valable
  spark = null;         // le SVG porte les anciennes couleurs en dur
  config = await window.dash.setTheme(b.dataset.theme);
  syncSettings();
  drawNetSpark();
  if (!$('chartOv').hidden) loadChart();
});

/** Liste des ecrans detectes, avec projection plein ecran au clic. */
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
    b.innerHTML =
      `<span class="dName">${d.label}</span>` +
      `<span class="dRes">${d.width} &times; ${d.height}${tags ? ' · ' + tags : ''}</span>`;
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
  // Le zoom change la taille du viewport : les SVG doivent etre retraces.
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
  // On repositionne la case sur l'etat reellement applique : si Windows refuse
  // l'ecriture dans le registre, la case ne doit pas rester cochee a tort.
  e.target.checked = await window.dash.setAutoLaunch(e.target.checked);
});

/* ---------------- ajout de lignes ---------------- */

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
      li.innerHTML = `<span class="rsSym">${c.symbol}</span><span class="rsVs">/ ${c.vs}</span><span class="rsAdd">+</span>`;
      li.addEventListener('click', () => addItem(item));
      ul.appendChild(li);
    }
  }, 280);
});

/* ---------------- demarrage ---------------- */

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

  renderMarkets();
  syncSettings();
})();

window.addEventListener('resize', () => {
  if (!$('chartOv').hidden) loadChart();
});
