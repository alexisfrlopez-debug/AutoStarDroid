/**
 * Tests v2.5.0 — GOTO RELAIS de bout en bout (AutostarClient.gotoRaDec) :
 * la séquence directe :Sr/:Sd/:MS échoue (refus/mutisme) → l'app pilote
 * elle-même les moteurs en boucle fermée (vitesses :RS#/:RC#, impulsions
 * :Me#…/:Qe#, lectures :Gr#/:Gd#) jusqu'à la cible. C'est le contournement
 * du retour terrain : « le goto ne fonctionne toujours pas quand il est
 * lancé autrement que par la raquette ».
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

async function connectedClient(capMs = 60): Promise<{client: AutostarClient; tp: ScriptTransport}> {
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

const POLE = {name: 'Pôle', latDeg: 90, lonDeg: 0, elevM: 0};

describe('v2.5.0 — GOTO RELAIS en boucle fermée (fin de la déconnexion au GOTO app)', () => {
  let client: AutostarClient;
  let tp: ScriptTransport;

  beforeEach(() => {
    client = null as any; tp = null as any;
    useSettingsStore.getState().setSite(POLE); // alt(DEC) = DEC > 0 garanti
    // taux MESURÉS : slew 5°/s → impulsions courtes dans les tests
    useMotorCalibStore.getState().setRates({speed: 'slew', e: 5, w: 5, n: 5, s: 5, noise: 0.01});
    useMotorCalibStore.getState().setApply(true);
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
    useMotorCalibStore.getState().resetAll();
  });

  test(':Sr refusé aux 2 précisions → RELAIS converge vers la cible → ok (moteurs :RS/:Me/:Qe)', async () => {
    ({client, tp} = await connectedClient());
    // chemin direct : :Sr haute précision refusée, basse précision refusée
    // relais : position (AD 6h00 = 90°, DEC +20*00) → cible (AD 100°, DEC 20°)
    // v2.9.3 : setSpeed à CHAQUE itération + doublon :RS#/:R9# → 4 écritures
    // par itération (RS, R9, Me, Qe)
    tp.script = [
      '0#', '0#',                       // :Sr refusé ×2 → 'refused' → relais
      '06:00:00#', '+20*00#',           // position initiale : AD 90°, DEC 20°
      null, null, null, null,           // :RS#, :R9#, :Me#, :Qe#
      '06:24:00#', '+20*00#',           // relecture : AD 96° (reste 4°)
      null, null, null, null,           // 2e itération : :RS#, :R9#, :Me#, :Qe#
      '06:40:00#', '+20*00#',           // relecture : AD 100° = cible → done
      null, null,                       // :Q# (stopAll) ×2 (done + finally)
    ];
    const r = await client.gotoRaDec(100, 20);
    expect(r).toBe('ok');
    // les commandes du relais sont passées par là
    expect(tp.writes).toContain(':RS#');       // vitesse slew
    expect(tp.writes).toContain(':R9#');       // doublon Autostar v2.9.3
    expect(tp.writes.filter((w) => w === ':RS#').length).toBe(2); // à CHAQUE itération
    expect(tp.writes.filter((w) => w === ':Me#').length).toBe(2); // 2 impulsions Est
    expect(tp.writes.filter((w) => w === ':Qe#').length).toBe(2); // stop individuel
    expect(tp.writes.filter((w) => w === ':Q#').length).toBe(2);  // stopAll ×2
    expect(tp.writes.some((w) => w === ':RC#')).toBe(false);      // jamais center
    expect(tp.writes.some((w) => w === ':MS#')).toBe(false);      // jamais :MS
  }, 30000);

  test('RELAIS : position figée malgré les impulsions (butée) → relayPartial', async () => {
    ({client, tp} = await connectedClient());
    // cible AD 100° jamais atteinte : la relecture renvoie TOUJOURS 90°
    // v2.9.3 : 4 écritures par itération (RS, R9, Me, Qe) — l'apprentissage
    // ne s'applique pas (arc mesuré sous le bruit : valeur précédente)
    tp.script = [
      '0#', '0#',                       // :Sr refusé ×2 → relais
      '06:00:00#', '+20*00#',           // position initiale
      null, null, null, null, '06:00:00#', '+20*00#',  // impulsion 1 : rien ne bouge
      null, null, null, null, '06:00:00#', '+20*00#',  // impulsion 2 : figé (streak 2)
      null, null, null, null, '06:00:00#', '+20*00#',  // impulsion 3 : figé (streak 3)
      null, null,                       // :Q# ×2
    ];
    const r = await client.gotoRaDec(100, 20);
    expect(r).toBe('relayPartial');
    expect(tp.writes.filter((w) => w === ':Me#').length).toBe(3);
  }, 30000);

  test('RELAIS : cible sous l\u2019horizon → belowHorizon sans AUCUN moteur', async () => {
    ({client, tp} = await connectedClient());
    tp.script = ['0#', '0#']; // chemin direct refusé → relais
    const r = await client.gotoRaDec(100, -30); // DEC −30° au pôle → alt −30
    expect(r).toBe('belowHorizon');
    expect(tp.writes.some((w) => w === ':RS#' || w === ':RC#' || w === ':Me#' || w === ':Mw#' || w === ':Mn#' || w === ':Ms#')).toBe(false);
  }, 30000);
});
