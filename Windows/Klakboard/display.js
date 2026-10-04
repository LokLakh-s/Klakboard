/**
 * Choix de l'ecran du tableau de bord. Aucune dependance a Electron : les
 * ecrans sont passes en argument (forme de screen.getAllDisplays()).
 */

/**
 * Ecran a recouvrir : celui retenu dans les reglages, retrouve par son id ou a
 * defaut par sa resolution (l'id peut changer quand l'ecran change de port).
 * Sans choix enregistre, le petit ecran secondaire : 960 x 640, sinon le plus
 * petit des ecrans secondaires <= 1100 x 800. null si aucun ne convient : on ne
 * recouvre jamais l'ecran principal sans qu'il ait ete choisi.
 *
 * @param {Array} displays        ecrans connectes
 * @param {number} primaryId      id de l'ecran principal
 * @param {?{id, width, height}} remembered  ecran choisi dans les reglages
 */
function findTargetDisplay(displays, primaryId, remembered) {
  if (remembered) {
    return displays.find((d) => d.id === remembered.id)
      || displays.find((d) => d.bounds.width === remembered.width && d.bounds.height === remembered.height)
      || null;
  }
  const secondary = displays.filter((d) => d.id !== primaryId);
  const exact = secondary.find((d) => d.bounds.width === 960 && d.bounds.height === 640);
  if (exact) return exact;
  const small = secondary
    .filter((d) => d.bounds.width <= 1100 && d.bounds.height <= 800)
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  return small[0] || null;
}

/** Ce qu'on retient d'un ecran pour le retrouver au prochain demarrage. */
function displayKey(d) {
  return { id: d.id, width: d.bounds.width, height: d.bounds.height };
}

/** Vrai si le rectangle `b` recoupe au moins un ecran : sinon la fenetre serait hors champ. */
function isOnScreen(displays, b) {
  return displays.some(({ bounds: d }) =>
    b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y);
}

module.exports = { findTargetDisplay, displayKey, isOnScreen };
