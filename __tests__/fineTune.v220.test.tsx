/**
 * Tests v2.2.0 — PRÉCISION PAR TÉLÉMÉTRIE + réglage fin automatique après
 * GOTO (services/tracking/fineTune.ts).
 *
 * Parcours réel vérifié : GOTO (app) → surveillance :D# → ARRIVÉE →
 * notification auditeur → mesure télémétrique AVANT → centrage fin
 * automatique (impulsions moteur) → mesure APRÈS → ATTENTE DE VALIDATION
 * → « Valider » enregistre un NOUVEAU point d'alignement (aucun mouvement)
 * ou « Ignorer » referme sans rien enregistrer.
 *
 * La bascule OFF ne déclenche RIEN (contrat utilisateur : c'est un bouton
 * activer/désactiver). Monture simulée : le jeu de pointage DIMINUE à
 * chaque arrêt moteur (convergence réaliste de la boucle).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

/** Capteurs d'orientation SIMULÉS : abonnés réf-comptés + orientation
 *  courante mutable (le jeu de pointage diminue à chaque :Q axe). */
jest.mock('../src/services/phone/sensors', () => {
  const state = {
    subs: new Set<Function>(),
    timers: new Set<any>(),
    quat: {w: 1, x: 0, y: 0, z: 0} as any,
  };
  return {
    __state: state,
    __setQuat: (q: any) => {
      state.quat = q;
      for (const cb of [...state.subs]) cb({qw: q.w, qx: q.x, qy: q.y, qz: q.z, accuracy: 3});
    },
    startOrientation: (cb: Function, ms: number) => {
      state.subs.add(cb);
      const id = setInterval(() => cb({qw: state.quat.w, qx: state.quat.x, qy: state.quat.y, qz: state.quat.z, accuracy: 3}), Math.max(50, ms));
      state.timers.add(id);
      return () => {
        state.subs.delete(cb);
        clearInterval(id);
        state.timers.delete(id);
      };
    },
    stopOrientation: async () => true,
    startGyro: (_cb: Function, _ms: number) => () => undefined,
    stopGyro: async () => true,
    sensorsAvailable: async () => ({rotationVector: true, accelerometer: true, magnetometer: true, gyroscope: true}),
  };
});

import {autostar} from '../src/services/protocol/client';
import {
  initFineTune,
  validateFineTune,
  dismissFineTune,
} from '../src/services/tracking/fineTune';
import {useTrackingStore} from '../src/store/trackingStore';
import {useTelemetryStore} from '../src/store/telemetryStore';
import {useGotoCheckStore} from '../src/store/gotoCheckStore';
import {useSettingsStore} from '../src/store/settingsStore';
import {useScopeStore} from '../src/store/scopeStore';
import {altAzToRaDec, raDecToAltAz} from '../src/services/astro/coords';
import {
  altAzToVec,
  matMul,
  matTranspose,
  matVec,
  quatToMat,
  vecToAltAz,
  type Mat3,
  type Quat,
  type Vec3,
} from '../src/services/astro/telemetry';
import type {Transport, TransportType, ConnectOptions} from '../src/services/connection/types';

/* ==================== outillage ==================== */

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;
const SITE = {latDeg: 48.85, lonDeg: 2.35};

function rodrigues(axis: Vec3, angleRad: number): Mat3 {
  const u = ((): Vec3 => {
    const n = Math.hypot(axis[0], axis[1], axis[2]);
    return [axis[0] / n, axis[1] / n, axis[2] / n];
  })();
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const C = 1 - c;
  const [x, y, z] = u;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const n = Math.hypot(axis[0], axis[1], axis[2]);
  const u: Vec3 = [axis[0] / n, axis[1] / n, axis[2] / n];
  const s = Math.sin(angleRad / 2);
  return {w: Math.cos(angleRad / 2), x: u[0] * s, y: u[1] * s, z: u[2] * s};
}

function matToQuat(m: Mat3): Quat {
  const tr = m[0] + m[4] + m[8];
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const sq = Math.sqrt(tr + 1) * 2;
    w = 0.25 * sq; x = (m[7] - m[5]) / sq; y = (m[2] - m[6]) / sq; z = (m[3] - m[1]) / sq;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const sq = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / sq; x = 0.25 * sq; y = (m[1] + m[3]) / sq; z = (m[6] + m[2]) / sq;
  } else if (m[4] > m[8]) {
    const sq = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / sq; x = (m[1] + m[3]) / sq; y = 0.25 * sq; z = (m[5] + m[7]) / sq;
  } else {
    const sq = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / sq; x = (m[2] + m[6]) / sq; y = (m[5] + m[7]) / sq; z = 0.25 * sq;
  }
  return {w, x, y, z};
}

/**
 * Quaternion SIMULÉ courant : orientation qui pointe la cible À L'INSTANT
 * courant (l'horloge virtuelle avance : la cible dérive en sidéral — le
 * téléphone suit, comme un vrai tube en suivi) + jeu de pointage offsetRad.
 * L'erreur mesurée est ainsi INVARIANTE au temps : elle ne contient QUE le jeu.
 */
function currentMockQuat(): Quat {
  const now = new Date();
  const tgtAA = raDecToAltAz(TARGET_RD.raDeg, TARGET_RD.decDeg, SITE.latDeg, SITE.lonDeg, now);
  const sky = altAzToVec(tgtAA.altDeg, tgtAA.azDeg);
  // R(q)·o doit valoir W⁻¹·sky (applyFit : vecToAltAz(W·R(q)·o))
  const o2sky = matVec(matTranspose(W_STAR), sky);
  const cross: Vec3 = [
    O_STAR[1] * o2sky[2] - O_STAR[2] * o2sky[1],
    O_STAR[2] * o2sky[0] - O_STAR[0] * o2sky[2],
    O_STAR[0] * o2sky[1] - O_STAR[1] * o2sky[0],
  ];
  const dot = O_STAR[0] * o2sky[0] + O_STAR[1] * o2sky[1] + O_STAR[2] * o2sky[2];
  const sin = Math.hypot(cross[0], cross[1], cross[2]);
  const base = sin < 1e-12
    ? {w: 1, x: 0, y: 0, z: 0}
    : matToQuat(rodrigues(cross, Math.atan2(sin, dot)));
  return quatMul(quatFromAxisAngle([0, 1, 0], offsetRad), base);
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Vérité terrain identique à telemetryFit.test.ts : objet à 30°/40°,
 *  biais capteur W*, 5 orientations → 5 points cohérents (RMS ≈ 0). */
const O_STAR = altAzToVec(30, 40);
const W_STAR = rodrigues([0.1, 0.2, 0.9747], 0.15);
const ORIENTS: Quat[] = [
  quatFromAxisAngle([0, 0, 1], 0.3),
  quatFromAxisAngle([1, 0, 0], -0.5),
  quatFromAxisAngle([0, 1, 0], 0.9),
  quatFromAxisAngle([0.5, 0.5, 0.707], 1.8),
  quatFromAxisAngle([-0.3, 0.8, 0.5], 2.4),
];
const Q_TRUE = ORIENTS[0];
const TARGET_AA = vecToAltAz(matVec(W_STAR, matVec(quatToMat(Q_TRUE), O_STAR)));
const TARGET_RD = altAzToRaDec(TARGET_AA.altDeg, TARGET_AA.azDeg, SITE.latDeg, SITE.lonDeg, new Date());

/** Jeu de pointage courant (rad autour de y) — réduit à chaque :Q axe. */
let offsetRad = 0;

class MountTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}
  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}
  private reply(s: string) {this.dataCb?.(s);}
  async write(data: string): Promise<void> {
    this.writes.push(data);
    if (data.startsWith(':Sr') || data.startsWith(':Sd')) {this.reply('1#'); return;}
    if (data === ':MS#') {this.reply('0#'); return;}
    if (data === ':D#') {this.reply('#'); return;} // à l'arrêt
    if (data.startsWith(':SG') || data.startsWith(':SL') || data.startsWith(':SC')
      || data.startsWith(':St') || data.startsWith(':Sg') || data === ':GG#') {this.reply('1#'); return;}
    if (data === ':Ga#') {this.reply('+30:00#'); return;}
    if (data === ':Gz#') {this.reply('+40:00#'); return;}
    if (data === ':Gr#') {this.reply('10:00:00#'); return;}
    if (data === ':Gd#') {this.reply('+30:00#'); return;}
    if (data.startsWith(':Q') && data.length === 3) {
      // arrêt d'axe : la monture « rattrape » une partie du jeu
      offsetRad *= 0.02;
      const sensors = require('../src/services/phone/sensors') as any;
      sensors.__setQuat(currentMockQuat());
    }
  }
}

function inject(tp: MountTransport) {
  (autostar as any).transport = tp;
  (autostar as any).log = () => undefined;
  tp.onData((chunk: string) => (autostar as any).onData(chunk));
  useScopeStore.getState().setConnStatus('connected');
}

async function pumpUntil(cond: () => boolean, maxMs = 240000): Promise<boolean> {
  for (let t = 0; t < maxMs && !cond(); t += 50) {
    await jest.advanceTimersByTimeAsync(50);
  }
  return cond();
}

async function seedAndArm(tp: MountTransport, offset: number) {
  const tel = useTelemetryStore.getState();
  tel.clearPoints();
  for (const q of ORIENTS) {
    const aa = vecToAltAz(matVec(W_STAR, matVec(quatToMat(q), O_STAR)));
    tel.addPoint({name: 'point', raDeg: 10, decDeg: 20, altDeg: aa.altDeg, azDeg: aa.azDeg, quat: q});
  }
  useTrackingStore.getState().setTarget({
    name: 'Vega test', raDeg: TARGET_RD.raDeg, decDeg: TARGET_RD.decDeg, moving: null, from: 'catalog',
  });
  useTrackingStore.getState().reset();
  useTrackingStore.getState().setTarget({
    name: 'Vega test', raDeg: TARGET_RD.raDeg, decDeg: TARGET_RD.decDeg, moving: null, from: 'catalog',
  });
  offsetRad = offset;
  const sensors = require('../src/services/phone/sensors') as any;
  sensors.__setQuat(currentMockQuat());
  inject(tp);
}

/* ==================== tests ==================== */

describe('fineTune v2.2.0 — réglage fin télémétrique après GOTO', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useSettingsStore.getState().setTelemetryPrecision(true);
    initFineTune();
  });

  afterEach(() => {
    jest.useRealTimers();
    (autostar as any).transport = null;
    useTrackingStore.getState().reset();
  });

  it('bascule OFF : l\'arrivée GOTO ne déclenche RIEN (aucun moteur)', async () => {
    const tp = new MountTransport();
    await seedAndArm(tp, 0.005);
    useSettingsStore.getState().setTelemetryPrecision(false);
    await autostar.gotoRaDec(TARGET_RD.raDeg, TARGET_RD.decDeg);
    await pumpUntil(() => tp.writes.filter((w) => w.startsWith(':EK')).length > 0 || false, 3000);
    await jest.advanceTimersByTimeAsync(8000); // largement le temps d'un réglage fin
    expect(useTrackingStore.getState().fineTune.state).toBe('idle');
    expect(tp.writes.some((w) => /^:M[nsew]#$/.test(w))).toBe(false);
  }, 30000);

  it('bascule ON : mesure → corrections moteur → validation → point enregistré', async () => {
    const tp = new MountTransport();
    await seedAndArm(tp, 0.005); // ≈ 17′ d'erreur initiale
    const before = useTrackingStore.getState().fineTune.state;
    expect(before).toBe('idle');

    await autostar.gotoRaDec(TARGET_RD.raDeg, TARGET_RD.decDeg);
    let lastState = '';
    const arrived = await pumpUntil(() => {
      const st = useTrackingStore.getState();
      const cur = `${st.fineTune.state}|${st.fineTune.beforeArcmin?.toFixed(1) ?? '-'}|${st.phase}`;
      if (cur !== lastState) { lastState = cur; console.log('STATE', cur, 'writes', tp.writes.filter(w=>w.startsWith(':M')).length, 'D', tp.writes.filter(w=>w===':D#').length); }
      return st.fineTune.state === 'awaitValidation';
    }, 60000);
    expect(arrived).toBe(true);

    const ft = useTrackingStore.getState().fineTune;
    expect(ft.beforeArcmin).not.toBeNull();
    expect(ft.beforeArcmin!).toBeGreaterThan(8); // le jeu initial est mesuré
    expect(ft.afterArcmin!).toBeLessThan(ft.beforeArcmin!); // la boucle a corrigé
    expect(ft.name).toBe('Vega test');
    // des impulsions moteur ont bien été envoyées (:Mn#/:Ms#/:Me#/:Mw#)
    const motorWrites = () => tp.writes.filter((w) => /^:M[nsew]#$/.test(w)).length;
    expect(motorWrites()).toBeGreaterThan(0);

    // VALIDATION : aucun mouvement, un point de PLUS dans le recalage
    const nPoints = useTelemetryStore.getState().points.length;
    const motorBefore = motorWrites();
    let validated: boolean | null = null;
    void validateFineTune().then((r) => {validated = r;});
    await pumpUntil(() => validated != null, 20000);
    expect(validated).toBe(true);
    expect(useTrackingStore.getState().fineTune.state).toBe('applied');
    expect(useTelemetryStore.getState().points.length).toBe(nPoints + 1);
    expect(motorWrites()).toBe(motorBefore); // aucun moteur pendant la validation
  }, 60000);

  it('bascule ON : « Ignorer » referme sans enregistrer', async () => {
    const tp = new MountTransport();
    await seedAndArm(tp, 0.005);
    await autostar.gotoRaDec(TARGET_RD.raDeg, TARGET_RD.decDeg);
    await pumpUntil(() => useTrackingStore.getState().fineTune.state === 'awaitValidation', 60000);
    const nPoints = useTelemetryStore.getState().points.length;
    dismissFineTune();
    expect(useTrackingStore.getState().fineTune.state).toBe('dismissed');
    expect(useTelemetryStore.getState().points.length).toBe(nPoints);
  }, 60000);

  it('déjà précis (< 2′) : aucune correction, pas de demande de validation', async () => {
    const tp = new MountTransport();
    await seedAndArm(tp, 0.0002); // ≈ 0,7′ : sous le seuil
    await autostar.gotoRaDec(TARGET_RD.raDeg, TARGET_RD.decDeg);
    await jest.advanceTimersByTimeAsync(10000);
    const ft = useTrackingStore.getState().fineTune;
    expect(ft.state).toBe('idle');
    expect(tp.writes.some((w) => /^:M[nsew]#$/.test(w))).toBe(false);
  }, 30000);

  it('v2.3.0 — contrôle croisé POOR : état « unreliable », AUCUN moteur', async () => {
    const tp = new MountTransport();
    await seedAndArm(tp, 0.005); // jeu réel : le réglage fin aurait voulu corriger
    // Le moniteur de GOTO a rendu un verdict « télémétrie instable » pendant
    // le slew (boussole perturbée) — cf. gotocheck.crossCheck.
    useGotoCheckStore.getState().setReport({
      verdict: 'poor', gyroDeg: 30, teleDeg: 4, ratio: 0.13,
      smooth: {ok: false, n: 40, gapMaxMs: 2100, jitterPct: 180, spikeCount: 6, frozenPct: 10, meanStepDeg: 0.1},
      reasons: ['sky.reasonJitter', 'sky.reasonRatio'],
    });
    await autostar.gotoRaDec(TARGET_RD.raDeg, TARGET_RD.decDeg);
    await jest.advanceTimersByTimeAsync(10000);
    const ft = useTrackingStore.getState().fineTune;
    expect(ft.state).toBe('unreliable');
    expect(ft.name).toBe('Vega test');
    expect(ft.beforeArcmin).not.toBeNull();
    // sécurité : AUCUNE impulsion moteur — la boussole ne guide plus rien
    expect(tp.writes.some((w) => /^:M[nsew]#$/.test(w))).toBe(false);
  }, 30000);
});
