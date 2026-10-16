# Audit Klakboard — 16/10/2026 (v1.5.0, Electron 44.5.1)

Périmètre : tout le dépôt `LokLakh-s/widgets` (code, tests, workflow, historique git), en vue
d'un passage en public et d'une promotion comme « tableau de bord pour écrans additionnels ».
Chaque constat est marqué **vérifié** (lu dans le code, testé ou lu dans la doc officielle) ou
**à vérifier** (plausible, pas encore prouvé sur la plateforme concernée).

## 1. Verdict

**Oui, Klakboard est un bon candidat au public, mais pas en l'état pour la promotion annoncée.**

Points forts (vérifiés) :

- code propre et sobre : ~2 600 lignes de JS hors tests, **aucune dépendance npm à l'exécution**, aucun module
  natif à recompiler ;
- sécurité soignée : CSP stricte, `contextIsolation`, navigation et fenêtres surgissantes
  bloquées, données d'API jamais injectées en HTML, empreinte SHA-256 exigée sur les mises à jour ;
- robustesse : config écrite de façon atomique, dernier cours gardé si une source tombe,
  écran absent géré, boucle réseau relancée avec délai croissant ;
- 22 tests `node:test` qui passent (main.js testé avec un faux Electron) ;
- CI de release déjà en place (tag + release automatiques au bump de version) ;
- historique git sans secret réel (seulement de faux tokens dans les tests).

Ce qui empêche de le promouvoir tel quel :

1. **Interface uniquement en français** (textes, dates et nombres en `fr-FR` codés en dur).
2. **Mise en page calibrée pour un seul format** : paysage ~3:2 (960 × 640). Les écrans
   additionnels courants sont aussi des **barres** (1920 × 480, 1920 × 440, 2560 × 720) et des
   écrans en **portrait** : deux colonnes fixes (58 / 42 %) et trois badges par ligne n'y tiennent pas.
3. **Windows seulement**, GPU **NVIDIA seulement**.
4. **Réglages accessibles uniquement par la zone de notifications** : là où elle manque
   (GNOME sans extension), l'appli serait inutilisable.

À préciser dans la communication : Klakboard ne marche qu'avec un écran que le système voit
comme **un moniteur** (HDMI, DisplayPort, USB-C / DisplayLink). Les petits écrans « capteurs »
vendus avec leur logiciel (3,5 à 8,8 pouces pilotés en USB série, type « Turing Smart Screen »)
ne sont pas des moniteurs pour Windows.

## 2. À régler avant de rendre le dépôt public

| # | Point | Détail |
|---|---|---|
| P1 | Fichier `LICENSE` absent | `package.json` et le README annoncent MIT, mais aucun fichier de licence n'existe. GitHub affiche « No license ». |
| P2 | Runner auto-hébergé + dépôt public | GitHub déconseille les runners auto-hébergés sur un dépôt public (une PR de fork peut exécuter du code sur la machine si un workflow réagit aux PR). Le workflow actuel ne réagit qu'aux push sur `main` et au lancement manuel, donc pas de risque immédiat, mais : (a) par défaut, un groupe de runners d'organisation **refuse les dépôts publics**, la release resterait en attente ; (b) le serveur est la prod. Les runners hébergés par GitHub sont **gratuits et illimités pour un dépôt public** (c'est déjà le cas de LCDHost-Revival). |
| P3 | Données personnelles | Les 30 commits portent l'adresse e-mail personnelle de l'auteur (LCDHost-Revival a été réécrit en adresse `noreply` GitHub avant d'être publié). La ville météo par défaut (`weather.js:11`, reprise dans le README) est une commune précise avec ses coordonnées. |
| P4 | README obsolète une fois public | Section « Le dépôt étant privé, il faut un token GitHub » : plus nécessaire (voir P5). |
| P5 | Token devenu inutile | Dépôt public : l'API des releases et le téléchargement des fichiers marchent sans token (60 requêtes/h par IP, l'appli en fait ~2/h). `updates.js` sait déjà s'en passer (en-tête ajouté seulement si un token existe). `token.js` et le chiffrement DPAPI peuvent rester pour les installations existantes, puis disparaître. |
| P6 | Nom et rangement | Dépôt `widgets`, appli dans `Windows/Klakboard/` : peu trouvable, et le dossier `Windows/` devient faux si l'appli passe multiplateforme. Un dépôt renommé reste joignable par l'ancienne URL (redirection GitHub) : `REPO = 'LokLakh-s/widgets'` (`updates.js:15`) continuerait de marcher pour les versions installées. Le préfixe de tag `klakboard-v` doit rester. |

## 3. Bugs et incohérences

| # | Gravité | Où | Constat |
|---|---|---|---|
| B1 | Haute | `markets.js:74-85` | **Vérifié en direct** : une seule paire invalide dans `symbols=[…]` fait répondre Binance `400 Invalid symbol` pour **tout le lot**. Une paire retirée de la cote (déjà arrivé aux paires BUSD) grise donc toutes les cryptos. Correctif : en cas de 400, repli paire par paire et signalement de la paire fautive. |
| B2 | Moyenne | `renderer.js:475-496` | Course entre requêtes : cliquer vite sur plusieurs périodes peut afficher la courbe d'une période antérieure (la réponse la plus lente gagne). Correctif : jeton de requête, ignorer les réponses périmées. |
| B3 | Moyenne | `main.js:600`, `main.js:719` | Entrées IPC non bornées : `set-refresh` accepte n'importe quel délai (0 → appels en rafale vers les API), `add-item` stocke un objet arbitraire dont `binance` est collé tel quel dans une URL (`markets.js:196`). Risque faible (page locale sous CSP), mais à valider côté main (délai borné, symboles `[A-Z0-9]`). |
| B4 | Basse | `renderer.js:295-298` | « AMD Ryzen 9 7950X 16-Core Processor » devient « Ryzen 9 7950X 16- » (le mot « Core » est retiré, le tiret reste). |
| B5 | Basse | `renderer.js:310` / `:324` | Unités incohérentes : RAM en « GB » décimaux (÷ 10⁹), VRAM en « Go » binaires (MiB ÷ 1024). Interface mi-français mi-anglais (« threads », « libres », « vent. », « pic », « purger »). |
| B6 | Basse | `renderer.js:553` | « purger » efface les cumuls réseau en un clic, sans confirmation. |
| B7 | Basse | `main.js:71` | Fusion superficielle de la config : si `items` ou `netTotals` manquent, la config partage les objets de `DEFAULT_CONFIG` et les modifie. Sans effet aujourd'hui (chargée une fois), piège pour plus tard. |
| B8 | Basse | `system.js:198` | Hors Windows, l'intervalle de lecture réseau n'est jamais arrêté par `stop()`. |
| B9 | Basse | `renderer.js:55-61` | `fmtRate` nomme `bits` une valeur en octets (l'affichage est juste). |
| B10 | Cohérence | tout le code | Commentaires et messages d'erreur en français, sans accents, souvent narratifs (« c'était des centaines d'écritures… »). Pour un dépôt public et selon la règle du code en anglais : commentaires et logs en anglais, courts ; les chaînes d'interface passent dans les traductions. |

## 4. Optimisations

| # | Gain | Proposition |
|---|---|---|
| O1 | CPU (Windows) | `nvidia-smi` est relancé toutes les 2 s (`system.js:63`, ~0,16 s par lancement). `nvidia-smi --query-gpu=… --format=csv,noheader,nounits -lms 2000` garde **un seul processus** qui écrit une ligne toutes les 2 s, comme la boucle PowerShell du réseau. |
| O2 | CPU (Windows) | La boucle réseau interroge `Get-NetAdapterStatistics` (requête CIM/WMI) chaque seconde. `[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()` lit les mêmes compteurs sans WMI. À mesurer avant de changer. |
| O3 | Inutile en arrière-plan | Fenêtre masquée : le main envoie quand même un échantillon par seconde et la page le dessine. Les cumuls réseau doivent continuer, pas l'envoi ni le dessin. |
| O4 | Maintenance | Trois traceurs de courbe séparés (`drawSpark`, `drawNetSpark`, `drawChart`) et `keyOf`/`labelOf` dupliqués entre `markets.js` et `renderer.js`. Un module de courbe commun prépare les vues détaillées (§ 8). |
| O5 | Lisibilité | `renderer.js` (820 lignes) mélange marchés, système, météo, réglages et courbes. La CSP autorise les modules locaux (`<script type="module">`) : un fichier par panneau. |

Pas d'optimisation lourde nécessaire : un cycle de marchés = 1 appel Binance + 1 appel Yahoo +
1 appel gold-api par métal, toutes les 20 s ; le reste est négligeable devant le coût d'Electron
lui-même (~150 à 300 Mo de RAM, **à vérifier** sur la machine).

## 5. Ce qui manque

**Pour un public** : traductions (au moins anglais et français, choisies d'après la langue du
système), choix de la ville météo au premier lancement, accès aux réglages depuis la fenêtre
(bouton ou clic droit), captures d'écran et GIF dans le README, `CHANGELOG`, `CONTRIBUTING`,
modèles d'issues.

**Pour la qualité** : tests lancés à **chaque** push (aujourd'hui ils ne tournent que lors d'une
release, donc jamais sans bump de version), un linter (ESLint), Dependabot (npm + actions),
actions épinglées par empreinte, tests du rendu (Playwright, déjà utilisé à la main).

**Fonctions attendues sur ce type de tableau de bord** : température CPU (facile sous Linux via
`/sys/class/hwmon` ; sous Windows elle exige un pilote en mode noyau et les droits admin, donc
**à écarter** pour l'instant), disques (occupation, débit), plusieurs GPU, GPU AMD et Intel.

**Sources de données** :

- Binance (`api.binance.com`) refuse certains pays (dont les États-Unis). Pour les seules données
  de marché, Binance documente `https://data-api.binance.vision` (**vérifié** dans la doc
  officielle et testé : même réponse).
- Yahoo Finance est une API non officielle : elle peut changer ou bloquer sans préavis, et le
  risque grandit avec le nombre d'utilisateurs. À dire dans le README, et garder le repli sur le
  dernier cours connu.

## 6. Multiplateforme

**Oui, c'est faisable** : Electron tourne partout et rien n'est natif. Environ 70 % du code est
déjà portable tel quel : `renderer.js`, `markets.js`, `weather.js`, `display.js`, la page et le
style. Le reste :

| Sujet | Windows | macOS | Linux |
|---|---|---|---|
| Icône de notification | `.ico` OK | **Invisible** : `.ico` n'est lu que sous Windows (doc Electron, vérifié) ; il faut un PNG « template » | **Invisible** (même raison) ; en plus, GNOME n'a pas de zone de notifications sans l'extension AppIndicator |
| `setAppUserModelId` (`main.js:513`) | OK | Réservé à Windows (types officiels) : à protéger par un test de plateforme, sinon risque de plantage au démarrage | idem |
| Recouvrir un écran précis (`setBounds` + `setAlwaysOnTop`) | OK | OK (niveau `screen-saver`), masquer l'icône du Dock (`app.dock.hide()`) | **Impossible en Wayland natif**, le mode par défaut depuis Electron 38 (vérifié) : positionnement et « toujours au-dessus » non pris en charge. Forcer XWayland (`--ozone-platform=x11`) |
| Raccourci de secours `Ctrl/Cmd+Shift+Q` | OK | `Cmd+Shift+Q` = « Fermer la session » de macOS : en choisir un autre | Raccourcis globaux indisponibles en Wayland natif |
| Démarrage à l'ouverture de session | OK | OK | `setLoginItemSettings` ne gère pas Linux : écrire `~/.config/autostart/klakboard.desktop` |
| CPU | OK | OK | OK |
| RAM | OK | **Faux** : `os.freemem()` ne compte que les pages libres (vérifié dans libuv), la RAM paraîtrait pleine en permanence ; lire `vm_stat` | OK (`MemAvailable`) |
| Réseau | Boucle PowerShell | **Rien** : ni PowerShell ni `/proc` ; un seul `netstat -ib -w 1` persistant, **à vérifier** | `/proc/net/dev` OK (exclure aussi `tun`, `wg`, `tailscale` pour ne pas compter deux fois le trafic d'un VPN) |
| GPU | NVIDIA seulement ; tous fabricants via les compteurs `GPU Engine`, **à mesurer** | `ioreg` (puces Apple, AMD), **à vérifier** | NVIDIA via `nvidia-smi`, AMD via `/sys/class/drm/card*/device/gpu_busy_percent` |
| Police | Segoe UI | Absente : métriques différentes, risque de débordement aux tailles calibrées | idem. Embarquer Selawik (libre, mêmes métriques que Segoe UI) en repli garderait l'aspect Windows et les mêmes mesures ailleurs |
| Mise à jour intégrée | Remplacement d'`app.asar` + installeur NSIS | Remplacer `app.asar` dans le `.app` casse sa signature ; la mise à jour officielle (Squirrel.Mac) exige une app signée Apple | AppImage en lecture seule : remplacement impossible |
| Paquet | NSIS | `.dmg`, à construire sur un Mac (runner GitHub) | AppImage + `.deb` |
| Signature | Absente → avertissement SmartScreen | Absente → Gatekeeper bloque au premier lancement (clic droit → Ouvrir) ; signer = compte Apple Developer, 99 $/an | Sans objet |

Proposition pour la mise à jour hors Windows : **notifier et ouvrir la page de la release**,
sans installation automatique. Option plus large : passer à `electron-updater` (standard,
vérifie un SHA-512, gère NSIS en silencieux et AppImage), au prix d'une première dépendance
d'exécution et de la réécriture du mécanisme actuel. Elle ne règle pas macOS sans signature.

## 7. CI/CD

**Existant** (`.github/workflows/klakboard-release.yml`) — fait déjà l'essentiel de la demande :

- déclenchement au push sur `main` (chemins `Windows/Klakboard/**`) et à la main ;
- si `version` n'a pas de release `klakboard-v<version>` : tests, build NSIS + archive dans
  un conteneur `electronuserland/builder:wine`, puis **tag et release créés automatiquement**
  sur le commit construit ;
- sans bump : rien n'est publié (et rien n'est testé, voir § 5).

**Manques** : tests à chaque push et sur les PR ; notes de release (le texte est fixe, aucun
changelog) ; image Docker non épinglée (`:wine` bouge) ; actions non épinglées par empreinte ;
Windows seulement ; pas de fichier d'empreintes (`SHA256SUMS`) ni d'attestation de provenance.

**Cible proposée si le dépôt devient public** (runners GitHub, gratuits pour un dépôt public) :

1. `ci.yml` — à chaque push et PR : `npm ci`, lint, tests, sous Linux. Sans secret : sans risque
   pour les PR de forks.
2. `release.yml` — au push sur `main` avec un nouveau numéro de version (même règle qu'aujourd'hui) :
   - matrice de builds natifs : Windows (NSIS + `app-electron<majeure>.asar`), macOS (`.dmg`
     arm64 + x64), Linux (AppImage + `.deb`), sans Wine ;
   - une tâche finale crée le tag et la release, avec les notes générées depuis les commits
     depuis le tag précédent, `SHA256SUMS` et l'attestation de provenance GitHub
     (`actions/attest-build-provenance`, gratuite en public) ;
   - les noms des fichiers Windows ne changent pas : les versions installées continuent de se
     mettre à jour.

## 8. Plus tard : grands écrans et vues détaillées

À préparer dès maintenant pour ne pas tout refaire :

- **Historique côté main** : tampons circulaires par mesure (par cœur, GPU, réseau), par exemple
  1 h à 1 s. 32 cœurs × 3 600 points tiennent dans un `Float32Array` de ~460 Ko. La vue détaillée
  s'ouvre alors avec son historique au lieu d'une courbe vide. Aujourd'hui seul le réseau a un
  historique (90 s, côté page).
- **Un composant de courbe commun**, en `<canvas>` pour les séries rafraîchies chaque seconde
  (32 courbes en SVG redessinées chaque seconde coûteraient cher), avec axe du temps, réticule et
  infobulle. La courbe des marchés n'a d'ailleurs pas d'axe du temps aujourd'hui.
- **Modes de mise en page** choisis d'après la taille et le format de la fenêtre (requêtes de
  conteneur, déjà utilisées pour la météo) : *compact* (l'actuel), *barre* (≥ 3:1), *portrait*,
  *large* (écran normal : plus de détails et de courbes).
- **Sources système par plateforme** (`system/win.js`, `mac.js`, `linux.js`) derrière une seule
  forme d'échantillon, qui prévoit plusieurs GPU et des mesures optionnelles (températures, disques).

## 9. Ordre proposé

1. **Publication propre** : `LICENSE`, README à jour (sans token, avec captures), historique en
   adresse `noreply`, ville par défaut neutre ou demandée au premier lancement, CI de tests sur
   runner GitHub. Correctifs B1 à B4.
2. **Promotion Windows** : traductions EN/FR, accès aux réglages dans la fenêtre, modes *barre* et
   *portrait*, GPU tous fabricants (Windows), traduction des commentaires.
3. **macOS et Linux** : sources système par plateforme, icônes, XWayland, démarrage auto,
   paquets, mise à jour par notification, matrice de builds.
4. **Grands écrans** : historique côté main, composant de courbe, vues détaillées CPU (par cœur),
   GPU et réseau au clic, mode *large*.
