# Feuille de route — multi-plateformes & monétisation

> Objectif : porter AutoStar Droid au-delà d'Android (Windows Store en priorité)
> et en tirer un peu de revenus, sans casser le projet ni sa licence.

## Situation de départ (atouts)

- **Cœur 100 % TypeScript pur et portable** : protocole Meade (`services/protocol`),
  astronomie (`services/astro`), catalogues (`services/catalog`), profils — aucune
  dépendance Android. Réutilisable tel quel sur toute plateforme JS.
- Ce qui est spécifique Android : les transports (USB-série, Bluetooth SPP via
  modules Kotlin), TCP (react-native-tcp-socket), l'UI (écrans RN).
- Marché prouvé : ScopeBoss vend un émulateur Autostar II à ~30 $ sur iOS.
  Niche fidèle (astronomes équipés Meade), faible concurrence directe sur
  Windows/Android, où SkySafari/Stellarium font planétarium mais **pas
  émulation de raquette ni console série**.

## Étape 0 — Fondations (fait / à faire maintenant)

| Sujet | État | Action |
|---|---|---|
| Licence | ✅ Propriétaire source-available (`LICENSE.md`) — droits commerciaux réservés | — |
| Marques | ⚠️ « AutoStar » est une marque Meade | Pour les boutiques, viser un nom distinctif (ex. « ScopeMate », « HandBox Pro ») et garder « Compatible Meade Autostar » en descriptif (fair use nominatif) |
| Clé de signature | ⚠️ APK actuel signé clé debug | Générer une **vraie clé de release**, sauvegardée (coffres) — indispensable avant Play Store |
| Comptes développeur | À faire | Microsoft Store : 19 $ (une fois) · Google Play : 25 $ (une fois) · Apple : 99 $/an |

## Étape 1 — Windows (chemin recommandé : cœur TS + coquille bureau)

Deux approches possibles :

**A. Web + bureau (recommandée)** — react-native-web ou React + **Tauri ou Electron** :
- **USB-série** : API Web Serial (Chrome/Edge) ou `serialport` (Electron) — les
  pilotes FTDI/PL2303/CP210x/CH340 **existent déjà sous Windows**, zéro driver à écrire.
- **TCP Wi-Fi** : sockets complets en bureau (node `net` / Rust) — même code que l'app.
- **Bluetooth SPP** : Windows expose les SPP en ports COM sortants → lisible via
  `serialport`. Le plus délicat reste l'appairage (dialogue système).
- **Packaging** : Tauri/Electron → **MSIX → Microsoft Store** (chemin éprouvé,
  de nombreuses apps Electron sont certifiées).
- Effort : réécrire l'UI (~8 écrans) ; le cœur métier est réutilisé à ~90 %.
  Ordre de grandeur : quelques semaines de travail sérieux.

**B. React Native Windows (RNW)** — UI RN réutilisée quasi telle quelle, mais :
tous les modules natifs (USB, BT, TCP) doivent être réécrits en C++/WinRT ;
RNW suit RN 0.75 de près. Effort plus élevé, bénéfice : une seule base d'UI.

> Décision suggérée : voie A d'abord (time-to-store minimal), voie B si l'on
> veut à terme une base unique.

## Étape 2 — Google Play

- L'APK actuel est quasi prêt (cible SDK 34) : créer le compte (25 $), la fiche
  (captures FR/EN), la clé de release dédiée + Play App Signing, rouler la CI.
- Attention : Play exige depuis 2024 que les APK ciblant les nouveaux SDK soient
  en **AAB** ; la CI peut produire `bundleRelease` en plus d'`assembleRelease`.

## Étape 3 — autres plateformes

- **macOS** : même coquille Tauri/Electron que Windows ; notarisation Apple
  (99 $/an). USB-série OK, SPP via IOBluetooth.
- **Linux** : AppImage/Flatpak, Flathub gratuit — peu d'effort en plus via voie A.
- **iOS** : le plus dur — pas d'accès SPP ni USB-série pour les apps tierces
  (sauf MFi) ; seul le **Wi-Fi TCP** fonctionnerait. À garder en dernier.

## Monétisation réaliste

| Modèle | Faisabilité | Remarque |
|---|---|---|
| **Achat unique boutique** (5–15 €) par plateforme | ★★★ | Simple à gérer ; le GitHub source-available reste le canal communautaire (usage perso gratuit), la version boutique apporte auto-màj + support + simplicité |
| **Freemium** (gratuit + fonctions pro : catalogues étendus, tour du ciel avancé, export de session) | ★★ | Revenus plus réguliers mais code à gérer en deux niveaux |
| **Dons** (GitHub Sponsors, Ko-fi) | ★★ | Faible revenu, zéro friction, bon complément |
| Abonnement | ☆ | Inadapté à cette niche et à cet usage (sorties ponctuelles) |

Positionnement honnête : niche de quelques milliers d'utilisateurs potentiels
dans le monde (détenteurs de Meade Autostar/LX). Un achat unique à ~10 € avec
une conversion de quelques % peut représenter un complément, pas un salaire —
sauf succès inattendu. Les frais de boutiques (15-30 %) s'appliquent.

## Garde-fous

1. **Ne pas utiliser la marque Autostar dans le nom produit** des boutiques.
2. Garder dans le README la mention d'indépendance (Meade, ScopeBoss) — déjà en place.
3. Toute contribution extérieure reste couverte par la clause de `LICENSE.md` §3
   (licence rétrocessive), ce qui permet la monétisation sans ambiguïté.
4. La clé de release ne vit **jamais** dans le dépôt git ni sur le Drive public.
