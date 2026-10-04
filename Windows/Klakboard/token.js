/**
 * Token GitHub des mises a jour (le depot est prive).
 *
 * Il se depose en clair dans github-token.txt ; a la premiere lecture il est
 * chiffre pour la session Windows (DPAPI, via safeStorage d'Electron) dans
 * github-token.bin, et le fichier en clair est supprime. Redeposer un .txt
 * remplace le token.
 */

const fs = require('fs');
const path = require('path');

const PLAIN = 'github-token.txt';
const SEALED = 'github-token.bin';

/**
 * @param {string} dir dossier des donnees de l'appli
 * @param {{isEncryptionAvailable, encryptString, decryptString}} safeStorage
 * @returns {?string} le token, ou null
 */
function readToken(dir, safeStorage) {
  const canSeal = safeStorage.isEncryptionAvailable();
  let plain = '';
  try {
    plain = fs.readFileSync(path.join(dir, PLAIN), 'utf8').trim();
  } catch {
    /* pas de token en clair : on lit la version chiffree */
  }
  if (plain) {
    if (canSeal) {
      try {
        fs.writeFileSync(path.join(dir, SEALED), safeStorage.encryptString(plain));
        fs.unlinkSync(path.join(dir, PLAIN));
      } catch {
        /* chiffrement impossible cette fois : le token reste utilisable en clair */
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
