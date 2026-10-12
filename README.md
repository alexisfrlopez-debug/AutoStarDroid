# AutoStar Droid

**Émulateur Android de raquettes Meade Autostar II et Autostar (#497/#495/#494) / LX200** — l'équivalent de ScopeBoss sur Android : une implémentation indépendante, écrite de zéro, pour télescopes Meade LX200GPS, LX90, ETX…

Application React Native (TypeScript) — package `com.autostardroid` — Android 7.0+ (minSdk 24).

[![Build APK](https://github.com/alexisfrlopez-debug/AutoStarDroid/actions/workflows/android.yml/badge.svg)](https://github.com/alexisfrlopez-debug/AutoStarDroid/actions/workflows/android.yml) · [Feuille de route multi-plateformes](ROADMAP.md)

## Fonctionnalités

| Domaine | Détail |
|---|---|
| **Liaisons** | Wi-Fi TCP (IP + port, ponts type StarGPS/Meade Wi-Fi), Bluetooth SPP (HC-05/06, cordon BT Meade), **USB-série** (câble Meade #505/#507, FTDI, Prolific PL2303, SiLabs CP210x, WCH CH340 via OTG), **mode Démo** (Autostar II entièrement simulé) |
| **Modèles** | Autostar II #497 (LX200GPS/RMS), Autostar #497 (ETX/LX90), #495, #494, LX200 classique — profils de commandes adaptés, séquence ESC ESC automatique pour les #49x |
| **Clavier auto** | Le firmware de la raquette est détecté via l'onglet **Connexion** (`:GVP#`/`:GVN#`) et le clavier de la raquette virtuelle **s'organise et se mappe automatiquement** : rangées, étiquettes secondaires, comportement des chiffres et touches dédiées (LX200 : MODE/ENTER/PREV/NEXT, FOCUS maintenues, RÉTICULE, SPEED). La **configuration optimale est appliquée automatiquement** (modèle détecté → profils, menus, clavier ; le choix manuel reste le secours) — carte « Micrologiciel détecté » dans l'onglet Connexion : produit, version, capacités actives, bouton **Redétecter** |
| **Raquette** | Interface unique du matériel (remplace l'ancien onglet « Visserie ») : pad directionnel N/S/E/O (maintenir = bouger), 4 vitesses Guide/Center/Find/Slew (`:RG/:RC/:RM/:RS`), mise au point `:F±`, pilule ■ STOP pendant un mouvement, pilule SYNCHRO |
| **GoTo** | Catalogues **Messier (110 objets)**, **NGC célèbres (79)**, **95 étoiles nommées**, **planètes calculées** (éphémérides basse précision, Soleil→Neptune), **Tour du ciel** trié par hauteur, recherche globale |
| **Alignement** | Modes Alt-Az / Polaire / Terrestre (`:AA/:AP/:AL`), parcours guidé Easy/Une étoile/Deux étoiles avec SYNC (`:CM`) ; **RECALAGE PAR TÉLÉMÉTRIE DU TÉLÉPHONE (v1.9.0)** : téléphone solidaire du tube → on pointe un objet (étoile du catalogue ou AD/DEC manuel), on le centre dans l'oculaire, **Valider** enregistre l'orientation du téléphone (rotation vector : gyroscope + accéléromètre + magnétomètre, quaternion brut émis par le module natif) et les coordonnées de l'objet ; un fit de rotation **Wahba/Kabsch** (SVD via Jacobi 3×3, modèle `s = W·R(q)·o` : axe optique fixe dans le repère téléphone + correction fixe du biais magnétique) recalcule en continu le **pointage réel** (AD/DEC + hauteur/azimut), son **écart avec la position crue par la raquette** (minutes d'arc), et la **RMS par point** ; 2-3 points répartis du ciel corrigent le biais magnétique ; points persistants (AsyncStorage) ; option **synchroniser la raquette** (`:Sr/:Sd` puis `:CM#`) à chaque validation ; bouton GPS → site ; **BOUTON POSITION HOME (v2.1.1)** : ancrage mécanique répétible — tube placé dans sa position Home connue (polaire : vers le pôle céleste, hauteur = latitude ; Alt-Az : horizontal vers le nord/sud, position de départ de l'alignement facile Meade), un appui enregistre la télémétrie du téléphone avec la direction ciel **théorique** de cette position → **point d'alignement immédiat, sans centrer d'étoile** (le biais magnétique est absorbé par la matrice W du recalage) ; un nouveau point Home **remplace** l'ancien (revalidation à chaque session) |
| **Convention Meade Est/Ouest corrigée (v2.2.1)** | **L'app inversait Est et Ouest pour la raquette** : le protocole Meade (révision 2010.10, cf. LX200CommandSet / driver INDI) exprime la longitude avec **l'EST NÉGATIF** (`:Sg-002*21` pour Paris) et le fuseau `:SG` comme les heures à **ajouter à l'heure locale pour obtenir UTC** (`-02.0` en France été) — l'app envoyait les valeurs cartographiques brutes (`+002*21` = « 2°21' OUEST » pour la raquette, `+02.0`) : TSL décalé, pointage AD décalé de 2×lon. Corrigé dans les DEUX SENS : envoi (`:Sg` Est-négatif DDD*MM, `:SG` UTC−local) et **lecture** (`:Gg#` accepte la forme signée et la forme 0-360 Ouest, `:GG#` reconverti) ; un **refus explicite de la raquette (`"0"`)** est désormais journalisé (Console, badge WRN) — avant, un site refusé passait inaperçu ; le cerveau DÉMO modélise la même convention (aller-retour verrouillé par tests) + correction d'un bug d'unité fuseau de la démo |
| **Monture DS-114 (v2.2.1)** | La raquette réglée « DS-114 » n'était **ni détectable ni choisissable** — précision importante : **Meade ne transmet PAS la monture choisie dans la raquette** (`:GVP#` identifie la RAQUETTE #497, pas la monture ; la « détection » n'est qu'une hypothèse) — la carte Monture l'explique désormais clairement et ajoute le preset **« DS-114 / série DS »** (alt-az en fourche, butées 0→88°, slew ≈ 3,5°/s, jeu de pignons supérieur à l'ETX) : le **choix manuel fait foi** pour les butées du diagnostic, les taux et le jeu de départ |
| **Sync téléphone → raquette (v2.1.2)** | Envoi date (`:SC`), heure (`:SL`), fuseau (`:SG`), latitude (`:St`) et longitude (`:Sg`) depuis le GPS et l'horloge du téléphone — **AUTOMATIQUE à chaque connexion** (défait réglage d'usine faussant suivi et éphémérides, réglable « Mise à jour auto de la raquette » dans Réglages, journalisé, tolérant aux raquettes muettes) + bouton manuel ; **GPS robuste (v2.1.2)** : permission approximative (coarse) acceptée — Android 12+ permet de n'accorder qu'elle (l'exigence de la précision fine refusait une position pourtant obtenable) — double tentative **GPS 18 s puis repli RÉSEAU 10 s** (Wi-Fi/antennes : un fix même en intérieur), message dédié par cause (permission / services OFF / délai / indisponible) |
| **Suivi télémétrique — boucle fermée (v2.0.0)** | Recherche de **n'importe quel objet** dans l'écran Alignement (planètes/Lune/Soleil calculés + Messier/NGC/étoiles, requête globale), puis **suivi en boucle fermée par la télémétrie du téléphone** : l'app compare en continu le pointage réel (fit Wahba/Kabsch) à la position théorique de l'objet (recalculée à chaque tick pour les planètes/Lune), et corrige les moteurs par impulsions fines `:Mn#:Ms#:Me#:Mw#` — durée calculée sur les taux mesurés, amortissement 60 %, plafond 3 s, seuil mort 2′, **anti-backlash automatique** au changement de sens, **auto-apprentissage du sens des axes** (si une correction aggrave l'erreur, le sens est inversé et mémorisé) ; GOTO + **centrage fin télémétrique** (convergence < 1,5′) + SYNC raquette (`:Sr/:Sd` + `:CM#`) ; badge de suivi live dans l'en-tête de tous les écrans ; sécurité : STOP systématique à l'arrêt et si la connexion tombe |
| **Auto-calibrage des moteurs (v2.0.0)** | La monture se calibre **elle-même** grâce au gyroscope brut du téléphone (nouveau flux natif 20 Hz, sans lissage du rotation vector) : mesure des **taux réels N/S/E/W** à la vitesse choisie (biais gyro soustrait, bruit affiché), mesure du **backlash AD et DEC** (amorçage → pause → inversion, premier mouvement soutenu au gyro → angle de jeu en ″), mesure de la **dérive de suivi** vs taux sidéral (15,041″/s) ; résultats **persistés** (AsyncStorage) et appliqués aux impulsions du suivi — la raquette affiche le calibrage et les sens appris |
| **Diagnostic moteur complet (v2.1.0 → v2.2.0)** | **UN bouton dans l'onglet Alignement** lance de manière **autonome une série complète de 10 tests télémétriques** (≈ 6 min) : pré-contrôles (biais gyro, bruit ambiant), **calibration moteur** (taux réels N/S/E/W → raquette), **ratio de chaque axe** (taux réel/théorique en % + linéarité de l'échelle de vitesses center↔find↔**slew** — impulsion slew courte 1,2 s avec chien de garde), **backlash AD/DEC** (→ raquette), **précision moteur** (répétabilité de 5 impulsions identiques), **train d'engrenages** (profil du taux par bins : oscillation crête-à-crête, RMS, blocages — **chien de garde butée v2.2.0 : la jambe s'interrompt si le tube bloque**), **min/max élévation — REDESSINÉ v2.2.0 (la v2.1.0 n'atteignait jamais la butée : 15 s à la vitesse center ≈ 1,2° de course !)** : approche en **DEUX ÉTAGES** (vitesse find jusqu'à ralentissement détecté, puis vitesse center jusqu'à l'**ARRÊT SOUTENU** confirmé 2,5 s commande maintenue), course **bornée par le preset de monture** (garde calculée sur la distance restante), altitude limite recoupée à `:Ga#` après l'arrêt, cas « déjà en butée » reconnu, statuts hit ✓ affichés ; **précision de pointage GOTO (v2.2.0)** : GOTO une étoile brillante, attente d'arrivée `:D#`, erreur résiduelle mesurée par le recalage télémétrique (< 5′ OK / < 15′ attention) ; **dérive du suivi** ; **MISE À JOUR DE LA RAQUETTE PHYSIQUE en fin de série (v2.2.0)** : horloge/site + **rétro-jeu AD/DEC poussé dans les menus de la raquette** (navigation `:EK#` vérifiée au miroir `:ED#`, valeur déduite du jeu mesuré ~20″/% — best-effort, sortie de secours par MODE, raquette toujours rendue à son accueil) ; progression en direct, bouton **ABORT** (`:Q#` immédiat), rapport **persisté** avec statut par test, `:Q#` de sécurité au lancement/entre les tests/à la fin, bouton manuel « Mettre à jour la raquette » |
| **Précision télémétrique + monture (v2.2.0)** | **Bascule « Précision par télémétrie »** dans le panneau de suivi : quand elle est ACTIVÉE, chaque pointage terminé (GOTO lancé par l'app **ou par la raquette physique** — surveillance `:D#` commune) déclenche automatiquement un **réglage fin télémétrique** : mesure de l'erreur (fit Wahba + gyro), corrections moteur par impulsions (taux mesurés, anti-backlash, signes appris), puis **VALIDATION UTILISATEUR** — « Valider et enregistrer » ajoute un **point d'alignement télémétrique** pour l'objet (aucun mouvement : les paramètres du recalage s'améliorent à chaque validation), « Ignorer » referme ; sous 2′ d'erreur, rien ne bouge ; **CARTE MONTURE dans l'onglet Alignement** : preset de monture **déduit automatiquement de la raquette détectée** (ETX-90/105/125, LX90, LX200/Autostar II, générique — butées mécaniques, taux attendus, jeu typique, Alt-Az/polaire) et **choix manuel** si la détection se trompe — le preset borne le test des butées (garde = course réelle) et sert de base aux ratios |
| **Carte du ciel interactive (v2.3.0)** | Nouvel onglet **« Ciel »** : **projection gnomonique** de la voûte centrée sur ce que voit le TÉLESCOPE (position raquette lue en continu), à défaut sur l'orientation du téléphone (télémétrie), à défaut pan manuel au doigt ; **champ chercheur 5° avec réticule** (cercle de champ VRAI, même en vue dézoomée 15°/45° pour choisir une cible), **bascule « miroir chercheur »** (image inversée par l'optique — comparaison directe avec l'oculaire), étiquettes des objets brillants, boussole E/O ; **sélection tactile d'un objet** (étoiles nommées, Messier, NGC célèbres, planètes calculées) → fiche (AD/DEC, hauteur/azimut, magnitude) → **GOTO** ou cible de suivi ; vision de nuit respectée (thème sombre/rouge de l'app) |
| **Contrôle croisé GOTO : télémétrie vs moteurs (v2.3.0)** | Pendant chaque GOTO lancé par l'app, un **moniteur** collecte en direct les deux vérités du même slew : le **gyroscope brut** (solidaire du tube → mouvement RÉEL des moteurs, chemin angulaire intégré) et le **rotation vector** (orientation absolue → arc reconstruit par la télémétrie) ; la **garde de fluidité** vérifie que la télémétrie est **suffisamment fluide pour s'y caler** : trous d'échantillonnage (> 2,5× l'intervalle nominal), bruit relatif (écart-type/moyenne des pas > 80 %), sauts aberrants magnétiques (> 6× le pas médian), flux figé, et **concordance des arcs** (ratio télémétrie/moteurs dans 0,5–2,0) — la carte du ciel affiche les deux arcs en live puis le **verdict** (fiable / instable + raisons lisibles) ; si la télémétrie est jugée INSTABLE, le **réglage fin automatique est BLOQUÉ** (état « unreliable », bannière dédiée) : aucune impulsion moteur n'est envoyée sur la foi d'une boussole qui décroche — la sécurité demandée : « la télémétrie peut être faussée ou avoir des problèmes de sensibilité » |
| **Série de diagnostic adaptable + toujours arrêtable (v2.3.0)** | **BUG CORRIGÉ** : l'état « diagnostic en cours » était **persisté** — une app tuée pendant la série relançait l'UI avec une série fantôme **inarrêtable** (le bouton Arrêter n'avait rien à arrêter) ; désormais seul le rapport est persisté, l'UI **s'auto-répare au montage** et le bouton Arrêter remet l'état au repos même zombie ; **tests adaptés à la MONTURE CHOISIE** : les taux théoriques des ratios viennent du preset (un DS-114 n'est plus jugé sur la base d'un LX200), le jeu de départ du backlash utilise le taux center du preset, le test des butées gagne un **ÉTAGE À VITESSE MAXIMALE (slew)** quand la course restante le permet (marge d'arrêt 8° calculée sur le preset + garde-temps dérivée du taux slew) puis relais find sur la course RESTANTE — la montée 45°→90° qui prenait 168 s à find prend ~19 s de slew + 36 s de find ; jambes du train d'engrenages à **arc constant** (~15° AD / ~9° DEC : durée déduite du taux mesuré — monture rapide = test court) ; **calibrage manuel arrêtable** (bouton STOP, moteurs stoppés à la frontière de phase) |
| **Liaison résiliente (v2.1.1 · v2.1.2)** | Fini la perte de connexion pendant les GOTO : **(1)** côté natif USB, une erreur de bus (appel de courant des moteurs pendant un slew → chute de tension OTG, re-énumération de l'adaptateur) ne tue plus le thread de lecture — le port est **rouvert automatiquement** (jusqu'à 8 essais espacés de 500 ms, périphérique recherché par deviceName PUIS VID/PID après re-énumération) tant que le câble est branché ; **(2)** si le périphérique a vraiment disparu, l'événement `usbDetached` est émis explicitement (le broadcast système peut ne jamais arriver après une re-énumération ratée) ; **(3)** côté app, **reconnexion USB automatique** (4 essais : match VID/PID, re-demande de permission, firmware redétecté, synchro relancée — journalisé dans la Console) — **corrigé v2.1.2** : la reconnexion réouvrait l'ANCIEN deviceName alors qu'une re-énumération en génère un NOUVEAU (l'ouverture échouait systématiquement = perte définitive observée au GOTO) ; désormais l'identité matérielle retrouvée (VID/PID) fournit le deviceName courant, passé dans des options clonées ; **(4)** le **polling est gelé pendant les séquences GOTO/SYNC** (`:Sr/:Sd/:MS` ont la ligne série pour elles — plus de `:ED#`/`:Gr#` intercalés) ; **(5) v2.1.2** : le mutisme NORMAL de la raquette pendant un moteur déclenché par l'app ne déclenche plus les diagnostics « muette » ni la sonde `:GVP#` ni l'effacement du miroir LCD (`ownMoveUntil` + `isBusyNow` centralisés) — plus de fausse « connexion perdue » pendant le slew d'un GOTO lancé depuis Objets/Alignement ; **(6) v2.1.2** : **reconnexion Bluetooth automatique** (même mécanique, adresse immuable — couvre le brown-out du module BT du télescope pendant un slew) |
| **Raquette virtuelle** | **DOUBLE AFFICHAGE LCD (v1.8.2)** : 2 écrans côte à côte dans un même cadre — le **MIROIR** de la raquette physique (`:ED#`) et un **AD/DEC PERMANENT** (les coordonnées restent affichées quel que soit l'état du miroir : plus d'alternance) ; **boutons de navigation des menus (MODE/▲/▼/ENTER/?) DANS le cadre des écrans**, comme sur le matériel ; panneaux ASU (arbre Menu Autostar, Slew Rate, Focus) déplacés en bas de page, la **Voix** reste juste sous les écrans ; **Hand Control Panel** au comportement du « Hand Control » d'AutostarSuite (v1.6.0) ; **MIROIR LCD LITTÉRAL (v1.8.1)** : l'écran 2×16 affiché est le LITTÉRAL de l'écran de la raquette physique, relu en continu par `:ED#` (extension raquette Autostar — le même mécanisme que le Remote Handbox d'ASU, prouvé sur matériel réel) : menus du firmware, saisies, « Slewing... » — tout apparaît au caractère près ; **touches = touches physiques (v1.8.1)** : chaque touche de la raquette virtuelle simule l'appui SUR la raquette physique (`:EK<ascii>#` — MODE=9, ENTER=13, flèches N/S/O/E=85/68/87/69, GO TO=71, chiffres 48-57) : la raquette réagit exactement comme si on appuyait sur elle et son écran (relu par `:ED#`) se répercute ici — miroir bidirectionnel exact ; **plus de menu simulé (v2.1.1)** : quand le miroir n'est pas actif (hors ligne, synchro coupée, au repos), le LCD affiche un écran **NEUTRE** « MIROIR LCD OFF » (HORS LIGNE / SYNCHRO OFF) au lieu du faux menu « Select Item » non synchronisé avec la raquette qui portait à confusion — l'aperçu des menus locaux ne dure plus que l'appui (retour écran neutre après 5 s) ; repli automatique sur l'écran télémétrie (AD/DEC, Alt/Az) si la raquette ne connaît pas `:ED#` (LX200 classique) ; les mouvements **venant de la raquette physique** s'affichent : croix allumée selon la direction, pastille ● PHYSIQUE ; **la synchro ne retombe plus en erreur** (v1.5.0) : réponses tardives conservées, lecture AD/DEC tolérante axe par axe, diagnostic continu et **recouvrement automatique** ; bouton SYNCHRO activer/désactiver/relancer (⟳ RELANCER) ; clavier reconstruit d'après le firmware détecté (voir **Clavier auto**), menus arborescents locaux reliés au protocole, saisie chiffrée type « M45 + ENTER », appui long MODE = accueil ; **panneau Remote Handbox ASU complet (v1.7.0)** : arbre **Menu Autostar** cliquable repliable, **Slew Rate** Guide/Center/Find/Slew, **Focus** (maintien) + vitesse `:FS#/:FM#/:FF#`, **Voix** (Speech Enable) qui énonce l'écran (y compris le LCD miroir) via le TTS natif |
| **Mise en station** | Aides au calage équatorial par les capteurs du téléphone : **niveau à bulle** (accéléromètre), **inclinomètre de l'axe horaire** vs latitude du site, **boussole + visée Polaris** (azimut vrai, déclinaison magnétique réglable), **site GPS** (acquisition + envoi date/heure/site à la raquette) |
| **Console** | Journal du trafic série temps réel (commandes envoyées/reçues) |
| **Liaison fiable (v1.8.0)** | DTR/RTS assertés à l'ouverture du port USB (les adaptateurs PL2303/CH340 ne transmettaient RIEN sans cela — cause racine « LCD non synchronisé / GOTO muet » en USB) ; séquence ESC ESC systématique (un #497 répond quel que soit le modèle présélectionné) ; repli ALT/AZ quand AD/DEC est muet (`:Ga#/:Gz#` alimentent le miroir et la croix directionnelle) ; timeouts adaptatifs sur liaison muette (reprise plus rapide dès que la raquette répond) ; GO TO toujours actif — hors des menus, la touche re-pointe la dernière cible définie, comme la touche GO TO de la raquette physique |
| **GO TO robuste (v1.8.1 · diagnostic v2.0.1)** | Le format des coordonnées dépend du mode de précision de la raquette : `:Sr`/`:Sd` sont **retentés automatiquement dans l'autre précision** (haute `HH:MM:SS`/`sDD*MM:SS` ↔ basse `HH:MM.T`/`sDD*MM`) avant de renoncer — un GOTO ne peut plus échouer pour une histoire de format ; la fin du slew est suivie par `:D#` (barre `|` pendant le moteur, vide à l'arrivée) et journalisée (« GOTO terminé ») ; en mode miroir, la touche GO TO simule la touche physique (`:EK71#`) — le GOTO direct reste disponible depuis Objets/menus/arbre. **v2.0.1 — chaque échec a SON message** (fini le « Connexion refusée » fourre-tout) : refus explicite de la raquette (« 0 » aux 2 précisions) ≠ **raquette muette** (aucune réponse → reset parseur ESC ESC + retentative ; si `:MS` est muet, une **sonde `:D#`** vérifie si le slew est parti quand même — barre `|` = GOTO confirmé parti) ≠ **liaison morte** (écriture impossible → état « connecté » fantôme remis à zéro, l'app demande une reconnexion) ; chaque étape est journalisée dans la Console |
| **Stabilité** | Aucun écran ne peut fermer l'application (v1.7.1) ; crash de l'onglet Raquette corrigé à la racine (v1.7.2 — aucune fonction JS ne peut plus atteindre un module natif) : chaque onglet est sous son propre filet de sécurité (ErrorBoundary — une erreur affiche une carte avec le détail et un bouton **Relancer** au lieu de planter) ; tous les appuis de la raquette virtuelle sont protégés (l'erreur s'affiche dans le LCD) ; au démarrage suivant, l'app affiche la dernière erreur interne consignée (capture d'écran = diagnostic) et le rapport de crash complet reste partageable depuis le lancement suivant |
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
  services/protocol/     Client Meade/LX200 (queue série, écho, ESC ESC), profils, mappages de clavier par firmware, télescope simulé
  services/astro/        Jour julien, TSL, RA/Dec↔Alt/Az, éphémérides planétaires (Schlyter)
  services/catalog/      Messier 110, NGC 79, étoiles 95 (OpenNGC/HYG, vérifiées <0.1°)
  services/phone/        GPS du téléphone (permissions gérées)
  store/                 Zustand persistant (réglages, état télescope)
  screens/               Connect, Main, Objects, Align, Setup, Handbox, Console
  i18n/                  fr.ts / en.ts
android/ .../usb/        Module natif Kotlin (usb-serial-for-android, JitPack)
android/ .../bt/         Module natif Kotlin SPP (UUID 00001101-…)
```

Protocole : voir `docs/PROTOCOLE.md`.

## Crédits & sources de données

- Concept : implémentation indépendante inspirée de **ScopeBoss** (iOS), l'excellent émulateur Autostar II de N. Olsen — aucun code ni asset réutilisé.
- Coordonnées : [OpenNGC](https://github.com/mattiaverga/OpenNGC) (CC-BY-SA-4.0), [HYG v4.4](https://codeberg.org/astronexus/hyg) (CC-BY-SA-4.0), contre-vérification d3-celestial.
- Drivers USB : [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) (MIT).
- Éphémérides : formules de Paul Schlyter (domaine public).

## Licence

- **Code** : licence propriétaire source-available — voir [LICENSE.md](LICENSE.md) : usage personnel, compilation et modification autorisés ; **redistribution et exploitation commerciale interdites** sans autorisation de l'auteur.
- **Catalogues** (`src/services/catalog/`) : données [OpenNGC](https://github.com/mattiaverga/OpenNGC) et [HYG](https://codeberg.org/astronexus/hyg), sous **CC-BY-SA-4.0**.
- **Marques** : Meade, Autostar, LX200, ETX sont des marques de Meade Instruments Corporation — projet indépendant, sans affiliation ni endorsement. ScopeBoss est un produit de son auteur : cette implémentation indépendante ne réutilise aucun de ses éléments.

## Feuille de route

Portage Windows (Microsoft Store), Google Play, macOS/Linux et modèle de monétisation : voir [ROADMAP.md](ROADMAP.md).
