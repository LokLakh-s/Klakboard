const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8');

test('version comparison', () => {
  const { isNewer } = require('../updates');
  assert.equal(isNewer('1.2.10', '1.2.9'), true);
  assert.equal(isNewer('1.3.0', '1.2.99'), true);
  assert.equal(isNewer('1.2.5', '1.2.5'), false);
  assert.equal(isNewer('1.2.4', '1.2.5'), false);
});

test('every weather code has an icon, by day and by night', () => {
  const { iconName, WMO_CODES } = require('../weather');
  for (const code of [...WMO_CODES, 42]) {
    for (const isDay of [true, false]) {
      const file = path.join(APP_DIR, 'icons', 'weather', `${iconName(code, isDay)}.svg`);
      assert.ok(fs.existsSync(file), `code ${code}: ${path.basename(file)} missing`);
    }
  }
});

test('chart periods exist on the markets side', () => {
  const { PERIODS } = require('../markets');
  const chips = [...read('index.html').matchAll(/data-range="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chips, Object.keys(PERIODS));
  // Default period when a chart opens: must be one of the chips.
  for (const [, range] of read('renderer.js').matchAll(/chartRange = '([^']+)'/g)) {
    assert.ok(chips.includes(range), `unknown default period: ${range}`);
  }
});

test('everything the app loads is packaged', () => {
  const { build } = require('../package.json');
  const packaged = (f) => build.files.includes(f)
    || build.files.some((g) => g.endsWith('/**/*') && f.startsWith(g.slice(0, -4)));

  // Local modules required, transitively from main.js (paths relative to the
  // requiring file).
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, dep] of read(file).matchAll(/require\('(\.{1,2}\/[\w./-]+)'\)/g)) {
      const rel = path.posix.join(path.posix.dirname(file), dep);
      visit(rel.endsWith('.js') || rel.endsWith('.json') ? rel : `${rel}.js`);
    }
  };
  visit('main.js');
  seen.add('preload.js');
  for (const [, ref] of read('index.html').matchAll(/(?:src|href)="([\w./-]+)"/g)) seen.add(ref);
  for (const [, ref] of read('style.css').matchAll(/url\("([\w./-]+)"\)/g)) seen.add(ref);
  // Tray icons picked per platform in main.js, and the Retina variant.
  for (const [, icon] of read('main.js').matchAll(/'((?:tray[\w-]*\.png)|icon\.ico)'/g)) seen.add(`build/${icon}`);
  seen.add('build/tray@2x.png');
  assert.ok(seen.has('platform/win32.js') && seen.has('history.js') && seen.has('fonts/selawik-bold.woff2'));

  for (const f of seen) {
    if (f === 'package.json') continue; // always packaged by electron-builder
    assert.ok(packaged(f), `${f} missing from build.files in package.json`);
  }
});

test('update: archive for the installed engine, otherwise installer', () => {
  const { pickUpdate } = require('../updates');
  const rel = (v, ...names) => ({
    tag_name: `klakboard-v${v}`, draft: false, prerelease: false,
    assets: names.map((name, i) => ({ name, url: `u${i}`, size: 1, digest: null })),
  });
  const releases = [
    rel('1.4.0', 'app-electron44.asar', 'Klakboard.Setup.1.4.0.exe'),
    rel('1.3.0', 'app-electron33.asar', 'app.asar', 'Klakboard.Setup.1.3.0.exe'),
    rel('1.2.5', 'app.asar', 'Klakboard.Setup.1.2.5.exe'),
  ];
  assert.deepEqual(
    [pickUpdate(releases, '1.2.5', '33').version, pickUpdate(releases, '1.2.5', '33').kind],
    ['1.4.0', 'installer'],
  );
  assert.equal(pickUpdate(releases, '1.3.0', '33').kind, 'installer');
  assert.equal(pickUpdate(releases, '1.4.0', '44'), null);
  assert.equal(pickUpdate(releases.slice(1), '1.2.5', '33').kind, 'asar');
  assert.equal(pickUpdate(releases.slice(1), '1.2.5', '33').asset.name, 'app-electron33.asar');
});

test('download digest', () => {
  const { checkDigest } = require('../updates');
  const buf = Buffer.from('klakboard');
  const ok = `sha256:${require('crypto').createHash('sha256').update(buf).digest('hex')}`;
  assert.doesNotThrow(() => checkDigest(buf, ok));
  assert.throws(() => checkDigest(buf, null), /not published/);
  assert.throws(() => checkDigest(Buffer.from('other'), ok), /digest mismatch/);
});

test('weather city labels', () => {
  const { placeLabel } = require('../weather');
  assert.equal(placeLabel({ name: 'Paris', country_code: 'FR', postcodes: ['75001'] }), 'Paris (75)');
  assert.equal(placeLabel({ name: 'Saint-Pierre', country_code: 'FR', postcodes: ['97410'] }), 'Saint-Pierre (974)');
  assert.equal(placeLabel({ name: 'Paris', country_code: 'US', postcodes: ['75460'] }), 'Paris (US)');
  assert.equal(placeLabel({ name: 'Nulle-part' }), 'Nulle-part');
});

test('GitHub token: encrypted on first read, plain file deleted', () => {
  const os = require('os');
  const { readToken, PLAIN } = require('../token');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klakboard-token-'));
  // Fake reversible encryption: only the file handling is tested.
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...s].reverse().join('')),
    decryptString: (b) => [...b.toString()].reverse().join(''),
  };
  assert.equal(readToken(dir, safe), null);

  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_abc\n');
  assert.equal(readToken(dir, safe), 'github_pat_abc');
  assert.ok(!fs.existsSync(path.join(dir, PLAIN)), 'the plain file must be deleted');
  assert.ok(!fs.readFileSync(path.join(dir, 'github-token.bin'), 'utf8').includes('github_pat_abc'));
  assert.equal(readToken(dir, safe), 'github_pat_abc');

  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_new');
  assert.equal(readToken(dir, safe), 'github_pat_new');
  assert.equal(readToken(dir, safe), 'github_pat_new');

  // Without encryption, the plain file stays and is used as is.
  const noSeal = { isEncryptionAvailable: () => false };
  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_plain');
  assert.equal(readToken(dir, noSeal), 'github_pat_plain');
  assert.ok(fs.existsSync(path.join(dir, PLAIN)));
});

test('night mode: from sunset to sunrise', () => {
  const { nightWindow } = require('../weather');
  const h = (x) => x * 3600e3;
  const sun = [{ rise: h(8), set: h(19.5) }, { rise: h(24 + 8), set: h(24 + 19.5) }];
  assert.deepEqual(nightWindow(h(3), sun), { on: true, from: null, until: h(8) });
  assert.deepEqual(nightWindow(h(12), sun), { on: false, from: h(19.5), until: h(32) });
  assert.deepEqual(nightWindow(h(21), sun), { on: true, from: h(19.5), until: h(32) });
  // After midnight, weather not refreshed yet: sun[0] is the previous day.
  assert.equal(nightWindow(h(24.5), sun).on, true);
  assert.equal(nightWindow(h(12), null), null);
  assert.equal(nightWindow(h(12), [{ rise: NaN, set: NaN }]), null);
});

test('everything the page calls is exposed by preload.js', () => {
  // A missing function throws at load time: blank page.
  const used = new Set([...read('renderer.js').matchAll(/window\.dash\.(\w+)/g)].map((m) => m[1]));
  const exposed = new Set([...read('preload.js').matchAll(/^\s+(\w+):/gm)].map((m) => m[1]));
  const missing = [...used].filter((f) => !exposed.has(f));
  assert.deepEqual(missing, []);
});

test('rows from the page: known fields only, invalid ones refused', () => {
  const { normalizeItem } = require('../markets');
  assert.deepEqual(normalizeItem({ kind: 'metal', code: 'XAU', extra: 1 }), { kind: 'metal', code: 'XAU' });
  assert.equal(normalizeItem({ kind: 'metal', code: 'XYZ' }), null);
  assert.deepEqual(normalizeItem({ kind: 'fx', from: 'EUR', to: 'USD' }), { kind: 'fx', from: 'EUR', to: 'USD' });
  assert.equal(normalizeItem({ kind: 'fx', from: 'EUR', to: 'EUR' }), null);
  assert.deepEqual(
    normalizeItem({ kind: 'crypto', symbol: '币安人生', vs: 'USDT', binance: '币安人生USDT' }),
    { kind: 'crypto', symbol: '币安人生', vs: 'USDT', binance: '币安人生USDT' },
  );
  assert.equal(normalizeItem({ kind: 'crypto', symbol: 'BTC', vs: 'USDT', binance: 'BTCUSDT&limit=1' }), null);
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem({ kind: 'stock' }), null);
});

test('a crypto pair rejected by Binance does not grey out the others', async () => {
  const markets = require('../markets');
  const realFetch = global.fetch;
  const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.searchParams.has('symbols')) return json(400, { code: -1121, msg: 'Invalid symbol.' });
    const sym = u.searchParams.get('symbol');
    if (sym === 'GONEUSDT') return json(400, { code: -1121, msg: 'Invalid symbol.' });
    return json(200, { symbol: sym, lastPrice: '100', priceChangePercent: '1.5' });
  };
  try {
    const { quotes, errors } = await markets.getQuotes([
      { kind: 'crypto', symbol: 'BTC', vs: 'USDT', binance: 'BTCUSDT' },
      { kind: 'crypto', symbol: 'GONE', vs: 'USDT', binance: 'GONEUSDT' },
    ]);
    assert.deepEqual(quotes['crypto:BTCUSDT'], { price: 100, change24h: 1.5 });
    assert.deepEqual(quotes['crypto:GONEUSDT'], { price: null, change24h: null });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /GONE\/USDT/);
  } finally {
    global.fetch = realFetch;
  }
});

test('translations: same keys in every language, every key used exists', () => {
  const i18n = require('../i18n');
  const { STRINGS } = i18n;
  const keys = Object.keys(STRINGS.en).sort();
  for (const lang of i18n.LANGUAGES) assert.deepEqual(Object.keys(STRINGS[lang]).sort(), keys, lang);

  const used = new Set();
  for (const [, key] of read('index.html').matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(key);
  for (const f of ['main.js', 'renderer.js', 'markets.js', 'updates.js']) {
    for (const [, key] of read(f).matchAll(/\bt\(\s*'([^']+)'/g)) used.add(key);
  }
  // Keys built at run time.
  const { METALS, PERIODS } = require('../markets');
  const { WMO_CODES } = require('../weather');
  for (const code of Object.keys(METALS)) used.add(`metal.${code}`);
  for (const range of Object.keys(PERIODS)) used.add(`range.${range}`);
  for (const code of WMO_CODES) used.add(`wmo.${code}`);
  for (const level of ['low', 'possible', 'high']) used.add(`storm.${level}`);
  for (const [, theme] of read('index.html').matchAll(/data-theme="([^"]+)"/g)) used.add(`theme.${theme}`);
  for (const key of used) assert.ok(key in STRINGS.en, `missing translation: ${key}`);
});

test('language resolution: system locale, forced language, fallback to English', () => {
  const { resolve } = require('../i18n');
  assert.deepEqual(resolve('auto', ['fr-FR', 'en-US']), { lang: 'fr', locale: 'fr-FR' });
  assert.deepEqual(resolve('auto', ['de-DE', 'fr-BE']), { lang: 'fr', locale: 'fr-BE' });
  assert.deepEqual(resolve('auto', ['en-GB']), { lang: 'en', locale: 'en-GB' });
  assert.deepEqual(resolve('auto', ['de-DE']), { lang: 'en', locale: 'en-US' });
  assert.deepEqual(resolve('auto', []), { lang: 'en', locale: 'en-US' });
  assert.deepEqual(resolve('en', ['fr-FR']), { lang: 'en', locale: 'en-US' });
  assert.deepEqual(resolve('fr', ['en-US', 'fr_CA']), { lang: 'fr', locale: 'fr-CA' });
});

test('translation placeholders and fallback', () => {
  const i18n = require('../i18n');
  i18n.setLanguage('fr');
  assert.equal(i18n.t('upd.message', { version: '2.0.0', current: '1.6.0' }),
    'Klakboard 2.0.0 est disponible (version actuelle : 1.6.0).');
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  i18n.setLanguage('xx');
  assert.equal(i18n.lang, 'en');
});

test('screen picked without a saved choice: small panels and bar screens only', () => {
  const { findTargetDisplay } = require('../display');
  const d = (id, width, height) => ({ id, bounds: { x: 0, y: 0, width, height } });
  const main = d(1, 2560, 1440);
  const pick = (...others) => findTargetDisplay([main, ...others], 1, null)?.id ?? null;
  assert.equal(pick(d(2, 1024, 600), d(3, 960, 640)), 3, '960 x 640 first');
  assert.equal(pick(d(2, 1920, 480)), 2, 'bar screen');
  assert.equal(pick(d(2, 2560, 720)), 2, 'wide bar screen');
  assert.equal(pick(d(2, 480, 1920)), 2, 'vertical bar screen');
  assert.equal(pick(d(2, 600, 1024)), 2, 'small portrait panel');
  assert.equal(pick(d(2, 1920, 480), d(3, 800, 480)), 3, 'smallest first');
  assert.equal(pick(d(2, 1920, 1080)), null, 'ordinary monitor');
  assert.equal(pick(d(2, 1080, 1920)), null, 'rotated monitor');
  assert.equal(pick(d(2, 1366, 768)), null, 'laptop panel');
  assert.equal(findTargetDisplay([d(1, 960, 640)], 1, null), null, 'never the primary screen');
});

test('nvidia-smi line: values, [N/A] fields, malformed lines', () => {
  const { parseNvidiaLine } = require('../platform/nvidia');
  assert.deepEqual(parseNvidiaLine('Quadro RTX 4000, 6, 304, 8192, [N/A], 55'),
    { name: 'Quadro RTX 4000', util: 6, memUsed: 304, memTotal: 8192, fan: null, temp: 55 });
  assert.equal(parseNvidiaLine('NVIDIA-SMI has failed because it could not communicate with the driver.'), null);
  assert.equal(parseNvidiaLine(''), null);
});

test('Linux network: physical interfaces only', () => {
  const { parseProcNetDev } = require('../platform/linux');
  const row = (name, rx, tx) => `${name.padStart(6)}: ${rx} 10 0 0 0 0 0 0 ${tx} 10 0 0 0 0 0 0`;
  const text = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    row('lo', 500, 500), row('eth0', 1000, 200), row('wlan0', 30, 4),
    row('docker0', 7, 7), row('veth1a2b', 7, 7), row('tailscale0', 9, 9), row('wg0', 9, 9), row('tun0', 9, 9),
    '',
  ].join('\n');
  assert.deepEqual(parseProcNetDev(text), { rx: 1030, tx: 204 });
});

test('Linux AMD GPU from sysfs; other vendors ignored', () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klakboard-drm-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('card0/device/vendor', '0x10de\n');                    // NVIDIA: handled by nvidia-smi
  write('card1/device/vendor', '0x1002\n');
  write('card1/device/gpu_busy_percent', '42\n');
  write('card1/device/mem_info_vram_used', String(512 * 2 ** 20));
  write('card1/device/mem_info_vram_total', String(8 * 2 ** 30));
  write('card1/device/hwmon/hwmon3/temp1_input', '61000\n');
  write('card1-DP-1/status', 'connected\n');
  const { readAmdGpu } = require('../platform/linux');
  assert.deepEqual(readAmdGpu(root), { name: 'AMD GPU', util: 42, memUsed: 512, memTotal: 8192, fan: null, temp: 61 });
  fs.rmSync(path.join(root, 'card1'), { recursive: true });
  assert.equal(readAmdGpu(root), null);
  assert.equal(readAmdGpu(path.join(root, 'missing')), null);
});

test('Windows loops: network counters and GPU counters lines', () => {
  const { parseNetLine, parseGpuLine } = require('../platform/win32');
  assert.deepEqual(parseNetLine('123456 7890\r'), { rx: 123456, tx: 7890 });
  assert.equal(parseNetLine(' '), null);
  assert.deepEqual(parseGpuLine('{"name":"AMD Radeon RX 7800 XT","util":37.6,"mem":2147483648}'),
    { name: 'AMD Radeon RX 7800 XT', util: 38, memUsed: 2048, memTotal: null, fan: null, temp: null });
  assert.equal(parseGpuLine('{"name":"Intel UHD","util":140,"mem":0}').util, 100);
  assert.equal(parseGpuLine('{"name":"Intel UHD","util":3,"mem":0}').memUsed, null);
  assert.equal(parseGpuLine('{"name":"x","util":null,"mem":1}'), null);
  assert.equal(parseGpuLine('not json'), null);
});

test('macOS sources: netstat, vm_stat and ioreg outputs', () => {
  const { parseNetstat, parseVmStat, parseIoreg } = require('../platform/darwin');
  const netstat = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'lo0        16384 <Link#1>                         2000     0     900000     2000     0     900000     0',
    'lo0        16384 127           127.0.0.1          2000     -     900000     2000     -     900000     -',
    'en0        1500  <Link#11>     a4:83:e7:00:00:01 50000     0   70000000    30000     0    4000000     0',
    'en0        1500  192.168.1     192.168.1.20      50000     -   70000000    30000     -    4000000     -',
    'en1        1500  <Link#12>     a4:83:e7:00:00:02   100     0      20000      100     0       3000     0',
    'utun3      1380  <Link#20>                         900     0     500000      900     0     400000     0',
    'awdl0      1500  <Link#14>     6a:1f:00:00:00:03    10     0       1000       10     0       1000     0',
  ].join('\n');
  assert.deepEqual(parseNetstat(netstat), { rx: 70020000, tx: 4003000 });
  assert.equal(parseNetstat('Name Mtu Network Address'), null);

  const vmstat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            300000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                         5000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        150000.',
  ].join('\n');
  assert.equal(parseVmStat(vmstat), (10000 + 200000 + 5000) * 16384);
  assert.equal(parseVmStat('garbage'), null);

  const ioreg = '+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>\n'
    + '    "PerformanceStatistics" = {"In use system memory"=1073741824,"Device Utilization %"=23,"Renderer Utilization %"=20}';
  assert.deepEqual(parseIoreg(ioreg), { util: 23, memUsed: 1024 });
  assert.equal(parseIoreg('+-o IOAccelerator'), null);
});

test('Linux start at login: XDG autostart entry, quoted command', () => {
  const os = require('os');
  const autostart = require('../autostart');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'klakboard-autostart-')), 'autostart');
  assert.equal(autostart.isEnabled(dir), false);
  autostart.setEnabled(true, ['/home/me/Apps/Klakboard 1.8.0.AppImage', '--ozone-platform=x11'], dir);
  const entry = fs.readFileSync(path.join(dir, 'klakboard.desktop'), 'utf8');
  assert.match(entry, /^Exec="\/home\/me\/Apps\/Klakboard 1\.8\.0\.AppImage" --ozone-platform=x11$/m);
  assert.equal(autostart.isEnabled(dir), true);
  autostart.setEnabled(false, [], dir);
  assert.equal(autostart.isEnabled(dir), false);
  assert.match(autostart.desktopEntry(['/opt/a"b$c']), /^Exec="\/opt\/a\\"b\\\$c"$/m);
});

test('update outside Windows: the release page', () => {
  const { pickUpdate } = require('../updates');
  const releases = [
    { tag_name: 'klakboard-v1.8.0', html_url: 'https://github.com/LokLakh-s/Klakboard/releases/tag/klakboard-v1.8.0',
      draft: false, prerelease: false, assets: [] },
    { tag_name: 'klakboard-v1.7.0', html_url: 'https://github.com/x', draft: false, prerelease: false, assets: [] },
  ];
  assert.deepEqual(pickUpdate(releases, '1.7.0', '44', 'darwin'),
    { version: '1.8.0', kind: 'page', url: 'https://github.com/LokLakh-s/Klakboard/releases/tag/klakboard-v1.8.0' });
  assert.equal(pickUpdate(releases, '1.8.0', '44', 'linux'), null);
  assert.equal(pickUpdate(releases, '1.7.0', '44', 'win32'), null, 'no file for Windows in this release');
});

test('history: rings, 10-second averages, missing values', () => {
  const { createHistory, Ring, FINE_LEN, COARSE_STEP } = require('../history');
  const ring = new Ring(3);
  [1, 2, 3, 4].forEach((v) => ring.push(v));
  assert.deepEqual([...ring.last()], [2, 3, 4]);
  assert.deepEqual([...ring.last(2)], [3, 4]);

  const h = createHistory();
  const sample = (i, gpu) => ({
    cpu: { per: [i, 100 - i], avg: 50 },
    ram: { pct: 40 },
    gpu: gpu ? { util: i, memUsed: 1000, temp: null } : null,
    net: { rate: i % 2 ? { down: 1000, up: 10 } : null },
  });
  const t0 = 1_000_000;
  for (let i = 0; i < 25; i++) h.push(sample(i, i < 5), t0 + i * 1000);

  const m = h.get('1m');
  assert.equal(m.t.length, 25);
  assert.equal(m.t[24], t0 + 24000);
  assert.deepEqual([...m.cores[0].slice(0, 3)], [0, 1, 2]);
  assert.ok(Number.isNaN(m.gpu[10]), 'no GPU sample -> NaN');
  assert.ok(Number.isNaN(m.gpuTemp[0]), 'null temperature -> NaN');

  const hour = h.get('1h');
  assert.equal(hour.t.length, Math.floor(25 / COARSE_STEP));
  assert.equal(hour.cores[0][0], 4.5, 'mean of 0..9');
  assert.equal(hour.gpu[0], 2, 'mean of the 5 known values');
  assert.ok(Number.isNaN(hour.gpu[1]), 'no value at all -> NaN');
  assert.equal(hour.down[0], 1000, 'silent counters ignored in the mean');

  for (let i = 0; i < FINE_LEN + 50; i++) h.push(sample(i, true), t0 + (25 + i) * 1000);
  assert.equal(h.get('10m').t.length, FINE_LEN);
  assert.equal(h.get('5m').t.length, 300);

  h.push({ cpu: { per: [1, 2, 3, 4], avg: 2 }, ram: { pct: 1 }, gpu: null, net: { rate: null } });
  assert.equal(h.get('1m').cores.length, 4, 'core count change restarts the history');
  assert.equal(createHistory().get('10m').t.length, 0);
});

test('moon: phase instants of 2026 (USNO), names, lit part', () => {
  const { elongation, moonPhase, litPath } = require('../astro');
  // aa.usno.navy.mil/api/moon/phases/year?year=2026, one in three.
  const usno = [
    ['2026-01-03T10:03Z', 'full'],
    ['2026-01-26T04:47Z', 'firstQuarter'],
    ['2026-02-17T12:01Z', 'new'],
    ['2026-03-11T09:38Z', 'lastQuarter'],
    ['2026-04-02T02:12Z', 'full'],
    ['2026-04-24T02:32Z', 'firstQuarter'],
    ['2026-05-16T20:01Z', 'new'],
    ['2026-06-08T10:00Z', 'lastQuarter'],
    ['2026-06-29T23:56Z', 'full'],
    ['2026-07-21T11:05Z', 'firstQuarter'],
    ['2026-08-12T17:37Z', 'new'],
    ['2026-09-04T07:51Z', 'lastQuarter'],
    ['2026-09-26T16:49Z', 'full'],
    ['2026-10-18T16:12Z', 'firstQuarter'],
    ['2026-11-09T07:02Z', 'new'],
    ['2026-12-01T06:08Z', 'lastQuarter'],
    ['2026-12-24T01:28Z', 'full'],
  ];
  const target = { new: 0, firstQuarter: 90, full: 180, lastQuarter: 270 };
  for (const [when, key] of usno) {
    const ms = Date.parse(when);
    const off = ((elongation(ms) - target[key] + 540) % 360) - 180;
    // 0.25 degree is about 30 minutes of the Moon's motion.
    assert.ok(Math.abs(off) < 0.25, `${when}: ${off.toFixed(3)} degrees from ${key}`);
    assert.equal(moonPhase(ms).key, key, when);
  }
  const day = 86400000;
  const full = Date.parse('2026-10-26T04:12Z');
  assert.equal(moonPhase(full).illumination.toFixed(3), '1.000');
  assert.equal(moonPhase(full - 3 * day).key, 'waxingGibbous');
  assert.equal(moonPhase(full + 3 * day).key, 'waningGibbous');
  assert.equal(moonPhase(full + 3 * day).waxing, false);
  // USNO: 58 % lit on 2026-10-19 at noon UT.
  assert.equal(Math.round(moonPhase(Date.parse('2026-10-19T12:00Z')).illumination * 100), 58);
  // Crescent: terminator bulging to the right (sweep 0); gibbous: to the left.
  assert.match(litPath(45, 28, 32), /A19\.8,28 0 0 0 32,4Z$/);
  assert.match(litPath(135, 28, 32), /A19\.8,28 0 0 1 32,4Z$/);
  assert.equal(litPath(30, 28, 32), litPath(330, 28, 32), 'same shape, the page mirrors it');
});

test('ping: reply lines in several Windows languages, macOS and Linux', () => {
  const { parseWindowsLine, parseUnixLine } = require('../platform/ping');
  assert.equal(parseWindowsLine('Reply from 9.9.9.9: bytes=32 time=12ms TTL=57'), 12);
  assert.equal(parseWindowsLine('Réponse de 9.9.9.9 : octets=32 temps=12 ms TTL=57'), 12);
  assert.equal(parseWindowsLine('Antwort von 9.9.9.9: Bytes=32 Zeit=8ms TTL=57'), 8);
  assert.equal(parseWindowsLine('Ответ от 9.9.9.9: число байт=32 время=15мс TTL=57'), 15);
  assert.equal(parseWindowsLine('来自 9.9.9.9 的回复: 字节=32 时间=21ms TTL=57'), 21);
  assert.equal(parseWindowsLine('Reply from 192.168.1.1: bytes=32 time<1ms TTL=64'), 1);
  for (const other of ['Pinging 9.9.9.9 with 32 bytes of data:', 'Request timed out.', 'Délai d\'attente de la demande dépassé.',
    '    Minimum = 8ms, Maximum = 12ms, Average = 10ms', 'Reply from 10.0.0.1: Destination host unreachable.']) {
    assert.equal(parseWindowsLine(other), null, other);
  }
  assert.equal(parseUnixLine('64 bytes from 9.9.9.9: icmp_seq=1 ttl=57 time=8.85 ms'), 8.85);
  assert.equal(parseUnixLine('64 bytes from 9.9.9.9: seq=0 ttl=57 time=12.345 ms'), 12.345);
  assert.equal(parseUnixLine('64 bytes from 9.9.9.9: icmp_seq=0 ttl=57 time=110 ms'), 110);
  for (const other of ['PING 9.9.9.9 (9.9.9.9): 56 data bytes', 'Request timeout for icmp_seq 3',
    'round-trip min/avg/max/stddev = 8.1/9.2/12.0/1.1 ms', 'rtt min/avg/max/mdev = 8.1/9.2/12.0/1.1 ms']) {
    assert.equal(parseUnixLine(other), null, other);
  }
});

test('history: ping kept, a lost answer as a gap', () => {
  const { createHistory } = require('../history');
  const h = createHistory();
  const base = { cpu: { per: [1], avg: 1 }, ram: { pct: 1 }, gpu: null, net: { rate: null } };
  [12, null, 14].forEach((ping, i) => h.push({ ...base, ping }, 1000 * i));
  const m = h.get('1m');
  assert.equal(m.ping[0], 12);
  assert.ok(Number.isNaN(m.ping[1]));
  assert.equal(m.ping[2], 14);
});
