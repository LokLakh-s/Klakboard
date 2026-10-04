/**
 * Meteo du jour, sans cle API.
 *
 *   previsions : Open-Meteo  /v1/forecast  (modele ECMWF/ICON, horaire + CAPE)
 *   villes     : Open-Meteo  /v1/search    (geocodage)
 *   carte      : Windy, ouverte dans le navigateur (radar, vent, temperature)
 *
 * CAPE = energie convective disponible : indicateur du risque d'orage.
 */

const DEFAULT_SITE = { label: 'Paris (75)', lat: 48.8566, lon: 2.3522, timezone: 'Europe/Paris' };

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';

const mapUrl = (site) => `https://www.windy.com/${site.lat}/${site.lon}?radar,${site.lat},${site.lon},9`;

const WMO = {
  0: 'Ciel dégagé', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine faible', 53: 'Bruine', 55: 'Bruine forte', 56: 'Bruine verglaçante', 57: 'Bruine verglaçante',
  61: 'Pluie faible', 63: 'Pluie', 65: 'Pluie forte', 66: 'Pluie verglaçante', 67: 'Pluie verglaçante',
  71: 'Neige faible', 73: 'Neige', 75: 'Neige forte', 77: 'Grains de neige',
  80: 'Averses faibles', 81: 'Averses', 82: 'Averses violentes',
  85: 'Averses de neige', 86: 'Fortes averses de neige',
  95: 'Orage', 96: 'Orage avec grêle', 99: 'Orage violent avec grêle',
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

function stormLevel(cape) {
  if (cape < 500) return 'faible';
  if (cape < 1500) return 'possible';
  return 'fort';
}

/** Nom de l'icone Meteocons (icons/weather/<nom>.svg) pour un code WMO. */
function iconName(code, isDay) {
  const dn = isDay ? 'day' : 'night';
  if (code === 0) return `clear-${dn}`;
  if (code === 1) return `mostly-clear-${dn}`;
  if (code === 2) return `partly-cloudy-${dn}`;
  if (code === 45 || code === 48) return `fog-${dn}`;
  if (code >= 51 && code <= 55) return 'drizzle';
  if ([56, 57, 66, 67].includes(code)) return 'sleet';
  if (code === 61 || code === 63) return 'rain';
  if (code === 65 || code === 82) return 'extreme-rain';
  if ([71, 73, 77].includes(code)) return 'snow';
  if (code === 75) return 'extreme-snow';
  if (code === 80 || code === 81) return `partly-cloudy-${dn}-rain`;
  if (code === 85 || code === 86) return `partly-cloudy-${dn}-snow`;
  if (code === 95) return `thunderstorms-${dn}-rain`;
  if (code === 96) return `thunderstorms-${dn}-hail`;
  if (code === 99) return `thunderstorms-extreme-${dn}-hail`;
  return `overcast-${dn}`;
}

function windDir(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

async function getWeather(site = DEFAULT_SITE) {
  const params = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    timezone: site.timezone || 'auto',
    forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max',
    hourly: 'cape',
  });
  const res = await fetch(`${OPEN_METEO}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();

  // Risque d'orage : pic de CAPE sur les 12 prochaines heures.
  const now = d.current.time;
  const upcoming = d.hourly.time
    .map((t, i) => ({ t, cape: d.hourly.cape[i] }))
    .filter((h) => h.t >= now)
    .slice(0, 12);
  const capeMax = Math.max(0, ...upcoming.map((h) => h.cape ?? 0));

  return {
    site: site.label,
    temp: d.current.temperature_2m,
    feels: d.current.apparent_temperature,
    desc: WMO[d.current.weather_code] || 'Inconnu',
    icon: iconName(d.current.weather_code, d.current.is_day === 1),
    min: d.daily.temperature_2m_min[0],
    max: d.daily.temperature_2m_max[0],
    rainProb: d.daily.precipitation_probability_max[0],
    rainSum: d.daily.precipitation_sum[0],
    wind: Math.round(d.current.wind_speed_10m),
    gusts: Math.round(d.current.wind_gusts_10m),
    windDir: windDir(d.current.wind_direction_10m),
    windMax: Math.round(d.daily.wind_speed_10m_max[0]),
    storm: stormLevel(capeMax),
    updatedAt: Date.now(),
  };
}

/**
 * Libelle court d'une ville : departement en France (« Paris (75) », trois
 * chiffres outre-mer), code pays ailleurs (« Paris (BE) »).
 */
function placeLabel(r) {
  const postcode = (r.postcodes || [])[0];
  if (r.country_code === 'FR' && postcode) {
    return `${r.name} (${postcode.slice(0, postcode.startsWith('97') ? 3 : 2)})`;
  }
  return r.country_code ? `${r.name} (${r.country_code})` : r.name;
}

/** Villes correspondant a `query`, avec de quoi les distinguer (departement, pays). */
async function searchPlaces(query) {
  const params = new URLSearchParams({ name: query, count: '8', language: 'fr', format: 'json' });
  const res = await fetch(`${GEOCODING}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const { results = [] } = await res.json();
  return results.map((r) => ({
    label: placeLabel(r),
    detail: [r.admin2 || r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || 'auto',
  }));
}

module.exports = { getWeather, searchPlaces, placeLabel, mapUrl, iconName, WMO, DEFAULT_SITE };
