/**
 * Boucle de suivi télémétrique fermée (v2.0.0).
 *
 * Chaque tick (1,5 s) :
 *  1. l'objet visé (fixe ou planète via éphémérides) donne la direction
 *     théorique au site/instant courant ;
 *  2. le pointage RÉEL vient du recalage télémétrie (fit Wahba/Kabsch sur
 *     les points d'alignement) appliqué à l'orientation courante du phone ;
 *  3. l'écart AD/DEC est converti en impulsions moteur (planPulses) dont la
 *     durée utilise les taux MESURÉS au gyroscope (calibrage) ou les taux
 *     théoriques, avec anti-backlash si changement de sens ;
 *  4. après impulsion, l'erreur est re-mesurée : si elle a grandi, le sens
 *     de l'axe est inversé (auto-apprentissage, persisté) — la raquette
 *     « apprend » la convention réelle du matériel.
 *
 * Sécurité : stopAll() systématique à l'arrêt, impulsions plafonnées (3 s),
 * amortissement 60 %, aucune correction si le fit est absent/trop brut.
 */
import {autostar} from '../protocol/client';
import {applyFit, type Quat} from '../astro/telemetry';
import {telemetryFitOf} from '../../store/telemetryStore';
import {useSettingsStore} from '../../store/settingsStore';
import {useScopeStore} from '../../store/scopeStore';
import {useTelemetryStore} from '../../store/telemetryStore';
import {useTrackingStore, type TrackTarget} from '../../store/trackingStore';
import {useMotorCalibStore, type MotorSpeed} from '../../store/motorCalibStore';
import {startOrientation} from '../phone/sensors';
import {planetRaDec, type PlanetName} from '../astro/planets';
import {
  DEFAULT_SKY_RATES,
  pointingError,
  planPulses,
  shouldFlipSign,
  flipSigns,
  movingTargetRaDec,
  type PulseDir,
  type PulseSigns,
} from '../astro/tracking';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TICK_MS = 1500;
const DEADBAND_ARCMIN = 2;
const CENTER_THRESHOLD_ARCMIN = 1.5;
const MAX_FIT_RMS_DEG = 0.5;
const DAMPING = 0.6;
const MAX_PULSE_SEC = 3;
const SETTLE_MS = 1200;

export type TrackerStartResult = 'ok' | 'noFit' | 'fitRms' | 'noSensors' | 'disconnected' | 'noTarget';

class TelemetryTracker {
  private sensorRelease: (() => void) | null = null;
  private quat: Quat | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private running = false;
  private lastDirs: {ra: PulseDir | null; dec: PulseDir | null} = {ra: null, dec: null};
  private savedSpeed: MotorSpeed | null = null;

  /** Capte l'orientation en continu (consommateur réf-compté partagé). */
  private acquireSensors() {
    if (this.sensorRelease) return;
    this.quat = null;
    this.sensorRelease = startOrientation(
      (o) => {
        if (typeof o.qw === 'number') {
          this.quat = {w: o.qw, x: o.qx ?? 0, y: o.qy ?? 0, z: o.qz ?? 0};
        }
      },
      100,
    );
  }

  private releaseSensors() {
    if (this.sensorRelease) {
      this.sensorRelease();
      this.sensorRelease = null;
      this.quat = null;
    }
  }

  /** Mesure l'erreur de pointage instantanée (null si données insuffisantes). */
  measureNow() {
    const ts = useTrackingStore.getState();
    const tgt = ts.target;
    if (!tgt || !this.quat) return null;
    const fit = telemetryFitOf(useTelemetryStore.getState().points);
    if (!fit || fit.rmsDeg > MAX_FIT_RMS_DEG) return null;
    const site = useSettingsStore.getState().site;
    const now = new Date();
    const target = movingTargetRaDec(tgt.raDeg, tgt.decDeg, tgt.moving, (name, date) =>
      planetRaDec(name as PlanetName, date), now);
    const aa = applyFit(fit, this.quat);
    return pointingError(target, aa, site.latDeg, site.lonDeg, now);
  }

  /**
   * Démarre le suivi de la cible. Vérifie : connexion, fit disponible et
   * assez précis, capteurs d'orientation présents.
   */
  async start(target: TrackTarget): Promise<TrackerStartResult> {
    if (this.running) await this.stop();
    const conn = useScopeStore.getState().connStatus;
    if (conn !== 'connected') return 'disconnected';
    const fit = telemetryFitOf(useTelemetryStore.getState().points);
    if (!fit) return 'noFit';
    if (fit.rmsDeg > MAX_FIT_RMS_DEG) return 'fitRms';

    const ts = useTrackingStore.getState();
    ts.setTarget(target);
    ts.reset();
    ts.setTarget(target); // reset conserve la cible, mais par sûreté

    this.acquireSensors();
    await sleep(250); // laisser arriver les premiers échantillons
    if (!this.quat) {
      this.releaseSensors();
      return 'noSensors';
    }

    this.running = true;
    this.lastDirs = {ra: null, dec: null};
    this.savedSpeed = useScopeStore.getState().speed;
    ts.setTracking(true);
    ts.setPhase('running');
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    void this.tick();
    return 'ok';
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    if (this.savedSpeed) {
      const s = this.savedSpeed;
      this.savedSpeed = null;
      await autostar.setSpeed(s).catch(() => undefined);
      useScopeStore.getState().setSpeed(s);
    }
    if (autostar.isConnected()) await autostar.stopAll().catch(() => undefined);
    this.releaseSensors();
    const ts = useTrackingStore.getState();
    ts.setTracking(false);
    ts.setPhase('idle');
  }

  /**
   * Centrage fin télémétrique one-shot : itère jusqu'à ce que l'erreur passe
   * sous ~1,5′ (max 10 itérations). Utilisable avec ou sans suivi actif.
   */
  async centerOnce(): Promise<{ok: boolean; errArcmin: number | null; iterations: number}> {
    if (this.busy) return {ok: false, errArcmin: null, iterations: 0};
    const wasRunning = this.running;
    this.acquireSensors();
    await sleep(250);
    const ts = useTrackingStore.getState();
    ts.setPhase('centering');
    let iterations = 0;
    try {
      for (let i = 0; i < 10; i++) {
        const err = this.measureNow();
        if (!err) break;
        ts.setErr(err.totalArcmin);
        if (err.totalArcmin < CENTER_THRESHOLD_ARCMIN) {
          return {ok: true, errArcmin: err.totalArcmin, iterations};
        }
        iterations += 1;
        await this.correct(err);
        if (!wasRunning && !autostar.isConnected()) break;
      }
      const final = this.measureNow();
      const err = final?.totalArcmin ?? null;
      return {ok: err != null && err < 3, errArcmin: err, iterations};
    } finally {
      ts.setPhase(this.running ? 'running' : 'idle');
      if (!wasRunning) this.releaseSensors();
    }
  }

  private async tick() {
    if (this.busy || !this.running) return;
    const ts = useTrackingStore.getState();
    if (ts.target == null) return;
    const err = this.measureNow();
    if (!err) return;
    ts.setErr(err.totalArcmin);
    ts.setPhase('running');
    if (err.totalArcmin > DEADBAND_ARCMIN) {
      await this.correct(err);
    }
  }

  /** Une ronde de corrections (impulsions + mesure + apprentissage). */
  private async correct(err: NonNullable<ReturnType<TelemetryTracker['measureNow']>>) {
    if (this.busy) return;
    this.busy = true;
    const ts = useTrackingStore.getState();
    ts.setPhase('pulsing');
    try {
      const mc = useMotorCalibStore.getState();
      const signs: PulseSigns = mc.apply ? mc.signs : {dec: 1, ra: 1};
      const speed: MotorSpeed = err.totalArcmin > 12 ? 'center' : 'guide';
      let raRate = DEFAULT_SKY_RATES[speed];
      let decRate = DEFAULT_SKY_RATES[speed];
      if (mc.apply && mc.rates && mc.rates.speed === speed) {
        const r = mc.rates;
        const raMeas = r.e ?? r.w;
        const decMeas = r.n ?? r.s;
        if (raMeas && raMeas > 1e-4) raRate = raMeas;
        if (decMeas && decMeas > 1e-4) decRate = decMeas;
      }
      // Anti-backlash : le jeu est stocké en ANGLE (″) → durée = angle/taux.
      const blRaSec =
        mc.apply && mc.backlash?.raArcsec ? (mc.backlash.raArcsec / 3600) / raRate : 0;
      const blDecSec =
        mc.apply && mc.backlash?.decArcsec ? (mc.backlash.decArcsec / 3600) / decRate : 0;
      const plan = planPulses({
        raErrDeg: err.raErrDeg,
        decErrDeg: err.decErrDeg,
        raRateDegPerSec: raRate,
        decRateDegPerSec: decRate,
        signs,
        damping: DAMPING,
        deadbandDeg: DEADBAND_ARCMIN / 60,
        maxPulseSec: MAX_PULSE_SEC,
        backlashSec: {ra: blRaSec, dec: blDecSec},
        lastDirs: this.lastDirs,
      });
      if (!plan.length) return;

      await autostar.setSpeed(speed);
      for (const step of plan) {
        if (step.durationMs < 80) continue;
        await autostar.startMove(step.dir);
        await sleep(step.durationMs);
        await autostar.stopMove(step.dir);
        await sleep(300);
        this.lastDirs[step.axis] = step.dir;
      }
      await sleep(SETTLE_MS);

      const after = this.measureNow();
      for (const step of plan) {
        const beforeDeg = step.axis === 'ra' ? err.raErrDeg : err.decErrDeg;
        const afterDeg = after ? (step.axis === 'ra' ? after.raErrDeg : after.decErrDeg) : null;
        ts.pushLog({
          axis: step.axis,
          dir: step.dir,
          durationMs: step.durationMs,
          beforeArcmin: Math.abs(beforeDeg) * 60,
          afterArcmin: afterDeg != null ? Math.abs(afterDeg) * 60 : null,
        });
        if (afterDeg != null && shouldFlipSign({
          axis: step.axis,
          errBeforeDeg: beforeDeg,
          errAfterDeg: afterDeg,
        })) {
          const ns = flipSigns(signs, step.axis);
          useMotorCalibStore.getState().setSigns(ns);
          useTrackingStore.getState().setSigns(ns);
        }
      }
      ts.bumpCorrections();
      if (after) ts.setErr(after.totalArcmin);
    } finally {
      this.busy = false;
      ts.setPhase(this.running ? 'running' : 'idle');
    }
  }
}

export const telemetryTracker = new TelemetryTracker();
