const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain, makeDisplay, sleep } = require('./electron-mock');

// Ecran principal 2560 x 1440 et petit ecran 960 x 640 a sa droite.
const primary = () => makeDisplay(1, 0, 0, 2560, 1440);
const small = () => makeDisplay(2, 2560, 0, 960, 640);
const DEBOUNCE = 600; // > delai de onDisplaysChanged

test('recouvre le petit ecran au demarrage', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  assert.deepEqual(app.window.bounds, small().bounds);
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, 'screen-saver');
});

test('petit ecran debranche : masquee, puis de retour quand il revient', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  app.unplug(2);
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, false, "ne doit pas recouvrir l'ecran principal");

  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, true);
  assert.deepEqual(app.window.bounds, small().bounds);
  assert.equal(app.window.onTop, 'screen-saver');
});

test('masquee par l\'utilisateur : ne reapparait pas au rebranchement', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  app.clickTray(); // masquer
  app.unplug(2);
  await sleep(DEBOUNCE);
  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, false);
});

test('petit ecran absent au demarrage : attend, sans recouvrir le principal', async () => {
  const app = await loadMain({ displays: [primary()] });
  assert.equal(app.window.visible, false);

  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, true);
  assert.deepEqual(app.window.bounds, small().bounds);
});

test('affichage demande sans son ecran : fenetre ordinaire sur le principal', async () => {
  const app = await loadMain({ displays: [primary()] });
  app.clickTray();
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, false);
  assert.deepEqual(app.window.bounds, { x: 800, y: 380, width: 960, height: 640 });
});

test("l'ecran choisi est retenu d'un demarrage a l'autre", async () => {
  const first = await loadMain({ displays: [primary(), small()] });
  await first.invoke('snap-to-display', 1);
  assert.deepEqual(first.window.bounds, primary().bounds);
  const saved = JSON.parse(fs.readFileSync(path.join(first.userData, 'dashboard.json'), 'utf8'));
  assert.deepEqual(saved.display, { id: 1, width: 2560, height: 1440 });

  const second = await loadMain({ displays: [primary(), small()], config: saved });
  assert.deepEqual(second.window.bounds, primary().bounds);
});

test('ecran retenu retrouve par sa resolution si son id a change', async () => {
  const config = { display: { id: 99, width: 960, height: 640 } };
  const app = await loadMain({ displays: [primary(), small()], config });
  assert.deepEqual(app.window.bounds, small().bounds);
});

test('mode fenetre : jamais au premier plan, position conservee', async () => {
  const bounds = { x: 100, y: 100, width: 800, height: 600 };
  const app = await loadMain({ displays: [primary(), small()], config: { coverTaskbar: false, bounds } });
  assert.deepEqual(app.window.bounds, bounds);
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, false);
});

test('config illisible : mise de cote, pas ecrasee', async () => {
  const app = await loadMain({ displays: [primary(), small()], config: '{"items": [tronque' });
  const files = fs.readdirSync(app.userData);
  assert.ok(files.some((f) => f.startsWith('dashboard.json.illisible-')), files.join(', '));
  await app.invoke('set-theme', 'red');
  const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'dashboard.json'), 'utf8'));
  assert.equal(saved.theme, 'red');
  assert.ok(!files.includes('dashboard.json.tmp'));
});

test('resolution fenetree : passe en mode fenetre et y reste', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  const config = await app.invoke('set-resolution', { width: 800, height: 600 });
  assert.equal(config.coverTaskbar, false);
  assert.equal(app.window.onTop, false);
  assert.equal(app.window.bounds.width, 800);

  app.plug(makeDisplay(3, -1920, 0, 1920, 1080));
  await sleep(DEBOUNCE);
  assert.equal(app.window.bounds.width, 800, 'un changement d\'ecran ne doit pas la ré-agrandir');
});

test('ville meteo : Paris par defaut, choix valide retenu, saisie invalide ignoree', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  let config = await app.invoke('get-config');
  assert.equal(config.weatherSite.label, 'Paris (75)');

  config = await app.invoke('set-weather-site', { label: 'Paris (BE)', lat: 51.2, lon: 3.22, timezone: 'Europe/Brussels' });
  assert.deepEqual(config.weatherSite, { label: 'Paris (BE)', lat: 51.2, lon: 3.22, timezone: 'Europe/Brussels' });

  config = await app.invoke('set-weather-site', { label: 'x', lat: 'abc', lon: 3 });
  assert.equal(config.weatherSite.label, 'Paris (BE)');
  config = await app.invoke('set-weather-site', { label: 'Pole', lat: 89, lon: 0, timezone: 'x; rm -rf' });
  assert.equal(config.weatherSite.timezone, 'auto');
});

test('mode nuit : actif par defaut a 50 %, reglages bornes et retenus', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  let config = await app.invoke('get-config');
  assert.deepEqual(config.night, { enabled: true, dim: 0.5 });
  config = await app.invoke('set-night', { dim: 5 });
  assert.deepEqual(config.night, { enabled: true, dim: 0.9 });
  config = await app.invoke('set-night', { enabled: false });
  assert.deepEqual(config.night, { enabled: false, dim: 0.9 });
  const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'dashboard.json'), 'utf8'));
  assert.deepEqual(saved.night, { enabled: false, dim: 0.9 });
});
