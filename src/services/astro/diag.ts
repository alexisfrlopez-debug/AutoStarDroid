/**
 * Diagnostic moteur complet (v2.1.0) — mathématiques pures.
 *
 * La suite autonome de l'onglet Alignement commande les moteurs et lit le
 * gyroscope brut du téléphone (solidaire du tube) pour produire un rapport
 * complet de la mécanique de la monture :
 *  - ANGLE INTÉGRÉ : displacement angulaire réel pendant une impulsion
 *    (intégration du taux gyro biais soustrait sur la fenêtre) ;
 *  - RATIO : taux réel / taux théorique par axe (rendement de la
 *    transmission à la vitesse commandée) ;
 *  - PRÉCISION : répétabilité de N impulsions identiques (moyenne,
 *    écart-type, dispersion) ;
 *  - TRAIN D'ENGRENAGES : régularité du taux (profil par bins, oscillation
 *    crête-à-crête, détection de blocage) ;
 *  - BUTÉES D'ÉLÉVATION : détection d'un ARRÊT SOUTENU du mouvement pendant
 *    une montée/descente → min/max élévation réellement atteignables.
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */
import {gyroRateDegPerSec, rateMagnitudeDegPerSec, dominantAxis, type GyroSample, type VecRate} from './motorcal';

/* ------------------------------------------------------------------ */
/* Outils statistiques                                                  */
/* ------------------------------------------------------------------ */

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/* ------------------------------------------------------------------ */
/* Angle intégré (déplacement réel pendant une impulsion)               */
/* ------------------------------------------------------------------ */

export interface IntegratedAngle {
  /** Déplacement signé sur l'axe dominant (deg). */
  deg: number;
  /** Axe gyro dominant de la fenêtre. */
  axis: 'x' | 'y' | 'z';
  /** Taux moyen sur la fenêtre (deg/s, norme biais soustraite). */
  degPerSec: number;
}

/**
 * Intègre le taux gyro (biais soustrait) sur [t0, t1] et projette sur
 * l'axe dominant de la fenêtre : le déplacement angulaire réel du tube.
 * Les échantillons sont supposés quasi-régulièrement répartis ; l'intégrale
 * est une somme de rectangles (20 Hz : erreur négligeable face au bruit).
 */
export function integrateGyroAngleDeg(
  samples: GyroSample[],
  t0: number,
  t1: number,
  bias: VecRate,
): IntegratedAngle {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
  const r = gyroRateDegPerSec(samples, t0, t1, bias);
  const dom = dominantAxis(r);
  let sum = 0;
  let n = 0;
  for (const s of win) {
    sum += (s[dom.axis] * (180 / Math.PI) - bias[dom.axis]);
    n += 1;
  }
  // Δt moyen entre échantillons (couvre les trous) — sinon pas d'échantillon
  const span = Math.max(1, t1 - t0) / 1000;
  const deg = n >= 2 ? (sum / n) * span : 0;
  return {deg, axis: dom.axis, degPerSec: n >= 2 ? Math.abs(deg / span) : 0};
}

/* ------------------------------------------------------------------ */
/* Ratio par axe                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ratio taux réel / taux théorique, en % (100 = parfait).
 * Renvoie null si le taux théorique est nul ou le réel absent.
 */
export function ratioPct(actualDegPerSec: number | null, theoreticalDegPerSec: number): number | null {
  if (actualDegPerSec == null || theoreticalDegPerSec <= 0) return null;
  return (actualDegPerSec / theoreticalDegPerSec) * 100;
}

/** Statut d'un ratio mesuré : l'électronique Autostar vise ±5 %, la
 *  mécanique (embrayage, tension courroie) élargit la tolérance. */
export function ratioStatus(pct: number | null): 'ok' | 'warn' | 'fail' {
  if (pct == null) return 'fail';
  if (pct >= 70 && pct <= 130) return 'ok';
  if (pct >= 40 && pct <= 200) return 'warn';
  return 'fail';
}

/* ------------------------------------------------------------------ */
/* Précision moteur (répétabilité)                                      */
/* ------------------------------------------------------------------ */

export interface PrecisionStats {
  /** Déplacement moyen par impulsion (deg). */
  meanDeg: number;
  /** Écart-type des déplacements (deg). */
  stdDeg: number;
  /** Dispersion max-min (deg). */
  spreadDeg: number;
  /** Écart-type relatif (% de la moyenne). */
  relPct: number;
}

/** Répétabilité de N impulsions identiques. null si < 2 essais exploitables. */
export function precisionStats(displacementsDeg: number[]): PrecisionStats | null {
  const v = displacementsDeg.filter((d) => Number.isFinite(d) && d > 0);
  if (v.length < 2) return null;
  const m = mean(v);
  const sd = std(v);
  return {
    meanDeg: m,
    stdDeg: sd,
    spreadDeg: Math.max(...v) - Math.min(...v),
    relPct: m > 0 ? (sd / m) * 100 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Train d'engrenages — régularité du taux                              */
/* ------------------------------------------------------------------ */

/**
 * Profil du taux gyro (deg/s, norme biais soustraite) par bins de binMs :
 * médiane de chaque bin (robuste aux échantillons aberrants).
 */
export function rateProfileDegPerSec(
  samples: GyroSample[],
  t0: number,
  t1: number,
  bias: VecRate,
  binMs = 1000,
): number[] {
  const bins: GyroSample[][] = [];
  for (let t = t0; t < t1; t += binMs) {
    bins.push(samples.filter((s) => s.t >= t && s.t < t + binMs));
  }
  const med = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
  };
  return bins.map((b) =>
    med(b.map((s) => rateMagnitudeDegPerSec({
      x: s.x * (180 / Math.PI) - bias.x,
      y: s.y * (180 / Math.PI) - bias.y,
      z: s.z * (180 / Math.PI) - bias.z,
    }))),
  );
}

export interface DrivetrainStats {
  /** Taux médian du profil (deg/s). */
  medianDegPerSec: number;
  /** Oscillation crête-à-crête (% du taux médian). */
  peakToPeakPct: number;
  /** RMS de l'oscillation (% du taux médian). */
  rmsPct: number;
  /** Nombre de bins « bloqués » (< 40 % du taux médian). */
  stallBins: number;
  /** Profil exploitable (assez de bins au-dessus du bruit). */
  valid: boolean;
}

/** Régularité du train d'engrenages sur un profil de taux par bins. */
export function drivetrainStats(profile: number[], noiseFloorDegPerSec = 0.01): DrivetrainStats {
  const active = profile.filter((r) => r > noiseFloorDegPerSec);
  if (active.length < 4) {
    return {medianDegPerSec: 0, peakToPeakPct: 0, rmsPct: 0, stallBins: 0, valid: false};
  }
  const sorted = active.slice().sort((a, b) => a - b);
  const med = sorted.length % 2
    ? sorted[(sorted.length >> 1)]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  if (med <= noiseFloorDegPerSec) {
    return {medianDegPerSec: med, peakToPeakPct: 0, rmsPct: 0, stallBins: 0, valid: false};
  }
  const sd = std(active);
  return {
    medianDegPerSec: med,
    peakToPeakPct: ((Math.max(...active) - Math.min(...active)) / med) * 100,
    rmsPct: med > 0 ? (sd / med) * 100 : 0,
    stallBins: profile.filter((r) => r > noiseFloorDegPerSec && r < 0.4 * med).length
      + profile.filter((r) => r <= noiseFloorDegPerSec).length,
    valid: true,
  };
}

/* ------------------------------------------------------------------ */
/* Butées d'élévation — détection d'arrêt soutenu                       */
/* ------------------------------------------------------------------ */

/**
 * Détecte l'instant où le mouvement S'ARRÊTE de façon soutenue (taux sous
 * stopRatio × taux attendu pendant sustainMs) après fromT — la butée
 * mécanique ou la limite logicielle de la raquette. Renvoie null si le
 * mouvement n'a jamais démarré (déjà en butée) ni ne s'est arrêté.
 */
export function motionStopTime(
  samples: GyroSample[],
  fromT: number,
  untilT: number,
  bias: VecRate,
  expectedRateDegPerSec: number,
  stopRatio = 0.35,
  sustainMs = 600,
): number | null {
  const threshold = Math.max(0.015, expectedRateDegPerSec * stopRatio);
  // 1) le mouvement a-t-il démarré ? (taux > seuil pendant ≥ 300 ms)
  let motionSeen = false;
  let above: number | null = null;
  for (const s of samples) {
    if (s.t < fromT) continue;
    if (s.t > untilT) break;
    const mag = rateMagnitudeDegPerSec({
      x: s.x * (180 / Math.PI) - bias.x,
      y: s.y * (180 / Math.PI) - bias.y,
      z: s.z * (180 / Math.PI) - bias.z,
    });
    if (mag > threshold) {
      if (above == null) above = s.t;
      if (s.t - above >= 300) { motionSeen = true; break; }
    } else {
      above = null;
    }
  }
  if (!motionSeen) return null;
  // 2) premier arrêt soutenu APRÈS le démarrage effectif
  let below: number | null = null;
  for (const s of samples) {
    if (s.t < fromT) continue;
    if (s.t > untilT) break;
    const mag = rateMagnitudeDegPerSec({
      x: s.x * (180 / Math.PI) - bias.x,
      y: s.y * (180 / Math.PI) - bias.y,
      z: s.z * (180 / Math.PI) - bias.z,
    });
    if (mag <= threshold) {
      if (below == null) below = Math.max(s.t, fromT);
      if (s.t - below >= sustainMs) return below;
    } else {
      below = null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Approche de butée en 2 étages (v2.2.0)                               */
/* ------------------------------------------------------------------ */

export type ApproachDecision = 'run' | 'slowdown' | 'stopped';

/**
 * Décision d'approche pendant une jambe du test des butées, d'après les
 * taux récents (deg/s, le plus récent en DERNIER) et le taux attendu :
 *  - 'run'      : le tube avance à (près de) la vitesse commandée ;
 *  - 'slowdown' : le taux est tombé sous slowRatio × attendu — le tube
 *                 approche une résistance (butée, limite logicielle) :
 *                 PASSER EN VITESSE LENTE pour finir doucement ;
 *  - 'stopped'  : le taux est resté sous stopRatio × attendu pendant
 *                 sustainMs — le tube est À L'ARRÊT malgré la commande :
 *                 BUTEE ATTEINTE (ou obstacle).
 *
 * v2.1.0 : la détection demandait un arrêt de 600 ms à 35 % du taux — mais
 * la jambe ne durait que 15 s à la vitesse center (~1,2° de course !) : la
 * butée n'était JAMAIS réellement atteinte et le moindre creux de bruit
 * gyro passait pour un arrêt. v2.2.0 : jambes bornées par la course réelle
 * du preset (limitLegGuardSec), vitesse rapide puis approche lente, arrêt
 * confirmé sur une fenêtre longue (2,5 s) + recoup :Ga# côté orchestrateur.
 */
export function approachStopDecision(
  recentRatesDegPerSec: number[],
  expectedRateDegPerSec: number,
  opts?: {slowRatio?: number; stopRatio?: number; sustainCount?: number},
): ApproachDecision {
  if (recentRatesDegPerSec.length === 0) return 'run';
  const slowRatio = opts?.slowRatio ?? 0.55;
  const stopRatio = opts?.stopRatio ?? 0.30;
  const sustainCount = opts?.sustainCount ?? 5; // ×400 ms d'échantillonnage = 2 s
  const last = recentRatesDegPerSec[recentRatesDegPerSec.length - 1];
  // Arrêt soutenu : les ~1,2 s DERNIERS bins (3 × 400 ms) tous sous
  // stopRatio × attendu. Le bruit gyro ambiant étant ~0,02-0,05 °/s, le
  // seuil absolu 0,015 °/s seul est trop bas près du bruit — le RATIO au
  // taux commandé est la vraie info. Un creux bref (1 bin) ne déclenche
  // jamais l'arrêt : les 3 bins consécutifs finaux sont exigés.
  const stopThresh = Math.max(0.02, expectedRateDegPerSec * stopRatio);
  const tail = recentRatesDegPerSec.slice(-sustainCount);
  const last3 = tail.slice(-3);
  if (last3.length >= 3 && last3.every((r) => r < stopThresh)) {
    return 'stopped';
  }
  const slowThresh = Math.max(0.03, expectedRateDegPerSec * slowRatio);
  if (last < slowThresh) return 'slowdown';
  return 'run';
}
