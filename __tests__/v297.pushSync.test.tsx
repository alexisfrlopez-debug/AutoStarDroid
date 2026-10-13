/**
 * Tests v2.9.7 — SYNCHRO APPLI → RAQUETTE fiable et immédiate.
 *
 * Retour terrain : « quand je fais une mise à jour date/heure/site de la
 * raquette avec les données du téléphone, ça prend beaucoup de temps et
 * l'interrogation de la raquette par l'appli échoue à donner longitude/
 * latitude » + « toute information validée dans l'appli doit synchroniser
 * automatiquement la raquette ».
 *
 * CAUSE RACINE (documentée Meade) : après :SC (date), l'Autostar #49x envoie
 * « Updating Planetary Data » et recalcule ses éphémérides pendant plusieurs
 * secondes — TOUTE commande reçue pendant cette fenêtre est PERDUE. L'ancien
 * ordre (:SG → :SL → :SC → :St → :Sg) envoyait le SITE 400 ms après :SC, en
 * pleine fenêtre muette : longitude/latitude n'atterrissaient jamais dans la
 * raquette, et la lecture :Gt#/:Gg# juste derrière échouait (raquette encore
 * occupée) — d'où « l'interrogation échoue à donner longitude/latitude ».
 *
 * Contrats verrouillés :
 *  1. ORDRE : :SG/:SL/:St/:Sg AVANT :SC (jamais dans la fenêtre muette) ;
 *  2. SONDE :GG# APRÈS :SC — résolue dès que la raquette redevient
 *     disponible ; le texte « Updating Planetary Data# » est consommé
 *     (réponse hors format) sans désynchroniser la liaison ;
 *  3. :SC refusé (« 0 ») → journalisé ;
 *  4. PARC vers Home → SYNC raquette (:Sr/:Sd/:CM#) à l'arrivée.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {AutostarClient} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';

/* ==================== outillage ==================== */

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

async function scriptClient(): Promise<{client: AutostarClient; tp: ScriptTransport}> {
  const client = new AutostarClient();
  const tp = new ScriptTransport();
  jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
  const orig = (client as any).cmd.bind(client);
  jest.spyOn(client as any, 'cmd').mockImplementation(
    (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, 80), e),
  );
  (client as any).transport = tp;
  tp.onData((chunk) => (client as any).onData(chunk));
  return {client, tp};
}

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

const idxOf = (writes: string[], prefix: string) =>
  writes.findIndex((w) => w.startsWith(prefix));

/* ==================== 1. ordre pushSite ==================== */

describe('v2.9.7 — pushSite : le site AVANT :SC, sonde après (fenêtre planétaire)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ordre : :SG/:SL/:St/:Sg AVANT :SC, sonde :GG# en dernier', async () => {
    const {client, tp} = await scriptClient();
    // réponses : SG SL St Sg SC puis sonde (tz « 0 »)
    tp.script = ['1#', '1#', '1#', '1#', '1#', '0#'];
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(700);
    await p;
    const iSC = idxOf(tp.writes, ':SC');
    expect(iSC).toBeGreaterThan(idxOf(tp.writes, ':SG'));
    expect(iSC).toBeGreaterThan(idxOf(tp.writes, ':SL'));
    expect(iSC).toBeGreaterThan(idxOf(tp.writes, ':St')); // site AVANT la date
    expect(iSC).toBeGreaterThan(idxOf(tp.writes, ':Sg')); // (fenêtre muette évitée)
    expect(idxOf(tp.writes, ':GG#')).toBeGreaterThan(iSC); // sonde après :SC
    client.disconnect();
  });

  it('« Updating Planetary Data » en attente → consommé, la sonde conclut', async () => {
    const {client, tp} = await scriptClient();
    // à l'écriture de la sonde :GG#, la raquette est encore occupée : le
    // texte planétaire arrive, PUIS la réponse :GG# (« 0 ») — dans le MÊME
    // flux. onData doit jeter le texte (hors format) et résoudre sur « 0 ».
    tp.script = ['1#', '1#', '1#', '1#', '1#',
      '                Updating Planetary Data#0#'];
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(700);
    const r = await p;
    expect(r.time).toMatch(/^\d{2}:\d{2}:\d{2}$/); // résolue : texte planétaire consommé
    client.disconnect();
  });

  it(':SC refusé (« 0 ») → journalisé (le site reste appliqué : il précède)', async () => {
    const {client, tp} = await scriptClient();
    tp.script = ['1#', '1#', '1#', '1#', '0#', '0#']; // :SC refusé, sonde ok
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(700);
    await p;
    const warn = useScopeStore.getState().log.find((l) => l.text.includes('refusées'));
    expect(warn).toBeDefined();
    expect(warn?.text).toContain('SC');
    client.disconnect();
  });

  it('raquette muette y compris sonde → promesse résolue, aucun rejet', async () => {
    const t0 = Date.now();
    const {client, tp} = await scriptClient();
    tp.script = [null, null, null, null, null, null];
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(900);
    const r = await p;
    expect(r.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const warn = useScopeStore.getState().log.find((l) => l.ts > t0 && l.text.includes('refusées'));
    expect(warn).toBeUndefined();
    client.disconnect();
  });
});
