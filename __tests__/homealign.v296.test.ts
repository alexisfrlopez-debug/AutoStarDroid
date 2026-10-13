/**
 * Tests v2.9.6 — ALIGNEMENT HOME imposé au lancement de la série de tests.
 *
 * Retour terrain : « la série de tests d'alignement est toujours très
 * lente. il faudrait qu'elle impose un alignement sur "home" avant de se
 * lancer et qu'elle prenne cette position en compte pour les butées de
 * test. »
 *
 * Comportements verrouillés :
 *  1. alignToHome() — GOTO Home par le relais MODE PARC puis SYNC
 *     (:Sr/:Sd/:CM#) sur les coordonnées Home RECALCULÉES à l'arrivée ;
 *  2. sans point Home → 'none' sans toucher les moteurs ;
 *  3. relais échoué → 'nogoto' (pas de SYNC) ;
 *  4. SYNC refusé → 'nosync' (le GOTO, lui, a bien eu lieu) ;
 *  5. diagRunner : avec un point Home, la suite émet la phase 'home' AVANT
 *     les pré-contrôles et consigne homeAlign=1 dans le test 'pre' ;
 *  6. sans point Home, aucun événement 'home' et homeAlign=null ;
 *  7. gardes de butées v2.9.6 : plafonds 150 s / 90 s.
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

import {AutostarClient} from '../src/services/protocol/client';
import {diagRunner, setDiagSleepForTests, setDiagNowForTests} from '../src/services/tracking/diagService';
import {autostar} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';
import {useTelemetryStore} from '../src/store/telemetryStore';
import {useMotorCalibStore} from '../src/store/motorCalibStore';
import {useDiagStore} from '../src/store/diagStore';
import {MOUNT_PRESETS, limitLegGuardSec, fastApproachGuardSec} from '../src/services/astro/mounts';
import {altAzToRaDec} from '../src/services/astro/coords';
import {proto} from '../src/services/astro/time';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';

const PARIS = {name: 'Paris', latDeg: 48.8566, lonDeg: 2.3522, elevM: 35};
const HOME_QUAT = {w: 1, x: 0, y: 0, z: 0};

/** Transport « monture vivante » : converge vers la Home à la 1re impulsion
 *  AD (même principe que parkHome.v295). Options de script :
 *  - positionMute : :Gr#/:Gd# muets (relais abandonné → 'mute') ;
 *  - syncRefuse : :Sr répond '0' (SYNC refusé). */
class LiveScopeTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  target: {raDeg: number; decDeg: number} | null = null;
  positionMute = false;
  syncRefuse = false;
  private raNow = 0;
  private dataCb: ((chunk: string) => void) | null = null;
  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return true;}
  async connect(_opts: ConnectOptions) {}
  async disconnect() {}
  async write(data: string): Promise<void> {
    this.writes.push(data);
    if (data === ':Gr#') {
      if (this.positionMute) return; // muet
      if (!this.target) {
        this.target = altAzToRaDec(0, 0, PARIS.latDeg, PARIS.lonDeg, new Date());
        this.raNow = this.target.raDeg - 3; // départ : 3° de la Home
      }
      this.dataCb?.(proto.raCmd(this.raNow) + '#');
      return;
    }
    if (data === ':Gd#') {
      if (this.positionMute) return;
      const dec = (this.target ?? altAzToRaDec(0, 0, PARIS.latDeg, PARIS.lonDeg, new Date())).decDeg;
      this.dataCb?.(proto.decCmdHigh(dec) + '#');
      return;
    }
    if (data === ':Me#') {
      if (this.target) this.raNow = this.target.raDeg; // 1re impulsion = arrivée
      return;
    }
    if (this.syncRefuse && data.startsWith(':Sr')) { this.dataCb?.('0#'); return; }
    if (this.syncRefuse && data.startsWith(':Sd')) { this.dataCb?.('0#'); return; }
    if (data.startsWith(':Sr') || data.startsWith(':Sd')) { this.dataCb?.('1#'); return; }
    /* vitesses, stops, :CM# : muets */
  }
}

function liveClient(tp: LiveScopeTransport): AutostarClient {
  const client = new AutostarClient();
  jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
  const orig = (client as any).cmd.bind(client);
  jest.spyOn(client as any, 'cmd').mockImplementation(
    (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, 60), e),
  );
  (client as any).transport = tp;
  tp.onData((chunk) => (client as any).onData(chunk));
  return client;
}

/* ================================================================== */
/* Partie A — alignToHome                                              */
/* ================================================================== */

describe('v2.9.6 — alignToHome : GOTO Home puis SYNC sur les coordonnées recalculées', () => {
  let client: AutostarClient | null = null;
  let tp: LiveScopeTransport | null = null;

  beforeEach(() => {
    useSettingsStore.getState().setSite(PARIS);
    useScopeStore.getState().setAlignMode('altaz'); // Home = tube horizontal
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    client = null; tp = null;
    jest.restoreAllMocks();
    useTelemetryStore.getState().clearPoints();
    useMotorCalibStore.getState().resetAll();
    useScopeStore.getState().setConnStatus('disconnected');
  });

  test('point Home + monture vivante → relais parc convergé PUIS :Sr/:Sd/:CM# — SYNC APRÈS les moteurs', async () => {
    client = liveClient(new LiveScopeTransport());
    tp = (client as any).transport as LiveScopeTransport;
    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const res = await client.alignToHome();
    expect(res).toBe('ok');
    // le relais a piloté les moteurs (mode parc — jamais :Sr/:Sd/:MS du GOTO)
    expect(tp.writes).toContain(':RS#');
    expect(tp.writes).toContain(':Me#');
    expect(tp.writes.some((w) => w.startsWith(':MS'))).toBe(false);
    // le SYNC a posé les coordonnées recalculées et clôturé par :CM#
    expect(tp.writes.some((w) => w.startsWith(':Sr'))).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':Sd'))).toBe(true);
    expect(tp.writes).toContain(':CM#');
    // ORDRE : le :CM# arrive APRÈS la dernière impulsion moteur (sync à l'arrivée)
    const lastPulse = tp.writes.map((w, i) => (w === ':Me#' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(tp.writes.indexOf(':CM#')).toBeGreaterThan(lastPulse);
  }, 30000);

  test('sans point Home → « none », aucun moteur commandé', async () => {
    client = liveClient(new LiveScopeTransport());
    tp = (client as any).transport as LiveScopeTransport;
    const res = await client.alignToHome();
    expect(res).toBe('none');
    expect(tp.writes.filter((w) => w.startsWith(':M') || w.startsWith(':R')).length).toBe(0);
  });

  test('position illisible (raquette muette) → relais abandonné → « nogoto », pas de SYNC', async () => {
    client = liveClient(new LiveScopeTransport());
    tp = (client as any).transport as LiveScopeTransport;
    tp.positionMute = true;
    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const res = await client.alignToHome();
    expect(res).toBe('nogoto');
    expect(tp.writes).not.toContain(':CM#');
  });

  test('SYNC refusé (:Sr = 0) → « nosync » — le GOTO Home, lui, a bien eu lieu', async () => {
    client = liveClient(new LiveScopeTransport());
    tp = (client as any).transport as LiveScopeTransport;
    tp.syncRefuse = true;
    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const res = await client.alignToHome();
    expect(res).toBe('nosync');
    expect(tp.writes).toContain(':Me#'); // le retour Home a été piloté
    expect(tp.writes).not.toContain(':CM#'); // pas de sync clôturé
  }, 30000);
});

/* ================================================================== */
/* Partie B — préambule de la SUITE de diagnostic                      */
/* ================================================================== */

/** Transport Meade SCRIPTÉ (identique diagSuite) : la suite entière tourne
 *  sur monture saine virtuelle. */
class ReplTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
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
    else if (data.startsWith(':SG') || data.startsWith(':SL') || data.startsWith(':SC')
      || data.startsWith(':St') || data.startsWith(':Sg')) this.reply('1#');
    else if (data.startsWith(':Sr') || data.startsWith(':Sd')) this.reply('1#');
    else if (data === ':MS#') this.reply('0#');
    else if (data === ':D#') this.reply('#');
    else if (data.startsWith(':EK')) { /* touches : rien */ }
    else if (data.startsWith(':ED#')) {
      this.reply('\u0080Objet           ' + '                ' + '#');
    }
  }
  get gyroRateDegPerSec(): number {
    return this.dirs.n - this.dirs.s + this.dirs.e - this.dirs.w;
  }
}

const sensorsMock = require('../src/services/phone/sensors') as any;

describe('v2.9.6 — la série de tests impose l\u2019alignement Home AVANT de se lancer', () => {
  let tp: ReplTransport;
  let fakeNow: number;
  let realDateNow: () => number;

  beforeAll(() => {
    realDateNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
  });
  afterAll(() => {
    (jest.spyOn(Date, 'now') as any).mockRestore();
  });

  beforeEach(() => {
    fakeNow = realDateNow();
    tp = new ReplTransport();
    (autostar as any).transport = tp;
    (autostar as any).log = () => undefined;
    tp.onData((chunk) => (autostar as any).onData(chunk));
    useScopeStore.getState().setConnStatus('connected');
    useSettingsStore.getState().setSite(PARIS);
    useMotorCalibStore.getState().resetAll();
    useDiagStore.getState().clear();
    useTelemetryStore.getState().clearPoints();
    diagRunner.abort();

    setDiagSleepForTests(async (ms: number) => {
      const cb = sensorsMock.__state.cb as ((g: any) => void) | null;
      if (cb) {
        const rate = tp.gyroRateDegPerSec;
        for (let t = fakeNow + 50; t <= fakeNow + ms; t += 50) {
          cb({t, x: 0, y: 0, z: (rate * Math.PI) / 180, accuracy: 3, ts: t});
        }
      }
      fakeNow += ms;
    });
    setDiagNowForTests(() => fakeNow);
  });

  test('point Home enregistré → phase « home » émise avant les pré-contrôles, homeAlign=1 dans le rapport', async () => {
    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const alignSpy = jest.spyOn(autostar, 'alignToHome').mockResolvedValue('ok');
    alignSpy.mockClear(); // le spy peut traverser les tests (aucun restore global ici)
    const events: any[] = [];
    const report = await diagRunner.run((e) => events.push(e));
    expect(report.results.length).toBe(10);
    expect(alignSpy).toHaveBeenCalledTimes(1);
    // la phase 'home' arrive AVANT le 'start' des pré-contrôles
    const iHome = events.findIndex((e) => e.test === 'pre' && e.phase === 'home');
    const iStart = events.findIndex((e) => e.test === 'pre' && e.phase === 'start');
    expect(iHome).toBeGreaterThanOrEqual(0);
    expect(iHome).toBeLessThan(iStart);
    const pre = report.results.find((r) => r.id === 'pre');
    expect(pre!.values.homeAlign).toBe(1);
  }, 45000);

  test('sans point Home → aucun événement « home », homeAlign=null, alignToHome jamais appelé', async () => {
    const alignSpy = jest.spyOn(autostar, 'alignToHome').mockResolvedValue('ok');
    alignSpy.mockClear(); // compte frais : le spy du test précédent persiste
    const events: any[] = [];
    const report = await diagRunner.run((e) => events.push(e));
    expect(report.results.length).toBe(10);
    expect(alignSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'home')).toBe(false);
    const pre = report.results.find((r) => r.id === 'pre');
    expect(pre!.values.homeAlign).toBeNull();
  }, 45000);
});

/* ================================================================== */
/* Partie C — gardes de butées v2.9.6 (plafonds raccourcis)            */
/* ================================================================== */

describe('v2.9.6 — gardes de butées raccourcies (suite plus rapide)', () => {
  const generic = MOUNT_PRESETS.generic;
  test('limitLegGuardSec plafonné à 150 s', () => {
    // 0→90° à 0,05°/s : (90/0,05)×1,4+10 = 2530 s → plafond 150
    expect(limitLegGuardSec(0, true, generic, 0.05)).toBe(150);
    expect(limitLegGuardSec(45, true, generic, 0.05)).toBe(150);
  });
  test('fastApproachGuardSec plafonné à 90 s', () => {
    // course énorme + taux slew minuscule → plafond 90
    expect(fastApproachGuardSec(500, generic)).toBe(90);
  });
});
