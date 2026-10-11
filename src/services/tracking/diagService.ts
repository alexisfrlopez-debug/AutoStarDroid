/**
 * Suite de diagnostic AUTONOME de la monture (v2.1.0) — orchestration.
 *
 * Un seul bouton dans l'onglet Alignement lance une série complète de tests
 * télémétriques (téléphone solidaire du tube, gyroscope brut) :
 *
 *   1. pre        — pré-contrôles : liaison, gyro, biais, bruit ambiant
 *   2. calib      — calibration moteur : taux réels N/S/E/W (→ raquette)
 *   3. ratio      — ratio de chaque axe : taux réel / théorique (%),
 *                   linéarité de l'échelle de vitesses (center vs find)
 *   4. backlash   — jeu mécanique AD et DEC (→ raquette)
 *   5. precision  — précision moteur : répétabilité de 5 impulsions
 *                   identiques (moyenne, écart-type, dispersion)
 *   6. drivetrain — train d'engrenages : régularité du taux, oscillation
 *                   crête-à-crête, détection de blocage
 *   7. limits     — min/max élévation : montée/descente jusqu'à butée
 *                   (arrêt soutenu détecté au gyro) ou garde-fou 15 s
 *   8. drift      — dérive du suivi vs taux sidéral (→ raquette)
 *
 * Sécurité : :Q# (stop) au lancement, entre les tests, à la fin et sur
 * ABORT ; chaque phase bornée dans le temps ; la perte de liaison ou l'absence
 * de gyroscope interrompt la suite ; les résultats alimentent motorCalibStore
 * (impulsions du suivi, anti-backlash) et le rapport est persisté.
 */
import {autostar} from '../protocol/client';
import {useScopeStore} from '../../store/scopeStore';
import {useMotorCalibStore} from '../../store/motorCalibStore';
import {gyroCollector, measureRate, measureBacklash, measureDrift, setCalibSleepForTests} from './motorcalService';
import {sensorsAvailable} from '../phone/sensors';
import {
  gyroBiasDegPerSec,
  rateMagnitudeDegPerSec,
} from '../astro/motorcal';
import {
  DEFAULT_SKY_RATES,
  type PulseDir,
} from '../astro/tracking';
import {
  integrateGyroAngleDeg,
  ratioPct,
  ratioStatus,
  precisionStats,
  rateProfileDegPerSec,
  drivetrainStats,
  motionStopTime,
} from '../astro/diag';

let sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms));
let now: () => number = () => Date.now();

/** Injection pour les tests (temps virtuel) — ne pas utiliser en production. */
export function setDiagSleepForTests(fn: (ms: number) => Promise<void>) {
  sleep = fn;
  setCalibSleepForTests(fn);
}
export function setDiagNowForTests(fn: () => number) {
  now = fn;
}

/* ------------------------------------------------------------------ */
/* Types publics                                                        */
/* ------------------------------------------------------------------ */

export type DiagTestId =
  | 'pre' | 'calib' | 'ratio' | 'backlash'
  | 'precision' | 'drivetrain' | 'limits' | 'drift';

export type DiagStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagTestResult {
  id: DiagTestId;
  status: DiagStatus;
  /** Valeurs clés du test (formatées par l'UI). */
  values: Record<string, number | null>;
  durationMs: number;
}

export interface DiagReport {
  startedAt: number;
  finishedAt: number;
  aborted: boolean;
  results: DiagTestResult[];
}

export interface DiagEvent {
  test: DiagTestId;
  /** Phase libre pour l'UI (mappée sur l'i18n côté composant). */
  phase: 'start' | 'bias' | 'move' | 'settle' | 'profile' | 'up' | 'down' | 'passive' | 'done';
  dir?: PulseDir;
  /** Progression globale 0..1 (durées estimées pondérées). */
  progress: number;
}

/** Durées estimées (s) — progression et affichage UI. */
export const DIAG_TEST_DURATIONS_S: Record<DiagTestId, number> = {
  pre: 5,
  calib: 32,
  ratio: 16,
  backlash: 34,
  precision: 30,
  drivetrain: 42,
  limits: 34,
  drift: 28,
};
export const DIAG_TOTAL_S = Object.values(DIAG_TEST_DURATIONS_S).reduce((a, b) => a + b, 0);

const DIRS: PulseDir[] = ['n', 's', 'e', 'w'];
const R2D = 180 / Math.PI;

function connGuard(): boolean {
  return useScopeStore.getState().connStatus === 'connected' && autostar.isConnected();
}

/* ------------------------------------------------------------------ */
/* Orchestrateur                                                        */
/* ------------------------------------------------------------------ */

class DiagRunner {
  private aborted = false;
  private running = false;

  get isRunning(): boolean {return this.running;}

  /** Demande l'arrêt : la suite s'arrête entre deux étapes, moteurs stoppés. */
  abort() {this.aborted = true;}

  async run(onEvent: (e: DiagEvent) => void): Promise<DiagReport> {
    if (this.running) throw new Error('Diagnostic déjà en cours');
    this.running = true;
    this.aborted = false;
    const startedAt = now();
    const results: DiagTestResult[] = [];
    let elapsedWeight = 0;
    let gyroOk = false;
    const totalWeight = DIAG_TOTAL_S;

    const emit = (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) =>
      onEvent({test, phase, dir, progress: Math.min(0.99, elapsedWeight / totalWeight)});

    const finishTest = (id: DiagTestId, t0: number, status: DiagStatus, values: Record<string, number | null>) => {
      results.push({id, status, values, durationMs: now() - t0});
      elapsedWeight += DIAG_TEST_DURATIONS_S[id];
      emit(id, 'done');
    };

    // Stop de sécurité immédiat
    if (connGuard()) await autostar.stopAll().catch(() => undefined);

    /* -- 1. PRE ------------------------------------------------------ */
    {
      const t0 = now();
      emit('pre', 'start');
      const okLink = connGuard();
      const sensors = okLink ? await sensorsAvailable().catch(() => null) : null;
      gyroOk = okLink && !!sensors?.gyroscope;
      let biasMag: number | null = null;
      let noise: number | null = null;
      if (gyroOk) {
        emit('pre', 'bias');
        gyroCollector.start(50);
        const tb = now();
        await sleep(2500);
        const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
        biasMag = rateMagnitudeDegPerSec(bias);
        const last = gyroCollector.samples.slice(-40);
        let mx = 0;
        for (const s of last) {
          const m = rateMagnitudeDegPerSec({
            x: s.x * R2D - bias.x, y: s.y * R2D - bias.y, z: s.z * R2D - bias.z,
          });
          if (m > mx) mx = m;
        }
        noise = mx;
        gyroCollector.stop();
      }
      const status: DiagStatus = !okLink ? 'fail'
        : !gyroOk ? 'fail'
        : (noise ?? 0) > 0.05 || (biasMag ?? 0) > 0.5 ? 'warn' : 'ok';
      finishTest('pre', t0, status, {biasMagDegPerSec: biasMag, ambientNoiseDegPerSec: noise});
    }

    /* -- 2. CALIB (taux réels 4 directions → raquette) --------------- */
    {
      const t0 = now();
      emit('calib', 'start');
      let rates: Awaited<ReturnType<DiagRunner['measureAllDirs']>> = null;
      if (connGuard() && !this.aborted && gyroOk) {
        rates = await this.safe(() => this.measureAllDirs(emit));
      }
      const vals: Record<string, number | null> = rates
        ? {n: rates.n, s: rates.s, e: rates.e, w: rates.w, noise: rates.noise}
        : {n: null, s: null, e: null, w: null, noise: null};
      const measured = rates ? [rates.n, rates.s, rates.e, rates.w].filter((v) => v != null) as number[] : [];
      const status: DiagStatus = !connGuard() ? 'fail'
        : !gyroOk || (this.aborted && !rates) ? 'skipped'
        : measured.length === 0 ? 'fail'
        : measured.length < 4 ? 'warn' : 'ok';
      finishTest('calib', t0, status, vals);
    }

    /* -- 3. RATIO (rendement par axe + linéarité des vitesses) -------- */
    {
      const t0 = now();
      emit('ratio', 'start');
      const vals: Record<string, number | null> = {pctN: null, pctS: null, pctE: null, pctW: null, linearityPct: null};
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (!gyroOk) status = 'skipped';
      else if (this.aborted) status = 'skipped';
      else {
        emit('ratio', 'move', 'e');
        const re = await this.safe(() => measureRate('find', 'e', () => emit('ratio', 'move', 'e')));
        emit('ratio', 'move', 'n');
        const rn = await this.safe(() => measureRate('find', 'n', () => emit('ratio', 'move', 'n')));
        const mc = useMotorCalibStore.getState().rates;
        const thC = DEFAULT_SKY_RATES.center;
        const thF = DEFAULT_SKY_RATES.find;
        vals.pctN = ratioPct(mc?.n ?? null, thC);
        vals.pctS = ratioPct(mc?.s ?? null, thC);
        vals.pctE = ratioPct(mc?.e ?? null, thC);
        vals.pctW = ratioPct(mc?.w ?? null, thC);
        // linéarité : le taux find doit valoir (find/center) × le taux center
        const linE = ratioPct(re?.degPerSec ?? null, (mc?.e ?? re?.degPerSec ?? thC) * (thF / thC));
        const linN = ratioPct(rn?.degPerSec ?? null, (mc?.n ?? rn?.degPerSec ?? thC) * (thF / thC));
        vals.linearityPct = linE != null && linN != null ? (linE + linN) / 2 : (linE ?? linN);
        const pctList = [vals.pctN, vals.pctS, vals.pctE, vals.pctW].filter((v) => v != null) as number[];
        const sts = pctList.map(ratioStatus);
        const linSt = ratioStatus(vals.linearityPct);
        status = pctList.length === 0 ? 'fail'
          : sts.includes('fail') || linSt === 'fail' ? 'fail'
          : sts.includes('warn') || linSt === 'warn' || pctList.length < 4 ? 'warn' : 'ok';
      }
      finishTest('ratio', t0, status, vals);
    }

    /* -- 4. BACKLASH (jeu AD/DEC → raquette) -------------------------- */
    {
      const t0 = now();
      emit('backlash', 'start');
      let ra: number | null = null;
      let dec: number | null = null;
      if (connGuard() && !this.aborted && gyroOk) {
        emit('backlash', 'move', 'e');
        ra = (await this.safe(() => measureBacklash('ra', () => emit('backlash', 'move', 'w'))))?.arcsec ?? null;
        if (!this.aborted && connGuard()) {
          emit('backlash', 'move', 'n');
          dec = (await this.safe(() => measureBacklash('dec', () => emit('backlash', 'move', 's'))))?.arcsec ?? null;
        }
      }
      const status: DiagStatus = !connGuard() ? 'fail'
        : !gyroOk || (this.aborted && ra == null && dec == null) ? 'skipped'
        : ra == null && dec == null ? 'fail'
        : ra == null || dec == null ? 'warn'
        : Math.max(ra, dec) > 600 ? 'warn' : 'ok';
      finishTest('backlash', t0, status, {raArcsec: ra, decArcsec: dec});
    }

    /* -- 5. PRECISION (répétabilité de 5 impulsions identiques) -------- */
    {
      const t0 = now();
      emit('precision', 'start');
      let displacements: number[] = [];
      if (connGuard() && !this.aborted && gyroOk) {
        displacements = await this.safe(() => this.measurePrecision(emit)) ?? [];
      }
      const stats = precisionStats(displacements);
      const status: DiagStatus = !connGuard() ? 'fail'
        : !gyroOk || (this.aborted && !stats) ? 'skipped'
        : !stats ? 'fail'
        : stats.relPct > 12 ? 'warn' : 'ok';
      finishTest('precision', t0, status, stats
        ? {meanDeg: stats.meanDeg, stdDeg: stats.stdDeg, spreadDeg: stats.spreadDeg, relPct: stats.relPct}
        : {meanDeg: null, stdDeg: null, spreadDeg: null, relPct: null});
    }

    /* -- 6. DRIVETRAIN (régularité du train d'engrenages) -------------- */
    {
      const t0 = now();
      emit('drivetrain', 'start');
      let vals: Record<string, number | null> = {
        pctP2PE: null, rmsPctE: null, stallsE: null, pctP2PN: null, rmsPctN: null, stallsN: null,
      };
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (!gyroOk || (this.aborted && vals.pctP2PE == null)) status = 'skipped';
      else {
        const res = await this.safe(() => this.measureDrivetrain(emit));
        if (res) {
          const stE = drivetrainStats(res.profileE);
          const stN = drivetrainStats(res.profileN);
          vals = {
            pctP2PE: stE.valid ? stE.peakToPeakPct : null,
            rmsPctE: stE.valid ? stE.rmsPct : null,
            stallsE: stE.valid ? stE.stallBins : null,
            pctP2PN: stN.valid ? stN.peakToPeakPct : null,
            rmsPctN: stN.valid ? stN.rmsPct : null,
            stallsN: stN.valid ? stN.stallBins : null,
          };
          const good = [stE, stN].filter((st) => st.valid);
          status = good.length === 0 ? 'fail'
            : good.some((st) => st.peakToPeakPct > 25 || st.stallBins > 0) ? 'warn' : 'ok';
        } else {
          status = 'fail';
        }
      }
      finishTest('drivetrain', t0, status, vals);
    }

    /* -- 7. LIMITS (min/max élévation) --------------------------------- */
    {
      const t0 = now();
      emit('limits', 'start');
      let vals: Record<string, number | null> = {
        altStartDeg: null, maxAltDeg: null, minAltDeg: null, upDeg: null, downDeg: null,
      };
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (!gyroOk || this.aborted) status = 'skipped';
      else {
        const res = await this.safe(() => this.measureLimits(emit));
        if (res) {
          vals = {
            altStartDeg: res.altStart,
            maxAltDeg: res.maxAlt,
            minAltDeg: res.minAlt,
            upDeg: res.upDeg,
            downDeg: res.downDeg,
          };
          const moved = (res.upDeg ?? 0) > 0.05 || (res.downDeg ?? 0) > 0.05;
          status = !moved && !res.hitUp && !res.hitDown ? 'fail' : moved ? 'ok' : 'warn';
        } else {
          status = 'fail';
        }
      }
      finishTest('limits', t0, status, vals);
    }

    /* -- 8. DRIFT (dérive du suivi → raquette) ------------------------- */
    {
      const t0 = now();
      emit('drift', 'start');
      let drift: {degPerSec: number | null; vsSidereal: number | null} | null = null;
      if (connGuard() && !this.aborted && gyroOk) {
        drift = await this.safe(() => measureDrift(() => emit('drift', 'passive')));
      }
      const status: DiagStatus = !connGuard() ? 'fail'
        : !gyroOk || (this.aborted && !drift) ? 'skipped'
        : !drift || drift.degPerSec == null ? 'fail'
        : Math.abs(drift.vsSidereal ?? 0) > 15 ? 'warn' : 'ok';
      finishTest('drift', t0, status, {
        driftDegPerSec: drift?.degPerSec ?? null,
        vsSiderealArcsecPerSec: drift?.vsSidereal ?? null,
      });
    }

    // Stop final + arrêt propre
    if (connGuard()) await autostar.stopAll().catch(() => undefined);

    this.running = false;
    return {startedAt, finishedAt: now(), aborted: this.aborted, results};
  }

  /* ---------------------------------------------------------------- */

  private async safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (_) {
      return null;
    }
  }

  /** 4 directions via measureRate (qui persiste dans motorCalibStore). */
  private async measureAllDirs(
    emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void,
  ): Promise<{
    speed: 'center'; n: number | null; s: number | null; e: number | null; w: number | null;
    noise: number; measuredAt: number;
  } | null> {
    const speed = 'center' as const;
    const values: Partial<Record<PulseDir, number | null>> = {};
    let noise = 0;
    for (const d of DIRS) {
      if (this.aborted) break;
      emit('calib', 'move', d);
      const r = await measureRate(speed, d, () => emit('calib', 'move', d));
      values[d] = r.degPerSec;
      noise = Math.max(noise, r.noise);
      await sleep(600);
    }
    const allNull = DIRS.every((d) => values[d] == null);
    if (allNull) return null;
    const rates = {
      speed,
      n: values.n ?? null,
      s: values.s ?? null,
      e: values.e ?? null,
      w: values.w ?? null,
      noise,
      measuredAt: now(),
    };
    useMotorCalibStore.getState().setRates(rates);
    return rates;
  }

  /**
   * Précision : 5 impulsions identiques E (2 s à center) séparées par un
   * retour approximatif W ; le déplacement de CHAQUE impulsion est intégré
   * au gyro → moyenne/écart-type/dispersion (répétabilité).
   */
  private async measurePrecision(emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void) {
    gyroCollector.start(50);
    try {
      emit('precision', 'bias');
      const tb = now();
      await sleep(1500);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
      await autostar.setSpeed('center');
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        if (this.aborted) break;
        emit('precision', 'move', 'e');
        const tm = now();
        await autostar.startMove('e');
        await sleep(2000);
        await autostar.stopMove('e');
        // Fenêtre = durée réelle de l'impulsion : au moment de l'évaluation,
        // les échantillons au-delà de la fin du mouvement n'existent pas
        // encore (événements gyro asynchrones) — et l'inertie résiduelle
        // n'est pas représentative d'une impulsion identique répétée.
        const a = integrateGyroAngleDeg(gyroCollector.samples, tm, tm + 2000, bias);
        if (Math.abs(a.deg) > 0.01) out.push(Math.abs(a.deg));
        emit('precision', 'settle');
        await sleep(600);
        // retour approximatif (la répétabilité se mesure impulsion par impulsion)
        await autostar.startMove('w');
        await sleep(2200);
        await autostar.stopMove('w');
        await sleep(600);
      }
      return out;
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
  }

  /**
   * Train d'engrenages : mouvement continu à find — profil du taux par bins
   * de 1 s (25 s sur l'axe AD, 15 s sur DEC) → oscillation + blocages.
   */
  private async measureDrivetrain(emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void) {
    gyroCollector.start(50);
    try {
      emit('drivetrain', 'bias');
      const tb = now();
      await sleep(1200);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
      await autostar.setSpeed('find');
      // Axe AD (E) — 25 s
      emit('drivetrain', 'profile', 'e');
      const tE = now();
      await autostar.startMove('e');
      await sleep(25000);
      await autostar.stopMove('e');
      await sleep(500);
      const profileE = rateProfileDegPerSec(gyroCollector.samples, tE, tE + 25000, bias, 1000);
      await sleep(800);
      // Axe DEC (N) — 15 s
      if (this.aborted) return {profileE, profileN: []};
      emit('drivetrain', 'profile', 'n');
      const tN = now();
      await autostar.startMove('n');
      await sleep(15000);
      await autostar.stopMove('n');
      await sleep(500);
      const profileN = rateProfileDegPerSec(gyroCollector.samples, tN, tN + 15000, bias, 1000);
      return {profileE, profileN};
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
  }

  /**
   * Min/max élévation : montée N jusqu'à ARRÊT SOUTENU du tube (butée
   * mécanique ou limite logicielle) — garde-fou 15 s — puis descente S.
   * Les altitudes absolues viennent de la raquette (:Ga#) quand elle
   * répond, les déplacements du gyro intégré (toujours disponibles).
   */
  private async measureLimits(emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void) {
    const mc = useMotorCalibStore.getState().rates;
    const rateDeg = mc?.n ?? DEFAULT_SKY_RATES.center;
    const alt0 = await autostar.readAltAz().catch(() => null);
    const altStart = alt0?.altDeg ?? null;
    gyroCollector.start(50);
    try {
      emit('limits', 'bias');
      const tb = now();
      await sleep(1200);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
      await autostar.setSpeed('center');

      const leg = async (dir: PulseDir, phase: 'up' | 'down'): Promise<{deg: number; hit: boolean}> => {
        emit('limits', phase, dir);
        const t0 = now();
        await autostar.startMove(dir);
        let hit = false;
        // Surveillance : arrêt soutenu du mouvement = butée atteinte
        while (now() - t0 < 15000) {
          await sleep(400);
          if (this.aborted) break;
          const stop = motionStopTime(gyroCollector.samples, t0, now(), bias, rateDeg || 0.08);
          if (stop != null && stop < now() - 600) {hit = true; break;}
        }
        await autostar.stopMove(dir);
        const deg = Math.abs(integrateGyroAngleDeg(gyroCollector.samples, t0, now(), bias).deg);
        await sleep(700);
        return {deg, hit};
      };

      const up = await leg('n', 'up');
      const down = this.aborted ? {deg: 0, hit: false} : await leg('s', 'down');
      const altNow = await autostar.readAltAz().catch(() => null);
      // max/min atteints : altitude raquette si lisible, sinon reconstruction
      const maxAlt = altNow?.altDeg != null && up.hit
        ? Math.min(90, altNow.altDeg)
        : altStart != null ? Math.min(90, altStart + up.deg) : null;
      const minAlt = altNow?.altDeg != null && down.hit
        ? Math.max(0, altNow.altDeg)
        : altStart != null ? Math.max(0, altStart - down.deg) : null;
      return {altStart, maxAlt, minAlt, upDeg: up.deg, downDeg: down.deg, hitUp: up.hit, hitDown: down.hit};
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
  }
}

/** Instance unique : l'UI garde la référence pour pouvoir ABORT. */
export const diagRunner = new DiagRunner();
