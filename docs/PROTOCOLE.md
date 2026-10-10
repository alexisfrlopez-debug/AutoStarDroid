# Protocole Meade Autostar / LX200 — notes d'implémentation

## Généralités

- Commandes ASCII `:XX…#`, réponses terminées par `#`.
- Half-duplex : une commande à la fois (file d'attente sérielle dans `AutostarClient`).
- Les Autostar #49x basculent en mode PC série après réception de `ESC ESC` (`0x1B 0x1B`) envoyé à la mise sous tension — l'app le fait automatiquement (profil `wake: true`).
- Certaines raquettes renvoient un **écho** de la commande : le client le détecte et le retire avant analyse.
- Mouvements (`:Mn#` etc.) et vitesse (`:RG#`…) : **pas de réponse** → envoi « silencieux ».

## Commandes implémentées

| Commande | Réponse | Rôle |
|---|---|---|
| `:Gr#` / `:GR#` | `HH:MM:SS#` | AD courante |
| `:Gd#` / `:GD#` | `sDD*MM'#` | DEC courante |
| `:Gz#`, `:Galt#` | `sDD*MM'#` | Azimut / hauteur |
| `:GL#`, `:GC#`, `:GG#` | `HH:MM:SS#`, `MM/JJ/AA#`, `sHH#` | Heure, date, fuseau |
| `:SLHH:MM:SS#`, `:SCMM/JJ/AA#`, `:SGsHH#` | `1#` | Réglage heure/date/fuseau |
| `:Gt#`, `:Gg#` | `sDD*MM#`, `DDD*MM#` | Site (lat/long) |
| `:StsDD*MM#`, `:SgDDD*MM#` | `1#`/`0#` | Réglage site (long : 0–359, ouest = 180+) |
| `:W1#…:W4#`, `:GM#…` | — | Sélection/nom des sites |
| `:SrHH:MM:SS#`, `:SdsDD*MM#` | `1#`/`0#` | Cible GoTo |
| `:MS#` | `0#`=OK, `1#`=sous l'horizon, `2#`=pas d'objet | Lancer le GoTo |
| `:CM#` | `<OBJET>#` | SYNC sur la position courante |
| `:Mn/:Ms/:Me/:Mw#` | — | Bouger N/S/E/O |
| `:Qn/:Qs/:Qe/:Qw#`, `:Q#` | — | Stopper (une direction / tout) |
| `:RG/:RC/:RM/:RS#` | — | Vitesse Guide/Center/Find/Slew |
| `:AA#/:AP#/:AL#` | — | Suivi Alt-Az / Polaire / Terrestre |
| `:Aa#…:Ae#` | — | Alignement (facile, 1 étoile, 2 étoiles…) — Autostar II |
| `:F+#/:F-#/:FQ#/:FP#/:FS#` | — | Mise au point |
| `:hP#` | — | Parc |
| `:GVP#`, `:GVN#`, `:GVD#`, `:GVT#` | texte | Nom produit, version, date, heure du firmware |
| `:GPS#` | — | Init GPS (LX200GPS) |

## Différences par génération (profils)

| Profil | ESC ESC | Date/heure | Site | Align cmds | Focuser | PEC |
|---|---|---|---|---|---|---|
| Autostar II (#497 LX200GPS) | non | oui | oui | oui | oui | oui |
| Autostar #497 (ETX/LX90) | **oui** | oui | oui | non | oui | oui |
| Autostar #495 | **oui** | oui | oui | non | oui | non |
| Autostar #494 | **oui** | oui | oui | non | non* | non |
| LX200 classique | non | oui | oui | non | oui | oui |

\* Le #494 d'origine n'a pas de port série : liaison USB/BT possible uniquement avec un câble « AUX modifié », sinon utiliser le mode Démo.

## Vitesses (mode Démo, ordres de grandeur réels)

Guide = 1× sidéral (0.0042°/s), Center ≈ 0.5°/s, Find ≈ 2°/s, Slew ≈ 6–8°/s.

## Conversion des coordonnées

- Longitudes envoyées en convention Meade : 0–359°, `long_Meade = long_E < 0 ? 360 + long_E : long_E`.
- Réponses DEC : `sDD*MM` ; AD : `HH:MM:SS`.
- L'app convertit AD/DEC ↔ hauteur/azimut via TSL locale (formule IAU, précision ~0.1 s) et affiche la hauteur des objets pour filtrer ce qui est sous l'horizon.
