/**
 * Tests de régression v2.1.2 — trois retours terrain :
 *  1. « dans l'onglet "objet" ou "alignement", si je clique sur Goto la
 *     raquette perd la connexion » — DEUX causes traitées :
 *       a) la reconnexion USB automatique réouvrait l'ANCIEN deviceName
 *          alors qu'une re-énumération en génère un NOUVEAU (le numéro de
 *          périphérique change) — l'adaptateur était retrouvé par VID/PID
 *          puis l'ouverture échouait : perte DÉFINITIVE ;
 *       b) pendant un GOTO lancé par l'app, le mutisme normal de la raquette
 *          déclenchait les diagnostics « muette » + sonde :GVP# + effacement
 *          du miroir LCD — l'utilisateur croyait la liaison morte.
 *  2. « l'application n'arrive pas à obtenir la position GPS » (Réglages) —
 *     permission fine exigée (Android 12+ n'accorde parfois que
 *     l'approximative) + GPS seul sans repli réseau.
 *  3. mise à jour AUTOMATIQUE de la raquette à la connexion (date/heure/site).
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
import {UsbSerialNative, UsbTransport} from '../src/services/connection/usb';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';
import {TransportError} from '../src/services/connection/types';
import Geolocation from '@react-native-community/geolocation';
import {PermissionsAndroid, Platform} from 'react-native';
import {getPhonePosition, GpsError} from '../src/services/phone/gps';

/* ==================== outillage ==================== */

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

const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ==================== 1a. reconnexion USB : deviceName courant ==================== */

describe('v2.1.2 — reconnexion USB automatique après re-énumération (GOTO → connexion perdue)', () => {
  let client: AutostarClient | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    useScopeStore.getState().setConnStatus('disconnected');
  });
  afterEach(async () => {
    if (client) {try {(client as any).stopPoll();} catch (_) {} await client.disconnect().catch(() => undefined);}
    client = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
    useScopeStore.getState().setConnStatus('disconnected');
  });

  test('l\'adaptateur retrouvé par VID/PID est rouvert sous son deviceName COURANT', async () => {
    const OLD_NAME = '/dev/bus/usb/003/014';
    const NEW_NAME = '/dev/bus/usb/003/017'; // re-énumération : numéro changé
    const VID = 0x067b, PID = 0x2303; // PL2303
    const opts: ConnectOptions = {usb: {deviceName: OLD_NAME, baud: 9600}};

    // connect() réussit sans matériel : ouverture USB simulée au niveau prototype
    const tpConnect = jest.spyOn(UsbTransport.prototype, 'connect').mockResolvedValue(undefined);
    // 1re connexion : l'adaptateur porte l'ancien nom ; après glitch : nouveau
    let listed = [
      {deviceName: OLD_NAME, vendorId: VID, productId: PID, vendorHex: '067b', productHex: '2303', driver: 'PL2303Driver', brand: 'Prolific PL'},
    ];
    jest.spyOn(UsbSerialNative, 'listDevices').mockImplementation(async () => listed);
    jest.spyOn(UsbSerialNative, 'requestPermission').mockResolvedValue(true);

    client = new AutostarClient();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    // Le polling + firmware + auto-sync écriraient via UsbTransport.write →
    // USB natif absent : on coupe le poll (le test cible la reconnexion).
    jest.spyOn(client as any, 'startPoll').mockImplementation(() => undefined);
    // connect() contient des sleeps (ESC ESC 500 ms…) : timers factifs
    const cp = client.connect('usb', opts, 'autostar497');
    await jest.advanceTimersByTimeAsync(700);
    await cp;
    expect(useScopeStore.getState().connStatus).toBe('connected');
    expect((client as any).lastUsb.vid).toBe(VID);

    // GLITCH : usbDetached (comme pendant un slew GOTO) → liaison fermée
    (client as any).handleLinkClosed();
    expect(useScopeStore.getState().connStatus).toBe('disconnected');
    expect(useScopeStore.getState().log.some((l: any) => String(l.text).includes('reconnexion automatique USB'))).toBe(true);

    // L'adaptateur est re-énuméré SOUS UN AUTRE NOM (même identité matérielle)
    listed = [
      {deviceName: NEW_NAME, vendorId: VID, productId: PID, vendorHex: '067b', productHex: '2303', driver: 'PL2303Driver', brand: 'Prolific PL'},
    ];

    // premier essai à 2,5 s + ouverture (sleep ESC ESC 500 ms) + marge
    await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(10); // purge des microtâches (timers fake actifs)

    expect(useScopeStore.getState().connStatus).toBe('connected');
    const reOpts = tpConnect.mock.calls.at(-1)?.[0] as ConnectOptions;
    // CORRECTIF : c'est le deviceName COURANT qui est rouvert (bug v2.1.1 :
    // l'ANCIEN était passé → « Périphérique non trouvé » → perte définitive)
    expect(reOpts.usb?.deviceName).toBe(NEW_NAME);
    // identité matérielle mémorisée pour une future re-énumération
    expect(reOpts.usb?.vendorId).toBe(VID);
    expect(reOpts.usb?.productId).toBe(PID);
    expect((client as any).lastUsb.vid).toBe(VID);
  }, 20000);

  test('adaptateur introuvable → 4 essais puis abandon explicite', async () => {
    jest.spyOn(UsbTransport.prototype, 'connect').mockResolvedValue(undefined);
    jest.spyOn(UsbSerialNative, 'listDevices').mockResolvedValue([]); // jamais retrouvé
    client = new AutostarClient();
    jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
    jest.spyOn(client as any, 'startPoll').mockImplementation(() => undefined);
    (client as any).lastUsb = {
      opts: {usb: {deviceName: '/dev/bus/usb/003/014', baud: 9600}},
      model: 'autostar497', vid: 0x067b, pid: 0x2303,
    };
    // la liaison VIT encore au moment du glitch (sinon handleLinkClosed sort tôt)
    useScopeStore.getState().setConnStatus('connected');
    (client as any).handleLinkClosed();
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(3000);
    }
    expect(useScopeStore.getState().connStatus).toBe('disconnected');
    expect(useScopeStore.getState().log.some((l: any) => String(l.text).includes('abandonnée'))).toBe(true);
  }, 20000);
});

/* ==================== 1b. pas de diagnostics « muette » pendant un GOTO app ==================== */

describe('v2.1.2 — GOTO lancé par l\'app : le mutisme normal n\'affiche plus « connexion perdue »', () => {
  test('applyHint : pendant ownMoveUntil (GOTO app) → hint « none » même sans position depuis 20 s', () => {
    const client = new AutostarClient();
    (client as any).ownMoveUntil = Date.now() + 45000; // GOTO en cours
    (client as any).lastPosAt = Date.now() - 20000;    // position très ancienne
    const s = useScopeStore.getState();
    s.setHbHint('wait');
    (client as any).applyHint(s, Date.now());
    expect(useScopeStore.getState().hbHint).toBe('none');
  });

  test('applyHint : hors GOTO, le même mutisme reste diagnostiqué « mute »', () => {
    const client = new AutostarClient();
    (client as any).ownMoveUntil = 0;
    (client as any).lastPosAt = Date.now() - 20000;
    (client as any).lastAltAzAt = 0;
    const s = useScopeStore.getState();
    s.setHbHint('none');
    (client as any).applyHint(s, Date.now());
    expect(useScopeStore.getState().hbHint).toBe('mute');
  });

  test('isBusyNow : pendant le GOTO app, les compteurs d\'échec LCD/position sont gelés', () => {
    const client = new AutostarClient();
    (client as any).ownMoveUntil = Date.now() + 45000;
    (client as any).lastMovedFlag = false;
    (client as any).holding.clear();
    (client as any).lastExternalAt = 0;
    expect((client as any).isBusyNow()).toBe(true);
    (client as any).ownMoveUntil = 0;
    expect((client as any).isBusyNow()).toBe(false);
  });

  test('lcdFail : les échecs :ED# pendant un moteur ne comptent pas (miroir conservé)', () => {
    const client = new AutostarClient();
    (client as any).lastMovedFlag = true; // slew en cours
    const before = (client as any).lcdFail;
    // simule la branche d'échec :ED# du poll (v2.1.2 : garde isBusyNow)
    if (!(client as any).isBusyNow()) (client as any).lcdFail += 1;
    expect((client as any).lcdFail).toBe(before);
  });
});

/* ==================== 2. GPS robuste ==================== */

describe('v2.1.2 — GPS (Réglages) : permissions granulaires + repli réseau', () => {
  const origOs = Platform.OS;
  let gpsSpy: jest.SpiedFunction<typeof Geolocation.getCurrentPosition>;
  beforeEach(() => {
    gpsSpy = jest.spyOn(Geolocation, 'getCurrentPosition');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(Platform, 'OS', {value: origOs, configurable: true, writable: true});
  });
  const forceAndroid = () =>
    Object.defineProperty(Platform, 'OS', {value: 'android', configurable: true, writable: true});

  test('permission approximative seule (coarse) acceptée → position obtenue', async () => {
    forceAndroid();
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false as any);
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]: 'denied' as any,
      [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]: 'granted' as any,
    } as any);
    // Android refuse le provider GPS sans permission fine : le repli RÉSEAU
    // (2e tentative, enableHighAccuracy=false) fournit une position.
    gpsSpy.mockImplementationOnce((_s: any, e: any) => e({code: 2, message: 'pas de GPS'}))
      .mockImplementationOnce((s: any) => s({coords: {latitude: 48.8566, longitude: 2.3522, altitude: 35}}));
    const pos = await getPhonePosition();
    expect(pos.latDeg).toBe(48.8566);
    expect(pos.lonDeg).toBe(2.3522);
    expect(gpsSpy.mock.calls.length).toBe(2);
    expect(gpsSpy.mock.calls[0][2].enableHighAccuracy).toBe(true);
    expect(gpsSpy.mock.calls[1][2].enableHighAccuracy).toBe(false); // repli réseau
  }, 20000);

  test('GPS sans fix → repli réseau réussi (extérieur/intérieur)', async () => {
    Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true, writable: true}); // permission = ok
    gpsSpy.mockImplementationOnce((_s: any, e: any) => e({code: 3, message: 'timeout'}))
      .mockImplementationOnce((s: any) => s({coords: {latitude: 43.6, longitude: 1.44, altitude: 141}}));
    const pos = await getPhonePosition();
    expect(pos.latDeg).toBeCloseTo(43.6);
    expect(gpsSpy.mock.calls[1][2].enableHighAccuracy).toBe(false);
  }, 20000);

  test('tout échec → GpsError codée (perm/off/timeout/unavailable) pour un message i18n précis', async () => {
    Object.defineProperty(Platform, 'OS', {value: 'ios', configurable: true, writable: true});
    gpsSpy.mockImplementationOnce((_s: any, e: any) => e({code: 3, message: 'timeout'}))
      .mockImplementationOnce((_s: any, e: any) => e({code: 2, message: 'unavailable'}));
    await expect(getPhonePosition()).rejects.toBeInstanceOf(GpsError);
  }, 20000);

  test('permission refusée → GpsError « perm » sans appeler le GPS', async () => {
    forceAndroid();
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false as any);
    jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]: 'never_ask_again' as any,
      [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]: 'denied' as any,
    } as any);
    await expect(getPhonePosition()).rejects.toMatchObject({code: 'perm'});
    expect(gpsSpy).not.toHaveBeenCalled();
  }, 20000);

  test('permission déjà accordée (fine) → pas de nouvelle boîte de dialogue', async () => {
    forceAndroid();
    const checkSpy = jest.spyOn(PermissionsAndroid, 'check')
      .mockImplementation(async (p) => p === PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION as any);
    const reqSpy = jest.spyOn(PermissionsAndroid, 'requestMultiple');
    gpsSpy.mockImplementation((s: any) => s({coords: {latitude: 1, longitude: 2, altitude: 0}}));
    await getPhonePosition();
    expect(checkSpy).toHaveBeenCalled();
    expect(reqSpy).not.toHaveBeenCalled(); // check() a répondu : pas de dialog
  }, 20000);
});

/* ==================== 3. mise à jour auto de la raquette à la connexion ==================== */

describe('v2.1.2 — mise à jour automatique de la raquette (date, heure, site) à la connexion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    useSettingsStore.getState().setAutoSyncScope(true);
  });

  test('autoSyncScopeData : :SG/:SL/:SC/:St/:Sg envoyés + horloge raquette rafraîchie', async () => {
    const {client, tp} = await scriptClient();
    useSettingsStore.getState().setSite({name: 'Puy de Dôme', latDeg: 45.7733, lonDeg: 2.9671, elevM: 1100});
    tp.script = ['1#', '1#', '1#', '1#', '1#']; // :SG :SL :SC :St :Sg répondent
    await (client as any).autoSyncScopeData();
    expect(tp.writes.some((w) => w.startsWith(':SG'))).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':SL'))).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':SC'))).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':St'))).toBe(true);
    expect(tp.writes.some((w) => w.startsWith(':Sg'))).toBe(true);
    // fuseau et coordonnées cohérents
    const sg = tp.writes.find((w) => w.startsWith(':SG')) ?? '';
    expect(sg).toMatch(/^:SG[+-]\d{2}\.\d#$/); // ex. +02.0
    const st = tp.writes.find((w) => w.startsWith(':St')) ?? '';
    expect(st).toContain('45*');
    const s = useScopeStore.getState();
    expect(s.scopeTime).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(s.scopeDate).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
  }, 15000);

  test('raquette muette : l\'envoi est toléré (aucun crash, commandes tout de même parties)', async () => {
    const {client, tp} = await scriptClient();
    tp.script = [null, null, null, null, null]; // raquette muette
    await expect((client as any).autoSyncScopeData()).resolves.toBeUndefined();
    expect(tp.writes.filter((w) => w.startsWith(':S')).length).toBe(5);
  }, 15000);

  test('réglage désactivé → aucun envoi automatique', async () => {
    const {client, tp} = await scriptClient();
    useSettingsStore.getState().setAutoSyncScope(false);
    await (client as any).autoSyncScopeData();
    expect(tp.writes.length).toBe(0);
  }, 15000);
});
