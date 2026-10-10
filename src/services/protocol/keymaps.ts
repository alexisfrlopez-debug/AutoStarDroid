/**
 * Mappages de clavier de la raquette virtuelle, par génération de matériel.
 *
 * La raquette virtuelle ne code plus son clavier en dur : à la connexion,
 * le firmware détecté (:GVP# / :GVN# → client.matchFirmware) sélectionne
 * ici le mappage adapté, et les touches s'organisent et se mappent
 * automatiquement (composition des rangées, étiquettes secondaires,
 * comportement des chiffres, touches dédiées LX200…).
 *
 *   - Autostar #497 / #495 / #494 : clavier historique (ENTER/MODE/GO TO,
 *     croix, pavé 0-9, défilement + ?) ; les chiffres 1-9 portent les
 *     raccourcis vitesse des #49x (GUIDE/CENTER/FIND/SLEW).
 *   - Autostar II : mêmes rangées, mais étiquettes secondaires doubles
 *     (SPEED/CALD/M/FOCUS/SS/STAR/RET/LC./NGC) et sauts de menu.
 *   - LX200 classique : clavier propre (MODE/ENTER/PREV/NEXT, croix,
 *     rangée FOCUS/RÉTICULE, pavé chiffré + SPEED) ; ENTER valide et
 *     pointe, SPEED cycle les vitesses.
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

const cmdRow = (a: KeySpec, b: KeySpec, c: KeySpec): KeyRow[] => [{keys: [a, b, c]}];

export const KEYMAPS: Record<ScopeModelId, Keymap> = {
  /* ---- Autostar #497 (ETX/LX90) — clavier physique de référence ---- */
  autostar497: {
    digitMode: 'speedShortcuts',
    rows: [
      ...cmdRow(act('enter', 'enter'), act('mode', 'mode'), act('goto', 'goto')),
      ...CROSS,
      ...DIGITS,
      {keys: [act('scrollUp', 'up', '▲'), act('help', 'help'), act('scrollDown', 'down', '▼')]},
    ],
  },

  /* ---- Autostar #495 : identique au #497 (raccourcis vitesse inclus) ---- */
  autostar495: {
    digitMode: 'speedShortcuts',
    rows: [
      ...cmdRow(act('enter', 'enter'), act('mode', 'mode'), act('goto', 'goto')),
      ...CROSS,
      ...DIGITS,
      {keys: [act('scrollUp', 'up', '▲'), act('help', 'help'), act('scrollDown', 'down', '▼')]},
    ],
  },

  /* ---- Autostar #494 : pas de touche ? (aide) sur le matériel ---- */
  autostar494: {
    digitMode: 'speedShortcuts',
    rows: [
      ...cmdRow(act('enter', 'enter'), act('mode', 'mode'), act('goto', 'goto')),
      ...CROSS,
      ...DIGITS,
      {keys: [act('scrollUp', 'up', '▲'), act('scrollDown', 'down', '▼')], center: true},
    ],
  },

  /* ---- Autostar II (LX200GPS/RMS) : doubles étiquettes + sauts de menu ---- */
  autostar2: {
    digitMode: 'menuJumps',
    rows: [
      ...cmdRow(act('enter', 'enter'), act('mode', 'mode'), act('goto', 'goto')),
      ...CROSS,
      ...DIGITS_AUTOSTAR2,
      {keys: [act('scrollUp', 'up', '▲'), act('help', 'help'), act('scrollDown', 'down', '▼')]},
    ],
  },

  /* ---- LX200 classique : clavier dédié du handpad d'origine ---- */
  lx200: {
    digitMode: 'plain',
    rows: [
      {keys: [
        act('mode', 'mode'),
        act('enterGoto', 'enter'),
        act('scrollUp', 'prev', 'PREV'),
        act('scrollDown', 'next', 'NEXT'),
      ]},
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
