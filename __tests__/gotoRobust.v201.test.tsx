/**
 * Tests de régression v2.0.1 — GOTO « connexion refusée » : chaque cause a
 * son statut et son message.
 *
 * Contexte (retour terrain) : « pour le pointage télémétrique, le GOTO ne
 * marche pas, il marque connexion refusée ». Cause : gotoRaDec écrasait TOUS
 * les échecs (écriture impossible, raquette muette, refus explicite) en un
 * seul statut 'refused' → message unique trompeur « Connexion refusée ».
 * Correctif :
 *   - 'noLink'  : liaison morte → état de connexion remis à zéro (fini le
 *                 « connected » fantôme après un câble retiré sans événement) ;
 *   - 'mute'    : raquette muette → ESC ESC (reset parseur, séquence de
 *                 connexion) + UNE retentative ; :MS muet → sonde :D# (le
 *                 slew a peut-être démarré quand même) ;
 *   - 'refused' : refus EXPLICITE de la raquette (« 0 » aux 2 précisions).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {AutostarClient, gotoErrorText} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';
import {TransportError} from '../src/services/connection/types';

/** Transport « scripté » : chaque écriture consomme la réponse suivante du
 *  script (string = octets renvoyés, null = raquette muette). */
class ScriptTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  script: Array<string | null> = [];
  failWrites = false;
  private dataCb: ((chunk: string) => void) | null = null;

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}

  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}

  async write(data: string): Promise<void> {
    this.writes.push(data);
    if (this.failWrites) throw new TransportError('Échec écriture USB : port fermé');
    const next = this.script.shift();
    if (next != null) this.dataCb?.(next);
  }
}

async function connectedClient(capMs = 60): Promise<{client: AutostarClient; tp: ScriptTransport}> {
  const client = new AutostarClient();
  const tp = new ScriptTransport();
  jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
  // Timeouts réels trop longs pour les tests : la vraie cmd est conservée
  // (file sérielle, parse, attentes) mais plafonnée au cap demandé.
  const orig = (client as any).cmd.bind(client);
  jest.spyOn(client as any, 'cmd').mockImplementation(
    (c: string, ms: number, e?: RegExp) => orig(c, Math.min(ms, capMs), e),
  );
  (client as any).transport = tp;
  tp.onData((chunk) => (client as any).onData(chunk));
  return {client, tp};
}

describe('v2.0.1 — GOTO granulaire (fini le « Connexion refusée » fourre-tout)', () => {
  let client: AutostarClient;
  let tp: ScriptTransport;

  beforeEach(() => {client = null as any; tp = null as any;});
  afterEach(async () => {
    if (client) await client.disconnect().catch(() => undefined);
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
  });

  test(':Sr muet → ESC ESC + retentative acceptée → GOTO part (ok)', async () => {
    ({client, tp} = await connectedClient());
    // :Sr haute précision muet ; ESC ESC muet ; retentative acceptée ;
    // :Sd accepté ; :MS = 0 (slew parti).
    // v2.9.4 : le boost de vitesse (:RS#/:R9#, muets) précède la séquence.
    tp.script = [null, null, null, null, '1#', '1#', '0#'];
    const r = await client.gotoRaDec(82.75, 22.0147);
    expect(r).toBe('ok');
    // la retentative a bien eu lieu APRÈS le reset ESC ESC
    const srWrites = tp.writes.filter((w) => w.startsWith(':Sr'));
    expect(srWrites.length).toBe(2);
    expect(srWrites[0]).toBe(srWrites[1]); // même format retenté
    expect(tp.writes).toContain('\x1b\x1b');
  }, 15000);

  test(':Sr muet même après ESC ESC → relais : position illisible → \'mute\' (pas de :Sd ni :MS)', async () => {
    ({client, tp} = await connectedClient());
    // v2.9.4 : boost :RS#/:R9# muets, puis :Sr muet ×2 (ESC ESC + retentative)
    tp.script = [null, null, null, null, null];
    // relais : site pôle Nord (alt = dec > 0 garanti), position illisible
    useSettingsStore.getState().setSite({name: 'Pôle', latDeg: 90, lonDeg: 0, elevM: 0});
    const r = await client.gotoRaDec(82.75, 22.0147);
    expect(r).toBe('mute');
    expect(tp.writes.some((w) => w.startsWith(':Sd'))).toBe(false);
    expect(tp.writes.some((w) => w === ':MS#')).toBe(false);
    // le relais a bien été tenté, mais sans aucune lecture de position : pas
    // un seul ordre moteur ne part (sécurité) — le boost v2.9.4 :RS# est
    // attendu (vitesse), :RC#/:Me#/:Mn# sont des ordres moteur/taux relais
    expect(tp.writes.some((w) => w === ':RC#' || w === ':Me#' || w === ':Mn#')).toBe(false);
  }, 15000);

  test('refus explicite « 0 » aux 2 précisions → \'refused\' sur le chemin DIRECT (v1.8.1 conservé)', async () => {
    ({client, tp} = await connectedClient());
    // v2.9.4 : boost :RS#/:R9# (muets) puis :Sr refusé ×2
    tp.script = [null, null, '0#', '0#'];
    // v2.5.0 : le CHEMIN DIRECT garde la sémantique de refus (testée ici sur
    // gotoRaDecInner) ; ensuite gotoRaDec enchaîne sur le relais (tests v2.5.0)
    const r = await (client as any).gotoRaDecInner(82.75, 22.0147);
    expect(r).toBe('refused');
    expect(tp.writes.some((w) => w === ':MS#')).toBe(false);
  }, 15000);

  test(':MS muet → sonde :D# voit la barre « | » → slew confirmé parti → \'ok\'', async () => {
    ({client, tp} = await connectedClient());
    // :Sr ok, :Sd ok, :MS muet, [sonde 700 ms] :D# → « | » (moteur en marche)
    // v2.9.4 : boost :RS#/:R9# (muets) en tête
    tp.script = [null, null, '1#', '1#', null, '|#'];
    const r = await client.gotoRaDec(10, -30);
    expect(r).toBe('ok');
    expect(tp.writes.some((w) => w === ':D#')).toBe(true);
  }, 15000);

  test(':MS muet → sonde :D# voit la monture à l\'arrêt (vide) → \'mute\' → relais refuse sous l\'horizon', async () => {
    ({client, tp} = await connectedClient());
    // :Sr ok, :Sd ok, :MS muet, [sonde] :D# → vide (à l'arrêt : :MS sans effet)
    // v2.9.4 : boost :RS#/:R9# (muets) en tête
    tp.script = [null, null, '1#', '1#', null, '#'];
    // relais : site pôle Nord → alt(DEC −30°) = −30° < 0 : le garde-fou
    // horizon du relais refuse de piloter les moteurs sous l'horizon
    useSettingsStore.getState().setSite({name: 'Pôle', latDeg: 90, lonDeg: 0, elevM: 0});
    const r = await client.gotoRaDec(10, -30);
    expect(r).toBe('belowHorizon');
    // aucune impulsion moteur : le relais s'est arrêté au garde-fou
    // (le boost v2.9.4 :RS# est une commande de VITESSE, pas un moteur)
    expect(tp.writes.some((w) => w === ':RC#' || w === ':Me#' || w === ':Mn#')).toBe(false);
  }, 15000);

  test('liaison morte (écriture impossible) → \'noLink\' ET connexion remise à zéro', async () => {
    ({client, tp} = await connectedClient());
    tp.connected = false; // câble retiré sans événement usbDetached
    tp.failWrites = true;
    useScopeStore.getState().setConnStatus('connected'); // état fantôme
    const r = await client.gotoRaDec(82.75, 22.0147);
    expect(r).toBe('noLink');
    // plus de « connected » fantôme : l'app sait qu'il faut se reconnecter
    expect(useScopeStore.getState().connStatus).toBe('disconnected');
    // v2.5.0 : le relais a laissé 25 s à la reconnexion automatique avant
    // d'abandonner (aucun mouvement sans liaison)
  }, 45000);

  test('syncRaDec : muet → ESC ESC + retentative → SYNC acceptée (:CM envoyé)', async () => {
    ({client, tp} = await connectedClient());
    // :Sr muet, ESC ESC muet, retentative ok, :Sd ok, :CM# (silencieux)
    tp.script = [null, null, '1#', '1#'];
    const ok = await client.syncRaDec(82.75, 22.0147);
    expect(ok).toBe(true);
    expect(tp.writes.some((w) => w === ':CM#')).toBe(true);
  }, 15000);

  test('syncRaDec : refus explicite → false (pas de :CM)', async () => {
    ({client, tp} = await connectedClient());
    tp.script = ['0#', '0#'];
    const ok = await client.syncRaDec(82.75, 22.0147);
    expect(ok).toBe(false);
    expect(tp.writes.some((w) => w === ':CM#')).toBe(false);
  }, 15000);

  test('gotoErrorText : chaque statut a son message dédié', () => {
    const x = {
      belowHorizon: 'SOUS-HORIZON', empty: 'VIDE',
      gotoNoLink: 'LIISON-MORTE', gotoMute: 'MUETTE', refused: 'REFUS',
      relayPartial: 'RELAIS-PARTIEL',
    };
    expect(gotoErrorText('ok', x)).toBe('');
    expect(gotoErrorText('belowHorizon', x)).toBe('SOUS-HORIZON');
    expect(gotoErrorText('noObject', x)).toBe('VIDE');
    expect(gotoErrorText('noLink', x)).toBe('LIISON-MORTE');
    expect(gotoErrorText('mute', x)).toBe('MUETTE');
    expect(gotoErrorText('refused', x)).toBe('REFUS');
    expect(gotoErrorText('relayPartial', x)).toBe('RELAIS-PARTIEL');
  });
});

describe('v2.1.1 — GOTO hors raquette : ligne série réservée à la séquence', () => {
  let client: AutostarClient;
  let tp: ScriptTransport;

  const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
    useScopeStore.setState({hbSync: 'off' as const});
  });

  test('PAS de :ED#/:Gr# intercalés pendant la séquence GOTO (gel cmdPhase), reprise après', async () => {
    // GOTO muet : :Sr (400 ms) + ESC ESC + sleep 350 + :Sr retry (400)
    // ≈ 1,15 s — bien au-delà de priorityUntil (700 ms) : sans cmdPhase,
    // le polling réinjecterait :ED# pendant la séquence.
    ({client, tp} = await connectedClient(400));
    useScopeStore.setState({hbSync: 'live' as const});
    (client as any).setPollInterval(25);
    (client as any).startPoll();
    tp.script = [null, null, null, null, null]; // boost muet ×2 + :Sr muet ×2 → 'mute' → relais
    // relais : alt = dec (+20° au pôle Nord) > 0 garanti, position illisible →
    // abandon immédiat sans moteur
    useSettingsStore.getState().setSite({name: 'Pôle', latDeg: 90, lonDeg: 0, elevM: 0});
    const p = client.gotoRaDec(10, 20);
    await flush(200);
    expect((client as any).cmdPhase).toBe(true);
    const during = tp.writes.filter((w) => w.startsWith(':ED')).length;
    const r = await p;
    expect(r).toBe('mute');
    expect((client as any).cmdPhase).toBe(false);
    await flush(300); // le polling reprend après la séquence
    const after = tp.writes.filter((w) => w.startsWith(':ED')).length;
    expect(during).toBe(0);   // gel strict pendant le GOTO
    expect(after).toBeGreaterThan(0); // reprise normale ensuite
  }, 15000);

  test('les commandes de position (:Gr#) ne partent pas pendant syncRaDec', async () => {
    ({client, tp} = await connectedClient(400));
    useScopeStore.setState({hbSync: 'live' as const});
    (client as any).setPollInterval(25);
    (client as any).startPoll();
    // :Sr muet (400 ms) + ESC ESC + 350 + retry ok + :Sd ok ≈ 1,2 s —
    // au-delà de priorityUntil (700 ms) : sans cmdPhase, le poll injecterait
    // :ED#/:Gr# au milieu de la séquence SYNC.
    tp.script = [null, null, '1#', '1#'];
    const ok = await client.syncRaDec(10, 20);
    expect(ok).toBe(true);
    expect(tp.writes.some((w) => w === ':CM#')).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':Gr'))).toBe(false);
    expect(tp.writes.some((w) => w.startsWith(':ED'))).toBe(false);
  }, 15000);
});
