/**
 * Tests de la suite de diagnostic autonome (v2.1.0).
 *
 * Partie A — mathématiques pures (services/astro/diag.ts) :
 *   angle intégré, ratio, répétabilité, profil de taux / train
 *   d'engrenages, détection d'arrêt soutenu (butées).
 *
 * Partie B — orchestration complète (services/tracking/diagService.ts) sur
 *   transport Meade SCRIPTÉ + gyroscope VIRTUEL + horloge VIRTUELLE
 *   (Date.now maîtrisé) : la suite entière (8 tests) est exécutée en
 *   quelques millisecondes avec des valeurs déterministes.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

jest.mock('../src/services/phone/sensors', () => {
  const state: {cb: ((g: any) => void) | null} = {cb: null};
  return {
    __state: state,
    startGyro: (cb: (g: any) => void) => {
      state.cb = cb;
      return () => {state.cb = null;};
    },
    stopGyro: async () => true,
    startOrientation: () => () => undefined,
    stopOrientation: async () => true,
    sensorsAvailable: async () => ({rotationVector: true, accelerometer: true, magnetometer: true, gyroscope: true}),
  };
});

import {
  integrateGyroAngleDeg,
  ratioPct,
  ratioStatus,
  precisionStats,
  rateProfileDegPerSec,
  drivetrainStats,
  motionStopTime,
  approachStopDecision,
} from '../src/services/astro/diag';
import {setDiagSleepForTests, setDiagNowForTests, diagRunner, DIAG_TOTAL_S} from '../src/services/tracking/diagService';
import {autostar} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import {useMotorCalibStore} from '../src/store/motorCalibStore';
import {useDiagStore} from '../src/store/diagStore';
import type {Transport, TransportType, ConnectOptions} from '../src/services/connection/types';
import type {GyroSample, VecRate} from '../src/services/astro/motorcal';

/* ================================================================== */
/* PARTIE A — maths pures                                              */
/* ================================================================== */

const BIAS: VecRate = {x: 0, y: 0, z: 0};
const D2R = Math.PI / 180;

/** Échantillons gyro synthétiques : taux constant (deg/s) sur l'axe z. */
function constSamples(t0: number, ms: number, degPerSec: number, stepMs = 50): GyroSample[] {
  const out: GyroSample[] = [];
  for (let t = t0; t <= t0 + ms; t += stepMs) {
    out.push({t, x: 0, y: 0, z: degPerSec * D2R});
  }
  return out;
}

describe('Partie A — integrateGyroAngleDeg', () => {
  it('intègre un taux constant 0,08 °/s pendant 2 s → 0,16°', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 2000, 0.08);
    const a = integrateGyroAngleDeg(s, t0, t0 + 2000, BIAS);
    expect(a.axis).toBe('z');
    expect(a.deg).toBeCloseTo(0.16, 3);
    expect(a.degPerSec).toBeCloseTo(0.08, 4);
  });

  it('soustrait le biais du gyro', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 2000, 0.08).map((g) => ({...g, z: g.z + 0.01}));
    // VecRate est en deg/s : biais = 0,01 rad/s converti
    const bias: VecRate = {x: 0, y: 0, z: 0.01 * (180 / Math.PI)};
    const a = integrateGyroAngleDeg(s, t0, t0 + 2000, bias);
    expect(a.deg).toBeCloseTo(0.16, 3);
  });

  it('signe : taux négatif → déplacement négatif', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 1000, -0.4);
    const a = integrateGyroAngleDeg(s, t0, t0 + 1000, BIAS);
    expect(a.deg).toBeCloseTo(-0.4, 3);
  });

  it('fenêtre vide → 0', () => {
    const s = constSamples(1_000_000, 1000, 0.08);
    expect(integrateGyroAngleDeg(s, 2_000_000, 2_001_000, BIAS).deg).toBe(0);
  });
});

describe('Partie A — ratio par axe', () => {
  it('ratioPct et statuts', () => {
    expect(ratioPct(0.08, 0.08)).toBeCloseTo(100, 6);
    expect(ratioPct(null, 0.08)).toBeNull();
    expect(ratioPct(0.08, 0)).toBeNull();
    expect(ratioStatus(100)).toBe('ok');
    expect(ratioStatus(75)).toBe('ok');
    expect(ratioStatus(50)).toBe('warn');
    expect(ratioStatus(180)).toBe('warn');
    expect(ratioStatus(10)).toBe('fail');
    expect(ratioStatus(null)).toBe('fail');
  });
});

describe('Partie A — precisionStats (répétabilité)', () => {
  it('déplacements identiques → std 0', () => {
    const st = precisionStats([0.16, 0.16, 0.16, 0.16, 0.16]);
    expect(st).not.toBeNull();
    expect(st!.meanDeg).toBeCloseTo(0.16, 6);
    expect(st!.stdDeg).toBe(0);
    expect(st!.relPct).toBe(0);
  });
  it('dispersion connue', () => {
    const st = precisionStats([0.14, 0.16, 0.15, 0.15]);
    expect(st!.meanDeg).toBeCloseTo(0.15, 6);
    expect(st!.spreadDeg).toBeCloseTo(0.02, 6);
    expect(st!.relPct).toBeGreaterThan(0);
  });
  it('< 2 essais → null ; valeurs non finies ignorées', () => {
    expect(precisionStats([])).toBeNull();
    expect(precisionStats([0.2])).toBeNull();
    expect(precisionStats([0.2, NaN, Infinity, 0.21])).not.toBeNull();
  });
});

describe('Partie A — profil de taux / train d\'engrenages', () => {
  it('mouvement régulier → oscillation quasi nulle, 0 blocage', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 10000, 0.4);
    const prof = rateProfileDegPerSec(s, t0, t0 + 10000, BIAS, 1000);
    expect(prof.length).toBe(10);
    const st = drivetrainStats(prof);
    expect(st.valid).toBe(true);
    expect(st.peakToPeakPct).toBeLessThan(2);
    expect(st.stallBins).toBe(0);
  });

  it('oscillation sinusoïdale ±10 % → crête-à-crête ≈ 20 %', () => {
    const t0 = 1_000_000;
    const s: GyroSample[] = [];
    for (let t = t0; t <= t0 + 10000; t += 50) {
      const sec = (t - t0) / 1000;
      s.push({t, x: 0, y: 0, z: 0.4 * (1 + 0.1 * Math.sin(2 * Math.PI * sec / 5)) * D2R});
    }
    const prof = rateProfileDegPerSec(s, t0, t0 + 10000, BIAS, 1000);
    const st = drivetrainStats(prof);
    expect(st.peakToPeakPct).toBeGreaterThan(8);
    expect(st.peakToPeakPct).toBeLessThan(25);
  });

  it('blocage (2 bins au plancher) → stallBins > 0', () => {
    const t0 = 1_000_000;
    const s: GyroSample[] = [];
    for (let t = t0; t <= t0 + 10000; t += 50) {
      const stalled = t >= t0 + 4000 && t < t0 + 6000; // 2 s de blocage
      s.push({t, x: 0, y: 0, z: (stalled ? 0.001 : 0.4) * D2R});
    }
    const prof = rateProfileDegPerSec(s, t0, t0 + 10000, BIAS, 1000);
    const st = drivetrainStats(prof);
    expect(st.stallBins).toBeGreaterThanOrEqual(2);
  });

  it('profil vide / silencieux → invalide', () => {
    expect(drivetrainStats([]).valid).toBe(false);
    expect(drivetrainStats([0, 0, 0, 0, 0]).valid).toBe(false);
  });
});

describe('Partie A — motionStopTime (butées d\'élévation)', () => {
  it('mouvement qui s\'arrête → temps d\'arrêt détecté', () => {
    const t0 = 1_000_000;
    const s: GyroSample[] = [
      ...constSamples(t0, 3000, 0.08),      // montée
      ...constSamples(t0 + 3000, 3000, 0),  // butée (immobile)
    ];
    const t = motionStopTime(s, t0, t0 + 6000, BIAS, 0.08);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(t0 + 3000);
    expect(t!).toBeLessThan(t0 + 4000);
  });

  it('mouvement continu → null (pas de butée atteinte)', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 15000, 0.08);
    expect(motionStopTime(s, t0, t0 + 15000, BIAS, 0.08)).toBeNull();
  });

  it('déjà en butée (aucun mouvement) → null', () => {
    const t0 = 1_000_000;
    const s = constSamples(t0, 5000, 0);
    expect(motionStopTime(s, t0, t0 + 5000, BIAS, 0.08)).toBeNull();
  });
});

describe('Partie A — approachStopDecision (butées v2.2.0)', () => {
  it('taux nominal → run', () => {
    expect(approachStopDecision([0.4, 0.4, 0.4], 0.4)).toBe('run');
    expect(approachStopDecision([], 0.4)).toBe('run');
  });
  it('taux en chute (55 %) → slowdown : passer en vitesse douce', () => {
    expect(approachStopDecision([0.4, 0.35, 0.2], 0.4)).toBe('slowdown');
  });
  it('arrêt soutenu (2 s sous 30 %) → stopped : butée atteinte', () => {
    const rates = [0.4, 0.4, 0.4, 0.01, 0.01, 0.01, 0.01, 0.01];
    expect(approachStopDecision(rates, 0.4)).toBe('stopped');
    // 3 bins seulement suffisent (1,2 s) si tous sous le seuil
    expect(approachStopDecision([0.4, 0.01, 0.01, 0.01], 0.4)).toBe('stopped');
  });
  it('un simple creux bref ne déclenche PAS l’arrêt', () => {
    const rates = [0.4, 0.4, 0.4, 0.01, 0.4, 0.4, 0.4, 0.4];
    expect(approachStopDecision(rates, 0.4)).toBe('run');
  });
  it('seuils absolus de plancher (faibles taux attendus)', () => {
    // center 0,08 : 30 % = 0,024 → au-dessus du plancher 0,02
    expect(approachStopDecision([0.08, 0.08, 0.02, 0.02, 0.02], 0.08)).toBe('stopped');
  });
});

/* ================================================================== */
/* PARTIE B — orchestration complète (transport + gyro + horloge virt) */
/* ================================================================== */

/** Transport Meade SCRIPTÉ : commandes moteur → taux virtuels, lectures
 *  (:Ga#/:Gz#/:Gr#/:Gd#/:GVP#/:GVN#) → réponses déterministes. */
class ReplTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
  /** Taux réel de la monture (deg/s) à la VITESSE sélectionnée. */
  speedRate = 0.08;
  dirs = {n: 0, s: 0, e: 0, w: 0};

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}
  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}

  private reply(s: string) {this.dataCb?.(s);}

  async write(data: string): Promise<void> {
    this.writes.push(data);
    if (data === ':RG#') this.speedRate = 0.0041781;
    else if (data === ':RC#') this.speedRate = 0.08;
    else if (data === ':RM#') this.speedRate = 0.4;
    else if (data === ':RS#') this.speedRate = 2.0;
    else if (data === ':Mn#') this.dirs.n = this.speedRate;
    else if (data === ':Ms#') this.dirs.s = this.speedRate;
    else if (data === ':Me#') this.dirs.e = this.speedRate;
    else if (data === ':Mw#') this.dirs.w = this.speedRate;
    else if (data.startsWith(':Q')) this.dirs = {n: 0, s: 0, e: 0, w: 0};
    else if (data === ':Ga#') this.reply('+45:00#');
    else if (data === ':Gz#') this.reply('+180:00#');
    else if (data === ':Gr#') this.reply('10:00:00#');
    else if (data === ':Gd#') this.reply('+45:00#');
    else if (data === ':GVP#') this.reply('Autostar#');
    else if (data === ':GVN#') this.reply('43Eg#');
    // v2.2.0 : réponses d'accusé (horloge/site), cibles, écran LCD idle
    else if (data.startsWith(':SG') || data.startsWith(':SL') || data.startsWith(':SC')
      || data.startsWith(':St') || data.startsWith(':Sg')) this.reply('1#');
    else if (data.startsWith(':Sr') || data.startsWith(':Sd')) this.reply('1#');
    else if (data === ':MS#') this.reply('0#');
    else if (data === ':D#') this.reply('#'); // monture à l'arrêt
    else if (data.startsWith(':EK')) { /* touches : rien */ }
    else if (data.startsWith(':ED#')) {
      // écran d'accueil : marqueur + 'Objet' + ligne 2 vide (2×16 = 32 car.)
      this.reply('\u0080Objet           ' + '                ' + '#');
    }
  }

  get gyroRateDegPerSec(): number {
    return this.dirs.n - this.dirs.s + this.dirs.e - this.dirs.w;
  }
}

const sensorsMock = require('../src/services/phone/sensors') as any;

describe('Partie B — suite autonome complète (horloge virtuelle)', () => {
  let tp: ReplTransport;
  let fakeNow: number;
  let sleepCalls: number;
  let abortAtCall: number | null;
  let realDateNow: () => number;

  beforeAll(() => {
    realDateNow = Date.now;
    // Horloge VIRTUELLE : Date.now() n'avance que par les sleep injectés.
    jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
  });

  afterAll(() => {
    (jest.spyOn(Date, 'now') as any).mockRestore();
  });

  beforeEach(() => {
    fakeNow = realDateNow();
    sleepCalls = 0;
    abortAtCall = null;
    tp = new ReplTransport();
    (autostar as any).transport = tp;
    (autostar as any).log = () => undefined; // silence des journaux
    // Sans connect(), le câblage des réponses doit être fait à la main
    tp.onData((chunk) => (autostar as any).onData(chunk));
    useScopeStore.getState().setConnStatus('connected');
    useMotorCalibStore.getState().resetAll();
    useDiagStore.getState().clear();
    diagRunner.abort(); // reset du flag d'un éventuel abort précédent

    // Sommeil VIRTUEL : pousse des échantillons gyro couvrant [t, t+ms]
    // au taux courant de la monture simulée, puis avance l'horloge.
    setDiagSleepForTests(async (ms: number) => {
      const cb = sensorsMock.__state.cb as ((g: any) => void) | null;
      if (cb) {
        const rate = tp.gyroRateDegPerSec;
        for (let t = fakeNow + 50; t <= fakeNow + ms; t += 50) {
          cb({t, x: 0, y: 0, z: (rate * Math.PI) / 180, accuracy: 3, ts: t});
        }
      }
      fakeNow += ms;
      sleepCalls += 1;
      if (abortAtCall != null && sleepCalls >= abortAtCall) {
        abortAtCall = null;
        diagRunner.abort();
      }
    });
    setDiagNowForTests(() => fakeNow);
  });

  const byId = (results: any[], id: string) => results.find((r) => r.id === id);

  it('suite entière OK sur monture saine — valeurs déterministes', async () => {
    const events: any[] = [];
    const report = await diagRunner.run((e) => events.push(e));

    expect(report.results.length).toBe(10);
    expect(report.aborted).toBe(false);
    const statuses = Object.fromEntries(report.results.map((r) => [r.id, r.status]));

    // pré-contrôles : biais et bruit nuls sur gyro parfait → OK
    expect(statuses.pre).toBe('ok');
    expect(byId(report.results, 'pre')!.values.biasMagDegPerSec).toBeCloseTo(0, 4);

    // calibration : 4 taux réels à center = 0,08 °/s → OK + store alimenté
    expect(statuses.calib).toBe('ok');
    const calib = byId(report.results, 'calib')!;
    expect(calib.values.n).toBeCloseTo(0.08, 4);
    expect(calib.values.e).toBeCloseTo(0.08, 4);
    const stored = useMotorCalibStore.getState().rates;
    expect(stored).not.toBeNull();
    expect(stored!.e).toBeCloseTo(0.08, 4); // mise à jour de la raquette

    // ratio : 0,08/0,08 = 100 %, linéarité find = 100 %, slew ≈ 96 % (bin
    // frontière du mock gyro) → ratioStatus(96) = OK
    expect(statuses.ratio).toBe('ok');
    const ratio = byId(report.results, 'ratio')!;
    expect(ratio.values.pctE!).toBeCloseTo(100, 1);
    expect(ratio.values.linearityPct!).toBeCloseTo(100, 1);
    expect(ratio.values.pctSlew!).toBeGreaterThan(90);

    // backlash : reprise immédiate au gyro (0,05 s → ≈ 14″) → OK
    expect(statuses.backlash).toBe('ok');
    const bl = byId(report.results, 'backlash')!;
    expect(bl.values.raArcsec!).toBeGreaterThan(0);
    expect(bl.values.raArcsec!).toBeLessThan(100);

    // précision : 5 impulsions identiques → répétabilité parfaite
    expect(statuses.precision).toBe('ok');
    const pr = byId(report.results, 'precision')!;
    expect(pr.values.meanDeg!).toBeCloseTo(0.16, 2);
    expect(pr.values.relPct!).toBeCloseTo(0, 3);

    // train d'engrenages : taux constant → oscillation ~0, aucun blocage
    expect(statuses.drivetrain).toBe('ok');
    const dt = byId(report.results, 'drivetrain')!;
    expect(dt.values.pctP2PE!).toBeLessThan(5);
    expect(dt.values.stallsE).toBe(0);

    // min/max élévation v2.2.0 : jambes à la vitesse find (0,4 °/s) bornées
    // par la course du preset générique (45°→90° = 168 s de garde) — la
    // monture SAINED déplace 0,4×168 ≈ 67° par jambe, sans toucher la butée.
    expect(statuses.limits).toBe('ok');
    const li = byId(report.results, 'limits')!;
    expect(li.values.altStartDeg!).toBeCloseTo(45, 1);
    expect(li.values.upDeg!).toBeGreaterThan(60);
    expect(li.values.upDeg!).toBeLessThan(75);
    expect(li.values.downDeg!).toBeGreaterThan(60);
    expect(li.values.hitUp).toBe(0); // pas de butée sur monture libre
    expect(li.values.hitDown).toBe(0);
    expect(li.values.maxAltDeg!).toBeCloseTo(90, 0);  // reconstruction bornée
    expect(li.values.minAltDeg!).toBeCloseTo(0, 0);

    // GOTO de contrôle : sans point d'alignement télémétrique → IGNORÉ
    expect(statuses.goto).toBe('skipped');

    // dérive : gyro immobile → 0″/s vs sidéral 15,04 → écart −15 → ATTENTION
    expect(statuses.drift).toBe('warn');

    // mise à jour raquette : horloge/site acquittés ('1'), rétro-jeu non
    // poussé (menu Configuration introuvable sur l'écran figé) → ATTENTION
    expect(statuses.handbox).toBe('warn');
    expect(byId(report.results, 'handbox')!.values.clockOk).toBe(1);

    // progression : dernier événement ~ 99 %
    expect(events.length).toBeGreaterThan(20);
    const progressMax = Math.max(...events.map((e) => e.progress));
    expect(progressMax).toBeGreaterThan(0.9);

    // la monture a bien été STOPPÉE en fin de suite (:Q#)
    expect(tp.writes.filter((w) => w === ':Q#').length).toBeGreaterThanOrEqual(2);

    // durée totale estimée cohérente (> 5 min réelles annoncées à l'UI)
    expect(DIAG_TOTAL_S).toBeGreaterThan(300);
  }, 45000);

  it('ABORT en cours de suite → rapport partiel, tests restants ignorés', async () => {
    abortAtCall = 40; // abort déclenché au 40e sommeil (pendant backlash/précision)
    const report = await diagRunner.run(() => undefined);
    expect(report.aborted).toBe(true);
    const skipped = report.results.filter((r) => r.status === 'skipped').map((r) => r.id);
    expect(skipped.length).toBeGreaterThanOrEqual(2);
    expect(skipped).toContain('drift'); // dernier test jamais atteint
    // les tests exécutés avant l'abort ne sont pas « skipped »
    expect(byId(report.results, 'pre')!.status).not.toBe('skipped');
  }, 30000);

  it('raquette déconnectée → échec des tests, aucun moteur commandé', async () => {
    useScopeStore.getState().setConnStatus('disconnected');
    const report = await diagRunner.run(() => undefined);
    expect(report.results.length).toBe(10);
    const okCount = report.results.filter((r) => r.status === 'ok').length;
    expect(okCount).toBe(0);
    expect(byId(report.results, 'pre')!.status).toBe('fail');
    // aucun ordre moteur envoyé (transport jamais écrit)
    expect(tp.writes.length).toBe(0);
  }, 30000);
});
