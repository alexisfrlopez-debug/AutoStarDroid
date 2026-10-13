/**
 * Tests v2.2.1 — INVERSION EST/OUEST + monture DS-114.
 *
 * Retour terrain : « j'ai l'impression que l'application inverse Est et
 * Ouest » + « la raquette est réglée sur DS114 mais l'application ne
 * détecte pas cette monture ».
 *
 * CAUSE RACINE E/O (protocole Meade révision 2010.10 — cf. LX200CommandSet,
 * driver INDI, MeadeLX200protocol.json du projet lx200emulator) :
 *   - :Sg# longitude SIGNÉE avec l'EST NÉGATIF ("−002*21" pour Paris) ;
 *     l'app envoyait "+002*21" que la raquette lit « 2°21' OUEST » → TSL
 *     décalé de 2×lon → pointage AD décalé (sensation d'E/O inversés) ;
 *   - :SG# = heures à AJOUTER à l'heure LOCALE pour obtenir UTC (= UTC −
 *     local) : France été "−02.0", l'app envoyait "+02.0" (4 h d'écart
 *     potentiel sur l'horloge raquette) ;
 *   - :Gg#/:GG# (lectures) doivent être reconverties vers la convention
 *     cartographique de l'app.
 *
 * Contrats verrouillés :
 *  1. proto.lonCmd / lonDegFromMeade (conversions pures, 2 sens) ;
 *  2. pushPhoneData envoie :SG signé Meade + :Sg Est-négatif DDD*MM ;
 *  3. un refus explicite ("0") est journalisé (avant : silence) ;
 *  4. readScopeData convertit :Gg# (2 formes) et :GG# ;
 *  5. le cerveau DÉMO modélise la même convention (aller-retour) ;
 *  6. preset DS-114 présent, cohérent et sélectionnable manuellement.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {AutostarClient} from '../src/services/protocol/client';
import {DemoScopeBrain} from '../src/services/protocol/demoScope';
import {proto, lonDegFromMeade} from '../src/services/astro/time';
import {MOUNT_PRESETS, limitLegGuardSec, resolvePreset} from '../src/services/astro/mounts';
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

/* ==================== 1. conversions pures ==================== */

describe('v2.2.1 — convention Meade : proto.lonCmd (Est-NÉGATIF)', () => {
  it('Paris (2,35° E) → "-002*21" et non "+002*21"', () => {
    expect(proto.lonCmd(2.3522)).toBe('-002*21');
  });
  it('New York (74° O) → "+074*00" (Ouest positif, DDD sur 3 chiffres)', () => {
    expect(proto.lonCmd(-74.006)).toBe('+074*00');
  });
  it('Greenwich → "+000*00"', () => {
    expect(proto.lonCmd(0)).toBe('+000*00');
  });
  it('arrondi des minutes + débordement 60′', () => {
    expect(proto.lonCmd(2.3333)).toBe('-002*20');   // 2°19,998′ → 20′
    expect(proto.lonCmd(2.345)).toBe('-002*21');    // 2°20,7′ → 21′
    expect(proto.lonCmd(-179.995)).toBe('+180*00'); // 59,97′ → 60′ → débordement
  });
});

describe('v2.2.1 — lonDegFromMeade (lecture :Gg# → cartographique)', () => {
  it('forme signée Est-négative (protocole 2010.10)', () => {
    expect(lonDegFromMeade(-2.3522)).toBeCloseTo(2.3522, 6);
    expect(lonDegFromMeade(+74)).toBeCloseTo(-74, 6);
    expect(lonDegFromMeade(0)).toBe(0);
  });
  it('forme 0-360 Ouest-positive (LX200 classique) — équivalente mod 360', () => {
    expect(lonDegFromMeade(357.65)).toBeCloseTo(2.35, 6);   // 360−357,65 = 2,35 E
    expect(lonDegFromMeade(74)).toBeCloseTo(-74, 6);
    expect(lonDegFromMeade(180)).toBe(-180);
  });
  it('aller-retour lonCmd → lonDegFromMeade = identité', () => {
    for (const lon of [0, 2.3522, -74.006, 179.5, -179.5, -0.5]) {
      const m = proto.lonCmd(lon).match(/^([+-])(\d{3})\*(\d{2})$/);
      expect(m).not.toBeNull();
      const meade = (m![1] === '-' ? -1 : 1) * (+m![2] + +m![3] / 60);
      // précision 0,1° : le format DDD*MM quantifie à la minute d'arc
      expect(lonDegFromMeade(meade)).toBeCloseTo(lon, 1);
    }
  });
});

/* ==================== 2. pushPhoneData ==================== */

describe('v2.2.1 — pushPhoneData : :SG (UTC−local) et :Sg (Est négatif)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Paris : :Sg-002*21# + :St+48*51# (jamais "+002*21")', async () => {
    const {client, tp} = await scriptClient();
    tp.script = ['1#', '1#', '1#', '1#', '1#', '0#'];
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(900);
    const r = await p;
    expect(r.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(tp.writes.some((w) => w.startsWith(':Sg+002'))).toBe(false);
    expect(tp.writes).toContain(':Sg-002*21#');
    expect(tp.writes).toContain(':St+48*51#');
    client.disconnect();
  });

  it('New York : :Sg+074*00# (Ouest → positif)', async () => {
    const {client, tp} = await scriptClient();
    tp.script = ['1#', '1#', '1#', '1#', '1#', '0#'];
    const p = client.pushPhoneData(40.7128, -74.006);
    await flush(900);
    await p;
    expect(tp.writes).toContain(':Sg+074*00#');
    expect(tp.writes).toContain(':St+40*43#');
    client.disconnect();
  });

  it(':SG = UTC − local (opposé du décalage cartographique du téléphone)', async () => {
    const {client, tp} = await scriptClient();
    tp.script = ['1#', '1#', '1#', '1#', '1#', '0#'];
    const now = new Date();
    const tzOffsetMin = -now.getTimezoneOffset(); // local − UTC
    const tzH = Math.floor(Math.abs(tzOffsetMin) / 60);
    const tzM = Math.abs(tzOffsetMin) % 60;
    const tzVal = (tzH + tzM / 60).toFixed(1).padStart(4, '0');
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(900);
    await p;
    const sg = tp.writes.find((w) => w.startsWith(':SG')) ?? '';
    // MEADE : heures ajoutées à l'heure LOCALE pour obtenir UTC = −(local−UTC)
    expect(sg).toBe(`:SG${tzOffsetMin >= 0 ? '-' : '+'}${tzVal}#`);
    client.disconnect();
  });

  it('refus explicite ("0") → journalisé, sans échouer', async () => {
    const {client, tp} = await scriptClient();
    tp.script = ['1#', '1#', '1#', '0#', '1#', '0#']; // :Sg refusé (ordre v2.9.7 : :Sg avant :SC)
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(900);
    await p;
    const warn = useScopeStore.getState().log.find((l) => l.text.includes('refusées'));
    expect(warn).toBeDefined();
    expect(warn?.text).toContain('Sg');
    client.disconnect();
  });

  it('raquette muette → aucun rejet journalisé, promesse résolue', async () => {
    const t0 = Date.now(); // le journal est global : ne regarder que ce test
    const {client, tp} = await scriptClient();
    tp.script = [null, null, null, null, null, null]; // raquette muette (y c. sonde :GG#)
    const p = client.pushPhoneData(48.8566, 2.3522);
    await flush(900);
    const r = await p;
    expect(r.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const warn = useScopeStore.getState().log.find((l) => l.ts > t0 && l.text.includes('refusées'));
    expect(warn).toBeUndefined();
    client.disconnect();
  });
});

/* ==================== 3. readScopeData ==================== */

describe('v2.2.1 — readScopeData : conversions Meade → cartographique', () => {
  afterEach(() => jest.restoreAllMocks());

  async function readWith(gg: string, gt: string, ggTz: string) {
    const {client, tp} = await scriptClient();
    tp.script = ['12:34:56#', '06/25/26#', ggTz, gt, gg];
    const p = client.readScopeData();
    await flush(700);
    const d = await p;
    client.disconnect();
    return d;
  }

  it(':Gg# signé Est-négatif "-002*21" → +2,35 ; :GG# "-02" → fuseau standard "+2"', async () => {
    const d = await readWith('-002*21#', '+48*51#', '-02#');
    expect(d.lonDeg).toBeCloseTo(2.3522, 2);
    expect(d.latDeg).toBeCloseTo(48.85, 2);
    expect(d.tz).toBe('2');
    expect(d.time).toBe('12:34:56');
  });

  it(':Gg# 0-360 Ouest-positif "357*39" → +2,35', async () => {
    const d = await readWith('357*39#', '+48*51#', '+00#');
    expect(d.lonDeg).toBeCloseTo(2.35, 2);
  });

  it(':Gg# "074*00" (74° O) → −74', async () => {
    const d = await readWith('074*00#', '+40*43#', '+05#');
    expect(d.lonDeg).toBeCloseTo(-74.0, 2);
    expect(d.tz).toBe('-5');
  });
});

/* ==================== 4. cerveau démo : même convention ==================== */

describe('v2.2.1 — cerveau démo : :Sg/:Gg Meade + :SG/:GL cohérents', () => {
  it('aller-retour :Sg → :Gg en forme Meade (Paris, New York)', () => {
    const brain = new DemoScopeBrain();
    expect(brain.handle(':Sg-002*21#')).toBe('1#');
    expect(brain.handle(':Gg#')).toBe('-002*21#');
    expect(brain.handle(':Sg+074*00#')).toBe('1#');
    expect(brain.handle(':Gg#')).toBe('+074*00#');
    // forme 0-360 acceptée aussi (firmware classiques)
    expect(brain.handle(':Sg357*39#')).toBe('1#');
    expect(brain.handle(':Gg#')).toBe('-002*21#');
  });

  it(':SG-02.0 (France été) → :GL renvoie l\'heure locale UTC+2', () => {
    const brain = new DemoScopeBrain();
    expect(brain.handle(':SG-02.0#')).toBe('1#');
    const gl = brain.handle(':GL#').replace('#', '');
    const [h, m, s] = gl.split(':').map((x) => +x);
    const gotSec = h * 3600 + m * 60 + s;
    // MEADE : UTC = local + SG → local = UTC − SG = UTC − (−2) = UTC+2
    const exp = new Date(Date.now() + 2 * 3600e3);
    const expSec = exp.getUTCHours() * 3600 + exp.getUTCMinutes() * 60 + exp.getUTCSeconds();
    const diff = Math.abs(((gotSec - expSec + 43200) % 86400) - 43200);
    expect(diff).toBeLessThan(10); // tolérance 10 s (franchissement de seconde)
  });

  it(':SG-05.5 (Inde, heures fractionnaires) → :GL = UTC+5,5', () => {
    const brain = new DemoScopeBrain();
    brain.handle(':SG-05.5#');
    const gl = brain.handle(':GL#').replace('#', '');
    const [h, m, s] = gl.split(':').map((x) => +x);
    const gotSec = h * 3600 + m * 60 + s;
    const exp = new Date(Date.now() + 5.5 * 3600e3);
    const expSec = exp.getUTCHours() * 3600 + exp.getUTCMinutes() * 60 + exp.getUTCSeconds();
    const diff = Math.abs(((gotSec - expSec + 43200) % 86400) - 43200);
    expect(diff).toBeLessThan(10);
  });

  it(':GG renvoie la forme Meade stockée', () => {
    const brain = new DemoScopeBrain();
    brain.handle(':SG-02.0#');
    expect(brain.handle(':GG#')).toBe('-02#');
  });
});

/* ==================== 5. monture DS-114 ==================== */

describe('v2.2.1 — preset DS-114 (raquette réglée « DS114 »)', () => {
  it('le preset existe, alt-az, butées et taux cohérents', () => {
    const ds = MOUNT_PRESETS.ds114;
    expect(ds).toBeDefined();
    expect(ds.label).toContain('DS-114');
    expect(ds.altaz).toBe(true);
    expect(ds.minAltDeg).toBe(0);
    expect(ds.maxAltDeg).toBeLessThanOrEqual(90);
    expect(ds.expectedRates.slew).toBeGreaterThan(ds.expectedRates.find);
    expect(ds.expectedRates.find).toBeGreaterThan(ds.expectedRates.center);
    // pignons DS : nettement plus de jeu que l'ETX (vis sans fin)
    expect(ds.typicalBacklashArcsec.ra).toBeGreaterThan(MOUNT_PRESETS.etx125.typicalBacklashArcsec.ra);
  });

  it('sélection manuelle : resolvePreset respecte DS-114 (la raquette ne transmet pas la monture)', () => {
    // un #497 suggère ETX-125 (hypothèse) — l'utilisateur corrige en DS-114
    expect(resolvePreset('auto', 'autostar497').id).toBe('etx125');
    expect(resolvePreset('ds114', 'autostar497').id).toBe('ds114');
    expect(resolvePreset('ds114', null).id).toBe('ds114');
  });

  it('garde des jambes de butées calculée sur la course du preset', () => {
    const ds = MOUNT_PRESETS.ds114;
    // 30°→88° = 58° à 2°/s = 29 s ×1,4 +10 = 51
    expect(limitLegGuardSec(30, true, ds, 2.0)).toBe(51);
    // 30°→0° = 30° à 2°/s = 15 s ×1,4 +10 = 31
    expect(limitLegGuardSec(30, false, ds, 2.0)).toBe(31);
  });
});
