/**
 * Tests v2.6.0 — COUCHE DRIVER multi-marques.
 *
 * Verrouille les encodages protocole par protocole (références : driver INDI
 * celestrondriver.cpp + Stellarium NexStarCommand.cpp pour NexStar ; driver
 * INDIGO mount_ioptron (GSS) pour iOptron 8407) :
 *  1. Meade    : sonde :GVP#, robustesse double précision, :MS codes ;
 *  2. NexStar  : hex 1/2³², 'r'/'s' GOTO/SYNC, passthrough AUX flèches
 *                (0x50 0x02 axe sens vitesse), 'M' stop, 'L' mouvement,
 *                't'/'T' tracking + mode d'axes alt-az/équatorial ;
 *  3. SynScan  : héritage NexStar, identité, axes équatoriaux par défaut ;
 *  4. iOptron  : :Sr/:Sd espace, :MS INVERSÉ ('1'=ok), :SR/:m/:q, :MountInfo# ;
 *  5. Détection: resolveDriver sur sondes (:GVP#, 'V', :MountInfo#, muet).
 */
import {AutostarClient} from '../src/services/protocol/client';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {
  DRIVERS,
  parseMeadeDec,
  parseMeadeRa,
  type DriverClient,
} from '../src/services/protocol/driver';
import {
  dd2nex, dd2pnex, nex2dd, pnex2dd, parseNexStarRadec,
} from '../src/services/protocol/drivers/nexstar';
import {parseMountInfo} from '../src/services/protocol/drivers/ioptron';
import type {Dir, Speed} from '../src/services/protocol/driver';

/* ==================== outillage ==================== */

/** DriverClient factice : enregistre les commandes, répond selon un script. */
class FakeClient implements DriverClient {
  sent: string[] = [];
  private responders: Array<{match: (c: string) => boolean; reply: string | null}> = [];

  /** Enregistre une réponse : match(cmd) → reply (null = muet, jamais résolu). */
  on(match: RegExp | string, reply: string | null) {
    this.responders.push({
      match: typeof match === 'string' ? (c) => c.startsWith(match) : (c) => match.test(c),
      reply,
    });
  }

  async cmd(c: string): Promise<string> {
    this.sent.push(c);
    for (const r of this.responders) {
      if (r.match(c)) {
        if (r.reply === null) return new Promise<string>(() => undefined);
        return r.reply;
      }
    }
    throw new Error('mute');
  }
  async cmdSilent(c: string) {this.sent.push(c);}
  transportAlive() {return true;}
  async resetParser() {}
  bump() {}
  log() {}
  warn() {}
}

const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/* ==================== 1. parsing Meade partagé ==================== */

describe('v2.6.0 — parsing Meade partagé (driver.ts)', () => {
  it('parseMeadeRa : "HH:MM:SS" et "HH:MM.T"', () => {
    expect(parseMeadeRa('10:20:30')).toBeCloseTo((10 + 20 / 60 + 30 / 3600) * 15, 6);
    expect(parseMeadeRa('02:30.5')).toBeCloseTo((2 + 30.5 / 60) * 15, 6);
    expect(parseMeadeRa('bogus')).toBeNull();
  });
  it('parseMeadeDec : "sDD*MM(:SS)" et "sDD:MM"', () => {
    expect(parseMeadeDec('+48*51')).toBeCloseTo(48 + 51 / 60, 6);
    expect(parseMeadeDec('-02*21:30')).toBeCloseTo(-(2 + 21 / 60 + 30 / 3600), 6);
    expect(parseMeadeDec('45:30')).toBeCloseTo(45.5, 6);
    expect(parseMeadeDec('???')).toBeNull();
  });
});

/* ==================== 2. Meade ==================== */

describe('v2.6.0 — driver Meade', () => {
  it('caps complètes + sonde :GVP# sur le nom d\u2019usine', () => {
    const d = DRIVERS.meade;
    expect(d.caps.goto && d.caps.relay && d.caps.lcdMirror && d.caps.keyPress && d.caps.pushSite).toBe(true);
    expect(d.probe!.classify('Autostar II')).toBe(true);
    expect(d.probe!.classify('Meade LX200')).toBe(true);
    expect(d.probe!.classify('#497')).toBe(true);
    expect(d.probe!.classify('?')).toBe(false);
    expect(d.probe!.classify('')).toBe(false);
    expect(d.probe!.classify('8407,0308,')).toBe(false); // iOptron, PAS Meade
    expect(d.probe!.classify('4.22')).toBe(false);       // NexStar
  });

  it('GOTO : :Sr/:Sd haute précision acceptée → :MS=0 ok', async () => {
    const c = new FakeClient();
    c.on(':Sr', '1');
    c.on(':Sd', '1');
    c.on(':MS#', '0');
    const r = await DRIVERS.meade.goto(c, 82.75, 22.0147);
    expect(r).toBe('ok');
    expect(c.sent[0]).toMatch(/^:Sr\d{1,2}:\d{2}:\d{2}#/);
    expect(c.sent[1]).toMatch(/^:Sd\+?\d{1,2}\*\d{2}/);
    expect(c.sent[2]).toBe(':MS#');
  });

  it('GOTO : refus haute précision → retentative BASSE précision', async () => {
    const c = new FakeClient();
    c.on(':Sr', '0'); // les 2 formats refusés (répond 0 à chaque :Sr)
    const r = await DRIVERS.meade.goto(c, 82.75, 22.0147);
    expect(r).toBe('refused');
    expect(c.sent.filter((s) => s.startsWith(':Sr')).length).toBe(2); // haute puis basse
  });

  it('GOTO : :MS=1 sous l\u2019horizon, :MS=2 objet introuvable', async () => {
    const c = new FakeClient();
    c.on(':Sr', '1'); c.on(':Sd', '1'); c.on(':MS#', '1');
    expect(await DRIVERS.meade.goto(c, 82.75, 22.01)).toBe('belowHorizon');
    const c2 = new FakeClient();
    c2.on(':Sr', '1'); c2.on(':Sd', '1'); c2.on(':MS#', '2');
    expect(await DRIVERS.meade.goto(c2, 82.75, 22.01)).toBe('noObject');
  });

  it('flèches : :Mn#/:Me# et arrêts :Q*# ; stopAll :Q#', async () => {
    const c = new FakeClient();
    await DRIVERS.meade.startMove(c, 'n');
    await DRIVERS.meade.startMove(c, 'e');
    await DRIVERS.meade.stopMove(c, 'w');
    await DRIVERS.meade.stopAll(c);
    expect(c.sent).toEqual([':Mn#', ':Me#', ':Qw#', ':Q#']);
  });

  it('isMoving : "|" → true, vide → false, muet → null', async () => {
    const c1 = new FakeClient(); c1.on(':D#', '|');
    expect(await DRIVERS.meade.isMoving(c1)).toBe(true);
    const c2 = new FakeClient(); c2.on(':D#', '');
    expect(await DRIVERS.meade.isMoving(c2)).toBe(false);
    const c3 = new FakeClient();
    expect(await DRIVERS.meade.isMoving(c3)).toBeNull();
  });

  it('sonde de slew : :D# = "|" confirme un :MS muet', async () => {
    const c = new FakeClient();
    c.on(':Sr', '1'); c.on(':Sd', '1');
    c.on(':MS#', null); // :MS muet (jamais résolu — timeout réel)
    c.on(':D#', '|');
    // pas de vraie attente : le test ne lance PAS goto (qui attend 5 s),
    // il vérifie la sonde seule
    expect(await DRIVERS.meade.probeSlewStarted(c, 1)).toBe(true);
  });
});

/* ==================== 3. NexStar — conversions hex ==================== */

describe('v2.6.0 — NexStar : conversions hex (réf. INDI dd2nex/pnex)', () => {
  it('coarse 16 bits : aller-retour', () => {
    for (const deg of [0, 12.5, 89.9, 180, 234.567, 359.99]) {
      expect(nex2dd(dd2nex(deg))).toBeCloseTo(deg, 2); // résolution 360/65536 ≈ 0,0055°
    }
    expect(dd2nex(360)).toBe(0);
    expect(dd2nex(-45)).toBe(dd2nex(315));
  });
  it('précis 32 bits : aller-retour + résolution', () => {
    for (const deg of [0, 12.5, 89.9, 180, 234.567, 359.99]) {
      expect(pnex2dd(dd2pnex(deg))).toBeCloseTo(deg, 5); // résolution 360/2³² ≈ 8e-8°
    }
    expect(dd2pnex(360)).toBe(0);
  });
  it('dd2nex(0°) = 0, dd2nex(90°) = 0x4000, dd2nex(180°) = 0x8000', () => {
    expect(dd2nex(0)).toBe(0x0000);
    expect(dd2nex(90)).toBe(0x4000);
    expect(dd2nex(180)).toBe(0x8000);
    expect(dd2pnex(90)).toBe(0x40000000);
  });
  it('parseNexStarRadec : "34A6B2C1,0F2E3D40#" → AD/DEC ; DEC > 180 = négatif', () => {
    const rd = parseNexStarRadec('34A6B2C1,0F2E3D40');
    expect(rd).not.toBeNull();
    expect(rd!.raDeg).toBeCloseTo(pnex2dd(0x34A6B2C1), 6);
    expect(rd!.decDeg).toBeCloseTo(pnex2dd(0x0F2E3D40), 6);
    // déclinaison -45° encodée 315° (0xC8000000) → dépliée
    const neg = parseNexStarRadec('00000000,E0000000');
    expect(neg!.decDeg).toBeCloseTo(-45, 5);
    expect(parseNexStarRadec('nawak')).toBeNull();
  });
});

/* ==================== 4. NexStar — commandes ==================== */

describe('v2.6.0 — driver Celestron NexStar', () => {
  it('caps : GOTO/relais/sync/tracking OUI, Meade-only NON', () => {
    const caps = DRIVERS.celestron.caps;
    expect(caps.goto && caps.relay && caps.sync && caps.trackingModes && caps.isMoving).toBe(true);
    expect(caps.lcdMirror).toBe(false);
    expect(caps.keyPress).toBe(false);
    expect(caps.pushSite).toBe(false);
    expect(caps.alignWizards).toBe(false);
    expect(caps.focus).toBe(false);
  });

  it('sonde \u2019V\u2019 : "4.22" → oui, "AutoStar" → non', () => {
    expect(DRIVERS.celestron.probe!.classify('4.22')).toBe(true);
    expect(DRIVERS.celestron.probe!.classify('03.09')).toBe(true);
    expect(DRIVERS.celestron.probe!.classify('AutoStar II')).toBe(false);
    expect(DRIVERS.celestron.probe!.classify('')).toBe(false);
  });

  it('GOTO \u2019r\u2019 : AD/DEC hex précis, ACK \u2019#\u2019 (réponse vide)', async () => {
    const c = new FakeClient();
    c.on('r', ''); // '#' → réponse vide
    const ra = 82.75 / 15; // l'app passe des DEGRÉS d'AD
    const r = await DRIVERS.celestron.goto(c, ra, 22.0147);
    expect(r).toBe('ok');
    const expected = `r${hex8(dd2pnex(ra))},${hex8(dd2pnex(22.0147))}`;
    expect(c.sent[0]).toBe(expected);
  });

  it('GOTO sans ACK → \u2019mute\u2019 (relais prendra la main)', async () => {
    const c = new FakeClient();
    const r = await DRIVERS.celestron.goto(c, 10, 20);
    expect(r).toBe('mute');
  });

  it('SYNC \u2019s\u2019 : mêmes formats hex', async () => {
    const c = new FakeClient();
    c.on('s', '');
    const ok = await DRIVERS.celestron.syncRaDec(c, 10, 20);
    expect(ok).toBe(true);
    expect(c.sent[0]).toBe(`s${hex8(dd2pnex(10))},${hex8(dd2pnex(20))}`);
  });

  it('flèches passthrough AUX : P\\x02 axe sens vitesse — alt-az (N/S=azimut)', async () => {
    const drv = DRIVERS.celestron;
    const c = new FakeClient();
    c.on('P', '');
    await drv.setSpeed(c, 'center' as Speed);
    await drv.startMove(c, 'n' as Dir);
    await drv.startMove(c, 'e' as Dir);
    await drv.stopMove(c, 'n' as Dir);
    // N = az+ (0x11, 0x24) ; E = alt− (0x10, 0x25) ; vitesse center=3
    // (setSpeed NexStar n'envoie RIEN : la vitesse part dans chaque P)
    expect(c.sent[0]).toBe('P\x02\x11\x24\x03\x00\x00\x00');
    expect(c.sent[1]).toBe('P\x02\x10\x25\x03\x00\x00\x00');
    expect(c.sent[2]).toBe('P\x02\x11\x24\x00\x00\x00\x00'); // arrêt = vitesse 0
  });

  it('mode ÉQUATORIAL (tracking \u2019t\u2019=2) : N/S sur DEC, E/W sur AD', async () => {
    const drv = DRIVERS.celestron as import('../src/services/protocol/drivers/nexstar').NexStarDriver;
    const c = new FakeClient();
    c.on('t', '2');
    await drv.refreshAxisMode(c);
    const c2 = new FakeClient();
    c2.on('P', '');
    await drv.setSpeed(c2, 'slew' as Speed);
    await drv.startMove(c2, 'n' as Dir);
    await drv.startMove(c2, 'e' as Dir);
    // N = DEC+ (0x10, 0x24) ; E = AD− (0x11, 0x25) ; vitesse slew=9
    expect(c2.sent[0]).toBe('P\x02\x10\x24\x09\x00\x00\x00');
    expect(c2.sent[1]).toBe('P\x02\x11\x25\x09\x00\x00\x00');
  });

  it('stopAll = \u2019M\u2019 ; isMoving \u2019L\u2019 ; tracking \u2019T\u2019', async () => {
    const drv = DRIVERS.celestron;
    const c = new FakeClient();
    c.on('M', ''); c.on('L', '1'); c.on('T', '');
    await drv.stopAll(c);
    expect(c.sent[0]).toBe('M');
    expect(await drv.isMoving(c)).toBe(true);
    const c2 = new FakeClient(); c2.on('L', '0');
    expect(await drv.isMoving(c2)).toBe(false);
    const c3 = new FakeClient();
    expect(await drv.isMoving(c3)).toBeNull();
    await drv.setTracking(c, 'polar', 48.8); // hémisphère nord → T2
    expect(c.sent[2]).toBe('T2'); // sent[0]=M, sent[1]=L
    const c4 = new FakeClient(); c4.on('T', '');
    await drv.setTracking(c4, 'polar', -33.9); // sud → T3
    expect(c4.sent[0]).toBe('T3');
    const c5 = new FakeClient(); c5.on('T', '');
    await drv.setTracking(c5, 'land', 48.8);
    expect(c5.sent[0]).toBe('T0');
  });

  it('position \u2019e\u2019 : UNE commande pour AD+DEC (18 hex)', async () => {
    const c = new FakeClient();
    c.on('e', `${hex8(dd2pnex(82.75 / 15))},${hex8(dd2pnex(22.0147))}`);
    const rd = await DRIVERS.celestron.getRaDec!(c, 2000);
    expect(rd.raDeg).toBeCloseTo(82.75 / 15, 4);
    expect(rd.decDeg).toBeCloseTo(22.0147, 4);
    expect(c.sent.length).toBe(1); // 2× moins de trafic qu'un Autostar
  });

  it('syncHere : relit la position puis \u2019s\u2019 à l\u2019identique', async () => {
    const drv = DRIVERS.celestron;
    const c = new FakeClient();
    c.on('e', `${hex8(dd2pnex(5))},${hex8(dd2pnex(30))}`);
    c.on('s', '');
    await drv.syncHere(c);
    expect(c.sent.filter((s) => s.startsWith('s')).length).toBe(1);
    expect(c.sent[c.sent.length - 1]).toBe(`s${hex8(dd2pnex(5))},${hex8(dd2pnex(30))}`);
  });
});

/* ==================== 5. SynScan ==================== */

describe('v2.6.0 — driver Sky-Watcher SynScan', () => {
  it('identité propre, héritage NexStar, axes équatoriaux par défaut', async () => {
    expect(DRIVERS.skywatcher.id).toBe('skywatcher');
    expect(DRIVERS.skywatcher.caps.goto).toBe(true);
    const drv = DRIVERS.skywatcher as import('../src/services/protocol/drivers/nexstar').NexStarDriver;
    const c = new FakeClient();
    c.on('P', '');
    await drv.setSpeed(c, 'center' as Speed);
    await drv.startMove(c, 'n' as Dir);
    // SynScan = montures EQ majoritairement : N = DEC+ (0x10, 0x24)
    expect(c.sent[0]).toBe('P\x02\x10\x24\x03\x00\x00\x00');
  });
});

/* ==================== 6. iOptron 8407 ==================== */

describe('v2.6.0 — driver iOptron Go2Nova 8407', () => {
  it('sonde :MountInfo# : "8407,0308," → oui, le reste → non', () => {
    expect(DRIVERS.ioptron.probe!.classify('8407,0308,')).toBe(true);
    expect(parseMountInfo('8407,0308,')).toEqual({product: '8407', version: '0308'});
    expect(parseMountInfo('CEM40,1.04')).toEqual({product: 'CEM40', version: '1.04'});
    expect(DRIVERS.ioptron.probe!.classify('AutoStar II')).toBe(false);
    expect(DRIVERS.ioptron.probe!.classify('4.22')).toBe(false);
    expect(DRIVERS.ioptron.probe!.classify('')).toBe(false);
  });

  it('caps : GOTO/relais OUI · pushSite/lcd/park NON · isMoving indisponible', () => {
    const caps = DRIVERS.ioptron.caps;
    expect(caps.goto && caps.relay && caps.sync).toBe(true);
    expect(caps.pushSite).toBe(false);
    expect(caps.lcdMirror).toBe(false);
    expect(caps.park).toBe(false);
    expect(caps.isMoving).toBe(false);
  });

  it('GOTO : ":Sr HH:MM:SS#" + ":Sd ±DD*MM:SS#" (avec espace) → :MS #1=ok', async () => {
    const c = new FakeClient();
    c.on(':Sr ', '1');
    c.on(':Sd ', '1');
    c.on(':MS#', '1');
    const r = await DRIVERS.ioptron.goto(c, 82.75, 22.0147);
    expect(r).toBe('ok');
    expect(c.sent[0]).toMatch(/^:Sr \d{1,2}:\d{2}:\d{2}#$/);
    expect(c.sent[1]).toMatch(/^:Sd \+?\d{1,2}\*\d{2}:\d{2}#$/);
    expect(c.sent[2]).toBe(':MS#');
  });

  it('SÉMANTIQUE INVERSÉE : :MS \u20191\u2019=ok, \u20190\u2019=sous l\u2019horizon, \u20192\u2019=hors limites', async () => {
    const mk = (ms: string) => {
      const c = new FakeClient();
      c.on(':Sr ', '1'); c.on(':Sd ', '1'); c.on(':MS#', ms);
      return c;
    };
    expect(await DRIVERS.ioptron.goto(mk('1'), 82.75, 22.01)).toBe('ok');
    expect(await DRIVERS.ioptron.goto(mk('0'), 82.75, 22.01)).toBe('belowHorizon');
    expect(await DRIVERS.ioptron.goto(mk('2'), 82.75, 22.01)).toBe('noObject');
  });

  it('position : :GR#/:GD# (formats Meade)', async () => {
    const c = new FakeClient();
    c.on(':GR#', '05:31:00');
    c.on(':GD#', '+22*01');
    const rd = await DRIVERS.ioptron.getRaDec!(c, 2000);
    expect(rd.raDeg).toBeCloseTo((5 + 31 / 60) * 15, 5);
    expect(rd.decDeg).toBeCloseTo(22 + 1 / 60, 5);
  });

  it('flèches : :SR<n># puis :m<dir># (sans réponse) ; arrêts :qD#/:qR#/:q#', async () => {
    const drv = DRIVERS.ioptron;
    const c = new FakeClient();
    c.on(':SR', '1');
    c.on(':q', '1'); // arrêts acquittés : pas de retentative silencieuse
    await drv.setSpeed(c, 'center' as Speed);
    await drv.startMove(c, 'n' as Dir);
    await drv.startMove(c, 'e' as Dir);
    expect(c.sent[0]).toBe(':SR3#');
    expect(c.sent[1]).toBe(':mn#');
    expect(c.sent[2]).toBe(':me#');
    await drv.stopMove(c, 'n' as Dir);
    await drv.stopMove(c, 'e' as Dir);
    await drv.stopAll(c);
    expect(c.sent[3]).toBe(':qD#'); // N/S → axe DEC
    expect(c.sent[4]).toBe(':qR#'); // E/W → axe AD
    expect(c.sent[5]).toBe(':q#');
  });

  it('tracking : :ST1# (altaz/polaire) / :ST0# (terrestre)', async () => {
    const drv = DRIVERS.ioptron;
    const c = new FakeClient(); c.on(':ST', '1');
    await drv.setTracking!(c, 'polar', 48.8);
    expect(c.sent[0]).toBe(':ST1#');
    const c2 = new FakeClient(); c2.on(':ST', '1');
    await drv.setTracking!(c2, 'land', 48.8);
    expect(c2.sent[0]).toBe(':ST0#');
  });
});

/* ==================== 7. détection de protocole ==================== */

describe('v2.6.0 — résolution du protocole (resolveDriver)', () => {
  const clientWith = (replyFor: (c: string) => string | null) => {
    const client = new AutostarClient();
    jest.spyOn(client, 'cmd').mockImplementation(((c: string) => {
      const r = replyFor(c);
      if (r === null) return Promise.reject(new Error('Délai dépassé (muette)'));
      return Promise.resolve(r);
    }) as typeof client.cmd);
    return client;
  };

  it(':GVP# = "Autostar II" → meade', async () => {
    const client = clientWith((c) => (c === ':GVP#' ? 'Autostar II' : null));
    expect((await client.resolveDriver('auto')).id).toBe('meade');
  });

  it(':GVP# = "?" (Meade muet/mécontent) → sonde suivante', async () => {
    const client = clientWith((c) => (c === 'V' ? '4.22' : '?'));
    // :GVP# → '?' rejeté par classify, 'V' → '4.22' → celestron
    expect((await client.resolveDriver('auto')).id).toBe('celestron');
  });

  it("'V' = \"4.22\" → celestron", async () => {
    const client = clientWith((c) => (c === 'V' ? '4.22' : null));
    expect((await client.resolveDriver('auto')).id).toBe('celestron');
  });

  it(':MountInfo# = "8407,0308," → ioptron', async () => {
    const client = clientWith((c) => (c === ':MountInfo#' ? '8407,0308,' : null));
    expect((await client.resolveDriver('auto')).id).toBe('ioptron');
  });

  it('tout muet → repli Meade/LX200', async () => {
    const client = clientWith(() => null);
    expect((await client.resolveDriver('auto')).id).toBe('meade');
  });

  it('préférence explicite : choisie sans sonde', async () => {
    const client = clientWith(() => null); // ne doit PAS être appelé
    const cmdSpy = jest.spyOn(client, 'cmd');
    expect((await client.resolveDriver('skywatcher')).id).toBe('skywatcher');
    expect(cmdSpy).not.toHaveBeenCalled();
  });
});
