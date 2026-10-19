/**
 * Moon phase, computed from the date alone (no network): mean elements of the
 * Sun and the Moon with the main periodic terms of the Moon's longitude (Meeus,
 * Astronomical Algorithms, ch. 25 and 47). Accurate to about half a degree of
 * elongation, i.e. within an hour of the phase instants. Loaded by the page
 * (window.astro) and by the tests (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.astro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RAD = Math.PI / 180;
  const norm = (deg) => ((deg % 360) + 360) % 360;
  const sin = (deg) => Math.sin(deg * RAD);

  /** Moon-Sun elongation in ecliptic longitude at `ms`, in degrees: 0 new moon, 90 first quarter, 180 full. */
  function elongation(ms) {
    const T = (ms / 86400000 + 2440587.5 - 2451545) / 36525;   // Julian centuries since J2000
    const D = 297.8501921 + 445267.1114034 * T;    // mean elongation
    const M = 357.5291092 + 35999.0502909 * T;     // Sun's mean anomaly
    const Mp = 134.9633964 + 477198.8675055 * T;   // Moon's mean anomaly
    const F = 93.272095 + 483202.0175233 * T;      // Moon's argument of latitude
    const moon = 6.288774 * sin(Mp) + 1.274027 * sin(2 * D - Mp) + 0.658314 * sin(2 * D)
      + 0.213618 * sin(2 * Mp) - 0.185116 * sin(M) - 0.114332 * sin(2 * F)
      + 0.058793 * sin(2 * D - 2 * Mp) + 0.057066 * sin(2 * D - M - Mp) + 0.053322 * sin(2 * D + Mp)
      + 0.045758 * sin(2 * D - M) - 0.040923 * sin(M - Mp) - 0.03472 * sin(D) - 0.030383 * sin(M + Mp);
    const sunCentre = (1.914602 - 0.004817 * T) * sin(M) + 0.019993 * sin(2 * M);
    return norm(D + moon - sunCentre);
  }

  const PHASES = ['new', 'waxingCrescent', 'firstQuarter', 'waxingGibbous', 'full', 'waningGibbous', 'lastQuarter', 'waningCrescent'];
  // New moon, quarters and full moon are named from a day before to a day after.
  const NAMED_WITHIN = 12;   // degrees of elongation, the Moon gains ~12.2 a day

  /** { key (one of PHASES), elongation (degrees), illumination (0 to 1), waxing } at `ms`. */
  function moonPhase(ms) {
    const e = elongation(ms);
    const nearest = Math.round(e / 90);
    const key = Math.abs(e - nearest * 90) <= NAMED_WITHIN
      ? PHASES[(nearest % 4) * 2]
      : PHASES[Math.floor(e / 90) * 2 + 1];
    return { key, elongation: e, illumination: (1 - Math.cos(e * RAD)) / 2, waxing: e < 180 };
  }

  /**
   * SVG path of the lit part of a Moon of radius `r` centred on (c, c), lit on
   * the right as seen from the northern hemisphere while waxing: the caller
   * mirrors it when waning, and again in the southern hemisphere.
   */
  function litPath(e, r, c = r) {
    const a = e <= 180 ? e : 360 - e;    // 0 new .. 180 full, whatever the half
    const rx = Math.abs(Math.cos(a * RAD)) * r;
    const f = (v) => +v.toFixed(2);
    // Right half-disc, then back up along the terminator: an ellipse bulging to
    // the right while a crescent, to the left once gibbous.
    return `M${f(c)},${f(c - r)}A${f(r)},${f(r)} 0 0 1 ${f(c)},${f(c + r)}`
      + `A${f(rx)},${f(r)} 0 0 ${a < 90 ? 0 : 1} ${f(c)},${f(c - r)}Z`;
  }

  return { elongation, moonPhase, litPath, PHASES };
});
