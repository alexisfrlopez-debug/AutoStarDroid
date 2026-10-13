/**
 * Tests v2.9.5 — PARC vers la « Position Home » enregistrée (parkToHome).
 *
 * Retour terrain : « quand je clique sur "park" dans l'onglet principal, le
 * telescope ne revient pas sur la position "home" que j'ai enregistré dans
 * l'onglet "alignement" ».
 *
 * Trois comportements verrouillés :
 *  1. point Home présent → GOTO relais MODE PARC vers la géométrie Home
 *     RECONVERTIE en AD/Dec à l'instant présent (la Home alt-az = tube
 *     horizontal alt 0° serait refusée par la garde normale du relais
 *     comme par :MS) ;
 *  2. sans point Home → repli parc raquette :hP# (Meade) ;
 *  3. hors Meade sans point Home → erreur claire (pas de :hP#).
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
import {useTelemetryStore} from '../src/store/telemetryStore';
import {useMotorCalibStore} from '../src/store/motorCalibStore';
import {getDriver} from '../src/services/protocol/driver';
import {altAzToRaDec} from '../src/services/astro/coords';
import {proto} from '../src/services/astro/time';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';
import {TransportError} from '../src/services/connection/types';

const PARIS = {name: 'Paris', latDeg: 48.8566, lonDeg: 2.3522, elevM: 35};
const HOME_QUAT = {w: 1, x: 0, y: 0, z: 0};

/** Transport « scripté » (réponses à chaque écriture, null = muet). */
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

/** Transport « monture vivante » : la monture converge vers la Home — la
 *  cible est calculée à la PREMIÈRE lecture (dérive AD entre parkToHome et
 *  cette lecture ≈ 0,01° « tolérance d'arrivée 0,12°). La première impulsion
 *  AD amène la monture SUR la cible : le relais doit conclure « ok » SANS
 *  refuser la cible à l'horizon (garde normale : alt 0 < minAlt + 2°). */
class LiveScopeTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  target: {raDeg: number; decDeg: number} | null = null;
  private raNow = 0;
  private pulses = 0;
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
      if (!this.target) {
        this.target = altAzToRaDec(0, 0, PARIS.latDeg, PARIS.lonDeg, new Date());
        this.raNow = this.target.raDeg - 3; // départ : 3° de la Home
      }
      this.dataCb?.(proto.raCmd(this.raNow) + '#');
      return;
    }
    if (data === ':Gd#') {
      const dec = (this.target ?? altAzToRaDec(0, 0, PARIS.latDeg, PARIS.lonDeg, new Date())).decDeg;
      this.dataCb?.(proto.decCmdHigh(dec) + '#');
      return;
    }
    if (data === ':Me#') {
      this.pulses += 1;
      if (this.target) this.raNow = this.target.raDeg; // 1re impulsion = arrivée
    }
    /* vitesses (:RS#/:R9#), stops (:Qe#/:Q#) : muets */
  }
}

async function scriptClient(capMs = 60): Promise<{client: AutostarClient; tp: ScriptTransport}> {
  const client = new AutostarClient();
  const tp = new ScriptTransport();
  jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
  const orig = (client as any).cmd.bind(client);
  jest.spyOn(client as any, 'cmd').mockImplementation(
    (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, capMs), e),
  );
  (client as any).transport = tp;
  tp.onData((chunk) => (client as any).onData(chunk));
  return {client, tp};
}

describe('v2.9.5 — parcToHome : le bouton PARC vise la Home de l\u2019onglet Alignement', () => {
  let client: AutostarClient | null = null;

  beforeEach(() => {
    useSettingsStore.getState().setSite(PARIS);
    useScopeStore.getState().setAlignMode('altaz'); // Home = tube horizontal (alt 0, az 0)
    useMotorCalibStore.getState().setRates({speed: 'slew', e: 5, w: 5, n: 5, s: 5, noise: 0.01});
    useMotorCalibStore.getState().setApply(true);
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    client = null;
    jest.restoreAllMocks();
    useTelemetryStore.getState().clearPoints();
    useMotorCalibStore.getState().resetAll();
    useScopeStore.getState().setConnStatus('disconnected');
  });

  test('point Home enregistré → relais MODE PARC vers la Home reconvertie à l\u2019instant présent', async () => {
    ({client} = {client: new AutostarClient()});
    const tp = new ScriptTransport();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    (client as any).transport = tp;
    tp.onData((chunk) => (client as any).onData(chunk));
    const relaySpy = jest.spyOn(client as any, 'gotoRaDecRelay').mockResolvedValue('ok');

    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const res = await client.parkToHome();
    expect(res).toEqual({via: 'home', status: 'ok'});
    expect(relaySpy).toHaveBeenCalledTimes(1);

    // cible = géométrie Home (alt-az : alt 0°, az 0°) reconvertie MAINTENANT
    const [ra, dec, , , , opts] = relaySpy.mock.calls[0] as unknown as [
      number, number, string, Date, number, {park?: boolean},
    ];
    const expected = altAzToRaDec(0, 0, PARIS.latDeg, PARIS.lonDeg, new Date());
    expect(ra).toBeCloseTo(expected.raDeg, 1); // dérive AD < 0,05° entre les 2 calculs
    expect(dec).toBeCloseTo(expected.decDeg, 3);
    expect(opts.park).toBe(true); // la cible à l'horizon doit passer la garde
  });

  test('le mode parc emporte la garde basse : cible alt 0° convergée → « ok » (pas noObject/relayPartial)', async () => {
    client = new AutostarClient();
    const tp = new LiveScopeTransport();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    const orig = (client as any).cmd.bind(client);
    jest.spyOn(client as any, 'cmd').mockImplementation(
      (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, 60), e),
    );
    (client as any).transport = tp;
    tp.onData((chunk) => (client as any).onData(chunk));

    useTelemetryStore.getState().setHomePoint({
      name: 'Home', raDeg: 0, decDeg: 0, altDeg: 0, azDeg: 0, quat: HOME_QUAT,
    });
    const res = await client.parkToHome();
    expect(res.via).toBe('home');
    expect(res.status).toBe('ok');
    // le relais a piloté les moteurs (pas de :Sr/:Sd/:MS direct en parc)
    expect(tp.writes).toContain(':RS#');
    expect(tp.writes).toContain(':Me#');
    expect(tp.writes.some((w) => w.startsWith(':MS'))).toBe(false);
    expect(tp.writes.some((w) => w.startsWith(':Sr'))).toBe(false);
  }, 30000);

  test('sans point Home → repli parc raquette :hP# (Meade)', async () => {
    const {client: c, tp} = await scriptClient();
    client = c;
    useTelemetryStore.getState().clearPoints();
    const res = await client.parkToHome();
    expect(res).toEqual({via: 'handbox', status: 'ok'});
    expect(tp.writes).toContain(':hP#');
  });

  test('hors Meade sans point Home → erreur explicite (pas de :hP# inventé)', async () => {
    const {client: c, tp} = await scriptClient();
    client = c;
    (client as any).drv = getDriver('celestron');
    useTelemetryStore.getState().clearPoints();
    await expect(client.parkToHome()).rejects.toBeInstanceOf(TransportError);
    expect(tp.writes).not.toContain(':hP#');
  });
});
