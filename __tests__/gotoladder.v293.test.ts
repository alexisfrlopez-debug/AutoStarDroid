/**
 * Tests v2.9.3 — GOTO « toujours lent » : TROIS paliers dans le relais
 * (slew → find → center — la fin de course ne rampe plus à 0,05°/s sur
 * 2,5°), vitesse demandée à CHAQUE itération (une commande perdue ne
 * laisse plus la monture au taux précédent), doublon de famille
 * :RS#/:R9# (LX200 classique + niveau Autostar explicite) et apprentissage
 * du taux réel en cours de pointage (relayLearnRate via AutostarClient).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {AutostarClient} from '../src/services/protocol/client';
import {MEADE_DRIVER} from '../src/services/protocol/drivers/meade';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';
import {useMotorCalibStore} from '../src/store/motorCalibStore';
import type {DriverClient} from '../src/services/protocol/driver';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';

/* ==================== outillage ==================== */

/** DriverClient factice : enregistre les commandes silencieuses. */
class SpeedClient implements DriverClient {
  sent: string[] = [];
  async cmd(c: string): Promise<string> {this.sent.push(c); throw new Error('mute');}
  async cmdSilent(c: string) {this.sent.push(c);}
  transportAlive() {return true;}
  async resetParser() {}
  bump() {}
  log() {}
  warn() {}
}

/** Transport « scripté » : chaque écriture consomme la réponse suivante. */
class ScriptTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  script: Array<string | null> = [];
  private dataCb: ((chunk: string) => void) | null = null;
  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}
  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}
  async write(data: string): Promise<void> {
    this.writes.push(data);
    const next = this.script.shift();
    if (next != null) this.dataCb?.(next);
  }
}

const POLE = {name: 'Pôle', latDeg: 90, lonDeg: 0, elevM: 0};

/* ==================== 1. doublon de famille :RS#/:R9# ==================== */

describe('v2.9.3 — setSpeed Meade : doublon de famille (LX200 + Autostar)', () => {
  let c: SpeedClient;
  beforeEach(() => {c = new SpeedClient();});

  it('slew → :RS# PUIS :R9# (niveau explicite Autostar)', async () => {
    await MEADE_DRIVER.setSpeed(c, 'slew');
    expect(c.sent).toEqual([':RS#', ':R9#']);
  });
  it('find → :RM# PUIS :R4#', async () => {
    await MEADE_DRIVER.setSpeed(c, 'find');
    expect(c.sent).toEqual([':RM#', ':R4#']);
  });
  it('center → :RC# seul (taux MESURÉ au calibrage — pas de décalage)', async () => {
    await MEADE_DRIVER.setSpeed(c, 'center');
    expect(c.sent).toEqual([':RC#']);
  });
  it('guide → :RG# seul', async () => {
    await MEADE_DRIVER.setSpeed(c, 'guide');
    expect(c.sent).toEqual([':RG#']);
  });
});

/* ==================== 2. palier FIND en relais e2e ==================== */

describe('v2.9.3 — RELAIS e2e : palier find (fin de la course rampante)', () => {
  let client: AutostarClient;
  let tp: ScriptTransport;

  beforeEach(() => {
    client = null as any; tp = null as any;
    useSettingsStore.getState().setSite(POLE);
    // PAS de calibrage : les taux viennent du preset générique
    // (slew 2°/s, find 0,4°/s, center 0,08°/s)
    useMotorCalibStore.getState().setApply(false);
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
    useMotorCalibStore.getState().resetAll();
  });

  test('cible à 1° d\u2019AD → vitesse find (:RM#/:R4#), JAMAIS center (:RC#)', async () => {
    client = new AutostarClient();
    tp = new ScriptTransport();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    const orig = (client as any).cmd.bind(client);
    jest.spyOn(client as any, 'cmd').mockImplementation(
      (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, 60), e),
    );
    (client as any).transport = tp;
    tp.onData((chunk) => (client as any).onData(chunk));
    // :Sr refusé ×2 → relais ; position AD 100° (14h40) → cible AD 101°
    // impulsion 1 (find 0,4°/s : 1×0,8/0,4 = 2 s) → arrivée
    tp.script = [
      null, null,                       // boost v2.9.4 : :RS#, :R9#
      '0#', '0#',                       // :Sr refusé ×2 → relais
      '06:40:00#', '+20*00#',           // position initiale : AD 100°, DEC 20°
      null, null, null, null,           // :RM#, :R4#, :Me#, :Qe#
      '06:44:00#', '+20*00#',           // relecture : AD 101° = cible → done
      null, null,                       // :Q# ×2 (done + finally)
    ];
    const r = await client.gotoRaDec(101, 20);
    expect(r).toBe('ok');
    expect(tp.writes).toContain(':RM#');   // palier find (famille LX200)
    expect(tp.writes).toContain(':R4#');   // doublon Autostar
    expect(tp.writes.some((w) => w === ':RC#')).toBe(false); // jamais center
    // v2.9.4 : le boost du chemin direct envoie :RS# UNE fois ; le RELAIS
    // n'a jamais slewté (cible à 1° — le palier reste find)
    expect(tp.writes.filter((w) => w === ':RS#').length).toBe(1);
    expect(tp.writes.filter((w) => w === ':Me#').length).toBe(1);
  }, 30000);

  test('taux APPRIS : monture plus lente que l\u2019hypothèse → traversée slew→find→center recalée', async () => {
    client = new AutostarClient();
    tp = new ScriptTransport();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    const orig = (client as any).cmd.bind(client);
    jest.spyOn(client as any, 'cmd').mockImplementation(
      (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, 60), e),
    );
    (client as any).transport = tp;
    tp.onData((chunk) => (client as any).onData(chunk));
    // calibrage : hypothèse slew 2°/s ; la monture fait 1°/s réels.
    // itération 1 (slew 4 s) : arc réel 4° → obs 1°/s → JOURNAL « taux réel »
    // itération 2 (slew, taux appris 1 : 4,8 s) : AD 108,8 (reste 1,2°)
    // itération 3 (find 0,4 : 2,4 s) : AD 109,758 (reste 0,24°)
    // itération 4 (center 0,08 : ~2,3 s) : AD 110 = cible → ok
    useMotorCalibStore.getState().setRates({speed: 'slew', e: 2, w: 2, n: 2, s: 2, noise: 0.01});
    useMotorCalibStore.getState().setApply(true);
    tp.script = [
      null, null,                       // boost v2.9.4 : :RS#, :R9#
      '0#', '0#',                       // :Sr refusé ×2 → relais
      '06:40:00#', '+20*00#',           // position initiale : AD 100°, DEC 20°
      null, null, null, null,           // itération 1 : :RS#, :R9#, :Me#, :Qe#
      '06:56:00#', '+20*00#',           // AD 104° (reste 6°)
      null, null, null, null,           // itération 2 : :RS#, :R9#, :Me#, :Qe#
      '07:15:12#', '+20*00#',           // AD 108,8° (reste 1,2°)
      null, null, null, null,           // itération 3 : :RM#, :R4#, :Me#, :Qe#
      '07:19:02#', '+20*00#',           // AD 109,758° (reste 0,24°)
      null, null, null,                 // itération 4 : :RC#, :Me#, :Qe# (center = 1 seule vitesse)
      '07:20:00#', '+20*00#',           // AD 110° = cible
      null, null,                       // :Q# ×2 (done + finally)
    ];
    const r = await client.gotoRaDec(110, 20);
    expect(r).toBe('ok');
    expect(tp.writes.filter((w) => w === ':RS#').length).toBe(3);  // boost + 2 itérations slew
    expect(tp.writes.filter((w) => w === ':RM#').length).toBe(1);  // 1 itération find
    expect(tp.writes.filter((w) => w === ':RC#').length).toBe(1);  // 1 itération center
    // le journal annonce le taux réel appris (une seule ligne, vitesse slew)
    const log = useScopeStore.getState().log
      .filter((l) => l.text.includes('taux réel')).map((l) => l.text);
    expect(log.length).toBe(1);
    expect(log[0]).toContain('slew');
  }, 45000);
});
