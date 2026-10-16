/**
 * Today's weather, keyless.
 *
 *   forecast : Open-Meteo  /v1/forecast  (ECMWF/ICON models, hourly + CAPE)
 *   cities   : Open-Meteo  /v1/search    (geocoding)
 *   map      : Windy, opened in the browser (radar, wind, temperature)
 *
 * CAPE = convective available potential energy: a thunderstorm risk indicator.
 */

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';

const mapUrl = (site) => `https://www.windy.com/${site.lat}/${site.lon}?radar,${site.lat},${site.lon},9`;

// WMO weather codes used by Open-Meteo; their descriptions are in i18n.js.
const WMO_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

/** Thunderstorm risk level from CAPE (J/kg): 'low', 'possible' or 'high'. */
function stormLevel(cape) {
  if (cape < 500) return 'low';
  if (cape < 1500) return 'possible';
  return 'high';
}

/** Meteocons icon name (icons/weather/<name>.svg) for a WMO code. */
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

async function getWeather(site) {
  const params = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    timezone: site.timezone || 'auto',
    forecast_days: '2',
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
    hourly: 'cape,temperature_2m,weather_code,is_day,precipitation_probability',
  });
  const res = await fetch(`${OPEN_METEO}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const d = await res.json();

  // Thunderstorm risk: highest CAPE over the next 12 hours. Times are local to
  // the city ("2026-10-16T14:00"), so they compare as strings.
  const now = d.current.time;
  const nextHours = d.hourly.time
    .map((t, i) => ({ t, i }))
    .filter((h) => h.t >= now.slice(0, 13))
    .slice(0, 24);
  const upcoming = nextHours.slice(0, 12).map(({ i }) => ({ cape: d.hourly.cape[i] }));
  const capeMax = Math.max(0, ...upcoming.map((h) => h.cape ?? 0));

  // City local times without offset: converted to absolute instants.
  const toMs = (local) => (local ? Date.parse(`${local}:00Z`) - d.utc_offset_seconds * 1000 : NaN);

  return {
    site: site.label,
    temp: d.current.temperature_2m,
    feels: d.current.apparent_temperature,
    code: d.current.weather_code,
    icon: iconName(d.current.weather_code, d.current.is_day === 1),
    min: d.daily.temperature_2m_min[0],
    max: d.daily.temperature_2m_max[0],
    rainProb: d.daily.precipitation_probability_max[0],
    rainSum: d.daily.precipitation_sum[0],
    wind: Math.round(d.current.wind_speed_10m),
    gusts: Math.round(d.current.wind_gusts_10m),
    windDeg: d.current.wind_direction_10m,
    windMax: Math.round(d.daily.wind_speed_10m_max[0]),
    storm: stormLevel(capeMax),
    // Next 24 hours, for large screens: hour (local to the city), icon, °C, rain %.
    hourly: nextHours.map(({ t, i }) => ({
      hour: Number(t.slice(11, 13)),
      icon: iconName(d.hourly.weather_code[i], d.hourly.is_day[i] === 1),
      temp: d.hourly.temperature_2m[i],
      rainProb: d.hourly.precipitation_probability[i],
    })),
    // Sunrise and sunset of today and tomorrow (missing during polar night or day).
    sun: d.daily.sunrise.map((rise, i) => ({ rise: toMs(rise), set: toMs(d.daily.sunset[i]) })),
    updatedAt: Date.now(),
  };
}

/**
 * Short city label: department in France (« Paris (75) », three digits
 * overseas), country code elsewhere (« Paris (US) »).
 */
function placeLabel(r) {
  const postcode = (r.postcodes || [])[0];
  if (r.country_code === 'FR' && postcode) {
    return `${r.name} (${postcode.slice(0, postcode.startsWith('97') ? 3 : 2)})`;
  }
  return r.country_code ? `${r.name} (${r.country_code})` : r.name;
}

/** Cities matching `query`, with what tells them apart (department, country). */
async function searchPlaces(query, language = 'en') {
  const params = new URLSearchParams({ name: query, count: '8', language, format: 'json' });
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

/**
 * Current or next night, from sunset to sunrise: { on, from, until } (instants
 * in ms; from is null before sunrise, the previous sunset being unknown). null
 * without sun times (weather unavailable, polar night or day). `sun[0]` is the
 * current day in the city's time zone; after midnight, until the weather is
 * refreshed, it is still the previous day: we are then after its sunset, so it
 * is indeed night.
 */
function nightWindow(now, sun) {
  const [today, tomorrow] = sun || [];
  if (!today || !Number.isFinite(today.rise) || !Number.isFinite(today.set)) return null;
  if (now < today.rise) return { on: true, from: null, until: today.rise };
  const until = Number.isFinite(tomorrow?.rise) ? tomorrow.rise : null;
  return { on: now >= today.set, from: today.set, until };
}

module.exports = { getWeather, searchPlaces, placeLabel, mapUrl, nightWindow, iconName, stormLevel, WMO_CODES };
