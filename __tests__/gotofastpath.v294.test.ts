/**
 * Tests v2.9.4 — fin du « le goto est toujours lent quand il se lance »
 * (2e retour terrain) :
 *
 *  1. CACHE « CHEMIN DIRECT MORT » : sur les raquettes #49x muettes à
 *     :Sr/:Sd/:MS, chaque GOTO repayait 15-25 s de sondes (ESC ESC + 2
 *     précisions :Sr + :Sd + :MS + sonde :D#) AVANT que le relais ne bouge
 *     la monture. Dès qu'un chemin direct échoue (muet/refus), les GOTO
 *     suivants de la session partent DIRECTEMENT en relais — le premier
 *     mouvement moteur part en ~1 s.
 *  2. BOOST DE VITESSE : :RS#/:R9# précèdent :Sr/:Sd/:MS — un GOTO natif
 *     accepté part au taux maximum de la raquette (et non au taux courant,
 *     resté à center/guide après un suivi ou un réglage fin).
 *  3. Les refus HONNÊTES du protocole (:MS = 1/2 — sous l'horizon, objet
 *     introuvable) ne tuent PAS le chemin direct : ce n'est pas un défaut
 *     de liaison, le prochain GOTO (autre cible) doit retenter le natif.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {AutostarClient} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';
import {useMotorCalibStore} from '../src/store/motorCalibStore';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';

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

describe('v2.9.4 — GOTO : cache « chemin direct mort » + boost de vitesse', () => {
  let client: AutostarClient;
  let tp: ScriptTransport;

  beforeEach(() => {
    client = null as any; tp = null as any;
    useSettingsStore.getState().setSite(POLE); // alt(DEC) = DEC > 0 garanti
    useMotorCalibStore.getState().setRates({speed: 'slew', e: 5, w: 5, n: 5, s: 5, noise: 0.01});
    useMotorCalibStore.getState().setApply(true);
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
    useMotorCalibStore.getState().resetAll();
  });

  async function connect(capMs = 60) {
    client = new AutostarClient();
    tp = new ScriptTransport();
    // log → pushLog : les lignes this.log('info'/'error') alimentent le
    // journal du store (les assertions log le lisent), sent/recv ignorés.
    jest.spyOn(client as any, 'log').mockImplementation((dir: string, m: string) => {
      if (dir === 'info' || dir === 'error' || dir === 'warn') {
        useScopeStore.getState().pushLog(dir, m);
      }
    });
    const orig = (client as any).cmd.bind(client);
    jest.spyOn(client as any, 'cmd').mockImplementation(
      (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, capMs), e),
    );
    (client as any).transport = tp;
    tp.onData((chunk) => (client as any).onData(chunk));
  }

  test('1er GOTO : chemin direct refusé → relais ; 2e GOTO : RELAIS IMMÉDIAT (plus aucune sonde :Sr)', async () => {
    await connect();
    // GOTO 1 — direct refusé ×2, relais converge (AD 90° → 100°)
    tp.script = [
      null, null,                       // boost : :RS#, :R9# (muets)
      '0#', '0#',                       // :Sr refusé ×2 → 'refused' → relais
      '06:00:00#', '+20*00#',           // position : AD 90°, DEC 20°
      null, null, null, null,           // :RS#, :R9#, :Me#, :Qe#
      '06:40:00#', '+20*00#',           // AD 100° = cible → done
      null, null,                       // :Q# ×2 (done + finally)
    ];
    const r1 = await client.gotoRaDec(100, 20);
    expect(r1).toBe('ok');
    expect((client as any).directGotoDead).toBe(true);
    const srAfterFirst = tp.writes.filter((w) => w.startsWith(':Sr')).length;
    expect(srAfterFirst).toBe(2);

    // GOTO 2 — AUCUNE sonde directe : le relais part sur la position lue
    tp.script = [
      '06:40:00#', '+20*00#',           // position : AD 100°, DEC 20°
      null, null, null, null,           // :RS#, :R9#, :Me#, :Qe#
      '06:42:00#', '+20*00#',           // AD 100,5° = cible → done
      null, null,                       // :Q# ×2 (done + finally)
    ];
    const r2 = await client.gotoRaDec(100.5, 20);
    expect(r2).toBe('ok');
    // le chemin direct n'a PAS été retenté (toujours 2 :Sr au total)
    expect(tp.writes.filter((w) => w.startsWith(':Sr')).length).toBe(srAfterFirst);
    // le journal l'annonce explicitement
    const log = useScopeStore.getState().log.map((l) => l.text);
    expect(log.some((m) => m.includes('RELAIS immédiat'))).toBe(true);
  }, 60000);

  test('boost de vitesse : :RS#/:R9# partent AVANT :Sr (GOTO natif au taux max)', async () => {
    await connect();
    // chemin direct accepté de bout en bout
    tp.script = [
      null, null,                       // boost : :RS#, :R9#
      '1#', '1#', '0#',                 // :Sr ok, :Sd ok, :MS = 0 (parti)
    ];
    const r = await client.gotoRaDec(10, 20);
    expect(r).toBe('ok');
    const iRS = tp.writes.indexOf(':RS#');
    const iR9 = tp.writes.indexOf(':R9#');
    const iSr = tp.writes.findIndex((w) => w.startsWith(':Sr'));
    expect(iRS).toBeGreaterThanOrEqual(0);
    expect(iR9).toBeGreaterThan(iRS);
    expect(iSr).toBeGreaterThan(iR9); // le boost précède la pose de cible
    expect((client as any).directGotoDead).toBe(false); // natif OK → pas de cache
  }, 30000);

  test(':MS = 1 (sous l\u2019horizon) : refus HONNÊTE — le chemin direct N\u2019EST PAS tué', async () => {
    await connect();
    tp.script = [
      null, null,                       // boost
      '1#', '1#', '1#',                 // :Sr ok, :Sd ok, :MS = 1 → belowHorizon
    ];
    const r1 = await client.gotoRaDec(10, -30);
    expect(r1).toBe('belowHorizon');
    expect((client as any).directGotoDead).toBe(false);

    // 2e GOTO (autre cible) : le natif est RETENTÉ (1 :Sr + 1 :MS par GOTO —
    // la 1re précision acceptée court-circuite la 2e)
    tp.script = [
      null, null,
      '1#', '1#', '1#',
    ];
    const r2 = await client.gotoRaDec(10, -40);
    expect(r2).toBe('belowHorizon');
    expect(tp.writes.filter((w) => w.startsWith(':Sr')).length).toBe(2);
    expect(tp.writes.filter((w) => w === ':MS#').length).toBe(2);
  }, 30000);
});
