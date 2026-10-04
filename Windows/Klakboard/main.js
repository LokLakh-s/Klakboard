const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, shell, dialog, Notification } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const markets = require('./markets');
const system = require('./system');
const weather = require('./weather');
const updates = require('./updates');
const { version: APP_VERSION } = require('./package.json');

/* ---------------- configuration ---------------- */

const DEFAULT_CONFIG = {
  refreshMs: 20000,
  coverTaskbar: true,
  zoom: 1,
  theme: 'dark',
  netTotals: { rx: 0, tx: 0 },
  bounds: null,
  items: [
    { kind: 'metal', code: 'XAU' },
    { kind: 'metal', code: 'XAG' },
    { kind: 'fx', from: 'EUR', to: 'USD' },
    { kind: 'fx', from: 'USD', to: 'JPY' },
    { kind: 'crypto', symbol: 'BTC', vs: 'USDT', binance: 'BTCUSDT' },
    { kind: 'crypto', symbol: 'ETH', vs: 'USDT', binance: 'ETHUSDT' },
  ],
};

/* Doit refleter --bg de chaque theme dans style.css. */
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
// Distingue une vraie sortie d'une simple mise en veilleuse dans la zone de
// notifications : sans ce drapeau, la fenetre ne pourrait plus jamais se fermer.
let isQuitting = false;

function quitApp() {
  isQuitting = true;
  saveConfig();
  app.quit();
}

const configPath = () => path.join(app.getPath('userData'), 'dashboard.json');

function loadConfig() {
  try {
    const loaded = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
    // Le theme "blue" a ete remplace par "forest".
    if (loaded.theme === 'blue') loaded.theme = 'forest';
    return loaded;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('sauvegarde config impossible:', err.message);
  }
}

/* ---------------- fenetre ---------------- */

/** Cible en priorite le petit ecran secondaire (le 6 pouces en 960x640). */
function pickDisplay() {
  const all = screen.getAllDisplays();
  const exact = all.find((d) => d.bounds.width === 960 && d.bounds.height === 640);
  if (exact) return exact;
  const small = all
    .filter((d) => d.bounds.width <= 1100 && d.bounds.height <= 800)
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  return small[0] || screen.getPrimaryDisplay();
}

function createWindow() {
  const target = pickDisplay();
  const b = config.bounds || target.bounds;

  mainWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,            // pas de bandeau de fenetre
    resizable: true,
    skipTaskbar: true,       // presente dans la zone de notifications, pas la barre des taches
    // Accordee au theme, sinon un flash sombre precede le rendu en theme clair.
    backgroundColor: THEME_BG[config.theme] || THEME_BG.dark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  if (config.coverTaskbar) applyCoverTaskbar(true);

  // 'resize' et 'move' se declenchent des dizaines de fois par seconde pendant
  // un glisser : ecrire le fichier a chaque evenement, c'etait des centaines
  // d'ecritures disque pour un seul deplacement. On ne garde que la position
  // finale, 400 ms apres le dernier evenement.
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

  // Fermer met en veilleuse dans la zone de notifications ; seul quitApp()
  // laisse reellement passer la fermeture.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------------- zone de notifications ---------------- */

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  // Le niveau doit etre reaffirme apres un show(), sinon Windows repose la
  // fenetre sous la barre des taches.
  if (config.coverTaskbar) mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

/** Ouvre un panneau (settings ou add) dans la fenetre, depuis le menu de la zone de notifications. */
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

/**
 * Le niveau 'screen-saver' est le seul qui passe au-dessus de la barre des
 * taches Windows ; on recale aussi la fenetre sur les bounds PHYSIQUES de
 * l'ecran (et non sur workArea, qui exclut justement la barre).
 */
function applyCoverTaskbar(on) {
  if (!mainWindow) return;
  if (on) {
    const d = pickDisplay();
    mainWindow.setBounds(d.bounds);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
}

/* ---------------- marches ---------------- */

async function refreshMarkets() {
  if (!mainWindow) return;
  try {
    const quotes = await markets.getQuotes(config.items);
    mainWindow.webContents.send('quotes', {
      quotes,
      items: config.items,
      updatedAt: Date.now(),
      error: null,
    });
  } catch (err) {
    mainWindow.webContents.send('quotes', {
      quotes: null,
      items: config.items,
      updatedAt: Date.now(),
      error: err.message,
    });
  }
}

function restartMarketTimer() {
  if (marketTimer) clearInterval(marketTimer);
  marketTimer = setInterval(refreshMarkets, config.refreshMs);
}

/* ---------------- meteo ---------------- */

async function refreshWeather() {
  if (!mainWindow) return;
  try {
    mainWindow.webContents.send('weather', { data: await weather.getWeather(), error: null });
  } catch (err) {
    mainWindow.webContents.send('weather', { data: null, error: err.message });
  }
}

/* ---------------- mises a jour ---------------- */

const tokenPath = () => path.join(app.getPath('userData'), 'github-token.txt');

function readUpdateToken() {
  try {
    return fs.readFileSync(tokenPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function checkForUpdates({ manual = false } = {}) {
  let update;
  try {
    update = await updates.findUpdate(APP_VERSION, readUpdateToken());
  } catch (err) {
    console.error('verification des mises a jour impossible:', err.message);
    if (manual) dialog.showErrorBox('Vérification impossible', `${err.message}\n\nToken lu dans : ${tokenPath()}`);
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
 * Remplace resources/app.asar par la nouvelle version. Le fichier courant est
 * verrouille tant que l'appli tourne : un script .cmd attend la fin du process,
 * remplace le fichier, puis relance Klakboard.
 */
function swapAndRelaunch(staged, target) {
  const script = path.join(os.tmpdir(), 'klakboard-update.cmd');
  fs.writeFileSync(script, [
    '@echo off',
    ':wait',
    `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
    'if not errorlevel 1 (ping -n 2 127.0.0.1 >nul & goto wait)',
    'set n=0',
    ':move',
    `move /Y "${staged}" "${target}" >nul 2>&1`,
    'if not errorlevel 1 goto launch',
    'set /a n+=1',
    'if %n% lss 30 (ping -n 2 127.0.0.1 >nul & goto move)',
    ':launch',
    `start "" "${process.execPath}"`,
    'del "%~f0"',
  ].join('\r\n'));
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

let installing = false;

async function installUpdate(update = pendingUpdate) {
  if (!update || installing) return;
  pendingUpdate = update;
  refreshTrayMenu();
  // Sans fenetre parente : la boite s'ouvre sur l'ecran principal, la ou l'on a
  // clique, et non sur le petit ecran du dashboard.
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Mettre à jour', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Mise à jour Klakboard',
    message: `Klakboard ${pendingUpdate.version} est disponible (version actuelle : ${APP_VERSION}).`,
    detail: 'Klakboard va se fermer, se mettre à jour puis se relancer toute seule.',
  });
  if (response !== 0) return;

  installing = true;
  const target = path.join(process.resourcesPath, 'app.asar');
  const staged = `${target}.new`;
  try {
    await updates.downloadAsar(pendingUpdate, readUpdateToken(), staged);
    swapAndRelaunch(staged, target);
    quitApp();
  } catch (err) {
    installing = false;
    dialog.showErrorBox('Mise à jour impossible', err.message);
  }
}

/* ---------------- cycle de vie ---------------- */

// Windows n'affiche les notifications que pour un AppUserModelID connu : celui
// du raccourci cree par l'installeur, c'est-a-dire build.appId.
app.setAppUserModelId('com.klakh.klakboard');

app.whenReady().then(() => {
  config = loadConfig();
  createWindow();
  createTray();

  // Filet de securite : sans bandeau de fenetre et au-dessus de la barre des
  // taches, un rendu plante laisserait une fenetre impossible a fermer.
  globalShortcut.register('CommandOrControl+Shift+Q', quitApp);

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(config.zoom || 1);
    refreshMarkets();
    restartMarketTimer();

    refreshWeather();
    weatherTimer = setInterval(refreshWeather, 15 * 60 * 1000);

    setTimeout(checkForUpdates, 8000);
    setInterval(checkForUpdates, 30 * 60 * 1000);

    system.start((sample) => {
      // Les cumuls reseau s'accumulent a partir des deltas : les compteurs de
      // l'OS repartent de zero a chaque redemarrage, un absolu serait faux.
      config.netTotals.rx += sample.net.delta.rx;
      config.netTotals.tx += sample.net.delta.tx;
      totalsDirty = true;
      if (mainWindow) {
        mainWindow.webContents.send('sys', { ...sample, totals: config.netTotals });
      }
    });
  });
});

// Les cumuls reseau bougent a chaque seconde ; les persister aussi souvent
// userait le disque pour rien. Une ecriture par minute suffit, et l'arret de
// l'application sauvegarde de toute facon.
setInterval(() => {
  if (totalsDirty) { saveConfig(); totalsDirty = false; }
}, 60000);

// L'application survit a la fermeture de sa fenetre : elle vit dans la zone
// de notifications jusqu'a "Quitter".
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  system.stop();
  if (marketTimer) clearInterval(marketTimer);
  if (weatherTimer) clearInterval(weatherTimer);
  saveConfig();
});

/* ---------------- IPC ---------------- */

ipcMain.handle('get-config', () => config);
ipcMain.handle('get-catalogs', () => ({
  metals: markets.METALS,
  fxCurrencies: markets.FX_CURRENCIES,
}));

ipcMain.handle('set-refresh', (_e, ms) => {
  config.refreshMs = ms;
  saveConfig();
  restartMarketTimer();
  return config;
});

/** Liste des ecrans, pour que l'utilisateur choisisse ou projeter le widget. */
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

/** Plein ecran par-dessus la barre des taches, sur l'ecran demande. */
ipcMain.handle('snap-to-display', (_e, displayId) => {
  if (!mainWindow) return config;
  const d = screen.getAllDisplays().find((x) => x.id === displayId) || screen.getPrimaryDisplay();
  // bounds et non workArea : workArea exclut justement la barre des taches.
  mainWindow.setBounds(d.bounds);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  config.coverTaskbar = true;
  config.bounds = d.bounds;
  saveConfig();
  return config;
});

/** Taille fenetree, ancree sur l'ecran courant et bornee a sa surface. */
ipcMain.handle('set-resolution', (_e, { width, height }) => {
  if (!mainWindow) return config;
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
 * Demarrage automatique a l'ouverture de session (cle Run du registre).
 * On renvoie toujours l'etat REEL lu depuis l'OS et non `config` : l'utilisateur
 * peut desactiver l'entree depuis le Gestionnaire des taches, auquel cas la
 * config mentirait.
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
      // En developpement, process.execPath est electron.exe : sans le chemin du
      // projet en argument, l'entree lancerait Electron a vide.
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
  config.theme = String(name || 'dark');
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
  saveConfig();
  applyCoverTaskbar(config.coverTaskbar);
  return config;
});

ipcMain.handle('add-item', (_e, item) => {
  const k = markets.keyOf(item);
  if (!config.items.some((i) => markets.keyOf(i) === k)) {
    config.items.push(item);
    saveConfig();
    refreshMarkets();
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

ipcMain.handle('get-chart', async (_e, { item, range }) => {
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

ipcMain.handle('open-weather-map', () => shell.openExternal(weather.CARD_URL));
