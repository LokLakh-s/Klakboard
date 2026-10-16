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

  // Local modules required, transitively from main.js.
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, dep] of read(file).matchAll(/require\('\.\/([\w.-]+)'\)/g)) {
      visit(dep.endsWith('.js') || dep.endsWith('.json') ? dep : `${dep}.js`);
    }
  };
  visit('main.js');
  seen.add('preload.js');
  for (const [, ref] of read('index.html').matchAll(/(?:src|href)="([\w./-]+)"/g)) seen.add(ref);

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
