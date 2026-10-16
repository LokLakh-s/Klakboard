const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, shell, dialog, Notification, powerMonitor, safeStorage } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const markets = require('./markets');
const system = require('./system');
const weather = require('./weather');
const updates = require('./updates');
const display = require('./display');
const token = require('./token');
const { version: APP_VERSION } = require('./package.json');

/* ---------------- configuration ---------------- */

const DEFAULT_CONFIG = {
  refreshMs: 20000,
  coverTaskbar: true,
  zoom: 1,
  theme: 'dark',
  netTotals: { rx: 0, tx: 0 },
  bounds: null,
  display: null,   // screen picked in "Full screen on…": { id, width, height }
  weatherSite: null,   // picked on first launch
  night: { enabled: true, dim: 0.5 },   // dims the screen from sunset to sunrise
  items: [
    { kind: 'metal', code: 'XAU' },
    { kind: 'metal', code: 'XAG' },
    { kind: 'fx', from: 'EUR', to: 'USD' },
    { kind: 'fx', from: 'USD', to: 'JPY' },
    { kind: 'crypto', symbol: 'BTC', vs: 'USDT', binance: 'BTCUSDT' },
    { kind: 'crypto', symbol: 'ETH', vs: 'USDT', binance: 'ETHUSDT' },
  ],
};

/* Must match --bg of each theme in style.css. */
const THEME_BG = {
  dark: '#0b0e14', light: '#e8ebf0', red: '#150e10', forest: '#0b100a',
  green: '#0a1210', yellow: '#14120a', purple: '#100d16',
};

let config;
let mainWindow;
let marketTimer;
let weatherTimer;
let pendingUpdate = null;
let tray;
let totalsDirty = false;
// Tells a real quit from closing to the notification area: without it the
// window could never close.
let isQuitting = false;

function quitApp() {
  isQuitting = true;
  saveConfig();
  app.quit();
}

const configPath = () => path.join(app.getPath('userData'), 'dashboard.json');

// Deep copy: the config mutates its objects (items, netTotals) in place.
const defaultConfig = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

function loadConfig() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultConfig(); // first launch
  }
  try {
    const loaded = { ...defaultConfig(), ...JSON.parse(raw) };
    // The "blue" theme was replaced by "forest".
    if (loaded.theme === 'blue') loaded.theme = 'forest';
    return loaded;
  } catch (err) {
    // Unreadable file: set aside rather than overwritten on the next save, so the
    // tracked rows can still be recovered by hand.
    try {
      fs.renameSync(file, `${file}.illisible-${Date.now()}`);
    } catch {}
    console.error('config illisible, valeurs par defaut:', err.message);
    return defaultConfig();
  }
}

/**
 * Writes a temporary file then renames it: a power cut mid-write leaves the
 * previous config intact instead of truncated JSON.
 */
function saveConfig() {
  const file = configPath();
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(config, null, 2);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    // Rename refused (e.g. an antivirus holding the file): write directly.
    try {
      fs.writeFileSync(file, data);
    } catch (err) {
      console.error('sauvegarde config impossible:', err.message);
    }
  }
}

/* ---------------- window ---------------- */

/** Screen to cover (see display.js), or null when it is not connected. */
function targetDisplay() {
  return display.findTargetDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, config.display);
}

/** Ordinary 960 x 640 window centred on the primary screen. */
function centeredOnPrimary() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(960, wa.width);
  const height = Math.min(640, wa.height);
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height,
  };
}

function initialBounds() {
  const d = config.coverTaskbar ? targetDisplay() : null;
  if (d) return d.bounds;
  const b = config.bounds;
  return b && display.isOnScreen(screen.getAllDisplays(), b) ? b : centeredOnPrimary();
}

function createWindow() {
  const b = initialBounds();

  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    show: false,             // shown by placeWindow() once its screen is known
    frame: false,            // no title bar
    resizable: true,
    skipTaskbar: true,       // lives in the notification area, not the taskbar
    // Matches the theme, otherwise a dark flash precedes a light theme.
    backgroundColor: THEME_BG[config.theme] || THEME_BG.dark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The window only shows index.html: no navigation, no pop-up (the weather map
  // opens in the browser, through shell).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.loadFile('index.html');
  placeWindow(true);

  // 'resize' and 'move' fire dozens of times per second while dragging: only the
  // final position is saved, 400 ms after the last event.
  let persistTimer;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isMinimized()) {
        config.bounds = mainWindow.getBounds();
        saveConfig();
      }
    }, 400);
  };
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);

  // Closing hides the window to the notification area; only quitApp() lets it
  // really close.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- notification area ---------------- */

function showWindow() {
  if (!mainWindow) return;
  if (config.coverTaskbar && !targetDisplay()) {
    // Shown while the dashboard screen is missing: ordinary window on the
    // primary screen, without covering it. It moves back to its screen when that
    // screen returns (onDisplaysChanged).
    awaitingDisplay = false;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setBounds(centeredOnPrimary());
    mainWindow.show();
    return;
  }
  mainWindow.show();
  // The level must be set again after show(), otherwise Windows puts the window
  // back under the taskbar.
  if (config.coverTaskbar) mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

/** Opens a panel (settings or add) in the window, from the tray menu. */
function openPanel(name) {
  showWindow();
  if (mainWindow) mainWindow.webContents.send('open-panel', name);
}

function buildTrayMenu() {
  const template = [];
  if (pendingUpdate) {
    template.push(
      { label: `⬇  Installer la mise à jour ${pendingUpdate.version}…`, click: () => installUpdate() },
      { type: 'separator' },
    );
  }
  template.push(
    { label: 'Afficher / masquer', click: toggleWindow },
    { label: 'Rafraîchir les cours', click: refreshMarkets },
    { label: 'Ajouter une ligne…', click: () => openPanel('add') },
    { label: 'Réglages…', click: () => openPanel('settings') },
    { type: 'separator' },
    { label: `Vérifier les mises à jour (v${APP_VERSION})`, click: () => checkForUpdates({ manual: true }) },
    { label: 'Quitter Klakboard', click: quitApp },
  );
  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(pendingUpdate ? `Klakboard — mise à jour ${pendingUpdate.version} disponible` : 'Klakboard');
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Klakboard');
  refreshTrayMenu();
  tray.on('click', toggleWindow);
}

/* ---------------- placement ---------------- */

// True while the window is hidden because its screen is missing: it comes back
// by itself with the screen. Hidden by the user, it stays hidden.
let awaitingDisplay = false;

/**
 * Fits the window to its screen. In cover mode, 'screen-saver' is the only
 * level above the Windows taskbar, and the window takes the screen's PHYSICAL
 * bounds (workArea excludes the taskbar). When that screen is missing (not
 * detected yet at login, unplugged), the window is hidden: covering the primary
 * screen on top of everything would make it unusable.
 *
 * @param {boolean} reveal the window must be visible (startup); otherwise its
 *   current visibility is kept.
 */
function placeWindow(reveal = false) {
  if (!mainWindow) return;
  const wantVisible = reveal || awaitingDisplay || mainWindow.isVisible();
  if (!config.coverTaskbar) {
    awaitingDisplay = false;
    mainWindow.setAlwaysOnTop(false);
    if (wantVisible) mainWindow.show();
    return;
  }
  const d = targetDisplay();
  if (!d) {
    mainWindow.hide();
    awaitingDisplay = wantVisible;
    return;
  }
  awaitingDisplay = false;
  mainWindow.setBounds(d.bounds);
  if (wantVisible) showWindow();
  else mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

// Plugging a screen fires a burst of events: wait for the last one.
let displayTimer;
function onDisplaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => placeWindow(), 500);
}

/* ---------------- markets ---------------- */

// Last successful quote per row ({ price, change24h, at }): a failing source
// keeps the last known price on screen, greyed out, instead of "--".
const lastGood = new Map();
let marketsBusy = false;
let marketsAgain = false;

async function refreshMarkets() {
  if (!mainWindow) return;
  // One cycle at a time; a request during a cycle (row added) runs another one
  // right after.
  if (marketsBusy) { marketsAgain = true; return; }
  marketsBusy = true;
  try {
    let quotes = {};
    let errors;
    try {
      ({ quotes, errors } = await markets.getQuotes(config.items));
    } catch (err) {
      errors = [err.message];
    }
    const now = Date.now();
    for (const [key, q] of Object.entries(quotes)) {
      if (q.price != null) lastGood.set(key, { ...q, at: now });
    }
    const out = {};
    for (const it of config.items) {
      const key = markets.keyOf(it);
      out[key] = lastGood.get(key) || { price: null, change24h: null, at: null };
    }
    if (mainWindow) {
      mainWindow.webContents.send('quotes', {
        quotes: out,
        updatedAt: now,
        errors,
        // Older quotes are stale: three missed cycles, two minutes at least.
        staleMs: Math.max(3 * config.refreshMs, 120000),
      });
    }
  } finally {
    marketsBusy = false;
    if (marketsAgain) { marketsAgain = false; refreshMarkets(); }
  }
}

function restartMarketTimer() {
  if (marketTimer) clearInterval(marketTimer);
  marketTimer = setInterval(refreshMarkets, config.refreshMs);
}

/* ---------------- sparklines ---------------- */

// A 12-hour curve barely moves in 20 s: refreshed every 5 min.
const SPARK_EVERY_MS = 5 * 60 * 1000;
let sparkTimer;

async function refreshSparks() {
  if (!mainWindow) return;
  const sparks = await markets.getSparks(config.items).catch(() => ({}));
  if (mainWindow) mainWindow.webContents.send('sparks', sparks);
}

/* ---------------- weather ---------------- */

async function refreshWeather() {
  if (!mainWindow) return;
  if (!config.weatherSite) {
    lastSun = null;
    mainWindow.webContents.send('weather', { data: null, error: null, needsSite: true });
    applyNight();
    return;
  }
  try {
    const data = await weather.getWeather(config.weatherSite);
    lastSun = data.sun;
    if (mainWindow) mainWindow.webContents.send('weather', { data, error: null });
    applyNight();
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('weather', { data: null, error: err.message });
  }
}

/* ---------------- night mode ---------------- */

// Sun times of the weather city: night is evaluated every minute, while the
// weather is only refreshed every 15 min.
let lastSun = null;
let nightTimer;

function applyNight() {
  if (!mainWindow) return;
  const win = weather.nightWindow(Date.now(), lastSun);
  mainWindow.webContents.send('night', {
    on: config.night.enabled && !!win?.on,
    dim: config.night.dim,
    from: win?.from ?? null,
    until: win?.until ?? null,
    current: !!win?.on,
  });
}

/* ---------------- updates ---------------- */

const tokenPath = () => path.join(app.getPath('userData'), token.PLAIN);
const readUpdateToken = () => token.readToken(app.getPath('userData'), safeStorage);

// The app archive only runs on the Electron major it was built for.
const findUpdate = () =>
  updates.findUpdate(APP_VERSION, process.versions.electron.split('.')[0], readUpdateToken());

async function checkForUpdates({ manual = false } = {}) {
  let update;
  try {
    update = await findUpdate();
  } catch (err) {
    console.error('verification des mises a jour impossible:', err.message);
    if (manual) {
      dialog.showErrorBox('Vérification impossible',
        `${err.message}\n\nPour changer de token GitHub, le déposer en clair dans : ${tokenPath()}`);
    }
    return;
  }
  if (!update) {
    if (manual) {
      dialog.showMessageBox({ type: 'info', title: 'Klakboard', message: `Klakboard ${APP_VERSION} est à jour.` });
    }
    return;
  }
  if (manual) return installUpdate(update);
  if (pendingUpdate && pendingUpdate.version === update.version) return;
  pendingUpdate = update;
  refreshTrayMenu();
  if (Notification.isSupported()) {
    const n = new Notification({
      title: `Klakboard ${update.version} disponible`,
      body: 'Cliquer ici pour mettre à jour (ou clic droit sur l\'icône de Klakboard).',
    });
    n.on('click', () => installUpdate());
    n.show();
  }
}

/**
 * Replaces resources/app.asar with the new version. The current file is locked
 * while the app runs: updater.js (copied out of the archive) waits for the
 * process to exit, swaps the file, then restarts Klakboard.
 */
function swapAndRelaunch(staged, target) {
  const helper = path.join(os.tmpdir(), 'klakboard-updater.js');
  fs.writeFileSync(helper, fs.readFileSync(path.join(__dirname, 'updater.js')));
  const logFile = path.join(os.tmpdir(), 'klakboard-update.log');
  spawn(process.execPath, [helper, String(process.pid), staged, target, process.execPath, logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

let installing = false;

async function installUpdate(update = pendingUpdate) {
  if (!update || installing) return;
  pendingUpdate = update;
  refreshTrayMenu();
  // No parent window: the dialog opens on the primary screen, where the user
  // clicked, not on the small dashboard screen.
  const viaInstaller = update.kind === 'installer';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Mettre à jour', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Mise à jour Klakboard',
    message: `Klakboard ${update.version} est disponible (version actuelle : ${APP_VERSION}).`,
    detail: viaInstaller
      ? 'Cette version change le moteur de Klakboard : elle passe par l\'installeur complet. '
        + 'Klakboard va se fermer et l\'installation s\'ouvrir ; Klakboard se relancera à la fin.'
      : 'Klakboard va se fermer, se mettre à jour puis se relancer toute seule.',
  });
  if (response !== 0) return;

  installing = true;
  try {
    // Release data read again right before downloading: the notification's may
    // predate GitHub publishing the digest.
    const fresh = await findUpdate().catch(() => null);
    if (fresh?.version === update.version) update = fresh;
    if (viaInstaller) {
      // Unsigned installer, but written by the app rather than a browser: without the
      // "downloaded from the Internet" mark, SmartScreen does not step in.
      const setup = path.join(os.tmpdir(), update.asset.name);
      await updates.downloadAsset(update.asset, readUpdateToken(), setup);
      // Quit only once the installer has actually started.
      await new Promise((resolve, reject) => {
        const child = spawn(setup, [], { detached: true, stdio: 'ignore' });
        child.once('spawn', resolve);
        child.once('error', reject);
        child.unref();
      });
    } else {
      const target = path.join(process.resourcesPath, 'app.asar');
      const staged = `${target}.new`;
      await updates.downloadAsset(update.asset, readUpdateToken(), staged);
      swapAndRelaunch(staged, target);
    }
    quitApp();
  } catch (err) {
    installing = false;
    dialog.showErrorBox('Mise à jour impossible', err.message);
  }
}

/* ---------------- lifecycle ---------------- */

// Windows only shows notifications for a known AppUserModelID: the one of the
// shortcut created by the installer, i.e. build.appId.
if (process.platform === 'win32') app.setAppUserModelId('com.klakh.klakboard');

// Single instance: starting Klakboard while it runs (or while an update
// restarts it) shows the existing window instead of opening another one.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  config = loadConfig();
  createWindow();
  createTray();

  // Safety net: with no title bar and above the taskbar, a crashed renderer would
  // leave a window that cannot be closed.
  globalShortcut.register('CommandOrControl+Shift+Q', quitApp);

  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // After sleep, quotes and weather are outdated: do not wait for the next cycle.
  powerMonitor.on('resume', () => {
    refreshMarkets();
    refreshSparks();
    refreshWeather();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(config.zoom || 1);
    refreshMarkets();
    restartMarketTimer();

    refreshSparks();
    sparkTimer = setInterval(refreshSparks, SPARK_EVERY_MS);

    refreshWeather();
    weatherTimer = setInterval(refreshWeather, 15 * 60 * 1000);
    nightTimer = setInterval(applyNight, 60 * 1000);

    setTimeout(checkForUpdates, 8000);
    setInterval(checkForUpdates, 30 * 60 * 1000);

    system.start((sample) => {
      // Network totals add up deltas: OS counters restart from zero at each boot, an
      // absolute value would be wrong.
      config.netTotals.rx += sample.net.delta.rx;
      config.netTotals.tx += sample.net.delta.tx;
      totalsDirty = true;
      if (mainWindow) {
        mainWindow.webContents.send('sys', { ...sample, totals: config.netTotals });
      }
    });
  });
});

// Network totals change every second; saving them that often would wear the
// disk for nothing. Once a minute is enough, and quitting saves anyway.
setInterval(() => {
  if (totalsDirty) { saveConfig(); totalsDirty = false; }
}, 60000);

// The app survives its window being closed: it lives in the notification area
// until "Quit".
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  system.stop();
  if (marketTimer) clearInterval(marketTimer);
  if (sparkTimer) clearInterval(sparkTimer);
  if (weatherTimer) clearInterval(weatherTimer);
  if (nightTimer) clearInterval(nightTimer);
  saveConfig();
});

/* ---------------- IPC ---------------- */

ipcMain.handle('get-config', () => config);
ipcMain.handle('get-catalogs', () => ({
  metals: markets.METALS,
  fxCurrencies: markets.FX_CURRENCIES,
}));

ipcMain.handle('set-refresh', (_e, ms) => {
  // Lower bound: below it, the keyless sources end up refusing requests.
  config.refreshMs = Math.min(3600000, Math.max(5000, Number(ms) || DEFAULT_CONFIG.refreshMs));
  saveConfig();
  restartMarketTimer();
  return config;
});

/** Connected screens, so the user can pick where to show the dashboard. */
ipcMain.handle('get-displays', () => {
  const current = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds()).id
    : screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Écran ${i + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
    x: d.bounds.x,
    y: d.bounds.y,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
    current: d.id === current,
  }));
});

/** Full screen above the taskbar, on the given screen. */
ipcMain.handle('snap-to-display', (_e, displayId) => {
  if (!mainWindow) return config;
  const d = screen.getAllDisplays().find((x) => x.id === displayId) || screen.getPrimaryDisplay();
  // Remembered for the next launches.
  config.display = display.displayKey(d);
  config.coverTaskbar = true;
  config.bounds = d.bounds;
  saveConfig();
  placeWindow();
  return config;
});

/**
 * Windowed size, anchored on the current screen and clamped to it. Switches to
 * window mode: in cover mode the window would take the whole screen again at
 * the next launch or screen change.
 */
ipcMain.handle('set-resolution', (_e, { width, height }) => {
  if (!mainWindow) return config;
  config.coverTaskbar = false;
  mainWindow.setAlwaysOnTop(false);
  const d = screen.getDisplayMatching(mainWindow.getBounds());
  const w = Math.min(width, d.bounds.width);
  const h = Math.min(height, d.bounds.height);
  const cur = mainWindow.getBounds();
  const x = Math.min(Math.max(cur.x, d.bounds.x), d.bounds.x + d.bounds.width - w);
  const y = Math.min(Math.max(cur.y, d.bounds.y), d.bounds.y + d.bounds.height - h);
  mainWindow.setBounds({ x, y, width: w, height: h });
  config.bounds = { x, y, width: w, height: h };
  saveConfig();
  return config;
});

/**
 * Start at login (Run registry key on Windows). Always returns the REAL state
 * read from the OS, not `config`: the user may disable the entry from Task
 * Manager, and the config would then be wrong.
 */
function autoLaunchState() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

ipcMain.handle('get-auto-launch', () => autoLaunchState());

ipcMain.handle('set-auto-launch', (_e, on) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      path: process.execPath,
      // In development process.execPath is electron.exe: without the project path as
      // argument, the entry would start an empty Electron.
      args: app.isPackaged ? [] : [path.resolve(process.argv[1] || '.')],
    });
  } catch (err) {
    console.error('demarrage automatique impossible:', err.message);
  }
  const real = autoLaunchState();
  config.autoLaunch = real;
  saveConfig();
  return real;
});

ipcMain.handle('set-theme', (_e, name) => {
  config.theme = Object.hasOwn(THEME_BG, name) ? name : 'dark';
  saveConfig();
  return config;
});

ipcMain.handle('set-zoom', (_e, z) => {
  config.zoom = Math.min(2.5, Math.max(0.8, Number(z) || 1));
  saveConfig();
  if (mainWindow) mainWindow.webContents.setZoomFactor(config.zoom);
  return config;
});

ipcMain.handle('set-cover-taskbar', (_e, on) => {
  config.coverTaskbar = !!on;
  // No screen picked and no small screen detected: cover the screen the window
  // is on rather than hiding it.
  if (config.coverTaskbar && mainWindow && !targetDisplay()) {
    config.display = display.displayKey(screen.getDisplayMatching(mainWindow.getBounds()));
  }
  saveConfig();
  placeWindow();
  return config;
});

ipcMain.handle('add-item', (_e, raw) => {
  const item = markets.normalizeItem(raw);
  if (!item) return config;
  const k = markets.keyOf(item);
  if (!config.items.some((i) => markets.keyOf(i) === k)) {
    config.items.push(item);
    saveConfig();
    refreshMarkets();
    refreshSparks();
  }
  return config;
});

ipcMain.handle('remove-item', (_e, item) => {
  const k = markets.keyOf(item);
  config.items = config.items.filter((i) => markets.keyOf(i) !== k);
  saveConfig();
  refreshMarkets();
  return config;
});

ipcMain.handle('get-chart', async (_e, { item: raw, range } = {}) => {
  const item = markets.normalizeItem(raw);
  if (!item) return { points: [], error: 'ligne inconnue' };
  try {
    return { ...(await markets.getChart(item, range)), error: null };
  } catch (err) {
    return { points: [], error: err.message };
  }
});

ipcMain.handle('search-crypto', async (_e, q) => {
  try {
    return await markets.searchCrypto(q);
  } catch {
    return [];
  }
});

ipcMain.handle('reset-net-totals', () => {
  config.netTotals = { rx: 0, tx: 0 };
  saveConfig();
  return config.netTotals;
});

ipcMain.handle('open-weather-map', () => {
  if (config.weatherSite) shell.openExternal(weather.mapUrl(config.weatherSite));
});

ipcMain.handle('set-night', (_e, { enabled, dim } = {}) => {
  const level = Number(dim);
  config.night = {
    enabled: enabled === undefined ? config.night.enabled : !!enabled,
    dim: Number.isFinite(level) ? Math.min(0.9, Math.max(0.1, level)) : config.night.dim,
  };
  saveConfig();
  applyNight();
  return config;
});

ipcMain.handle('search-places', async (_e, q) => {
  try {
    return await weather.searchPlaces(String(q).slice(0, 80));
  } catch {
    return [];
  }
});

ipcMain.handle('set-weather-site', (_e, site) => {
  const lat = Number(site?.lat);
  const lon = Number(site?.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return config;
  config.weatherSite = {
    label: String(site.label || '').slice(0, 60) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    lat,
    lon,
    // IANA time zone of the city (weather day, min/max); Open-Meteo guesses it otherwise.
    timezone: /^[A-Za-z_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(site.timezone || '') ? site.timezone : 'auto',
  };
  saveConfig();
  refreshWeather();
  return config;
});
