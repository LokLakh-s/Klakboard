/**
 * Picks the dashboard screen. No Electron dependency: screens are passed as
 * arguments (shape of screen.getAllDisplays()).
 */

/**
 * Screen to cover: the one saved in the settings, found by id or else by
 * resolution (the id may change when the screen moves to another port).
 * Without a saved choice, the small secondary screen: 960 x 640, or else the
 * smallest dashboard-shaped secondary screen (see isDashboardShaped). null when
 * none fits: the primary screen is never covered unless it was picked.
 *
 * @param {Array} displays        connected screens
 * @param {number} primaryId      id of the primary screen
 * @param {?{id, width, height}} remembered  screen picked in the settings
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
    .filter((d) => isDashboardShaped(d.bounds))
    .sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  return small[0] || null;
}

/**
 * Small panel, landscape or portrait (up to 1100 x 800), or bar screen (at
 * least 2.4:1 with a short side up to 800, e.g. 1920 x 480, 2560 x 720). Excludes
 * ordinary monitors and laptop panels, even rotated (16:9 is 1.78:1).
 */
function isDashboardShaped({ width, height }) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return short <= 800 && (long <= 1100 || long / short >= 2.4);
}

/** What is kept of a screen to find it again at the next launch. */
function displayKey(d) {
  return { id: d.id, width: d.bounds.width, height: d.bounds.height };
}

/** True when rectangle `b` overlaps at least one screen: otherwise the window would be off-screen. */
function isOnScreen(displays, b) {
  return displays.some(({ bounds: d }) =>
    b.x < d.x + d.width && b.x + b.width > d.x && b.y < d.y + d.height && b.y + b.height > d.y);
}

module.exports = { findTargetDisplay, isDashboardShaped, displayKey, isOnScreen };
