<p align="center">
  <img src="build/logo.png" width="160" alt="Klakboard">
</p>

<h1 align="center">Klakboard</h1>

<p align="center">
  Tableau de bord marchés, météo et monitoring système, pour petit écran secondaire.
</p>

---

Application Electron sans bandeau de fenêtre, qui vit dans la zone de
notifications et se projette en plein écran par-dessus la barre des tâches sur
l'écran de votre choix. Conçue et calibrée pour une dalle de 3,6 pouces en
960 × 640 (≈ 325 PPI) ; la taille d'affichage et la résolution sont réglables.

## Fonctions

**Marchés** — badges, trois par ligne, chacun ouvrant une courbe plein écran
sur 14 périodes (1 h → 5 ans).

- **Métaux** : or, argent, platine, palladium, cuivre
- **Devises** : n'importe quelle paire parmi 26 monnaies
- **Cryptos** : recherche parmi tout le catalogue Binance

Si une source ne répond plus, le badge garde le dernier cours connu, grisé
au-delà de trois cycles manqués, et la pastille de l'en-tête passe au rouge
(détail de la panne dans son infobulle).

**Météo** — conditions actuelles et journée à Paris (75) : température,
ressenti, min/max, pluie, vent et rafales, risque d'orage (CAPE). Un clic ouvre
la carte Windy. La carte occupe la place laissée par les badges et se compacte
quand elle manque.

**Système** — rafraîchi chaque seconde, indépendamment des marchés.

- Charge par cœur logique (barres colorées vert → ambre → rouge)
- RAM utilisée / totale / disponible
- GPU NVIDIA : utilisation, VRAM, ventilateur, température
- Réseau : débits instantanés, historique 90 s, cumuls purgeables

**Confort** — 7 thèmes désaturés (sombre, clair, rouge, vert forêt, vert,
jaune, violet), zoom de 100 à 175 %, démarrage à l'ouverture de session.

**Écran** — l'écran choisi dans *Plein écran sur…* est retenu. S'il est absent
(pas encore détecté à l'ouverture de session, débranché), la fenêtre attend
masquée au lieu de recouvrir l'écran principal, et le rejoint dès son retour.

## Sources de données

Toutes gratuites et **sans clé API**. Les appels partent du processus
principal (Yahoo n'envoie aucun en-tête CORS), avec un délai maximum de 10 s.

| Donnée | Cotation | Historique |
|---|---|---|
| Métaux | [gold-api.com](https://api.gold-api.com) (spot réel) | Yahoo Finance, recalée sur le spot |
| Devises | Yahoo Finance (`spark`) | Yahoo Finance |
| Cryptos | Binance `ticker/24hr` | Binance `klines` |
| Météo | [Open-Meteo](https://open-meteo.com) | — |

Deux détails qui ont leur importance :

- Yahoo cote le **future** sur les métaux (`GC=F` porte ~1 % de contango sur le
  spot). Le prix affiché vient de gold-api, et la courbe est multipliée par
  `spot / dernier_close` pour finir exactement sur ce prix.
- CoinGecko a été écarté : l'API publique renvoie des `429` même à une requête
  toutes les 25 s, inexploitable pour un rafraîchissement régulier.

Un cycle complet coûte 3 types d'appels : un vers Binance (toutes les cryptos),
un vers Yahoo (tous les métaux et devises groupés), et un par métal vers
gold-api.

## Utilisation

Tout passe par l'icône de la zone de notifications : clic pour afficher ou
masquer, clic droit pour le menu (ajouter une ligne, réglages, rafraîchir,
mises à jour, quitter).

| | |
|---|---|
| `Ctrl+Shift+Q` | Quitter — **sortie de secours**, la fenêtre n'ayant ni bandeau ni entrée dans la barre des tâches |
| ✕ au survol d'un badge | Retirer la ligne |
| `Échap` | Fermer le panneau ouvert |

## Installation

Récupérez l'installeur dans les [releases](../../../releases), ou construisez-le :

```bash
npm ci
npm test            # tests sous Node, sans Electron
npm run dist        # -> dist/Klakboard Setup <version>.exe
npm start           # lancement direct, sans packager
```

L'exécutable n'étant pas signé, SmartScreen affiche un avertissement au premier
lancement : *Informations complémentaires* → *Exécuter quand même*.

## Mises à jour

Klakboard vérifie les releases du dépôt toutes les 30 minutes et le signale
par une notification ; clic droit sur l'icône → *Installer la mise à jour*.
Le dépôt étant privé, il faut un token GitHub en lecture seule (Contents: read)
dans `%APPDATA%/Klakboard/github-token.txt`.

- **Même version d'Electron** : seule l'archive de l'appli
  (`app-electron<majeure>.asar`) est téléchargée, puis `updater.js` la met en
  place une fois Klakboard fermée et relance l'appli. Journal :
  `%TEMP%/klakboard-update.log`.
- **Nouvelle version d'Electron** : l'archive ne tournerait pas sur l'ancien
  moteur ; Klakboard télécharge l'installeur complet et le lance.

Chaque fichier téléchargé est contrôlé avec l'empreinte SHA-256 publiée par
GitHub. Une mise à jour est toujours exécutée par la version **installée** :
un correctif du mécanisme de mise à jour ne joue qu'à la mise à jour suivante.

Publier une version : bumper `version` dans `package.json` et pousser sur
`main`. Le workflow lance les tests, construit l'installeur et l'archive, puis
crée la release `klakboard-v<version>`. Après un push forcé, il faut le lancer
à la main (`gh workflow run "Klakboard release" --ref main`).

## Architecture

Aucune dépendance npm à l'exécution. Les métriques système sont obtenues sans
module natif, donc rien à recompiler :

| Métrique | Méthode | Coût |
|---|---|---|
| CPU, RAM | module `os` | ~0,2 ms/s |
| GPU | `nvidia-smi` relancé toutes les 2 s (retenté 30 s après un échec) | ~0,16 s par appel |
| Réseau | **un seul** processus PowerShell persistant, relancé s'il s'arrête | un spawn coûte 0,82 s, impensable chaque seconde |

```
main.js       processus principal : fenêtre, écrans, tray, IPC, config, mises à jour
display.js    choix de l'écran à recouvrir
markets.js    sources de marché et normalisation des courbes
weather.js    météo Open-Meteo et choix des icônes
system.js     métriques CPU / RAM / GPU / réseau
updates.js    recherche et téléchargement des releases
updater.js    remplacement de l'archive après fermeture (lancé hors de l'appli)
preload.js    pont IPC (contextIsolation activé)
renderer.js   rendu, badges, courbes, réglages
style.css     thèmes et échelle typographique
test/         tests node:test ; main.js y tourne avec un faux module electron
```

La configuration (thème, éléments suivis, écran, cumuls réseau, position) est
écrite dans `%APPDATA%/Klakboard/dashboard.json`, via un fichier temporaire
renommé : une coupure en pleine écriture ne la corrompt pas. Un fichier
illisible est mis de côté (`dashboard.json.illisible-<date>`), jamais écrasé.

Icônes météo : [Meteocons](https://github.com/basmilius/weather-icons) (MIT).

## Licence

MIT
