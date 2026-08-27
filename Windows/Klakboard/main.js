const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const markets = require('./markets');
const system = require('./system');

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
  dark: '#0b0e14', light: '#e8ebf0', red: '#150e10', blue: '#0a0f18',
  green: '#0a1210', yellow: '#14120a', purple: '#100d16',
};

let config;
let mainWindow;
let marketTimer;
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
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
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

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    // Le niveau doit etre reaffirme apres un show(), sinon Windows repose la
    // fenetre sous la barre des taches.
    if (config.coverTaskbar) mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Klakboard');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Afficher / masquer', click: toggleWindow },
      { type: 'separator' },
      { label: 'Quitter Klakboard', click: quitApp },
    ])
  );
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

/* ---------------- cycle de vie ---------------- */

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
  saveConfig();
});

/* ---------------- IPC ---------------- */

ipcMain.handle('get-config', () => config);
ipcMain.handle('get-catalogs', () => ({
  metals: markets.METALS,
  fxCurrencies: markets.FX_CURRENCIES,
}));

ipcMain.handle('force-refresh', () => refreshMarkets());

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

/* La croix de l'en-tete met en veilleuse ; on quitte par la zone de
   notifications ou par Ctrl+Shift+Q. */
ipcMain.handle('hide-window', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.handle('quit-app', quitApp);
