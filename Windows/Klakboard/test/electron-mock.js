/**
 * Faux module 'electron' pour charger main.js sous Node : fenetre, ecrans et
 * IPC simules, sans interface graphique. loadMain() renvoie de quoi piloter
 * l'appli (brancher un ecran, appeler un handler IPC, cliquer sur l'icone).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const APP_DIR = path.join(__dirname, '..');

function makeDisplay(id, x, y, width, height) {
  return { id, label: `ecran ${id}`, bounds: { x, y, width, height }, workArea: { x, y, width, height: height - 40 }, scaleFactor: 1 };
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function createMock({ displays, primaryId, userData }) {
  const listeners = {};
  const on = (bag) => (event, cb) => { (bag[event] ||= []).push(cb); };
  const emit = (bag, event, ...args) => (bag[event] || []).forEach((cb) => cb(...args));

  const screenEvents = {};
  const trayEvents = {};
  const handlers = {};
  let window = null;

  class BrowserWindow {
    constructor(opts) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.visible = opts.show !== false;
      this.onTop = false;
      this.events = {};
      this.webContents = { send() {}, once() {}, on() {}, setZoomFactor() {}, setWindowOpenHandler() {} };
      window = this;
    }
    loadFile() {}
    on(event, cb) { on(this.events)(event, cb); }
    getBounds() { return { ...this.bounds }; }
    setBounds(b) { this.bounds = { ...b }; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    setAlwaysOnTop(flag, level) { this.onTop = flag ? level || 'floating' : false; }
  }

  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays.find((d) => d.id === primaryId),
    getDisplayMatching: (b) => displays.find((d) => intersects(d.bounds, b)) || screen.getPrimaryDisplay(),
    on: on(screenEvents),
  };

  const electron = {
    app: {
      setAppUserModelId() {},
      requestSingleInstanceLock: () => true,
      exit() {},
      quit() {},
      on: on(listeners),
      whenReady: () => Promise.resolve(),
      getPath: () => userData,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings() {},
      isPackaged: false,
    },
    BrowserWindow,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    screen,
    globalShortcut: { register() {} },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on(e, cb) { on(trayEvents)(e, cb); } },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    shell: { openExternal() {} },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {} },
    Notification: class { static isSupported() { return false; } },
    powerMonitor: { on() {} },
    safeStorage: { isEncryptionAvailable: () => false },
  };

  return {
    electron,
    get window() { return window; },
    displays,
    /** Ajoute ou retire un ecran puis previent l'appli, comme Windows. */
    plug(d) { displays.push(d); emit(screenEvents, 'display-added', {}, d); },
    unplug(id) {
      const i = displays.findIndex((d) => d.id === id);
      const [d] = displays.splice(i, 1);
      emit(screenEvents, 'display-removed', {}, d);
    },
    clickTray: () => emit(trayEvents, 'click'),
    invoke: (name, ...args) => handlers[name]({}, ...args),
  };
}

/**
 * Charge un main.js neuf (caches vides) avec les ecrans et la config donnes.
 * @returns le pilote du mock, une fois app.whenReady() passe.
 */
async function loadMain({ displays, primaryId = displays[0].id, config } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'klakboard-test-'));
  if (config !== undefined) {
    fs.writeFileSync(path.join(userData, 'dashboard.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const mock = createMock({ displays, primaryId, userData });
  mock.userData = userData;

  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    return request === 'electron' ? mock.electron : originalLoad.call(this, request, ...rest);
  };
  // Les minuteurs poses au chargement (sauvegarde des cumuls reseau) ne doivent
  // pas empecher les tests de se terminer.
  const originalSetInterval = global.setInterval;
  global.setInterval = (...args) => originalSetInterval(...args).unref();
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(APP_DIR) && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
    }
    require(path.join(APP_DIR, 'main.js'));
  } finally {
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
  }
  await new Promise((resolve) => setImmediate(resolve)); // laisse passer whenReady().then()
  return mock;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { loadMain, makeDisplay, sleep };
