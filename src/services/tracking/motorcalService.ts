/**
 * Workflows d'auto-calibrage des moteurs par télémétrie gyroscope (v2.0.0).
 *
 * Orchestration concrète des mesures décrites dans astro/motorcal.ts :
 *  - mesureRate(speed, dir)  : biais gyro (1,2 s de repos) → impulsion
 *    4 s dans la direction donnée à la vitesse choisie → taux réel du tube
 *    (axe gyro dominant, biais soustrait) ;
 *  - mesureBacklash(axis)    : amorçage (2,5 s), pause (1 s), INVERSION
 *    (jusqu'à 10 s) → premier mouvement soutenu au gyro = angle de jeu,
 *    converti en secondes d'arc au taux mesuré ;
 *  - mesureDrift()           : 25 s passives moteurs en suivi → dérive
 *    résiduelle vs taux sidéral.
 *
 * Le gyroscope brut est indispensable : le rotation vector est lissé par le
 * filtre de Kalman et masquerait le démarrage du mouvement (backlash).
 */
import {autostar} from '../protocol/client';
import {useScopeStore} from '../../store/scopeStore';
import {useSettingsStore} from '../../store/settingsStore';
import {useMotorCalibStore, type MotorSpeed, type MeasuredRates} from '../../store/motorCalibStore';
import {activePreset as resolveActivePreset} from '../mounts/catalog';
import {startGyro, type GyroEvent} from '../phone/sensors';
import {
  gyroBiasDegPerSec,
  gyroRateDegPerSec,
  gyroNoiseDegPerSec,
  backlashSeconds,
  trackDriftDegPerSec,
  driftVsSiderealArcsecPerSec,
  rateMagnitudeDegPerSec,
  type GyroSample,
} from '../astro/motorcal';
import type {PulseDir} from '../astro/tracking';

let sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms));

/** Injection pour les tests (temps virtuel) — ne pas utiliser en production. */
export function setCalibSleepForTests(fn: (ms: number) => Promise<void>) {
  sleep = fn;
}


/** Annulation (v2.3.0 — l'utilisateur doit pouvoir ARRÊTER une mesure en
 *  cours) : drapeau consulté entre chaque phase motrice ; les mesures
 *  individuelles sont courtes (≤ 6 s) — l'arrêt prend effet à la frontière
 *  de phase suivante, moteurs stoppés. */
let cancelled = false;
export function cancelCalib(): void {cancelled = true;}
function resetCancel(): void {cancelled = false;}
function wasCancelled(): boolean {return cancelled;}

export type CalibPhase =
  | 'idle'
  | 'bias'
  | 'move'
  | 'settle'
  | 'prime'
  | 'gap'
  | 'reverse'
  | 'drift'
  | 'done';

export interface RateMeasureResult {
  degPerSec: number | null;
  noise: number;
}

/** Collecteur gyro : accumule les échantillons pendant le workflow. */
class GyroCollector {
  private release: (() => void) | null = null;
  samples: GyroSample[] = [];

  start(intervalMs = 50) {
    this.samples = [];
    this.release = startGyro((g: GyroEvent) => {
      this.samples.push({t: g.ts, x: g.x, y: g.y, z: g.z});
      if (this.samples.length > 6000) this.samples.shift(); // ~5 min max
    }, intervalMs);
  }

  stop() {
    if (this.release) {
      this.release();
      this.release = null;
    }
  }

  get available(): boolean {
    return this.release != null;
  }
}

export const gyroCollector = new GyroCollector();

function connGuard(): boolean {
  return useScopeStore.getState().connStatus === 'connected' && autostar.isConnected();
}

/** Mesure le taux réel (deg/s sur le tube) d'une direction à une vitesse. */
export async function measureRate(
  speed: MotorSpeed,
  dir: PulseDir,
  onPhase: (p: CalibPhase) => void,
): Promise<RateMeasureResult> {
  if (!connGuard()) return {degPerSec: null, noise: 0};
  // NOTE : pas de resetCancel() ici — measureRate est appelé EN BOUCLE par
  // measureAllDirections ; le drapeau n'est réarmé que par les points
  // d'entrée publics (mesure complète).
  gyroCollector.start(50);
  try {
    // 1. Biais : repos 1,2 s
    onPhase('bias');
    const tBias0 = Date.now();
    await sleep(1200);
    const bias = gyroBiasDegPerSec(
      gyroCollector.samples.filter((s) => s.t >= tBias0),
    );
    // 2. Impulsion 4 s
    onPhase('move');
    await autostar.setSpeed(speed);
    const tMove0 = Date.now();
    await autostar.startMove(dir);
    await sleep(4000);
    await autostar.stopMove(dir);
    // 3. Stabilisation
    onPhase('settle');
    await sleep(800);
    const rate = gyroRateDegPerSec(gyroCollector.samples, tMove0, tMove0 + 4000, bias);
    const noise = gyroNoiseDegPerSec(
      gyroCollector.samples,
      tBias0,
      tMove0 + 4000,
      bias,
    );
    const mag = rateMagnitudeDegPerSec(rate);
    return {degPerSec: mag > 1e-4 ? mag : null, noise};
  } finally {
    gyroCollector.stop();
    onPhase('done');
  }
}

/** Mesure complète des 4 directions à la vitesse donnée → store. */
export async function measureAllDirections(
  speed: MotorSpeed,
  onPhase: (p: CalibPhase, dir?: PulseDir) => void,
): Promise<MeasuredRates | null> {
  if (!connGuard()) return null;
  const dirs: PulseDir[] = ['e', 'w', 'n', 's'];
  const values: Partial<Record<PulseDir, number | null>> = {};
  let noise = 0;
  resetCancel();
  for (const d of dirs) {
    if (wasCancelled()) break;
    onPhase('move', d);
    const r = await measureRate(speed, d, (p) => onPhase(p, d));
    values[d] = r.degPerSec;
    noise = Math.max(noise, r.noise);
    await sleep(600);
  }
  const done = dirs.filter((d) => values[d] !== undefined);
  const allNull = done.every((d) => values[d] == null);
  if (allNull) return null;
  const rates: MeasuredRates = {
    speed,
    n: values.n ?? null,
    s: values.s ?? null,
    e: values.e ?? null,
    w: values.w ?? null,
    noise,
    measuredAt: Date.now(),
  };
  useMotorCalibStore.getState().setRates(rates);
  onPhase('done');
  return rates;
}

/**
 * Backlash d'une paire d'axes. Amorçage dans un sens, pause, inversion :
 * le temps avant mouvement soutenu au gyro donne le jeu, converti en
 * secondes d'arc avec le taux mesuré (à défaut : taux théorique center).
 */
export async function measureBacklash(
  axis: 'ra' | 'dec',
  onPhase: (p: CalibPhase) => void,
): Promise<{arcsec: number | null}> {
  if (!connGuard()) return {arcsec: null};
  resetCancel();
  const mc = useMotorCalibStore.getState();
  // vitesse center : assez rapide pour franchir le seuil gyro, assez douce
  const speed: MotorSpeed = 'center';
  // v2.3.0 : repli = taux center du PRESET de la monture choisie (un DS-114
  // est lent : 0,053°/s — plus de 0,08°/s universel qui faussait la
  // conversion en secondes d'arc sur les montures à pignons).
  const st = useSettingsStore.getState();
  const preset = resolveActivePreset(
      st.mountBrandId, st.mountModelId, st.customMount,
      useScopeStore.getState().model, st.mountPreset);
  const rateDegPerSec =
    (mc.rates?.speed === speed ? (axis === 'ra' ? mc.rates.e ?? mc.rates.w : mc.rates.n ?? mc.rates.s) : null) ??
    preset.expectedRates.center;
  const prime: PulseDir = axis === 'ra' ? 'e' : 'n';
  const reverse: PulseDir = axis === 'ra' ? 'w' : 's';

  gyroCollector.start(40);
  try {
    onPhase('bias');
    const tBias0 = Date.now();
    await sleep(1200);
    const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tBias0));

    onPhase('prime');
    await autostar.setSpeed(speed);
    await autostar.startMove(prime);
    await sleep(2500);
    await autostar.stopMove(prime);
    if (wasCancelled()) return {arcsec: null};

    onPhase('gap');
    await sleep(1000);

    onPhase('reverse');
    await autostar.startMove(reverse);
    const tRev = Date.now();
    // FIX v2.1.0 : COLLECTER d'abord (les événements gyro sont asynchrones —
    // évaluer le tampon immédiatement après startMove le trouvait toujours
    // vide → backlash « non détecté » en permanence sur matériel réel),
    // puis analyser la fenêtre complète.
    await sleep(Math.max(0, 10500 - (Date.now() - tRev)));
    const sec = backlashSeconds(gyroCollector.samples, tRev, 10000, bias, 0.03);
    await autostar.stopMove(reverse);
    onPhase('settle');
    await sleep(800);

    if (sec == null) return {arcsec: null};
    const arcsec = sec * rateDegPerSec * 3600;
    if (axis === 'ra') {
      useMotorCalibStore.getState().setBacklash(arcsec, mc.backlash?.decArcsec ?? null);
    } else {
      useMotorCalibStore.getState().setBacklash(mc.backlash?.raArcsec ?? null, arcsec);
    }
    return {arcsec};
  } finally {
    gyroCollector.stop();
    await autostar.stopAll().catch(() => undefined);
    onPhase('done');
  }
}

/** Dérive de suivi : 25 s passives, moteurs en suivi seul. */
export async function measureDrift(
  onPhase: (p: CalibPhase) => void,
): Promise<{degPerSec: number | null; vsSidereal: number | null}> {
  gyroCollector.start(80);
  try {
    onPhase('bias');
    const tBias0 = Date.now();
    await sleep(1500);
    if (wasCancelled()) return {degPerSec: null, vsSidereal: null};
    const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tBias0));
    onPhase('drift');
    const t0 = Date.now();
    await sleep(25000);
    const drift = trackDriftDegPerSec(gyroCollector.samples, t0, Date.now(), bias);
    const vs = driftVsSiderealArcsecPerSec(drift);
    useMotorCalibStore.getState().setDrift(drift, vs);
    onPhase('done');
    return {degPerSec: drift, vsSidereal: vs};
  } finally {
    gyroCollector.stop();
  }
}

