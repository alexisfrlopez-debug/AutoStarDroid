/**
 * Auto-calibrage des moteurs par télémétrie du téléphone (v2.0.0) —
 * mathématiques pures.
 *
 * Le téléphone, solidaire du tube, mesure avec son GYROSCOPE brut la
 * rotation réelle du télescope pendant que l'app commande les moteurs :
 *  - TAUX : impulsion N/S/E/W à la vitesse choisie → vitesse angulaire
 *    réelle (deg/s) sur le ciel = médiane du gyro pendant l'impulsion
 *    (biais du gyro soustrait via une fenêtre de repos avant l'impulsion) ;
 *  - BACKLASH : impulsion E (amorçage), arrêt, puis impulsion W → temps
 *    avant que le gyro ne détecte le renversement effectif du mouvement ;
 *  - DÉRIVE DE SUIVI : moteurs en suivi seul → vitesse angulaire résiduelle
 *    comparée au taux sidéral (15,041″/s).
 *
 * Ces valeurs alimentent la boucle de suivi (durées d'impulsion exactes)
 * et le statut affiché dans la raquette.
 *
 * 100 % pur TypeScript — testable sous Jest sans RN.
 */

export interface GyroSample {
  /** Horodatage (ms epoch). */
  t: number;
  /** rad/s sur les axes téléphone (convention Android). */
  x: number;
  y: number;
  z: number;
}

export interface VecRate {
  x: number;
  y: number;
  z: number;
}

const R2D = 180 / Math.PI;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Biais du gyro (deg/s) : médiane par axe sur une fenêtre de repos. */
export function gyroBiasDegPerSec(samples: GyroSample[]): VecRate {
  return {
    x: median(samples.map((s) => s.x)) * R2D,
    y: median(samples.map((s) => s.y)) * R2D,
    z: median(samples.map((s) => s.z)) * R2D,
  };
}

/** Vitesse angulaire médiane (deg/s, BIAIS SOUSTRAIT) sur la fenêtre
 *  [t0, t1] (ms epoch). */
export function gyroRateDegPerSec(
  samples: GyroSample[],
  t0: number,
  t1: number,
  bias: VecRate,
): VecRate {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
  return {
    x: median(win.map((s) => s.x)) * R2D - bias.x,
    y: median(win.map((s) => s.y)) * R2D - bias.y,
    z: median(win.map((s) => s.z)) * R2D - bias.z,
  };
}

/** Axe dominant du vecteur vitesse + norme signée sur cet axe. */
export function dominantAxis(r: VecRate): {axis: 'x' | 'y' | 'z'; degPerSec: number} {
  const ax = Math.abs(r.x);
  const ay = Math.abs(r.y);
  const az = Math.abs(r.z);
  if (ax >= ay && ax >= az) return {axis: 'x', degPerSec: r.x};
  if (ay >= az) return {axis: 'y', degPerSec: r.y};
  return {axis: 'z', degPerSec: r.z};
}

/** Norme du vecteur vitesse (deg/s). */
export function rateMagnitudeDegPerSec(r: VecRate): number {
  return Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
}

/** Écart-type du bruit (deg/s) pendant la fenêtre — qualité de mesure. */
export function gyroNoiseDegPerSec(samples: GyroSample[], t0: number, t1: number, bias: VecRate): number {
  const win = samples.filter((s) => s.t >= t0 && s.t <= t1);
  if (win.length < 4) return 0;
  const mags = win.map((s) => rateMagnitudeDegPerSec({
    x: s.x * R2D - bias.x, y: s.y * R2D - bias.y, z: s.z * R2D - bias.z,
  }));
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  const varr = mags.reduce((a, b) => a + (b - mean) * (b - mean), 0) / mags.length;
  return Math.sqrt(varr);
}

/* ------------------------------------------------------------------ */
/* Backlash                                                            */
/* ------------------------------------------------------------------ */

/** Détecte le premier instant où le mouvement devient SOUTENU (norme gyro
 *  au-dessus du seuil pendant `sustainMs`) après `fromT`. Renvoie null si
 *  rien n'est détecté avant `untilT`. */
export function firstSustainedMotion(
  samples: GyroSample[],
  fromT: number,
  untilT: number,
  bias: VecRate,
  thresholdDegPerSec: number,
  sustainMs = 300,
): number | null {
  let above: number | null = null;
  for (const s of samples) {
    if (s.t < fromT) continue;
    if (s.t > untilT) break;
    const mag = rateMagnitudeDegPerSec({
      x: s.x * R2D - bias.x, y: s.y * R2D - bias.y, z: s.z * R2D - bias.z,
    });
    if (mag > thresholdDegPerSec) {
      if (above == null) above = s.t;
      if (s.t - above >= sustainMs) return above;
    } else {
      above = null;
    }
  }
  return null;
}

/** Backlash (s) : temps entre l'envoi du sens inverse et le mouvement
 *  effectif détecté au gyro. Protocol : amorçage (move A), pause, inversion
 *  (move B) à reverseStartT. Renvoie null si le mouvement n'a pas repris. */
export function backlashSeconds(
  samples: GyroSample[],
  reverseStartT: number,
  searchMs: number,
  bias: VecRate,
  thresholdDegPerSec = 0.05,
): number | null {
  const t = firstSustainedMotion(samples, reverseStartT, reverseStartT + searchMs, bias, thresholdDegPerSec);
  if (t == null) return null;
  return Math.max(0, (t - reverseStartT) / 1000);
}

/* ------------------------------------------------------------------ */
/* Dérive de suivi                                                     */
/* ------------------------------------------------------------------ */

/** Dérive résiduelle (deg/s, norme du vecteur vitesse biais soustrait) du
 *  télescope en suivi seul sur la fenêtre donnée. Comparée au taux sidéral
 *  (15,041″/s), elle mesure la qualité du suivi interne de la raquette. */
export function trackDriftDegPerSec(
  samples: GyroSample[],
  t0: number,
  t1: number,
  bias: VecRate,
): number {
  const r = gyroRateDegPerSec(samples, t0, t1, bias);
  return rateMagnitudeDegPerSec(r);
}

/** Écart de suivi vs sidéral, en secondes d'arc par seconde. */
export function driftVsSiderealArcsecPerSec(driftDegPerSec: number): number {
  const SIDEREAL_ARCSEC_PER_SEC = 15.041;
  return (driftDegPerSec * 3600) - SIDEREAL_ARCSEC_PER_SEC;
}

/** Conversion backlash : secondes → secondes d'arc au taux donné. */
export function backlashArcsec(backlashSec: number, rateArcsecPerSec: number): number {
  return backlashSec * rateArcsecPerSec;
}
