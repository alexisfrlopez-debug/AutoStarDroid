# AutoStar Droid

**Clone Android complet de ScopeBoss** — émulateur de raquettes Meade Autostar II et Autostar (#497/#495/#494) pour télescopes Meade LX200GPS, LX90, ETX…

Application React Native (TypeScript) — package `com.autostardroid` — Android 7.0+ (minSdk 24).

[![Build APK](https://github.com/USERNAME/AutoStarDroid/actions/workflows/android.yml/badge.svg)](../../actions/workflows/android.yml)

## Fonctionnalités

| Domaine | Détail |
|---|---|
| **Liaisons** | Wi-Fi TCP (IP + port, ponts type StarGPS/Meade Wi-Fi), Bluetooth SPP (HC-05/06, cordon BT Meade), **USB-série** (câble Meade #505/#507, FTDI, Prolific PL2303, SiLabs CP210x, WCH CH340 via OTG), **mode Démo** (Autostar II entièrement simulé) |
| **Modèles** | Autostar II #497 (LX200GPS/RMS), Autostar #497 (ETX/LX90), #495, #494, LX200 classique — profils de commandes adaptés, séquence ESC ESC automatique pour les #49x |
| **Visserie** | Pad directionnel N/S/E/O (maintenir = bouger), 4 vitesses Guide/Center/Find/Slew (`:RG/:RC/:RM/:RS`), mise au point `:F±` |
| **GoTo** | Catalogues **Messier (110 objets)**, **NGC célèbres (79)**, **95 étoiles nommées**, **planètes calculées** (éphémérides basse précision, Soleil→Neptune), **Tour du ciel** trié par hauteur, recherche globale |
| **Alignement** | Modes Alt-Az / Polaire / Terrestre (`:AA/:AP/:AL`), parcours guidé Easy/Une étoile/Deux étoiles avec SYNC (`:CM`) |
| **Sync téléphone → raquette** | Envoi automatique date (`:SC`), heure (`:SL`), fuseau (`:SG`), latitude (`:St`) et longitude (`:Sg`) depuis le GPS et l'horloge du téléphone — réglage demandé par ScopeBoss mais absent de beaucoup d'apps |
| **Raquette virtuelle** | Émulation LCD 2×16 + clavier Autostar II (MODE/ENTER/GOTO/flèches) avec arborescence de menus reliée au protocole |
| **Console** | Journal du trafic série temps réel (commandes envoyées/reçues) |
| **Langue** | Bilingue français / anglais, commutable dans Réglages |
| **Vision nocturne** | Palette rouge plein écran (préserve l'adaptation oculaire) |

## Installation rapide (APK précompilé)

1. Télécharger le dernier APK depuis la page [Releases](../../releases).
2. Autoriser « Installer des applications inconnues » pour votre navigateur / gestionnaire de fichiers.
3. Installer l'APK (signé avec la clé debug — pas besoin de Play Store).
4. Lancer **AutoStar Droid**, onglet **Connexion** : choisir le modèle de raquette puis la liaison.

> APK signé en clé debug : réinstallable par-dessus une installation du même signataire.

## Utilisation

- **Mode Démo** : connectez-vous en « Démo » pour tout tester sans télescope — le télescope simulé bouge réellement (suivi sidéral, vitesses, horizon, GOTO, alignement).
- **Wi-Fi** : reliez le téléphone au pont Wi-Fi du télescope (ex. `192.168.4.1`), ports usuels 4030/5475/11880.
- **Bluetooth** : appairez d'abord l'adaptateur dans Android, puis rafraîchissez la liste dans l'app.
- **USB** : branchez le câble Meade USB-série via OTG, appuyez sur « Rechercher les périphériques USB », accordez la permission, 9600 bauds.
- **Autostar #497/#495/#494** : l'app envoie automatiquement `ESC ESC` pour passer la raquette en mode PC série — mettez la raquette sous tension **avant** de connecter.

## Compilation depuis les sources

Prérequis : Node ≥ 18, JDK 17 (complet, avec `jlink`), SDK Android (platform 34, build-tools 34.0.0), NDK 26.1.10909125, CMake 3.22.1, Gradle 8.8.

```bash
npm install
npm run build:apk        # APK : android/app/build/outputs/apk/release/app-release.apk
# ou pour le dev : npm start  +  npm run build:apk:debug
```

`scripts/build_env.sh.example` montre les variables d'environnement attendues (`ANDROID_HOME`, `JAVA_HOME`).

### Clé de signature

Le dépôt ne contient pas de keystore (bonne pratique). Au premier build, Android
demande `android/app/debug.keystore` ; générez le vôtre :

```bash
keytool -genkeypair -v -keystore android/app/debug.keystore \
  -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"
```

Pour publier des mises à jour sur un appareil déjà installé, réutilisez **le même
keystore** que la version précédente (sinon : désinstallation obligatoire).

### CI GitHub Actions

Le workflow [.github/workflows/android.yml](.github/workflows/android.yml) compile
l'APK release à chaque `push` sur `main` et à chaque tag `v*` (artefact téléchargeable ;
les tags produisent une Release). La CI génère son propre keystore debug — les APK de
CI sont destinés au test, pas aux mises à jour sur un appareil existant.

## Régénération des catalogues

Les catalogues (`src/services/catalog/*.ts`) sont générés depuis OpenNGC et HYG puis
vérifiés (<0.1°). Pour les régénérer ou les étendre :

```bash
python3 scripts/gen_catalogs.py       # télécharge + génère + vérifie
python3 scripts/validate_catalogs.py  # contre-vérification indépendante
```

## Architecture du code

```
src/
  services/connection/   Transports : TCP, Bluetooth SPP, USB-série, Démo (+ base64 Hermes)
  services/protocol/     Client Meade/LX200 (queue série, écho, ESC ESC), profils, télescope simulé
  services/astro/        Jour julien, TSL, RA/Dec↔Alt/Az, éphémérides planétaires (Schlyter)
  services/catalog/      Messier 110, NGC 79, étoiles 95 (OpenNGC/HYG, vérifiées <0.1°)
  services/phone/        GPS du téléphone (permissions gérées)
  store/                 Zustand persistant (réglages, état télescope)
  screens/               Connect, Main, Slew, Objects, Align, Setup, Handbox, Console
  i18n/                  fr.ts / en.ts
android/ .../usb/        Module natif Kotlin (usb-serial-for-android, JitPack)
android/ .../bt/         Module natif Kotlin SPP (UUID 00001101-…)
```

Protocole : voir `docs/PROTOCOLE.md`.

## Crédits & sources de données

- Concept : clone non-commercial de **ScopeBoss** (iOS), l'excellent émulateur Autostar II de N. Olsen.
- Coordonnées : [OpenNGC](https://github.com/mattiaverga/OpenNGC) (CC-BY-SA-4.0), [HYG v4.4](https://codeberg.org/astronexus/hyg) (CC-BY-SA-4.0), contre-vérification d3-celestial.
- Drivers USB : [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) (MIT).
- Éphémérides : formules de Paul Schlyter (domaine public).

*Projet d'amateur, sans affiliation avec Meade Instruments ni l'auteur de ScopeBoss.*
