/**
 * Looks for new versions in the GitHub releases (tags klakboard-v<semver>). The
 * repository is public: the token, if any, is optional.
 *
 * A release carries the installer and the app archive, named after the Electron
 * major it was built for (app-electron44.asar). An archive only runs on that
 * engine: when the release has none for the installed engine, the installer is
 * needed.
 */

const crypto = require('crypto');
const fs = require('fs');
const { t } = require('./i18n');

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
 * Picks the update among the releases (GitHub API format).
 * @returns {?{version, kind: 'asar'|'installer', asset}} the latest release
 *   newer than `currentVersion`, or null.
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
  if (!res.ok) throw new Error(t('upd.github', { status: res.status }));
  return pickUpdate(await res.json(), currentVersion, electronMajor);
}

/**
 * Throws when `buf` does not match the digest published by GitHub
 * ("sha256:<hex>"). GitHub only publishes it a moment after the upload: without
 * it, refuse rather than install unchecked.
 */
function checkDigest(buf, digest) {
  const [algo, expected] = (digest || '').split(':');
  if (algo !== 'sha256' || !expected) {
    throw new Error(t('upd.noDigest'));
  }
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error(t('upd.corrupt'));
}

/** Downloads a release file to `dest`, after checking its size and digest. */
async function downloadAsset(asset, token, dest) {
  const res = await fetch(asset.url, {
    headers: authHeaders('application/octet-stream', token),
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(t('upd.download', { status: res.status }));
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== asset.size) throw new Error(t('upd.incomplete'));
  checkDigest(buf, asset.digest);
  fs.writeFileSync(dest, buf);
}

module.exports = { findUpdate, pickUpdate, downloadAsset, checkDigest, isNewer, asarName };
