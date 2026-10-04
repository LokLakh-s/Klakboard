/**
 * Meteo du jour, sans cle API.
 *
 *   previsions : Open-Meteo  /v1/forecast  (modele ECMWF/ICON, horaire + CAPE)
 *   carte      : Windy, ouverte dans le navigateur (radar, vent, temperature)
 *
 * CAPE = energie convective disponible : indicateur du risque d'orage.
 */

const SITE = { label: 'Paris (75)', lat: 48.8566, lon: 2.3522 };

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const CARD_URL = `https://www.windy.com/${SITE.lat}/${SITE.lon}?radar,${SITE.lat},${SITE.lon},9`;

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

/** Cle d'illustration (voir WX_ICONS dans renderer.js) a partir du code WMO. */
function iconKey(code) {
  if (code === 0) return 'sun';
  if (code <= 2) return 'partly';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

function windDir(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

async function getWeather() {
  const params = new URLSearchParams({
    latitude: String(SITE.lat),
    longitude: String(SITE.lon),
    timezone: 'Europe/Paris',
    forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
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
    site: SITE.label,
    temp: d.current.temperature_2m,
    feels: d.current.apparent_temperature,
    desc: WMO[d.current.weather_code] || 'Inconnu',
    icon: iconKey(d.current.weather_code),
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

module.exports = { getWeather, CARD_URL };
