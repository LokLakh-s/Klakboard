<p align="center">
  <img src="build/logo.png" width="160" alt="Klakboard">
</p>

<h1 align="center">Klakboard</h1>

<p align="center">
  Tableau de bord marchés + monitoring système, pour petit écran secondaire.
</p>

---

Application Electron sans bandeau de fenêtre, qui vit dans la zone de
notifications et peut se projeter en plein écran par-dessus la barre des tâches
sur l'écran de votre choix. Conçue et calibrée pour une dalle de 3,6 pouces en
960 × 640 (≈ 325 PPI), mais la taille d'affichage et la résolution sont
réglables.

## Fonctions

**Marchés** — badges cliquables, chacun ouvrant une courbe plein écran sur
14 périodes (1 h → 5 ans).

- **Métaux** : or, argent, platine, palladium, cuivre
- **Devises** : n'importe quelle paire parmi 26 monnaies
- **Cryptos** : recherche parmi tout le catalogue Binance

**Système** — rafraîchi chaque seconde, indépendamment des marchés.

- Charge par cœur logique (barres colorées vert → ambre → rouge)
- RAM utilisée / totale / disponible
- GPU NVIDIA : utilisation, VRAM, ventilateur, température
- Réseau : débits instantanés, historique 90 s, cumuls purgeables

**Confort** — 7 thèmes désaturés (sombre, clair, rouge, bleu, vert, jaune,
violet), zoom de 100 à 175 %, démarrage à l'ouverture de session.

## Sources de données

Toutes gratuites et **sans clé API**. Les appels partent du processus principal :
Yahoo n'envoie aucun en-tête CORS.

| Donnée | Cotation | Historique |
|---|---|---|
| Métaux | [gold-api.com](https://api.gold-api.com) (spot réel) | Yahoo Finance, recalée sur le spot |
| Devises | Yahoo Finance (`spark`) | Yahoo Finance |
| Cryptos | Binance `ticker/24hr` | Binance `klines` |

Deux détails qui ont leur importance :

- Yahoo cote le **future** sur les métaux (`GC=F` porte ~1 % de contango sur le
  spot). Le prix affiché vient de gold-api, et la courbe est multipliée par
  `spot / dernier_close` pour finir exactement sur ce prix.
- CoinGecko a été écarté : l'API publique renvoie des `429` même à une requête
  toutes les 25 s, inexploitable pour un rafraîchissement régulier.

Un cycle complet coûte 3 types d'appels : un vers Binance (toutes les cryptos),
un vers Yahoo (tous les métaux et devises groupés), et un par métal vers
gold-api.

## Raccourcis

| | |
|---|---|
| `Ctrl+Shift+Q` | Quitter — **sortie de secours**, la fenêtre n'ayant ni bandeau ni entrée dans la barre des tâches |
| Clic sur l'icône de notification | Afficher / masquer |
| ✕ dans l'en-tête | Masquer dans la zone de notifications (ne quitte pas) |
| `Échap` | Fermer le panneau ouvert |

## Installation

Récupérez l'installeur dans les [releases](../../../releases), ou construisez-le :

```bash
npm install
npm run dist        # -> dist/Klakboard Setup 1.0.0.exe
npm start           # lancement direct, sans packager
```

L'exécutable n'étant pas signé, SmartScreen affiche un avertissement au premier
lancement : *Informations complémentaires* → *Exécuter quand même*.

## Architecture

Aucune dépendance npm à l'exécution. Les métriques système sont obtenues sans
module natif, donc rien à recompiler :

| Métrique | Méthode | Coût |
|---|---|---|
| CPU, RAM | module `os` | ~0,2 ms/s |
| GPU | `nvidia-smi` relancé toutes les 2 s | ~0,16 s par appel |
| Réseau | **un seul** processus PowerShell persistant | un spawn coûte 0,82 s, impensable chaque seconde |

```
main.js       processus principal : fenêtre, écrans, tray, IPC, config
markets.js    sources de marché et normalisation des courbes
system.js     métriques CPU / RAM / GPU / réseau
preload.js    pont IPC (contextIsolation activé)
renderer.js   rendu, badges, courbes, réglages
style.css     thèmes et échelle typographique
```

La configuration (thème, éléments suivis, cumuls réseau, position) est écrite
dans `%APPDATA%/Klakboard/dashboard.json`.

## Licence

MIT
