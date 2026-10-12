/**
 * Contrôle croisé GOTO : télémétrie du téléphone vs mouvement des moteurs
 * (v2.3.0 — demande utilisateur : « lors de ce goto, je veux que l'appli
 * compare l'évolution de la télémétrie du téléphone et le mouvement des
 * moteurs, en gardant en tête que la télémétrie peut être faussée ou avoir
 * des problèmes de sensibilité — vérifier si l'évolution de la télémétrie
 * est suffisamment fluide pour se caler dessus »).
 *
 * PRINCIPE — deux vérités indépendantes du même slew :
 *  - les MOTEURS : le gyroscope brut du téléphone (solidaire du tube)
 *    intègre le chemin angulaire réellement parcouru — c'est la référence
 *    physique, insensible aux champs magnétiques ;
 *  - la TÉLÉMÉTRIE : le rotation vector (boussole + accéléro + gyro)
 *    donne l'orientation absolue — la distance de rotation entre le
 *    premier et chaque quaternion suivant reconstitue SON arc parcouru.
 *
 * Si la télémétrie est saine, les deux arcs progressent ensemble (ratio
 * proche de 1). Si elle décroche (champs parasites, métal du tube, étalons
 * perdus), elle décroche SEULE : trous d'échantillonnage, pas erratiques,
 * arc divergent — c'est ce que la garde de fluidité détecte AVANT que le
 * réglage fin automatique ne s'appuie dessus pour actionner les moteurs.
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */

export interface TeleSample {
  /** Horodatage (ms). */
  t: number;
  /** Quaternion du rotation vector (composantes brutes Android). */
  qw: number;
  qx: number;
  qy: number;
  qz: number;
}

/** Gyroscope brut : rad/s sur les axes téléphone (cf. motorcal.GyroSample). */
export interface GyroLite {
  t: number;
  x: number;
  y: number;
  z: number;
}

const R2D = 180 / Math.PI;

/** Distance de rotation entre deux quaternions (deg) — 2·acos(|q1·q2|). */
export function quatAngleDeg(
  a: {qw: number; qx: number; qy: number; qz: number},
  b: {qw: number; qx: number; qy: number; qz: number},
): number {
  const d = Math.abs(a.qw * b.qw + a.qx * b.qx + a.qy * b.qy + a.qz * b.qz);
  return 2 * Math.acos(Math.min(1, Math.max(-1, d))) * R2D;
}

/** Norme du taux gyro biais soustrait (deg/s) d'un échantillon. */
export function gyroRateMagDegPerSec(s: GyroLite, bias: GyroLite): number {
  return Math.hypot(s.x - bias.x, s.y - bias.y, s.z - bias.z) * R2D;
}

/**
 * Chemin angulaire PARCOURU par le tube (deg) : somme des |ω|·dt — la
 * longueur d'arc physique, indépendante de l'axe (slew bi-axes inclus).
 */
export function gyroPathDeg(samples: GyroLite[], t0: number, t1: number, bias: GyroLite): number {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1).sort((a, b) => a.t - b.t);
  let path = 0;
  for (let i = 1; i < win.length; i++) {
    const dt = (win[i].t - win[i - 1].t) / 1000;
    if (dt <= 0 || dt > 2) continue; // trou : hors intégration
    path += gyroRateMagDegPerSec(win[i], bias) * dt;
  }
  return path;
}

/** Chemin angulaire reconstruit par la TÉLÉMÉTRIE (deg) : somme des angles
 *  de rotation consécutifs du quaternion — son propre « chemin d'arc ». */
export function telePathDeg(samples: TeleSample[], t0: number, t1: number): number {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1).sort((a, b) => a.t - b.t);
  let path = 0;
  for (let i = 1; i < win.length; i++) {
    path += quatAngleDeg(win[i - 1], win[i]);
  }
  return path;
}

/* ------------------------------------------------------------------ */
/* Garde de fluidité                                                    */
/* ------------------------------------------------------------------ */

export interface Smoothness {
  /** Verdict de fluidité (les raisons détaillées sont dans les champs). */
  ok: boolean;
  /** Nombre d'échantillons exploitables. */
  n: number;
  /** Plus grand trou d'échantillonnage (ms) — null si < 2 échantillons. */
  gapMaxMs: number | null;
  /** Bruit relatif : écart-type / moyenne des pas (0 = lisse). */
  jitterPct: number | null;
  /** Pas aberrants (sauts > 6× le pas médian) — parasites magnétiques. */
  spikeCount: number;
  /** Pas gelés (< 0,02°) en fraction — un flux figé n'est pas un flux. */
  frozenPct: number | null;
  /** Pas moyen (deg) sur la fenêtre. */
  meanStepDeg: number | null;
}

/**
 * La télémétrie est-elle SUFFISAMMENT FLUIDE pour s'y caler ? Quatre
 * critères indépendants, calibrés pour un rotation vector à 5-10 Hz :
 *  - pas de trou > 2,5× l'intervalle nominal (capteur qui décroche) ;
 *  - bruit relatif (std/mean des pas) ≤ 80 % — au-delà, la boussole
 *    tremble plus qu'elle ne tourne ;
 *  - ≤ 2 sauts aberrants (> 6× le pas médian) — sauts magnétiques ;
 *  - ≤ 40 % de pas gelés — un flux figé (étalon perdu) ne suit plus le tube.
 */
export function smoothnessOf(
  samples: TeleSample[],
  t0: number,
  t1: number,
  expectedIntervalMs: number,
): Smoothness {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1).sort((a, b) => a.t - b.t);
  const n = win.length;
  const base: Smoothness = {
    ok: false, n, gapMaxMs: null, jitterPct: null,
    spikeCount: 0, frozenPct: null, meanStepDeg: null,
  };
  if (n < 6) return base; // trop peu d'échantillons : verdict inconnu

  let gapMax = 0;
  const steps: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = win[i].t - win[i - 1].t;
    if (dt > gapMax) gapMax = dt;
    steps.push(quatAngleDeg(win[i - 1], win[i]));
  }
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const varr = steps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / steps.length;
  const stdv = Math.sqrt(varr);
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const spikes = steps.filter((v) => v > 6 * Math.max(median, 0.05)).length;
  const frozen = steps.filter((v) => v < 0.02).length;

  const gapMaxMs = gapMax;
  const jitterPct = mean > 1e-6 ? (stdv / mean) * 100 : null;
  const frozenPct = (frozen / steps.length) * 100;

  const gapOk = gapMax <= Math.max(2.5 * Math.max(expectedIntervalMs, 50), 1200);
  const jitterOk = jitterPct == null || jitterPct <= 80;
  const spikeOk = spikes <= 2;
  const frozenOk = frozenPct != null && frozenPct <= 40;
  const moving = mean > 0.005; // la fenêtre couvre un vrai mouvement

  return {
    ok: gapOk && jitterOk && spikeOk && frozenOk && moving,
    n,
    gapMaxMs,
    jitterPct,
    spikeCount: spikes,
    frozenPct,
    meanStepDeg: mean,
  };
}

/* ------------------------------------------------------------------ */
/* Verdict croisé                                                       */
/* ------------------------------------------------------------------ */

export type GotoCheckVerdict = 'good' | 'poor' | 'unknown';

export interface GotoCross {
  verdict: GotoCheckVerdict;
  /** Chemin parcouru selon les MOTEURS (gyro intégré, deg). */
  gyroDeg: number;
  /** Chemin parcouru selon la TÉLÉMÉTRIE (deg). */
  teleDeg: number;
  /** télémétrie / moteurs — ~1 si les deux voient la même chose. */
  ratio: number | null;
  /** Garde de fluidité de la télémétrie. */
  smooth: Smoothness;
  /** Raisons lisibles (clés i18n) quand verdict ≠ good. */
  reasons: string[];
}

export interface CrossCheckOpts {
  /** Intervalle nominal d'échantillonnage télémétrie (ms). */
  expectedTeleMs: number;
  /** Biais gyro mesuré avant le slew (rad/s par axe). */
  bias: GyroLite;
}

/**
 * Verdict croisé sur une fenêtre de slew [t0, t1] :
 *  - 'unknown' : pas assez de télémétrie (capteurs absents/muets) — on ne
 *    conclut rien, le réglage fin décidera avec SES propres mesures ;
 *  - 'poor'    : fluidité insuffisante OU arc télémétrie divergent de
 *    l'arc moteurs (ratio hors 0,5..2,0 avec un chemin significatif) —
 *    la télémétrie n'est PAS fiable pour guider des moteurs ;
 *  - 'good'    : fluide et concordante — la télémétrie peut se caler dessus.
 */
export function crossCheck(
  gyro: GyroLite[],
  tele: TeleSample[],
  t0: number,
  t1: number,
  opts: CrossCheckOpts,
): GotoCross {
  const smooth = smoothnessOf(tele, t0, t1, opts.expectedTeleMs);
  const gyroDeg = gyroPathDeg(gyro, t0, t1, opts.bias);
  const teleDeg = telePathDeg(tele, t0, t1);
  const reasons: string[] = [];

  if (smooth.n < 6) {
    return {
      verdict: 'unknown', gyroDeg, teleDeg, ratio: null, smooth,
      reasons: ['sky.reasonFew'],
    };
  }
  const ratio = gyroDeg > 0.5 ? teleDeg / gyroDeg : null;

  if (!smooth.ok) {
    if (smooth.gapMaxMs != null && smooth.gapMaxMs > Math.max(2.5 * Math.max(opts.expectedTeleMs, 50), 1200)) {
      reasons.push('sky.reasonGaps');
    }
    if (smooth.jitterPct != null && smooth.jitterPct > 80) reasons.push('sky.reasonJitter');
    if (smooth.spikeCount > 2) reasons.push('sky.reasonSpikes');
    if (smooth.frozenPct != null && smooth.frozenPct > 40) reasons.push('sky.reasonFrozen');
    if (smooth.meanStepDeg != null && smooth.meanStepDeg <= 0.005) reasons.push('sky.reasonStatic');
  }
  if (ratio != null && (ratio < 0.5 || ratio > 2.0)) {
    reasons.push('sky.reasonRatio');
  }

  return {
    verdict: reasons.length === 0 ? 'good' : 'poor',
    gyroDeg,
    teleDeg,
    ratio,
    smooth,
    reasons,
  };
}
