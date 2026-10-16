/**
 * Interface strings, in English and French. Loaded by the main process
 * (require) and by the page (<script>, exposed as window.i18n): both keep their
 * own current language, set by setLanguage().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.i18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WMO_EN = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
  };
  const WMO_FR = {
    0: 'Ciel dégagé', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert',
    45: 'Brouillard', 48: 'Brouillard givrant',
    51: 'Bruine faible', 53: 'Bruine', 55: 'Bruine forte', 56: 'Bruine verglaçante', 57: 'Bruine verglaçante',
    61: 'Pluie faible', 63: 'Pluie', 65: 'Pluie forte', 66: 'Pluie verglaçante', 67: 'Pluie verglaçante',
    71: 'Neige faible', 73: 'Neige', 75: 'Neige forte', 77: 'Grains de neige',
    80: 'Averses faibles', 81: 'Averses', 82: 'Averses violentes',
    85: 'Averses de neige', 86: 'Fortes averses de neige',
    95: 'Orage', 96: 'Orage avec grêle', 99: 'Orage violent avec grêle',
  };
  const prefix = (p, obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${p}.${k}`, v]));

  const STRINGS = {
    en: {
      // Formatting: locale used when the system locale is in another language.
      'locale': 'en-US',
      'units.bytes': 'B,kB,MB,GB,TB',
      'units.perSecond': '/s',
      'compass': 'N,NE,E,SE,S,SW,W,NW',

      'tray.install': '⬇  Install update {version}…',
      'tray.toggle': 'Show / hide',
      'tray.refresh': 'Refresh quotes',
      'tray.add': 'Add a row…',
      'tray.settings': 'Settings…',
      'tray.check': 'Check for updates (v{version})',
      'tray.quit': 'Quit Klakboard',
      'tray.tooltipUpdate': 'Klakboard — update {version} available',

      'upd.checkFailed': 'Update check failed',
      'upd.upToDate': 'Klakboard {version} is up to date.',
      'upd.notifTitle': 'Klakboard {version} available',
      'upd.notifBody': 'Click here to update (or right-click the Klakboard icon).',
      'upd.dialogTitle': 'Klakboard update',
      'upd.update': 'Update',
      'upd.later': 'Later',
      'upd.message': 'Klakboard {version} is available (current version: {current}).',
      'upd.viaInstaller': 'This version changes Klakboard\'s engine, so it goes through the full installer. '
        + 'Klakboard will close and the installer will open; Klakboard restarts at the end.',
      'upd.viaArchive': 'Klakboard will close, update and restart by itself.',
      'upd.viaPage': 'Download it from its release page on GitHub.',
      'upd.openPage': 'Open the download page',
      'upd.failed': 'Update failed',
      'upd.noDigest': 'GitHub has not published the file digest yet: try again in a minute',
      'upd.corrupt': 'Corrupted update file (SHA-256 digest mismatch)',
      'upd.incomplete': 'Incomplete update file',
      'upd.download': 'Download failed (HTTP {status})',
      'upd.github': 'GitHub {status}',

      'err.source': '{source}: {message}',
      'err.timeout': 'timed out on {host}',
      'err.unreachable': '{host} unreachable',
      'err.http': 'HTTP {status} on {host}',
      'err.yahooEmpty': 'empty Yahoo series',
      'err.unknownRow': 'unknown row',

      'display.fallback': 'Screen {n}',
      'display.primary': 'primary',

      'markets.empty': 'No tracked rows.',
      'markets.emptyHint': 'Right-click → Add a row…',
      'markets.remove': 'Remove {label}',
      'markets.lastQuote': 'Last quote at {time}',
      'markets.failing': 'Markets ({time}) — failing:',
      'markets.ok': 'Markets up to date — {time}',
      ...prefix('metal', { XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium', HG: 'Copper' }),

      'sys.network': 'NETWORK',
      'sys.reset': 'reset',
      'sys.resetTitle': 'Reset the totals',
      'sys.threads': '{n} threads',
      'sys.free': '{value} free',
      'sys.noGpu': 'no GPU data',
      'sys.fan': 'fan {fan}',
      'sys.na': 'n/a',
      'sys.peak': 'peak {value}',

      'chart.loading': 'loading…',
      'chart.empty': 'No data for this period',
      'chart.error': 'error: {message}',
      ...prefix('range', {
        '1h': '1 h', '3h': '3 h', '6h': '6 h', '12h': '12 h', '24h': '24 h', '3d': '3 d', '1w': '1 wk',
        '30d': '30 d', '60d': '60 d', '90d': '90 d', '6m': '6 mo', '1y': '1 yr', '3y': '3 yr', '5y': '5 yr',
      }),

      'weather.title': 'Weather',
      'weather.map': 'Map',
      'weather.openMap': 'Open the weather map',
      'weather.pickCityTitle': 'Pick the weather city',
      'weather.pickCity': 'Pick a city',
      'weather.clickToSearch': 'Click to search',
      'weather.feels': 'Feels like {temp} °C',
      'weather.minMax': 'Min / max',
      'weather.rain': 'Rain',
      'weather.rainProb': 'Rain · {prob} %',
      'weather.wind': 'Wind',
      'weather.windGusts': 'Wind · gusts {gusts}',
      'weather.storm': 'Storm',
      'weather.unavailable': 'Weather unavailable',
      'weather.unknown': 'Unknown',
      'storm.low': 'low',
      'storm.possible': 'possible',
      'storm.high': 'high',
      ...prefix('wmo', WMO_EN),

      'night.current': 'Night now',
      'night.next': 'Next night',
      'night.line': '{when}: {span}, from the sun in {city}.',
      'night.until': 'until {time}',
      'night.theCity': 'the weather city',
      'night.unknown': 'Sun times not known yet (weather unavailable).',
      'night.noCity': 'Pick a weather city: night follows its sunset and sunrise.',

      'add.title': 'Add a row',
      'add.metal': 'Metal',
      'add.fx': 'Currency',
      'add.crypto': 'Crypto',
      'add.pair': 'Add the pair',

      'settings.title': 'Settings',
      'settings.theme': 'Theme',
      ...prefix('theme', {
        dark: 'Dark', light: 'Light', red: 'Red', forest: 'Forest green', green: 'Green',
        yellow: 'Yellow', purple: 'Purple',
      }),
      'settings.language': 'Language',
      'settings.languageAuto': 'Automatic',
      'settings.screen': 'Full screen on…',
      'settings.windowSize': 'Windowed size',
      'settings.zoom': 'Display size',
      'settings.nightDim': 'Night mode · dim by',
      'settings.nightToggle': 'Dim from sunset to sunrise',
      'settings.city': 'Weather city',
      'settings.citySearch': 'Search for a city…',
      'settings.noCity': 'No city found',
      'settings.refresh': 'Market refresh',
      'settings.cover': 'Cover the taskbar',
      'settings.autostart': 'Start at login',
      'settings.sysHint': 'System metrics (CPU, RAM, GPU, network) update every second, whatever this setting.',

      'menu.button': 'Menu (or right-click)',
    },

    fr: {
      'locale': 'fr-FR',
      'units.bytes': 'o,ko,Mo,Go,To',
      'units.perSecond': '/s',
      'compass': 'N,NE,E,SE,S,SO,O,NO',

      'tray.install': '⬇  Installer la mise à jour {version}…',
      'tray.toggle': 'Afficher / masquer',
      'tray.refresh': 'Rafraîchir les cours',
      'tray.add': 'Ajouter une ligne…',
      'tray.settings': 'Réglages…',
      'tray.check': 'Vérifier les mises à jour (v{version})',
      'tray.quit': 'Quitter Klakboard',
      'tray.tooltipUpdate': 'Klakboard — mise à jour {version} disponible',

      'upd.checkFailed': 'Vérification impossible',
      'upd.upToDate': 'Klakboard {version} est à jour.',
      'upd.notifTitle': 'Klakboard {version} disponible',
      'upd.notifBody': 'Cliquer ici pour mettre à jour (ou clic droit sur l\'icône de Klakboard).',
      'upd.dialogTitle': 'Mise à jour Klakboard',
      'upd.update': 'Mettre à jour',
      'upd.later': 'Plus tard',
      'upd.message': 'Klakboard {version} est disponible (version actuelle : {current}).',
      'upd.viaInstaller': 'Cette version change le moteur de Klakboard : elle passe par l\'installeur complet. '
        + 'Klakboard va se fermer et l\'installation s\'ouvrir ; Klakboard se relancera à la fin.',
      'upd.viaArchive': 'Klakboard va se fermer, se mettre à jour puis se relancer toute seule.',
      'upd.viaPage': 'À télécharger depuis sa page de release sur GitHub.',
      'upd.openPage': 'Ouvrir la page de téléchargement',
      'upd.failed': 'Mise à jour impossible',
      'upd.noDigest': 'Empreinte du fichier pas encore publiée par GitHub : réessayer dans une minute',
      'upd.corrupt': 'Fichier de mise à jour corrompu (empreinte SHA-256 différente)',
      'upd.incomplete': 'Fichier de mise à jour incomplet',
      'upd.download': 'Téléchargement impossible (HTTP {status})',
      'upd.github': 'GitHub {status}',

      'err.source': '{source} : {message}',
      'err.timeout': 'délai dépassé sur {host}',
      'err.unreachable': '{host} injoignable',
      'err.http': 'HTTP {status} sur {host}',
      'err.yahooEmpty': 'série Yahoo vide',
      'err.unknownRow': 'ligne inconnue',

      'display.fallback': 'Écran {n}',
      'display.primary': 'principal',

      'markets.empty': 'Aucune ligne suivie.',
      'markets.emptyHint': 'Clic droit → Ajouter une ligne…',
      'markets.remove': 'Retirer {label}',
      'markets.lastQuote': 'Dernière cotation à {time}',
      'markets.failing': 'Marchés ({time}) — en panne :',
      'markets.ok': 'Marchés à jour — {time}',
      ...prefix('metal', { XAU: 'Or', XAG: 'Argent', XPT: 'Platine', XPD: 'Palladium', HG: 'Cuivre' }),

      'sys.network': 'RÉSEAU',
      'sys.reset': 'purger',
      'sys.resetTitle': 'Purger les cumuls',
      'sys.threads': '{n} threads',
      'sys.free': '{value} libres',
      'sys.noGpu': 'pas de données GPU',
      'sys.fan': 'vent. {fan}',
      'sys.na': 'n/a',
      'sys.peak': 'pic {value}',

      'chart.loading': 'chargement…',
      'chart.empty': 'Pas de données pour cette période',
      'chart.error': 'erreur : {message}',
      ...prefix('range', {
        '1h': '1 h', '3h': '3 h', '6h': '6 h', '12h': '12 h', '24h': '24 h', '3d': '3 j', '1w': '1 sem',
        '30d': '30 j', '60d': '60 j', '90d': '90 j', '6m': '6 m', '1y': '1 an', '3y': '3 ans', '5y': '5 ans',
      }),

      'weather.title': 'Météo',
      'weather.map': 'Carte',
      'weather.openMap': 'Ouvrir la carte météo',
      'weather.pickCityTitle': 'Choisir la ville météo',
      'weather.pickCity': 'Choisir une ville',
      'weather.clickToSearch': 'Cliquer pour rechercher',
      'weather.feels': 'Ressenti {temp} °C',
      'weather.minMax': 'Min / max',
      'weather.rain': 'Pluie',
      'weather.rainProb': 'Pluie · {prob} %',
      'weather.wind': 'Vent',
      'weather.windGusts': 'Vent · raf. {gusts}',
      'weather.storm': 'Orage',
      'weather.unavailable': 'Météo indisponible',
      'weather.unknown': 'Inconnu',
      'storm.low': 'faible',
      'storm.possible': 'possible',
      'storm.high': 'fort',
      ...prefix('wmo', WMO_FR),

      'night.current': 'Nuit en cours',
      'night.next': 'Prochaine nuit',
      'night.line': '{when} : {span}, d\'après le soleil à {city}.',
      'night.until': 'jusqu\'à {time}',
      'night.theCity': 'la ville météo',
      'night.unknown': 'Heures du soleil pas encore connues (météo indisponible).',
      'night.noCity': 'Choisir une ville météo : la nuit suit son coucher et son lever du soleil.',

      'add.title': 'Ajouter une ligne',
      'add.metal': 'Métal',
      'add.fx': 'Devise',
      'add.crypto': 'Crypto',
      'add.pair': 'Ajouter la paire',

      'settings.title': 'Réglages',
      'settings.theme': 'Thème',
      ...prefix('theme', {
        dark: 'Sombre', light: 'Clair', red: 'Rouge', forest: 'Vert forêt', green: 'Vert',
        yellow: 'Jaune', purple: 'Violet',
      }),
      'settings.language': 'Langue',
      'settings.languageAuto': 'Automatique',
      'settings.screen': 'Plein écran sur…',
      'settings.windowSize': 'Résolution fenêtrée',
      'settings.zoom': 'Taille de l\'affichage',
      'settings.nightDim': 'Mode nuit · assombrir de',
      'settings.nightToggle': 'Assombrir du coucher au lever du soleil',
      'settings.city': 'Ville météo',
      'settings.citySearch': 'Rechercher une ville…',
      'settings.noCity': 'Aucune ville trouvée',
      'settings.refresh': 'Rafraîchissement des marchés',
      'settings.cover': 'Recouvrir la barre des tâches',
      'settings.autostart': 'Démarrer à l\'ouverture de session',
      'settings.sysHint': 'Le système (CPU, RAM, GPU, réseau) se met à jour chaque seconde, indépendamment de ce réglage.',

      'menu.button': 'Menu (ou clic droit)',
    },
  };

  const LANGUAGES = Object.keys(STRINGS);
  let lang = 'en';
  let formatLocale = STRINGS.en.locale;

  /**
   * Interface language and formatting locale for a setting ('auto', 'en', 'fr')
   * and the system's preferred locales (e.g. ['fr-CA', 'en-US']). The system
   * locale formats numbers and dates when it is in the interface language.
   */
  function resolve(setting, systemLocales = []) {
    const base = (l) => String(l || '').toLowerCase().split(/[-_]/)[0];
    const picked = LANGUAGES.includes(setting)
      ? setting
      : base(systemLocales.find((l) => LANGUAGES.includes(base(l)))) || 'en';
    const sameLang = systemLocales.find((l) => base(l) === picked);
    let locale = STRINGS[picked].locale;
    try {
      if (sameLang) locale = Intl.getCanonicalLocales(sameLang.replace('_', '-'))[0];
    } catch {
      /* malformed system locale: keep the default one */
    }
    return { lang: picked, locale };
  }

  function setLanguage(l, locale) {
    lang = LANGUAGES.includes(l) ? l : 'en';
    formatLocale = locale || STRINGS[lang].locale;
  }

  /** String for `key` with {name} placeholders filled; the key itself when unknown. */
  function t(key, vars) {
    const s = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  return {
    STRINGS,
    LANGUAGES,
    resolve,
    setLanguage,
    t,
    get lang() { return lang; },
    get locale() { return formatLocale; },
  };
});
