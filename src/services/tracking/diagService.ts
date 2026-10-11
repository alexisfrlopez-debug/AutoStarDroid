/**
 * Suite de diagnostic AUTONOME de la monture (v2.2.0) — orchestration.
 *
 * Un seul bouton dans l'onglet Alignement lance une série complète de tests
 * télémétriques (téléphone solidaire du tube, gyroscope brut) :
 *
 *   1. pre        — pré-contrôles : liaison, gyro, biais, bruit ambiant
 *   2. calib      — calibration moteur : taux réels N/S/E/W (→ raquette)
 *   3. ratio      — ratio de chaque axe : taux réel / théorique (%),
 *                   linéarité de l'échelle de vitesses (center/find/slew)
 *   4. backlash   — jeu mécanique AD et DEC (→ raquette)
 *   5. precision  — précision moteur : répétabilité de 5 impulsions
 *                   identiques (moyenne, écart-type, dispersion)
 *   6. drivetrain — train d'engrenages : régularité du taux, oscillation
 *                   crête-à-crête, détection de blocage (chien de garde
 *                   butée : la jambe s'arrête net si le tube bloque)
 *   7. limits     — min/max élévation : approche en DEUX ÉTAGES (vitesse
 *                   find puis vitesse center) jusqu'à ARRÊT SOUTENU du tube
 *                   confirmé au gyro, course bornée par le preset de
 *                   monture, altitude limite recoupée à :Ga# (v2.2.0)
 *   8. goto       — précision de pointage : GOTO une étoile brillante,
 *                   attente d'arrivée, erreur résiduelle mesurée par le
 *                   recalage télémétrique (v2.2.0)
 *   9. drift      — dérive du suivi vs taux sidéral (→ raquette)
 *  10. handbox    — MISE À JOUR DE LA RAQUETTE PHYSIQUE : horloge/site +
 *                   rétro-jeu déduit des mesures (menus pilotés au miroir
 *                   :ED# — v2.2.0, demande utilisateur)
 *
 * Sécurité : :Q# (stop) au lancement, entre les tests, à la fin et sur
 * ABORT ; chaque phase bornée dans le temps (garde calculée sur la course
 * réelle du preset) ; la perte de liaison ou l'absence de gyroscope
 * interrompt la suite ; les résultats alimentent motorCalibStore (impulsions
 * du suivi, anti-backlash) et le rapport est persisté.
 */
import {autostar} from '../protocol/client';
import {useScopeStore} from '../../store/scopeStore';
import {useSettingsStore} from '../../store/settingsStore';
import {useMotorCalibStore} from '../../store/motorCalibStore';
import {gyroCollector, measureRate, measureBacklash, measureDrift, setCalibSleepForTests} from './motorcalService';
import {sensorsAvailable, startOrientation} from '../phone/sensors';
import {
  gyroBiasDegPerSec,
  rateMagnitudeDegPerSec,
} from '../astro/motorcal';
import {
  DEFAULT_SKY_RATES,
  pointingError,
  type PulseDir,
} from '../astro/tracking';
import {
  integrateGyroAngleDeg,
  ratioPct,
  ratioStatus,
  precisionStats,
  rateProfileDegPerSec,
  drivetrainStats,
  approachStopDecision,
} from '../astro/diag';
import {resolvePreset, limitLegGuardSec} from '../astro/mounts';
import {telemetryFitOf, useTelemetryStore} from '../../store/telemetryStore';
import {applyFit, type Quat} from '../astro/telemetry';
import {withAlt, type DisplayObject} from '../catalog';
import {BRIGHT_STARS} from '../catalog/stars';
import {pushCalibToHandbox} from '../protocol/handboxPush';

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
  | 'precision' | 'drivetrain' | 'limits' | 'goto' | 'drift' | 'handbox';

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
  phase: 'start' | 'bias' | 'move' | 'settle' | 'profile' | 'up' | 'down' | 'slow' | 'travel' | 'passive' | 'done';
  dir?: PulseDir;
  /** Progression globale 0..1 (durées estimées pondérées). */
  progress: number;
}

/** Durées estimées (s) — progression et affichage UI. */
export const DIAG_TEST_DURATIONS_S: Record<DiagTestId, number> = {
  pre: 5,
  calib: 32,
  ratio: 24,
  backlash: 34,
  precision: 30,
  drivetrain: 42,
  limits: 95,
  goto: 60,
  drift: 28,
  handbox: 10,
};
export const DIAG_TOTAL_S = Object.values(DIAG_TEST_DURATIONS_S).reduce((a, b) => a + b, 0);

const DIRS: PulseDir[] = ['n', 's', 'e', 'w'];
const R2D = 180 / Math.PI;

/** Fenêtre d'échantillonnage des décisions de butée (ms). */
const LIMIT_TICK_MS = 400;
/** Fenêtre de taux récents pour la décision (× tick = 2 s). */
const LIMIT_WINDOW_MS = 2000;
/** Ignorer le démarrage moteur (accélération) avant toute décision. */
const LIMIT_SPINUP_SKIP_MS = 1500;
/** Approche lente : garde maximale de l'étage center. */
const LIMIT_SLOW_GUARD_S = 90;
/** Attente d'arrivée GOTO (max, s). */
const GOTO_ARRIVE_GUARD_S = 180;

function connGuard(): boolean {
  return useScopeStore.getState().connStatus === 'connected' && autostar.isConnected();
}

/** Taux récents (deg/s) en bins médians de tickMs — entrée de la décision
 *  d'approche. Le plus récent en DERNIER. */
function recentRates(samples: Parameters<typeof rateProfileDegPerSec>[0], fromT: number, toT: number, bias: Parameters<typeof rateProfileDegPerSec>[3]): number[] {
  const f = fromT > toT - LIMIT_WINDOW_MS ? toT - LIMIT_WINDOW_MS : fromT;
  return rateProfileDegPerSec(samples, Math.max(fromT, f), toT, bias, LIMIT_TICK_MS);
}

/* ------------------------------------------------------------------ */
/* Orchestrateur                                                        */
/* ------------------------------------------------------------------ */

class DiagRunner {
  private aborted = false;
  private running = false;
  /** Mesures intermédiaires partagées entre phases (ratio → drivetrain/limits). */
  private suiteFindRate: number | null = null;
  private suiteSlewRate: number | null = null;

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
    this.suiteFindRate = null;
    this.suiteSlewRate = null;

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
      const vals: Record<string, number | null> = {
        pctN: null, pctS: null, pctE: null, pctW: null,
        linearityPct: null, pctSlew: null,
      };
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (!gyroOk) status = 'skipped';
      else if (this.aborted) status = 'skipped';
      else {
        emit('ratio', 'move', 'e');
        const re = await this.safe(() => measureRate('find', 'e', () => emit('ratio', 'move', 'e')));
        if (!this.aborted) {
          emit('ratio', 'move', 'n');
          const rn = await this.safe(() => measureRate('find', 'n', () => emit('ratio', 'move', 'n')));
          this.suiteFindRate = re?.degPerSec ?? rn?.degPerSec ?? null;
          // Slew : impulsion COURTE (1,2 s) + chien de garde butée — le slew
          // réel va 5-7°/s : 1,2 s = 6-8° de course, sans risque de fin de
          // course non surveillée.
          if (!this.aborted && connGuard()) {
            emit('ratio', 'move', 'e');
            const rs = await this.safe(() => this.measureSlew(emit, 'e'));
            this.suiteSlewRate = rs;
          }
          const mc = useMotorCalibStore.getState().rates;
          const thC = DEFAULT_SKY_RATES.center;
          const thF = DEFAULT_SKY_RATES.find;
          vals.pctN = ratioPct(mc?.n ?? null, thC);
          vals.pctS = ratioPct(mc?.s ?? null, thC);
          vals.pctE = ratioPct(mc?.e ?? null, thC);
          vals.pctW = ratioPct(mc?.w ?? null, thC);
          // linéarité find : le taux find doit valoir (find/center) × center
          const linE = ratioPct(re?.degPerSec ?? null, (mc?.e ?? re?.degPerSec ?? thC) * (thF / thC));
          const linN = ratioPct(rn?.degPerSec ?? null, (mc?.n ?? rn?.degPerSec ?? thC) * (thF / thC));
          vals.linearityPct = linE != null && linN != null ? (linE + linN) / 2 : (linE ?? linN);
          // linéarité slew : taux slew réel vs center × (slew/center) preset
          const preset = this.activePreset();
          const slewExp = (mc?.e ?? thC) * (preset.expectedRates.slew / preset.expectedRates.center);
          vals.pctSlew = ratioPct(this.suiteSlewRate, slewExp);
          const pctList = [vals.pctN, vals.pctS, vals.pctE, vals.pctW].filter((v) => v != null) as number[];
          const sts = pctList.map(ratioStatus);
          const linSt = ratioStatus(vals.linearityPct);
          const slewSt = vals.pctSlew != null ? ratioStatus(vals.pctSlew) : null;
          status = pctList.length === 0 ? 'fail'
            : sts.includes('fail') || linSt === 'fail' || slewSt === 'fail' ? 'fail'
            : sts.includes('warn') || linSt === 'warn' || slewSt === 'warn' || pctList.length < 4 ? 'warn' : 'ok';
        } else {
          status = 'skipped';
        }
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

    /* -- 7. LIMITS (min/max élévation, v2.2.0) ------------------------- */
    {
      const t0 = now();
      emit('limits', 'start');
      let vals: Record<string, number | null> = {
        altStartDeg: null, maxAltDeg: null, minAltDeg: null,
        upDeg: null, downDeg: null, hitUp: null, hitDown: null,
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
            hitUp: res.hitUp ? 1 : 0,
            hitDown: res.hitDown ? 1 : 0,
          };
          const moved = (res.upDeg ?? 0) > 0.05 || (res.downDeg ?? 0) > 0.05;
          status = !moved && !res.hitUp && !res.hitDown ? 'fail' : 'ok';
        } else {
          status = 'fail';
        }
      }
      finishTest('limits', t0, status, vals);
    }

    /* -- 8. GOTO (précision de pointage, v2.2.0) ----------------------- */
    {
      const t0 = now();
      emit('goto', 'start');
      let vals: Record<string, number | null> = {gotoErrArcmin: null, gotoOk: null};
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (!gyroOk || this.aborted) status = 'skipped';
      else {
        const fit = telemetryFitOf(useTelemetryStore.getState().points);
        if (!fit || fit.rmsDeg > 0.5) {
          status = 'skipped'; // recalage télémétrique requis pour mesurer
        } else {
          const res = await this.safe(() => this.measureGotoAccuracy(emit));
          if (res && res.errArcmin != null) {
            vals = {gotoErrArcmin: res.errArcmin, gotoOk: 1};
            status = res.errArcmin < 5 ? 'ok' : res.errArcmin < 15 ? 'warn' : 'fail';
          } else if (res) {
            vals = {gotoErrArcmin: null, gotoOk: 0}; // GOTO refusé/muet
            status = 'warn';
          } else {
            status = 'fail';
          }
        }
      }
      finishTest('goto', t0, status, vals);
    }

    /* -- 9. DRIFT (dérive du suivi → raquette) ------------------------- */
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

    /* -- 10. HANDBOX (mise à jour de la raquette physique, v2.2.0) ----- */
    {
      const t0 = now();
      emit('handbox', 'start');
      let vals: Record<string, number | null> = {clockOk: null, raPct: null, decPct: null};
      let status: DiagStatus;
      if (!connGuard()) status = 'fail';
      else if (this.aborted) status = 'skipped';
      else {
        const st = useSettingsStore.getState();
        const mc = useMotorCalibStore.getState();
        const rep = await this.safe(() => pushCalibToHandbox({
          latDeg: st.site.latDeg,
          lonDeg: st.site.lonDeg,
          backlash: mc.backlash,
        }));
        if (rep) {
          vals = {
            clockOk: rep.clock === 'ok' ? 1 : 0,
            raPct: rep.backlashRa === 'ok' ? rep.raPct : null,
            decPct: rep.backlashDec === 'ok' ? rep.decPct : null,
          };
          const pushed = rep.backlashRa === 'ok' || rep.backlashDec === 'ok';
          status = rep.clock === 'fail' ? 'fail' : pushed ? 'ok' : 'warn';
        } else {
          status = 'fail';
        }
      }
      finishTest('handbox', t0, status, vals);
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

  /** Preset de monture actif (choix manuel ou détection raquette). */
  private activePreset() {
    const st = useSettingsStore.getState();
    return resolvePreset(st.mountPreset, useScopeStore.getState().model);
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
   * Slew : impulsion COURTE (1,2 s) surveillée — le taux réel à la vitesse
   * max (deg/s). null si le tube n'a pas bougé (butée déjà atteinte ou
   * moteur muet).
   */
  private async measureSlew(
    emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void,
    dir: PulseDir,
  ): Promise<number | null> {
    gyroCollector.start(50);
    try {
      const tb = now();
      await sleep(1000);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
      await autostar.setSpeed('slew');
      const tm = now();
      await autostar.startMove(dir);
      await sleep(1200);
      await autostar.stopMove(dir);
      const a = integrateGyroAngleDeg(gyroCollector.samples, tm, tm + 1200, bias);
      emit('ratio', 'settle', dir);
      await sleep(700);
      const rate = Math.abs(a.deg) / 1.2;
      return rate > 0.05 ? rate : null;
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
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
   * v2.2.0 : CHIEN DE GARDE BUTÉE — si le taux s'effondre (approche de
   * butée, obstacle), la jambe est coupée immédiatement au lieu de forcer
   * contre la butée pendant toute la durée prévue.
   */
  private async measureDrivetrain(emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void) {
    gyroCollector.start(50);
    try {
      emit('drivetrain', 'bias');
      const tb = now();
      await sleep(1200);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));
      await autostar.setSpeed('find');
      const legProfile = async (
        dir: PulseDir, durMs: number, expected: number,
      ): Promise<number[]> => {
        emit('drivetrain', 'profile', dir);
        const t = now();
        await autostar.startMove(dir);
        let endT = t + durMs;
        while (now() - t < durMs) {
          await sleep(LIMIT_TICK_MS);
          if (this.aborted) break;
          if (now() - t > LIMIT_SPINUP_SKIP_MS) {
            const rates = recentRates(gyroCollector.samples, t, now(), bias);
            if (approachStopDecision(rates, expected) === 'stopped') {
              endT = now();
              break; // tube bloqué : inutile de forcer
            }
          }
        }
        await autostar.stopMove(dir);
        const profile = rateProfileDegPerSec(gyroCollector.samples, t, endT, bias, 1000);
        await sleep(500);
        return profile;
      };
      const preset = this.activePreset();
      const expectedFind = this.suiteFindRate ?? preset.expectedRates.find;
      // Axe AD (E) — 25 s
      const profileE = await legProfile('e', 25000, expectedFind);
      await sleep(800);
      // Axe DEC (N) — 15 s
      if (this.aborted) return {profileE, profileN: []};
      const profileN = await legProfile('n', 15000, expectedFind);
      return {profileE, profileN};
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
  }

  /**
   * Min/max élévation (v2.2.0 — REDESIGN complet de la version v2.1.0 qui
   * n'atteignait jamais réellement la butée : 15 s à la vitesse center
   * ≈ 1,2° de course !).
   *
   * APPROCHE EN DEUX ÉTAGES par jambe :
   *  - ÉTAGE RAPIDE (find) : parcourt la course à la vitesse find — la
   *    garde est CALCULÉE sur la distance réelle restante jusqu'à la butée
   *    du preset de monture (limitLegGuardSec) ;
   *  - dès que le taux chute (approachStopDecision = 'slowdown') :
   *  - ÉTAGE DOUX (center) : fin d'approche à vitesse lente jusqu'à ARRÊT
   *    SOUTENU (2 s sous 30 % du taux center) = BUTÉE ATTEINTE, confirmée
   *    pendant 2,5 s de commande maintenue.
   *  L'altitude de la butée est lue à :Ga# après l'arrêt (recoup) ; le gyro
   *  intégré donne le déplacement (toujours disponible). « Déjà en butée »
   *  (aucun mouvement malgré 4 s de commande) est un cas reconnu : hit.
   */
  private async measureLimits(
    emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void,
  ) {
    const mc = useMotorCalibStore.getState().rates;
    const preset = this.activePreset();
    const centerRate = mc?.n ?? preset.expectedRates.center;
    const fastRate = this.suiteFindRate ?? preset.expectedRates.find;
    const alt0 = await autostar.readAltAz().catch(() => null);
    const altStart = alt0?.altDeg ?? null;
    gyroCollector.start(50);
    try {
      emit('limits', 'bias');
      const tb = now();
      await sleep(1200);
      const bias = gyroBiasDegPerSec(gyroCollector.samples.filter((s) => s.t >= tb));

      const leg = async (dir: 'n' | 's', goingUp: boolean): Promise<{deg: number; hit: boolean}> => {
        emit('limits', goingUp ? 'up' : 'down', dir);
        const t0 = now();
        let hit = false;

        // --- ÉTAGE 1 : vitesse find, garde = course restante ---
        const guard1 = limitLegGuardSec(altStart, goingUp, preset, fastRate);
        await autostar.setSpeed('find');
        await autostar.startMove(dir);
        let stage2 = false;
        while (now() - t0 < guard1 * 1000) {
          await sleep(LIMIT_TICK_MS);
          if (this.aborted) break;
          if (now() - t0 <= LIMIT_SPINUP_SKIP_MS) continue;
          const rates = recentRates(gyroCollector.samples, t0, now(), bias);
          const dec = approachStopDecision(rates, fastRate);
          if (dec === 'stopped') {
            // tube bloqué dès la vitesse find : déjà en butée (ou obstacle)
            hit = true;
            break;
          }
          if (dec === 'slowdown') {
            stage2 = true;
            break;
          }
        }
        await autostar.stopMove(dir);
        if (this.aborted && !stage2 && !hit) {
          const deg = Math.abs(integrateGyroAngleDeg(gyroCollector.samples, t0, now(), bias).deg);
          return {deg, hit: false};
        }
        const degFast = Math.abs(integrateGyroAngleDeg(gyroCollector.samples, t0, now(), bias).deg);

        // --- ÉTAGE 2 : vitesse center, fin d'approche douce ---
        if (stage2) {
          emit('limits', 'slow', dir);
          const t2 = now();
          await autostar.setSpeed('center');
          await autostar.startMove(dir);
          let stopConfirmT: number | null = null;
          while (now() - t2 < LIMIT_SLOW_GUARD_S * 1000) {
            await sleep(LIMIT_TICK_MS);
            if (this.aborted) break;
            if (now() - t2 <= 800) continue; // accélération + backlash
            const rates = recentRates(gyroCollector.samples, t0, now(), bias);
            const dec = approachStopDecision(rates, centerRate);
            if (dec === 'stopped') {
              if (stopConfirmT == null) stopConfirmT = now();
              // confirmation SOUTENUE : 2,5 s d'arrêt malgré la commande
              if (now() - stopConfirmT >= 2500) {hit = true; break;}
            } else {
              stopConfirmT = null;
            }
          }
          await autostar.stopMove(dir);
        } else if (hit) {
          // déjà arrêté à l'étage find : maintenir brièvement pour CONFIRMER
          // la butée (2,5 s de commande maintenue contre l'arrêt)
          emit('limits', 'slow', dir);
          await autostar.setSpeed('center');
          const tc = now();
          await autostar.startMove(dir);
          while (now() - tc < 3000 && !this.aborted) await sleep(LIMIT_TICK_MS);
          await autostar.stopMove(dir);
        }
        const deg = Math.abs(integrateGyroAngleDeg(gyroCollector.samples, t0, now(), bias).deg) || degFast;
        await sleep(700);
        return {deg, hit};
      };

      const up = await leg('n', true);
      const down = this.aborted ? {deg: 0, hit: false} : await leg('s', false);
      const altNow = await autostar.readAltAz().catch(() => null);
      // Butées : altitude lue à :Ga# après l'ARRÊT (la raquette ne répond
      // plus pendant le mouvement — la lecture POST-arrêt est fiable),
      // sinon reconstruction depuis l'altitude de départ + gyro intégré.
      const maxAlt = up.hit && altNow?.altDeg != null
        ? Math.min(90, altNow.altDeg)
        : altStart != null ? Math.min(90, altStart + up.deg) : null;
      const minAlt = down.hit && altNow?.altDeg != null
        ? Math.max(0, altNow.altDeg)
        : altStart != null ? Math.max(0, altStart - down.deg) : null;
      return {altStart, maxAlt, minAlt, upDeg: up.deg, downDeg: down.deg, hitUp: up.hit, hitDown: down.hit};
    } finally {
      gyroCollector.stop();
      await autostar.stopAll().catch(() => undefined);
    }
  }

  /**
   * Précision de pointage GOTO (v2.2.0) : choisit une étoile brillante
   * entre 25° et 70° de hauteur, GOTO, attend l'arrivée (:D#), puis mesure
   * l'erreur résiduelle par le recalage télémétrique (fit Wahba + gyro).
   * Le fit doit exister (points d'alignement validés) — sinon 'skipped'.
   */
  private async measureGotoAccuracy(
    emit: (test: DiagTestId, phase: DiagEvent['phase'], dir?: PulseDir) => void,
  ): Promise<{errArcmin: number | null; gotoSent: boolean}> {
    const st = useSettingsStore.getState();
    const nowDate = new Date();
    const candidates = withAlt(BRIGHT_STARS, st.site.latDeg, st.site.lonDeg, nowDate)
      .filter((o: DisplayObject) => o.altDeg > 25 && o.altDeg < 70 && o.mag < 2.5)
      .sort((a, b) => a.altDeg - b.altDeg);
    const star = candidates[Math.floor(candidates.length / 2)]; // étoile médiane : course modérée
    if (!star) return {errArcmin: null, gotoSent: false};

    emit('goto', 'travel');
    const r = await autostar.gotoRaDec(star.raDeg, star.decDeg);
    if (r !== 'ok') return {errArcmin: null, gotoSent: false};

    // Attente d'arrivée : :D# vide = monture à l'arrêt (max 3 min)
    const t0 = now();
    while (now() - t0 < GOTO_ARRIVE_GUARD_S * 1000) {
      await sleep(1000);
      if (this.aborted) return {errArcmin: null, gotoSent: true};
      const moving = await autostar.isMoving().catch(() => null);
      if (moving === false) break;
      if (moving == null && now() - t0 > 15000) break; // muette trop longtemps
    }
    await sleep(1500); // stabilisation

    // Mesure télémétrique de l'erreur de pointage
    emit('goto', 'bias');
    let quat: Quat | null = null;
    const release = startOrientation((o) => {
      if (typeof o.qw === 'number') quat = {w: o.qw, x: o.qx ?? 0, y: o.qy ?? 0, z: o.qz ?? 0};
    }, 100);
    try {
      await sleep(700);
      const fit = telemetryFitOf(useTelemetryStore.getState().points);
      if (!fit || fit.rmsDeg > 0.5 || !quat) return {errArcmin: null, gotoSent: true};
      const d = new Date();
      const err = pointingError(
        {raDeg: star.raDeg, decDeg: star.decDeg},
        applyFit(fit, quat),
        st.site.latDeg, st.site.lonDeg, d,
      );
      return {errArcmin: err.totalArcmin, gotoSent: true};
    } finally {
      release();
    }
  }
}

/** Instance unique : l'UI garde la référence pour pouvoir ABORT. */
export const diagRunner = new DiagRunner();
