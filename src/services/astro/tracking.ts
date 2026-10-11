/**
 * Suivi télémétrique en boucle fermée (v2.0.0) — mathématiques pures.
 *
 * Principe : le pointage réel du télescope est connu en continu via le
 * recalage télémétrie (Wahba/Kabsch, cf. telemetry.ts). L'écart entre ce
 * pointage réel et la position théorique de l'objet visé est converti en
 * impulsions moteur (guide pulses :Mn#:Ms#:Me#:Mw#) dont la durée est
 * calculée à partir des taux mesurés (calibrage moteurs) ou des taux
 * théoriques. Chaque impulsion est suivie d'une mesure : si l'erreur a
 * grandi au lieu de baisser, le SENS de l'axe est inversé automatiquement
 * (auto-apprentissage — robuste aux conventions :Me#/:Mw# variables selon
 * les firmwares et les montures).
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */
import {raDecToAltAz, altAzToRaDec} from './coords';
import {shortestAngleDeg} from './alignment';

export const SIDEREAL_DEG_PER_SEC = 360.9856 / 86400; // 0.0041781 °/s (AD 1×)

/** Vitesse par défaut (deg/s sur le ciel) si non calibrée — ordre de grandeur
 *  Autostar ; la boucle fermée corrige l'écart de toute façon. */
export const DEFAULT_SKY_RATES: Record<'guide' | 'center' | 'find' | 'slew', number> = {
  guide: SIDEREAL_DEG_PER_SEC,
  center: 0.08,
  find: 0.4,
  slew: 2.0,
};

/* ------------------------------------------------------------------ */
/* Erreurs de pointage                                                 */
/* ------------------------------------------------------------------ */

/** Écart pointage réel → objet visé, en AD/DEC équatoriaux (deg).
 *  raErr est déjà multiplié par cos(dec) : c'est l'écart ANGULAIRE sur le
 *  ciel dans la direction est-ouest (minutes d'arc directes). */
export function raDecErrorDeg(
  target: {raDeg: number; decDeg: number},
  actual: {raDeg: number; decDeg: number},
): {raErrDeg: number; decErrDeg: number} {
  const decMean = ((target.decDeg + actual.decDeg) / 2) * (Math.PI / 180);
  const decErr = target.decDeg - actual.decDeg;
  const raErr = shortestAngleDeg(target.raDeg - actual.raDeg) * Math.max(0.05, Math.cos(decMean));
  return {raErrDeg: raErr, decErrDeg: decErr};
}

/** Écart complet (équat. + horizontal) entre le pointage réel et l'objet. */
export function pointingError(
  target: {raDeg: number; decDeg: number},
  actualAltAz: {altDeg: number; azDeg: number},
  latDeg: number,
  lonDeg: number,
  date: Date,
): {
  raErrDeg: number;
  decErrDeg: number;
  totalArcmin: number;
  targetAltAz: {altDeg: number; azDeg: number};
  actualRaDec: {raDeg: number; decDeg: number};
} {
  const targetAltAz = raDecToAltAz(target.raDeg, target.decDeg, latDeg, lonDeg, date);
  const actualRaDec = altAzToRaDec(actualAltAz.altDeg, actualAltAz.azDeg, latDeg, lonDeg, date);
  const e = raDecErrorDeg(target, actualRaDec);
  const totalArcmin = Math.sqrt(e.raErrDeg * e.raErrDeg + e.decErrDeg * e.decErrDeg) * 60;
  return {...e, totalArcmin, targetAltAz, actualRaDec};
}

/* ------------------------------------------------------------------ */
/* Planification d'impulsions                                          */
/* ------------------------------------------------------------------ */

export type Axis = 'ra' | 'dec';
export type PulseDir = 'n' | 's' | 'e' | 'w';

/** Signes appris : signDec = +1 → la commande 'n' augmente la DEC.
 *  signRa = +1 → la commande 'e' augmente l'AD. Inversés automatiquement
 *  par la boucle si une impulsion aggrave l'erreur. */
export interface PulseSigns {
  dec: 1 | -1;
  ra: 1 | -1;
}

export const DEFAULT_SIGNS: PulseSigns = {dec: 1, ra: 1};

export interface PulseStep {
  axis: Axis;
  dir: PulseDir;
  /** Durée d'impulsion en ms (backlash inclus). */
  durationMs: number;
  /** Correction angulaire visée (deg sur le ciel) — pour le log. */
  correctionDeg: number;
}

export interface PulsePlanParams {
  /** Erreur AD/DEC (deg ciel), cf. raDecErrorDeg. */
  raErrDeg: number;
  decErrDeg: number;
  /** Taux CIEL mesurés/théoriques par axe (deg/s). */
  raRateDegPerSec: number;
  decRateDegPerSec: number;
  signs: PulseSigns;
  /** Amortissement (0..1] : fraction de la correction appliquée. */
  damping?: number;
  /** Sous cette erreur (deg) on n'agit pas. */
  deadbandDeg?: number;
  /** Durée max d'une impulsion (s). */
  maxPulseSec?: number;
  /** Anti-lu backlash par axe (s), ajouté si changement de sens. */
  backlashSec?: {ra: number; dec: number};
  lastDirs?: {ra: PulseDir | null; dec: PulseDir | null};
}

/** Calcule les impulsions à envoyer pour réduire l'erreur. Renvoie [] si
 *  l'erreur est sous le seuil. Une seule impulsion par axe, la plus longue
 *  plafonnée à maxPulseSec — le reste sera repris au tick suivant. */
export function planPulses(p: PulsePlanParams): PulseStep[] {
  const damping = p.damping ?? 0.6;
  const deadband = p.deadbandDeg ?? 2 / 60; // 2′
  const maxSec = p.maxPulseSec ?? 3;
  const out: PulseStep[] = [];

  // --- Axe DEC ---
  const decErr = p.decErrDeg * damping;
  if (Math.abs(p.decErrDeg) > deadband && p.decRateDegPerSec > 1e-6) {
    const wantSec = Math.abs(decErr) / p.decRateDegPerSec;
    const sec = Math.min(wantSec, maxSec);
    const dir: PulseDir = decErr > 0 ? (p.signs.dec > 0 ? 'n' : 's') : p.signs.dec > 0 ? 's' : 'n';
    const extra =
      p.lastDirs?.dec && p.lastDirs.dec !== dir ? (p.backlashSec?.dec ?? 0) : 0;
    out.push({
      axis: 'dec',
      dir,
      durationMs: Math.round((sec + extra) * 1000),
      correctionDeg: decErr,
    });
  }

  // --- Axe AD ---
  const raErr = p.raErrDeg * damping;
  if (Math.abs(p.raErrDeg) > deadband && p.raRateDegPerSec > 1e-6) {
    const wantSec = Math.abs(raErr) / p.raRateDegPerSec;
    const sec = Math.min(wantSec, maxSec);
    const dir: PulseDir = raErr > 0 ? (p.signs.ra > 0 ? 'e' : 'w') : p.signs.ra > 0 ? 'w' : 'e';
    const extra =
      p.lastDirs?.ra && p.lastDirs.ra !== dir ? (p.backlashSec?.ra ?? 0) : 0;
    out.push({
      axis: 'ra',
      dir,
      durationMs: Math.round((sec + extra) * 1000),
      correctionDeg: raErr,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Apprentissage du signe                                              */
/* ------------------------------------------------------------------ */

export interface SignObservation {
  axis: Axis;
  /** Erreur (deg ciel, signée) AVANT l'impulsion. */
  errBeforeDeg: number;
  /** Erreur APRÈS l'impulsion (même convention). */
  errAfterDeg: number;
}

/** Décide si le signe de l'axe doit être inversé. On n'inverse que si
 *  l'erreur a NETTEMENT grandi (> 50 % et > 2′) — un simple bruit ou une
 *  dérive naturelle de l'objet ne doit pas déclencher de bascule. */
export function shouldFlipSign(obs: SignObservation): boolean {
  const before = Math.abs(obs.errBeforeDeg);
  const after = Math.abs(obs.errAfterDeg);
  if (before < 2 / 60) return false; // trop petit pour conclure
  const grew = after - before;
  return grew > 0.5 * before && after > 2 / 60 && obs.errBeforeDeg * obs.errAfterDeg > 0;
}

export function flipSigns(s: PulseSigns, axis: Axis): PulseSigns {
  return axis === 'dec' ? {...s, dec: (s.dec === 1 ? -1 : 1) as 1 | -1}
                        : {...s, ra: (s.ra === 1 ? -1 : 1) as 1 | -1};
}

/* ------------------------------------------------------------------ */
/* Objets mobiles (planètes, Lune, Soleil)                             */
/* ------------------------------------------------------------------ */

/** Direction cible d'un objet mobile recalculée à l'instant demandé.
 *  `resolve` est injecté (planetRaDec) pour garder ce module sans import
 *  d'éphémérides — facilite les tests. */
export function movingTargetRaDec(
  raDeg: number,
  decDeg: number,
  moving: string | null,
  resolve: (name: string, date: Date) => {raDeg: number; decDeg: number} | null,
  date: Date,
): {raDeg: number; decDeg: number} {
  if (!moving) return {raDeg, decDeg};
  const p = resolve(moving, date);
  return p ?? {raDeg, decDeg};
}

/** Taux horizontaux (deg/s) d'un objet au site et à l'instant donnés
 *  (dérivée numérique ±0,5 s). Utile au diagnostic (drift attendu vs mesuré). */
export function altAzRatesDegPerSec(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lonDeg: number,
  date: Date,
): {dAltDegPerSec: number; dAzDegPerSec: number} {
  const half = 500;
  const a1 = raDecToAltAz(raDeg, decDeg, latDeg, lonDeg, new Date(date.getTime() - half));
  const a2 = raDecToAltAz(raDeg, decDeg, latDeg, lonDeg, new Date(date.getTime() + half));
  return {
    dAltDegPerSec: (a2.altDeg - a1.altDeg) / 1.0,
    dAzDegPerSec: shortestAngleDeg(a2.azDeg - a1.azDeg) / 1.0,
  };
}
