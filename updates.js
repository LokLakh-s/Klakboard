/**
 * Verification des nouvelles versions via les releases GitHub (tags klakboard-v<semver>).
 * Le depot etant prive, l'API demande un token en lecture seule, fourni par l'appelant.
 *
 * Une release porte l'installeur et l'archive de l'appli, nommee d'apres la
 * version majeure d'Electron pour laquelle elle a ete construite
 * (app-electron33.asar). Une archive ne tourne que sur ce moteur : si la
 * release n'en a pas pour le moteur installe, il faut passer par l'installeur.
 */

const crypto = require('crypto');
const fs = require('fs');

const REPO = 'LokLakh-s/Klakboard';
const TAG_PREFIX = 'klakboard-v';
const asarName = (electronMajor) => `app-electron${electronMajor}.asar`;
const SETUP_RE = /^Klakboard\.Setup\.\d+\.\d+\.\d+\.exe$/;

function authHeaders(accept, token) {
  const headers = { 'User-Agent': 'Klakboard', Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseSemver(v) {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

const assetOf = (a) => ({ name: a.name, url: a.url, size: a.size, digest: a.digest || null });

/**
 * Choisit la mise a jour parmi les releases (format de l'API GitHub).
 * @returns {?{version, kind: 'asar'|'installer', asset}} la plus recente
 *   release plus recente que `currentVersion`, ou null.
 */
function pickUpdate(releases, currentVersion, electronMajor) {
  let best = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isNewer(version, currentVersion)) continue;
    if (best && !isNewer(version, best.version)) continue;
    const asar = r.assets.find((a) => a.name === asarName(electronMajor));
    const setup = r.assets.find((a) => SETUP_RE.test(a.name));
    if (asar) best = { version, kind: 'asar', asset: assetOf(asar) };
    else if (setup) best = { version, kind: 'installer', asset: assetOf(setup) };
  }
  return best;
}

async function findUpdate(currentVersion, electronMajor, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: authHeaders('application/vnd.github+json', token),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return pickUpdate(await res.json(), currentVersion, electronMajor);
}

/**
 * Leve une erreur si `buf` ne correspond pas a l'empreinte publiee par GitHub
 * ("sha256:<hex>"). GitHub ne la publie que quelques instants apres le depot
 * du fichier : sans elle, on refuse plutot que d'installer sans controle.
 */
function checkDigest(buf, digest) {
  const [algo, expected] = (digest || '').split(':');
  if (algo !== 'sha256' || !expected) {
    throw new Error('Empreinte du fichier pas encore publiée par GitHub : réessayer dans une minute');
  }
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error('Fichier de mise à jour corrompu (empreinte SHA-256 différente)');
}

/** Telecharge un fichier de release dans `dest`, apres controle de taille et d'empreinte. */
async function downloadAsset(asset, token, dest) {
  const res = await fetch(asset.url, {
    headers: authHeaders('application/octet-stream', token),
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Téléchargement ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== asset.size) throw new Error('Fichier de mise à jour incomplet');
  checkDigest(buf, asset.digest);
  fs.writeFileSync(dest, buf);
}

module.exports = { findUpdate, pickUpdate, downloadAsset, checkDigest, isNewer, asarName };
