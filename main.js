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
  display: null,   // ecran choisi dans "Plein ecran sur…" : { id, width, height }
  weatherSite: null,   // choisie au premier lancement
  night: { enabled: true, dim: 0.5 },   // assombrissement du coucher au lever du soleil
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

// Copie profonde : la config modifie ses objets (items, netTotals) sur place.
const defaultConfig = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));

function loadConfig() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return defaultConfig(); // premier lancement
  }
  try {
    const loaded = { ...defaultConfig(), ...JSON.parse(raw) };
    // Le theme "blue" a ete remplace par "forest".
    if (loaded.theme === 'blue') loaded.theme = 'forest';
    return loaded;
  } catch (err) {
    // Fichier illisible : on le met de cote plutot que de l'ecraser a la
    // prochaine sauvegarde, les lignes suivies restent recuperables a la main.
    try {
      fs.renameSync(file, `${file}.illisible-${Date.now()}`);
    } catch {}
    console.error('config illisible, valeurs par defaut:', err.message);
    return defaultConfig();
  }
}

/**
 * Ecriture dans un fichier temporaire puis renommage : une coupure en pleine
 * ecriture laisse l'ancienne config intacte au lieu d'un JSON tronque.
 */
function saveConfig() {
  const file = configPath();
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(config, null, 2);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    // Renommage refuse (antivirus qui tient le fichier, par exemple) : ecriture directe.
    try {
      fs.writeFileSync(file, data);
    } catch (err) {
      console.error('sauvegarde config impossible:', err.message);
    }
  }
}

/* ---------------- fenetre ---------------- */

/** Ecran a recouvrir (voir display.js), ou null s'il n'est pas branche. */
function targetDisplay() {
  return display.findTargetDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay().id, config.display);
}

/** Fenetre ordinaire de 960 x 640 au centre de l'ecran principal. */
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
    show: false,             // affichee par placeWindow(), une fois son ecran connu
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

  // La fenetre n'affiche que index.html : aucune navigation ni fenetre surgissante
  // (la carte meteo s'ouvre dans le navigateur, via shell).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.loadFile('index.html');
  placeWindow(true);

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
  if (config.coverTaskbar && !targetDisplay()) {
    // Affichage demande alors que l'ecran du tableau de bord est absent :
    // fenetre ordinaire sur l'ecran principal, sans le recouvrir. Elle
    // rejoindra son ecran quand il reviendra (onDisplaysChanged).
    awaitingDisplay = false;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setBounds(centeredOnPrimary());
    mainWindow.show();
    return;
  }
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

/* ---------------- placement sur l'ecran ---------------- */

// Vrai quand la fenetre est masquee parce que son ecran manque : elle
// reapparait d'elle-meme a son retour. Masquee par l'utilisateur, elle le reste.
let awaitingDisplay = false;

/**
 * Recale la fenetre sur son ecran. En mode recouvrement, le niveau
 * 'screen-saver' est le seul qui passe au-dessus de la barre des taches
 * Windows, et la fenetre prend les bounds PHYSIQUES de l'ecran (workArea
 * exclut justement la barre). Si cet ecran est absent (pas encore detecte a
 * l'ouverture de session, debranche), la fenetre est masquee : recouvrir
 * l'ecran principal au premier plan le rendrait inutilisable.
 *
 * @param {boolean} reveal la fenetre doit etre visible (demarrage) ; sinon sa
 *   visibilite actuelle est conservee.
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

// Un branchement d'ecran produit une rafale d'evenements : on attend la fin.
let displayTimer;
function onDisplaysChanged() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => placeWindow(), 500);
}

/* ---------------- marches ---------------- */

// Derniere cotation reussie par ligne ({ price, change24h, at }) : une source en
// panne laisse affiche le dernier cours connu, grise, au lieu de "--".
const lastGood = new Map();
let marketsBusy = false;
let marketsAgain = false;

async function refreshMarkets() {
  if (!mainWindow) return;
  // Un cycle a la fois ; une demande pendant un cycle (ligne ajoutee) en relance
  // un juste apres.
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
        // Au-dela, un cours est juge perime : trois cycles rates, deux minutes au moins.
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

/* ---------------- mini-courbes ---------------- */

// Une courbe de 12 h ne bouge guere en 20 s : rafraichie toutes les 5 min.
const SPARK_EVERY_MS = 5 * 60 * 1000;
let sparkTimer;

async function refreshSparks() {
  if (!mainWindow) return;
  const sparks = await markets.getSparks(config.items).catch(() => ({}));
  if (mainWindow) mainWindow.webContents.send('sparks', sparks);
}

/* ---------------- meteo ---------------- */

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

/* ---------------- mode nuit ---------------- */

// Heures de soleil de la ville meteo : la nuit est evaluee chaque minute, la
// meteo n'etant rafraichie que toutes les 15 min.
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

/* ---------------- mises a jour ---------------- */

const tokenPath = () => path.join(app.getPath('userData'), token.PLAIN);
const readUpdateToken = () => token.readToken(app.getPath('userData'), safeStorage);

// L'archive de l'appli ne tourne que sur le moteur pour lequel elle a ete construite.
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
 * Remplace resources/app.asar par la nouvelle version. Le fichier courant est
 * verrouille tant que l'appli tourne : updater.js (copie hors de l'archive) attend
 * la fin du process, remplace le fichier puis relance Klakboard.
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
  // Sans fenetre parente : la boite s'ouvre sur l'ecran principal, la ou l'on a
  // clique, et non sur le petit ecran du dashboard.
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
    // Infos relues juste avant le telechargement : celles de la notification
    // peuvent dater d'avant la publication de l'empreinte par GitHub.
    const fresh = await findUpdate().catch(() => null);
    if (fresh?.version === update.version) update = fresh;
    if (viaInstaller) {
      // Installeur non signe, mais ecrit par l'appli et non par un navigateur :
      // sans marque "telecharge d'Internet", SmartScreen ne s'interpose pas.
      const setup = path.join(os.tmpdir(), update.asset.name);
      await updates.downloadAsset(update.asset, readUpdateToken(), setup);
      // On ne quitte qu'une fois l'installeur effectivement lance.
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

/* ---------------- cycle de vie ---------------- */

// Windows n'affiche les notifications que pour un AppUserModelID connu : celui
// du raccourci cree par l'installeur, c'est-a-dire build.appId.
if (process.platform === 'win32') app.setAppUserModelId('com.klakh.klakboard');

// Une seule instance : relancer Klakboard pendant qu'elle tourne (ou pendant une
// relance de mise a jour) affiche la fenetre existante au lieu d'en ouvrir une autre.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  config = loadConfig();
  createWindow();
  createTray();

  // Filet de securite : sans bandeau de fenetre et au-dessus de la barre des
  // taches, un rendu plante laisserait une fenetre impossible a fermer.
  globalShortcut.register('CommandOrControl+Shift+Q', quitApp);

  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // Au reveil, cours et meteo datent de la mise en veille : on n'attend pas
  // le prochain cycle.
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
  // Borne basse : en dessous, les sources sans cle API finissent par refuser.
  config.refreshMs = Math.min(3600000, Math.max(5000, Number(ms) || DEFAULT_CONFIG.refreshMs));
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
  // Retenu pour les demarrages suivants : sans cela, l'appli revenait toujours
  // sur le petit ecran, quel que soit le choix fait ici.
  config.display = display.displayKey(d);
  config.coverTaskbar = true;
  config.bounds = d.bounds;
  saveConfig();
  placeWindow();
  return config;
});

/**
 * Taille fenetree, ancree sur l'ecran courant et bornee a sa surface. Passe en
 * mode fenetre : en mode recouvrement, la fenetre reprendrait tout l'ecran au
 * prochain demarrage ou changement d'ecran.
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
  // Aucun ecran choisi ni petit ecran detecte : on recouvre celui ou se trouve
  // la fenetre, plutot que de la masquer.
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
    // Fuseau IANA de la ville (journee meteo, min/max) ; Open-Meteo le deduit sinon.
    timezone: /^[A-Za-z_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(site.timezone || '') ? site.timezone : 'auto',
  };
  saveConfig();
  refreshWeather();
  return config;
});
