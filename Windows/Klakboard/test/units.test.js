const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8');

test('comparaison de versions', () => {
  const { isNewer } = require('../updates');
  assert.equal(isNewer('1.2.10', '1.2.9'), true);
  assert.equal(isNewer('1.3.0', '1.2.99'), true);
  assert.equal(isNewer('1.2.5', '1.2.5'), false);
  assert.equal(isNewer('1.2.4', '1.2.5'), false);
});

test('chaque code meteo a son icone, de jour comme de nuit', () => {
  const { iconName, WMO } = require('../weather');
  for (const code of [...Object.keys(WMO).map(Number), 42]) {
    for (const isDay of [true, false]) {
      const file = path.join(APP_DIR, 'icons', 'weather', `${iconName(code, isDay)}.svg`);
      assert.ok(fs.existsSync(file), `code ${code} : ${path.basename(file)} manquant`);
    }
  }
});

test('les periodes de la courbe existent cote marches', () => {
  const { PERIODS } = require('../markets');
  const chips = [...read('index.html').matchAll(/data-range="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(chips, Object.keys(PERIODS));
  // Periode par defaut a l'ouverture d'une courbe : doit etre l'une des puces.
  for (const [, range] of read('renderer.js').matchAll(/chartRange = '([^']+)'/g)) {
    assert.ok(chips.includes(range), `periode par defaut inconnue : ${range}`);
  }
});

test('tout ce que charge l\'appli est empaquete', () => {
  const { build } = require('../package.json');
  const packaged = (f) => build.files.includes(f)
    || build.files.some((g) => g.endsWith('/**/*') && f.startsWith(g.slice(0, -4)));

  // Modules locaux requis, de proche en proche depuis main.js.
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
    if (f === 'package.json') continue; // toujours embarque par electron-builder
    assert.ok(packaged(f), `${f} absent de build.files dans package.json`);
  }
});

test('mise a jour : archive pour le moteur installe, sinon installeur', () => {
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

test('empreinte de telechargement', () => {
  const { checkDigest } = require('../updates');
  const buf = Buffer.from('klakboard');
  const ok = `sha256:${require('crypto').createHash('sha256').update(buf).digest('hex')}`;
  assert.doesNotThrow(() => checkDigest(buf, ok));
  assert.doesNotThrow(() => checkDigest(buf, null));
  assert.throws(() => checkDigest(Buffer.from('autre'), ok), /empreinte/);
});

test('libelle des villes meteo', () => {
  const { placeLabel } = require('../weather');
  assert.equal(placeLabel({ name: 'Paris', country_code: 'FR', postcodes: ['75001'] }), 'Paris (75)');
  assert.equal(placeLabel({ name: 'Saint-Pierre', country_code: 'FR', postcodes: ['97410'] }), 'Saint-Pierre (974)');
  assert.equal(placeLabel({ name: 'Paris', country_code: 'BE', postcodes: ['8000'] }), 'Paris (BE)');
  assert.equal(placeLabel({ name: 'Nulle-part' }), 'Nulle-part');
});

test('token GitHub : chiffre a la premiere lecture, fichier en clair supprime', () => {
  const os = require('os');
  const { readToken, PLAIN } = require('../token');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klakboard-token-'));
  // Faux chiffrement reversible : seul le cheminement des fichiers est teste.
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...s].reverse().join('')),
    decryptString: (b) => [...b.toString()].reverse().join(''),
  };
  assert.equal(readToken(dir, safe), null);

  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_abc\n');
  assert.equal(readToken(dir, safe), 'github_pat_abc');
  assert.ok(!fs.existsSync(path.join(dir, PLAIN)), 'le fichier en clair doit disparaitre');
  assert.ok(!fs.readFileSync(path.join(dir, 'github-token.bin'), 'utf8').includes('github_pat_abc'));
  assert.equal(readToken(dir, safe), 'github_pat_abc');

  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_neuf');
  assert.equal(readToken(dir, safe), 'github_pat_neuf');
  assert.equal(readToken(dir, safe), 'github_pat_neuf');

  // Sans chiffrement disponible, le fichier en clair reste en place et sert tel quel.
  const noSeal = { isEncryptionAvailable: () => false };
  fs.writeFileSync(path.join(dir, PLAIN), 'github_pat_clair');
  assert.equal(readToken(dir, noSeal), 'github_pat_clair');
  assert.ok(fs.existsSync(path.join(dir, PLAIN)));
});

test('mode nuit : du coucher au lever du soleil', () => {
  const { nightWindow } = require('../weather');
  const h = (x) => x * 3600e3;
  const sun = [{ rise: h(8), set: h(19.5) }, { rise: h(24 + 8), set: h(24 + 19.5) }];
  assert.deepEqual(nightWindow(h(3), sun), { on: true, from: null, until: h(8) });
  assert.deepEqual(nightWindow(h(12), sun), { on: false, from: h(19.5), until: h(32) });
  assert.deepEqual(nightWindow(h(21), sun), { on: true, from: h(19.5), until: h(32) });
  // Apres minuit, meteo pas encore rafraichie : sun[0] est la veille.
  assert.equal(nightWindow(h(24.5), sun).on, true);
  assert.equal(nightWindow(h(12), null), null);
  assert.equal(nightWindow(h(12), [{ rise: NaN, set: NaN }]), null);
});

test('tout ce que la page appelle est expose par preload.js', () => {
  // Une fonction manquante leve une erreur des le chargement : page vide.
  const used = new Set([...read('renderer.js').matchAll(/window\.dash\.(\w+)/g)].map((m) => m[1]));
  const exposed = new Set([...read('preload.js').matchAll(/^\s+(\w+):/gm)].map((m) => m[1]));
  const missing = [...used].filter((f) => !exposed.has(f));
  assert.deepEqual(missing, []);
});
