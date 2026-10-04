/**
 * Verification des nouvelles versions via les releases GitHub (tags klakboard-v<semver>).
 * Le depot etant prive, l'API demande un token en lecture seule, fourni par l'appelant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'Klakh/widgets';
const TAG_PREFIX = 'klakboard-v';
const ASSET = 'app.asar';

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

/** Renvoie { version, assetUrl, size } si une release plus recente existe, sinon null. */
async function findUpdate(currentVersion, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: authHeaders('application/vnd.github+json', token),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const releases = await res.json();

  let best = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TAG_PREFIX.length);
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const asset = r.assets.find((a) => a.name === ASSET);
    if (!asset) continue;
    if (!best || isNewer(version, best.version)) {
      best = { version, assetUrl: asset.url, size: asset.size };
    }
  }

  return best && isNewer(best.version, currentVersion) ? best : null;
}

/** Telecharge le nouveau app.asar dans `dest`. */
async function downloadAsar(update, token, dest) {
  const res = await fetch(update.assetUrl, {
    headers: authHeaders('application/octet-stream', token),
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Téléchargement ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 * 1024) throw new Error('Fichier de mise à jour incomplet');
  fs.writeFileSync(dest, buf);
}

module.exports = { findUpdate, downloadAsar, isNewer };
