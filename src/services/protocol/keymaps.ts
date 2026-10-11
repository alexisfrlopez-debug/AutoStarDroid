/**
 * Mappages de clavier de la raquette virtuelle, par génération de matériel.
 *
 * La raquette virtuelle ne code plus son clavier en dur : à la connexion,
 * le firmware détecté (:GVP# / :GVN# → client.matchFirmware) sélectionne
 * ici le mappage adapté, et les touches s'organisent et se mappent
 * automatiquement (composition des rangées, étiquettes secondaires,
 * comportement des chiffres, touches dédiées LX200…).
 *
 * Chaque mappage sépare deux zones (v1.8.2) :
 *   - navRow : les BOUTONS DE NAVIGATION DES MENUS (MODE, ENTER, défilement
 *     ▲▼, ?, PREV/NEXT du LX200) — rendus DANS le cadre des écrans LCD,
 *     comme sur le matériel où ces touches entourent l'afficheur ;
 *   - rows   : le clavier principal (croix directionnelle, pavé 0-9,
 *     GO TO, touches dédiées FOCUS/RÉTICULE/SPEED).
 *
 *   - Autostar #497 / #495 / #494 : clavier historique (croix, pavé 0-9,
 *     GO TO) ; les chiffres 1-9 portent les raccourcis vitesse des #49x
 *     (GUIDE/CENTER/FIND/SLEW) ; le #494 n'a pas de touche ?.
 *   - Autostar II : mêmes rangées, mais étiquettes secondaires doubles
 *     (SPEED/CALD/M/FOCUS/SS/STAR/RET/LC./NGC) et sauts de menu.
 *   - LX200 classique : clavier propre (croix, rangée FOCUS/RÉTICULE,
 *     pavé chiffré + SPEED) ; ENTER (navRow) valide ET pointe, SPEED
 *     cycle les vitesses.
 */
import type {ScopeModelId} from '../../store/settingsStore';
import type {Dir} from './client';

/** Actions des touches « commande » (rendues via CmdKey / touches maintenues). */
export type KeyAct =
  | 'enter'         // valider / descendre dans le menu
  | 'enterGoto'     // valider ET pointer (ENTER du LX200 classique)
  | 'mode'          // remonter d'un niveau (appui long : accueil)
  | 'goto'          // GO TO
  | 'help'          // aide contextuelle
  | 'scrollUp' | 'scrollDown'
  | 'speedCycle'    // SPEED : cycle Guide→Center→Find→Slew
  | 'focusIn' | 'focusOut'    // maintien : moteur, relâcher : stop
  | 'reticlePlus' | 'reticleMinus'; // luminosité du réticule (:B+/B-)

export type KeySpec =
  | {t: 'act'; act: KeyAct; labelKey: string; label?: string}
  | {t: 'dir'; dir: Dir; label: string}
  | {t: 'gap'}                 // ressort (flex:1)
  | {t: 'spacer'; w: number}   // espace fixe
  | {t: 'digit'; digit: number; sub?: string};

export interface KeyRow {keys: KeySpec[]; center?: boolean}

export interface Keymap {
  /** Comportement des chiffres hors saisie de liste. */
  digitMode: 'speedShortcuts' | 'menuJumps' | 'plain';
  /** Boutons de navigation des menus — rendus dans le cadre des écrans LCD
   *  (v1.8.2) : MODE, ENTER, défilement ▲▼, ?, ou PREV/NEXT du LX200. */
  navRow: KeySpec[];
  /** Clavier principal : croix, pavé 0-9, GO TO, touches dédiées. */
  rows: KeyRow[];
}

/** Noms courts pour le badge firmware (i18n-free, références matériel). */
export const FW_SHORT: Record<ScopeModelId, string> = {
  autostar2: 'Autostar II',
  autostar497: '#497',
  autostar495: '#495',
  autostar494: '#494',
  lx200: 'LX200',
};

const act = (a: KeyAct, labelKey: string, label?: string): KeySpec =>
  ({t: 'act', act: a, labelKey, label});
const dir = (d: Dir, label: string): KeySpec => ({t: 'dir', dir: d, label});
const digit = (n: number, sub?: string): KeySpec => ({t: 'digit', digit: n, sub});
const gap: KeySpec = {t: 'gap'};
const sp = (w: number): KeySpec => ({t: 'spacer', w});

const CROSS: KeyRow[] = [
  {keys: [dir('n', '▲')], center: true},
  {keys: [dir('w', '◀'), sp(18), dir('e', '▶')], center: true},
  {keys: [dir('s', '▼')], center: true},
];

const DIGITS: KeyRow[] = [
  {keys: [digit(1), digit(2), digit(3)]},
  {keys: [digit(4), digit(5), digit(6)]},
  {keys: [digit(7), digit(8), digit(9)]},
  {keys: [gap, digit(0, 'LIGHT'), gap]},
];

/** Étiquettes secondaires du clavier Autostar II (touches 1-9). */
const DIGITS_AUTOSTAR2: KeyRow[] = [
  {keys: [digit(1, 'SPEED'), digit(2, 'CALD'), digit(3, 'M')]},
  {keys: [digit(4, 'FOCUS'), digit(5, 'SS'), digit(6, 'STAR')]},
  {keys: [digit(7, 'RET'), digit(8, 'LC.'), digit(9, 'NGC')]},
  {keys: [gap, digit(0, 'LIGHT'), gap]},
];

/** GO TO : rangée dédiée du clavier principal (touche isolée du #497). */
const gotoRow: KeyRow = {keys: [gap, act('goto', 'goto'), gap]};

/** navRow #49x / Autostar II : MODE | ▲ ? ▼ | ENTER (disposition matériel). */
const NAV_49X: KeySpec[] = [
  act('mode', 'mode'),
  act('scrollUp', 'up', '▲'),
  act('help', 'help'),
  act('scrollDown', 'down', '▼'),
  act('enter', 'enter'),
];

export const KEYMAPS: Record<ScopeModelId, Keymap> = {
  /* ---- Autostar #497 (ETX/LX90) — clavier physique de référence ---- */
  autostar497: {
    digitMode: 'speedShortcuts',
    navRow: NAV_49X,
    rows: [...CROSS, ...DIGITS, gotoRow],
  },

  /* ---- Autostar #495 : identique au #497 (raccourcis vitesse inclus) ---- */
  autostar495: {
    digitMode: 'speedShortcuts',
    navRow: NAV_49X,
    rows: [...CROSS, ...DIGITS, gotoRow],
  },

  /* ---- Autostar #494 : pas de touche ? (aide) sur le matériel ---- */
  autostar494: {
    digitMode: 'speedShortcuts',
    navRow: [
      act('mode', 'mode'),
      act('scrollUp', 'up', '▲'),
      act('scrollDown', 'down', '▼'),
      act('enter', 'enter'),
    ],
    rows: [...CROSS, ...DIGITS, gotoRow],
  },

  /* ---- Autostar II (LX200GPS/RMS) : doubles étiquettes + sauts de menu ---- */
  autostar2: {
    digitMode: 'menuJumps',
    navRow: NAV_49X,
    rows: [...CROSS, ...DIGITS_AUTOSTAR2, gotoRow],
  },

  /* ---- LX200 classique : clavier dédié du handpad d'origine ---- */
  lx200: {
    digitMode: 'plain',
    navRow: [
      act('mode', 'mode'),
      act('scrollUp', 'prev', 'PREV'),
      act('scrollDown', 'next', 'NEXT'),
      act('enterGoto', 'enter'),
    ],
    rows: [
      ...CROSS,
      {keys: [
        act('focusIn', 'focusIn', 'MAP −'),
        act('focusOut', 'focusOut', 'MAP +'),
        act('reticleMinus', 'retIn', 'RÉT −'),
        act('reticlePlus', 'retOut', 'RÉT +'),
      ]},
      {keys: [digit(1), digit(2), digit(3)]},
      {keys: [digit(4), digit(5), digit(6)]},
      {keys: [digit(7), digit(8), digit(9)]},
      {keys: [gap, digit(0), act('speedCycle', 'speed', 'SPEED')]},
    ],
  },
};
