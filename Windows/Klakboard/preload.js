const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  onQuotes: (cb) => ipcRenderer.on('quotes', (_e, d) => cb(d)),
  onSys: (cb) => ipcRenderer.on('sys', (_e, d) => cb(d)),

  getConfig: () => ipcRenderer.invoke('get-config'),
  getCatalogs: () => ipcRenderer.invoke('get-catalogs'),
  setRefresh: (ms) => ipcRenderer.invoke('set-refresh', ms),
  setCoverTaskbar: (on) => ipcRenderer.invoke('set-cover-taskbar', on),
  setZoom: (z) => ipcRenderer.invoke('set-zoom', z),
  setTheme: (t) => ipcRenderer.invoke('set-theme', t),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (on) => ipcRenderer.invoke('set-auto-launch', on),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  snapToDisplay: (id) => ipcRenderer.invoke('snap-to-display', id),
  setResolution: (r) => ipcRenderer.invoke('set-resolution', r),
  addItem: (item) => ipcRenderer.invoke('add-item', item),
  removeItem: (item) => ipcRenderer.invoke('remove-item', item),
  getChart: (item, range) => ipcRenderer.invoke('get-chart', { item, range }),
  searchCrypto: (q) => ipcRenderer.invoke('search-crypto', q),
  resetNetTotals: () => ipcRenderer.invoke('reset-net-totals'),
  onOpenPanel: (cb) => ipcRenderer.on('open-panel', (_e, name) => cb(name)),
  onWeather: (cb) => ipcRenderer.on('weather', (_e, d) => cb(d)),
  openWeatherMap: () => ipcRenderer.invoke('open-weather-map'),
});
