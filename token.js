/**
 * GitHub token for updates. Only needed while the repository was private: kept
 * for installations that still have one.
 *
 * It is dropped in plain text in github-token.txt; on first read it is encrypted
 * for the user session (DPAPI on Windows, through Electron's safeStorage) into
 * github-token.bin, and the plain file is deleted. Dropping a new .txt replaces
 * the token.
 */

const fs = require('fs');
const path = require('path');

const PLAIN = 'github-token.txt';
const SEALED = 'github-token.bin';

/**
 * @param {string} dir app data folder
 * @param {{isEncryptionAvailable, encryptString, decryptString}} safeStorage
 * @returns {?string} the token, or null
 */
function readToken(dir, safeStorage) {
  const canSeal = safeStorage.isEncryptionAvailable();
  let plain = '';
  try {
    plain = fs.readFileSync(path.join(dir, PLAIN), 'utf8').trim();
  } catch {
    /* no plain token: read the encrypted one */
  }
  if (plain) {
    if (canSeal) {
      try {
        fs.writeFileSync(path.join(dir, SEALED), safeStorage.encryptString(plain));
        fs.unlinkSync(path.join(dir, PLAIN));
      } catch {
        /* encryption failed this time: the plain token stays usable */
      }
    }
    return plain;
  }
  if (!canSeal) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(path.join(dir, SEALED))) || null;
  } catch {
    return null;
  }
}

module.exports = { readToken, PLAIN };
