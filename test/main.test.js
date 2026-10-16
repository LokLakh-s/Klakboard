const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadMain, makeDisplay, sleep } = require('./electron-mock');

// Primary screen 2560 x 1440 and small 960 x 640 screen on its right.
const primary = () => makeDisplay(1, 0, 0, 2560, 1440);
const small = () => makeDisplay(2, 2560, 0, 960, 640);
const DEBOUNCE = 600; // > onDisplaysChanged delay

test('covers the small screen at startup', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  assert.deepEqual(app.window.bounds, small().bounds);
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, 'screen-saver');
});

test('small screen unplugged: hidden, then back when it returns', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  app.unplug(2);
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, false, 'must not cover the primary screen');

  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, true);
  assert.deepEqual(app.window.bounds, small().bounds);
  assert.equal(app.window.onTop, 'screen-saver');
});

test('hidden by the user: stays hidden when the screen returns', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  app.clickTray(); // hide
  app.unplug(2);
  await sleep(DEBOUNCE);
  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, false);
});

test('small screen missing at startup: waits without covering the primary', async () => {
  const app = await loadMain({ displays: [primary()] });
  assert.equal(app.window.visible, false);

  app.plug(small());
  await sleep(DEBOUNCE);
  assert.equal(app.window.visible, true);
  assert.deepEqual(app.window.bounds, small().bounds);
});

test('shown without its screen: ordinary window on the primary', async () => {
  const app = await loadMain({ displays: [primary()] });
  app.clickTray();
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, false);
  assert.deepEqual(app.window.bounds, { x: 800, y: 380, width: 960, height: 640 });
});

test('the picked screen is remembered across launches', async () => {
  const first = await loadMain({ displays: [primary(), small()] });
  await first.invoke('snap-to-display', 1);
  assert.deepEqual(first.window.bounds, primary().bounds);
  const saved = JSON.parse(fs.readFileSync(path.join(first.userData, 'dashboard.json'), 'utf8'));
  assert.deepEqual(saved.display, { id: 1, width: 2560, height: 1440 });

  const second = await loadMain({ displays: [primary(), small()], config: saved });
  assert.deepEqual(second.window.bounds, primary().bounds);
});

test('remembered screen found by resolution when its id changed', async () => {
  const config = { display: { id: 99, width: 960, height: 640 } };
  const app = await loadMain({ displays: [primary(), small()], config });
  assert.deepEqual(app.window.bounds, small().bounds);
});

test('window mode: never on top, position kept', async () => {
  const bounds = { x: 100, y: 100, width: 800, height: 600 };
  const app = await loadMain({ displays: [primary(), small()], config: { coverTaskbar: false, bounds } });
  assert.deepEqual(app.window.bounds, bounds);
  assert.equal(app.window.visible, true);
  assert.equal(app.window.onTop, false);
});

test('unreadable config: set aside, not overwritten', async () => {
  const app = await loadMain({ displays: [primary(), small()], config: '{"items": [truncated' });
  const files = fs.readdirSync(app.userData);
  assert.ok(files.some((f) => f.startsWith('dashboard.json.illisible-')), files.join(', '));
  await app.invoke('set-theme', 'red');
  const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'dashboard.json'), 'utf8'));
  assert.equal(saved.theme, 'red');
  assert.ok(!files.includes('dashboard.json.tmp'));
});

test('windowed size: switches to window mode and stays there', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  const config = await app.invoke('set-resolution', { width: 800, height: 600 });
  assert.equal(config.coverTaskbar, false);
  assert.equal(app.window.onTop, false);
  assert.equal(app.window.bounds.width, 800);

  app.plug(makeDisplay(3, -1920, 0, 1920, 1080));
  await sleep(DEBOUNCE);
  assert.equal(app.window.bounds.width, 800, 'a screen change must not enlarge it again');
});

test('weather city: none by default, valid choice kept, invalid input ignored', async () => {
  const app = await loadMain({ displays: [primary(), small()] });
  let config = await app.invoke('get-config');
  assert.equal(config.weatherSite, null);

  config = await app.invoke('set-weather-site', { label: 'Paris (75)', lat: 48.85, lon: 2.35, timezone: 'Europe/Paris' });
  assert.deepEqual(config.weatherSite, { label: 'Paris (75)', lat: 48.85, lon: 2.35, timezone: 'Europe/Paris' });

  config = await app.invoke('set-weather-site', { label: 'x', lat: 'abc', lon: 3 });
  assert.equal(config.weatherSite.label, 'Paris (75)');
  config = await app.invoke('set-weather-site', { label: 'Pole', lat: 89, lon: 0, timezone: 'x; rm -rf' });
  assert.equal(config.weatherSite.timezone, 'auto');
});

test('night mode: on by default at 50 %, settings clamped and saved', async () => {
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

test('language: follows the system, can be forced, invalid values ignored', async () => {
  let app = await loadMain({ displays: [primary(), small()], locales: ['fr-CA', 'en-US'] });
  assert.deepEqual(await app.invoke('get-language'), { setting: 'auto', lang: 'fr', locale: 'fr-CA' });

  assert.deepEqual(await app.invoke('set-language', 'en'), { setting: 'en', lang: 'en', locale: 'en-US' });
  assert.equal((await app.invoke('set-language', 'xx')).setting, 'auto');

  app = await loadMain({ displays: [primary(), small()], locales: ['de-DE'] });
  assert.deepEqual(await app.invoke('get-language'), { setting: 'auto', lang: 'en', locale: 'en-US' });
});
