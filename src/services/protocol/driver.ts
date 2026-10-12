/**
 * Couche d'abstraction TÉLESCOPE (v2.6.0 — « étendre la compatibilité à
 * d'autres fabricants que Meade »).
 *
 * Un TelescopeDriver traduit les primitives haut niveau de l'app (lire la
 * position, GOTO, SYNC, flèches, vitesses, tracking…) en commandes d'un
 * protocole précis. AutostarClient reste propriétaire de la liaison (file
 * série, tampon '#'-terminal, polling, reconnexion, relais GOTO) et ROUTE
 * toutes les primitives vers le driver actif — tout le socle éprouvé
 * (relais boucle fermée v2.5.0, contrôle croisé télémétrie v2.3.0, réglage
 * fin v2.2.0, diagnostic moteur) fonctionne alors pour chaque marque.
 *
 * Protocoles implémentés :
 *  - meade      : Meade Autostar/#49x/LX200 (protocole historique de l'app)
 *  - celestron  : Celestron NexStar (NexStar+ / v4 : SE, SLT, Evo, GT…)
 *  - skywatcher : Sky-Watcher SynScan (accepte le jeu NexStar)
 *  - ioptron    : iOptron Go2Nova 8407 (sous-ensemble LX200 + :SR/:m/:q)
 *
 * Sources de référence : « NexStar Hand Control Communication Protocol »
 * (Celestron), drivers INDI celestrondriver.cpp / celestronprotocol.c /
 * ioptronv3, driver INDIGO mount_ioptron (GSS), Stellarium NexStarCommand.
 */
import type {MotorSpeed} from '../../store/motorCalibStore';

/* ---------- types partagés ---------- */

export type Dir = 'n' | 's' | 'e' | 'w';
/** Vitesses de l'app — 4 crans universels, mappés par chaque protocole. */
export type Speed = MotorSpeed; // 'guide' | 'center' | 'find' | 'slew'

export interface RaDec {raDeg: number; decDeg: number}

/** Résultat d'un GOTO (statuts finaux de l'app, indépendants du protocole). */
export type GotoStatus =
  | 'ok' | 'belowHorizon' | 'noObject' | 'refused' | 'mute' | 'noLink'
  | 'relayPartial';

/** Textes i18n nécessaires pour traduire un statut de GOTO. */
export interface GotoErrorTexts {
  belowHorizon: string;
  empty: string;
  gotoNoLink: string;
  gotoMute: string;
  refused: string;
  relayPartial: string;
}

/** Message localisé pour un statut de GOTO — partagé par tous les écrans. */
export function gotoErrorText(r: GotoStatus, x: GotoErrorTexts): string {
  if (r === 'ok') return '';
  return r === 'belowHorizon' ? x.belowHorizon
    : r === 'noObject' ? x.empty
    : r === 'noLink' ? x.gotoNoLink
    : r === 'mute' ? x.gotoMute
    : r === 'relayPartial' ? x.relayPartial
    : x.refused;
}

/* ---------- capacités (détectées par l'UI pour adapter les écrans) ---------- */

export interface DriverCaps {
  position: boolean;      // lecture AD/DEC
  altAz: boolean;         // lecture alt/az en direct (repli du miroir)
  goto: boolean;          // GOTO natif du protocole
  relay: boolean;         // primitives de jog → relais GOTO boucle fermée possible
  sync: boolean;          // SYNC sur coordonnées
  syncHere: boolean;      // SYNC « ici » sans coordonnées (:CM#)
  readSite: boolean;      // lecture date/heure/site de la monture
  pushSite: boolean;      // envoi date/heure/site du téléphone
  trackingModes: boolean; // altaz/polaire/terrestre
  alignWizards: boolean;  // assistants d'alignement du protocole (:Aa#… Meade)
  focus: boolean;         // moteur de mise au point
  reticle: boolean;       // réticule illuminé
  park: boolean;          // parc
  lcdMirror: boolean;     // miroir LCD de la raquette physique (:ED# Meade)
  keyPress: boolean;      // simulation d'appuis sur la raquette (:EK# Meade)
  isMoving: boolean;      // sonde « moteur en marche » (:D# / 'L' NexStar)
}

export const NO_CAPS: DriverCaps = {
  position: false, altAz: false, goto: false, relay: false, sync: false,
  syncHere: false, readSite: false, pushSite: false, trackingModes: false,
  alignWizards: false, focus: false, reticle: false, park: false,
  lcdMirror: false, keyPress: false, isMoving: false,
};

/* ---------- interface de rappel fournie par le client ---------- */

/** Ce que le driver peut appeler sur AutostarClient (sans dépendance
 *  circulaire : le client ROUTE, le driver TRADUIT). */
export interface DriverClient {
  /** Commande avec réponse '#'-terminal (tampon commun, format vérifié). */
  cmd(command: string, timeoutMs?: number, expect?: RegExp): Promise<string>;
  /** Écriture brute sans attente de réponse (commandes muettes Meade). */
  cmdSilent(command: string): Promise<void>;
  /** La liaison est-elle encore vivante ? */
  transportAlive(): boolean;
  /** Reset du parseur côté raquette (ESC ESC — Meade uniquement). */
  resetParser(): Promise<void>;
  /** Priorité aux commandes utilisateur (ticks de poll sautés). */
  bump(): void;
  /** Trafic de protocole (console série de l'app). */
  log(dir: 'sent' | 'recv' | 'info' | 'error' | 'warn', text: string): void;
  /** Avertissement UTILISATEUR (chemin séparé du trafic — jamais silencié). */
  warn(text: string): void;
}

/* ---------- sondes de détection ---------- */

/** Sonde : commande envoyée à l'aveugle à la connexion ; si une réponse
 *  arrive et passe `classify`, le protocole est identifié. */
export interface ProtocolProbe {
  cmd: string;
  timeoutMs: number;
  expect: RegExp;
  classify: (reply: string) => boolean;
}

/* ---------- interface driver ---------- */

export interface TelescopeDriver {
  id: DriverId;
  label: string;          // affiché (i18n clé driver.<id>)
  brands: string;         // fabricants couverts (affiché)
  caps: DriverCaps;
  probe?: ProtocolProbe;
  /** Identité du matériel (retournée à la détection / carte firmware). */
  firmware(c: DriverClient): Promise<{product: string; version: string}>;
  /** Position AD/DEC — null par axe si muet ce cycle (tolérant, poll). */
  readPosition(c: DriverClient, timeoutMs: number): Promise<{raDeg: number | null; decDeg: number | null}>;
  /** AD/DEC strict (échec rapide) — GOTO, réglage fin. */
  getRaDec?(c: DriverClient, timeoutMs: number): Promise<RaDec>;
  readAltAz?(c: DriverClient): Promise<{altDeg: number; azDeg: number} | null>;
  goto(c: DriverClient, raDeg: number, decDeg: number): Promise<GotoStatus>;
  syncRaDec(c: DriverClient, raDeg: number, decDeg: number): Promise<boolean>;
  syncHere(c: DriverClient): Promise<void>;
  setSpeed(c: DriverClient, s: Speed): Promise<void>;
  startMove(c: DriverClient, dir: Dir): Promise<void>;
  stopMove(c: DriverClient, dir: Dir): Promise<void>;
  stopAll(c: DriverClient): Promise<void>;
  /** true = moteur en marche, false = arrêté, null = indéterminé (muette). */
  isMoving(c: DriverClient): Promise<boolean | null>;
  setTracking?(c: DriverClient, mode: 'altaz' | 'polar' | 'land', latDeg: number): Promise<void>;
  startAlign?(c: DriverClient, kind: 'easy' | 'one' | 'two'): Promise<void>;
  focusStart?(c: DriverClient, inward: boolean): Promise<void>;
  focusStop?(c: DriverClient): Promise<void>;
  setFocusSpeed?(c: DriverClient, s: 'slow' | 'medium' | 'fast'): Promise<void>;
  reticleAdjust?(c: DriverClient, delta: 1 | -1): Promise<void>;
  park?(c: DriverClient): Promise<void>;
  pushSite?(c: DriverClient, latDeg: number, lonDeg: number): Promise<{time: string; date: string}>;
  readSite?(c: DriverClient): Promise<{
    time: string; date: string; tz: string; latDeg: number | null; lonDeg: number | null;
  }>;
  lcd?(c: DriverClient): Promise<{line1: string; line2: string} | null>;
  lcdRaw?(c: DriverClient): Promise<string | null>;
  keyPress?(c: DriverClient, code: number): Promise<void>;
}

export type DriverId = 'meade' | 'celestron' | 'skywatcher' | 'ioptron';
export type DriverPref = 'auto' | DriverId;

/* ---------- parsing du format Meade (partagé Meade + iOptron) ---------- */

// Longitudes/latitudes "±DD*MM(:SS)" — signe optionnel, '*' ou '°' ou ':'
// Secondes captées quand présentes (haute précision — utile au réglage fin).
const DEC_RE = /^([+-])?(\d{1,3})\D(\d{1,2})(?:\D(\d{1,2}))?/;

/** Parse "sDD*MM(:SS)" ou "sDD:MM" → degrés. null si hors format. */
export function parseMeadeDec(s: string): number | null {
  const m = s.trim().match(DEC_RE);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60 + (m[4] ? +m[4] / 3600 : 0));
}

/** Parse "HH:MM:SS" (Autostar) ou "HH:MM.T" (LX200 classique) → degrés AD. */
export function parseMeadeRa(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})|\.(\d))?/);
  if (!m) return null;
  const h = +m[1];
  const mm = +m[2];
  const sec = m[3] ? +m[3] / 3600 : m[4] ? +m[4] / 10 / 60 : 0;
  return (h + mm / 60 + sec) * 15;
}

/** Formats attendus des réponses (rejet des réponses « en retard »). */
export const VALID = {
  ra: /^\d{1,2}:\d{2}/,          // :Gr# :GL#  → "HH:MM:SS" ou "HH:MM.T"
  dec: /^[+-]?\d{1,3}[°*]\d{1,2}|^[+-]\d{1,3}:\d{1,2}/, // :Gd# :Ga# :Gz#…
  date: /^\d{1,2}\/\d{1,2}/,     // :GC# → "MM/JJ/AA"
  tz: /^[+-]?\d/,                // :GG# → heures de décalage
  bit: /^[01]$/,                 // :Sr# :Sd# → validé/refusé
  digit: /^\d/,                  // :MS# → 0/1/2
  any: /^.*$/,                   // réponse libre (sonde, ACK NexStar…)
} as const;

/** Registre : peuplé par drivers/index.ts (import unique côté client). */
export const DRIVERS: Record<DriverId, TelescopeDriver> = {} as Record<DriverId, TelescopeDriver>;

export function registerDriver(d: TelescopeDriver) {
  DRIVERS[d.id] = d;
}

export function getDriver(id: DriverId): TelescopeDriver {
  return DRIVERS[id] ?? DRIVERS.meade;
}
