/**
 * Tests v2.2.0 — mise à jour de la raquette physique avec les données de
 * précision (protocol/handboxPush.ts).
 *
 * Contrats verrouillés :
 *  1. heuristique rétro-jeu ″ → % (bornée, cas nuls) ;
 *  2. PARCOURS COMPLET : menus Configuration → Télescope → Rétro-jeu AD/DEC
 *     navigués par :EK# avec vérification :ED# — valeurs posées dans la
 *     raquette simulée, raquette ramenée à l'accueil ;
 *  3. tolérance : menu introuvable → 'fail' SANS bloquer (escape), miroir
 *     :ED# indisponible → 'skipped', pas de mesure → 'skipped' tôt ;
 *  4. horloge/site toujours poussés (:SG/:SL/:SC/:St/:Sg acquittés) ;
 *  5. démo : menus non pilotés, valeurs calculées seulement.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {autostar, HB_KEYS} from '../src/services/protocol/client';
import {
  backlashPctFromArcsec,
  parseLcdWithSelection,
  pushCalibToHandbox,
} from '../src/services/protocol/handboxPush';
import type {Transport, TransportType, ConnectOptions} from '../src/services/connection/types';

/* ==================== outillage ==================== */

const pad = (s: string) => (s + ' '.repeat(16)).slice(0, 16);

/** Fausse raquette #49x : menus étatiques (fr), rendus :ED# 2×16 avec
 *  flèche de sélection, touches :EK# (MODE/BAS/ENTRÉE/chiffres). */
class FakeHandbox implements Transport {
  readonly type: TransportType;
  connected = true;
  writes: string[] = [];
  /** Valeurs de rétro-jeu effectivement posées dans la raquette. */
  setValues: {ra: number | null; dec: number | null} = {ra: null, dec: null};
  /** 'idle' | 'main' | 'setup' | 'telescope' | 'value' */
  screen = 'idle';
  private sel = 0;
  private item = '';
  private digits = '';
  private menus = {
    main: ['Objet', 'Configuration', 'Guidage', 'Utilitaires'],
    setup: ['Heure/Date', 'Télescope', 'Brillants'],
    telescope: ['Entraînement', 'Rétro-jeu AD', 'Rétro-jeu DEC'],
  };
  private dataCb: ((chunk: string) => void) | null = null;

  constructor(type: TransportType = 'usb') {this.type = type;}

  /** Variante : menu principal SANS « Configuration » (raquette exotique). */
  noSetupMenu = false;

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}
  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}
  private reply(s: string) {this.dataCb?.(s);}

  private lines(): [string, string] {
    const m = this.noSetupMenu
      ? {main: ['Objet', 'Réglages avancés', 'Guidage'], setup: ['Heure/Date', 'Télescope'], telescope: ['Entraînement', 'Rétro-jeu AD', 'Rétro-jeu DEC']}
      : this.menus;
    switch (this.screen) {
      case 'idle': return [pad('Objet'), pad('')];
      case 'main': return [pad(m.main[this.sel] ?? ''), pad(m.main[this.sel + 1] ?? '')];
      case 'setup': return [pad(m.setup[this.sel] ?? ''), pad(m.setup[this.sel + 1] ?? '')];
      case 'telescope': return [pad(m.telescope[this.sel] ?? ''), pad(m.telescope[this.sel + 1] ?? '')];
      case 'value': return [pad(this.item), pad(`>${this.digits || '00'}%`)];
      default: return [pad('Objet'), pad('')];
    }
  }

  private render() {
    const [l1, l2] = this.lines();
    // flèche (\u0089) INSÉRÉE en cellule 0 de la ligne sélectionnée (le texte
    // reste lisible, décalé — comme sur le LCD matériel) ; menus uniquement
    const arrow = this.screen === 'main' || this.screen === 'setup' || this.screen === 'telescope';
    const body = (arrow ? '\u0089' + l1.slice(0, 15) : l1) + l2;
    this.reply('\u0080' + body + '#');
  }

  async write(data: string): Promise<void> {
    this.writes.push(data);
    if (data.startsWith(':SG') || data.startsWith(':SL') || data.startsWith(':SC')
      || data.startsWith(':St') || data.startsWith(':Sg') || data === ':GG#') {this.reply('1#'); return;}
    if (data === ':Ga#') {this.reply('+45:00#'); return;}
    if (data.startsWith(':ED#')) {this.render(); return;}
    if (data.startsWith(':EK')) {
      const code = Number(data.slice(3, -1));
      if (code === HB_KEYS.mode) {
        if (this.screen === 'value') this.screen = 'telescope';
        else if (this.screen === 'telescope') this.screen = 'setup';
        else if (this.screen === 'setup') this.screen = 'main';
        else if (this.screen === 'main') {this.screen = 'idle'; this.sel = 0;}
        else {this.screen = 'main'; this.sel = 0;} // MODE depuis l'accueil → menu principal
      } else if (code === HB_KEYS.down) {
        this.sel = Math.min(this.sel + 1, 5);
      } else if (code === HB_KEYS.enter) {
        if (this.screen === 'main') {this.screen = 'setup'; this.sel = 0;}
        else if (this.screen === 'setup') {this.screen = 'telescope'; this.sel = 0;}
        else if (this.screen === 'telescope') {
          this.item = this.menus.telescope[this.sel] ?? '';
          this.screen = 'value';
          this.digits = '';
        } else if (this.screen === 'value') {
          const v = parseInt(this.digits || '0', 10);
          if (/AD/i.test(this.item)) this.setValues.ra = v; else this.setValues.dec = v;
          this.screen = 'telescope';
        }
      } else if (code >= HB_KEYS.digit0 && code <= HB_KEYS.digit0 + 9 && this.screen === 'value') {
        this.digits += String(code - HB_KEYS.digit0);
      }
    }
  }
}

function inject(tp: Transport) {
  (autostar as any).transport = tp;
  (autostar as any).log = () => undefined;
  tp.onData((chunk: string) => (autostar as any).onData(chunk));
}

/** Fait avancer les timers factifs jusqu'à la résolution de la promesse. */
async function pump<T>(p: Promise<T>, maxMs = 120000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  p.then((v) => {settled = true; value = v;}, () => {settled = true;});
  for (let t = 0; t < maxMs && !settled; t += 100) {
    await jest.advanceTimersByTimeAsync(100);
  }
  return value as T;
}

/* ==================== heuristique ==================== */

describe('backlashPctFromArcsec — jeu mesuré → % rétro-jeu', () => {
  it('conversions nominales (~20″ par %)', () => {
    expect(backlashPctFromArcsec(90)).toBe(5);   // ETX-125 DEC typique
    expect(backlashPctFromArcsec(30)).toBe(2);
    expect(backlashPctFromArcsec(100)).toBe(5);
    expect(backlashPctFromArcsec(14)).toBe(1);   // plancher
  });
  it('bornée 1..50 et cas nuls', () => {
    expect(backlashPctFromArcsec(5000)).toBe(50);
    expect(backlashPctFromArcsec(0)).toBeNull();
    expect(backlashPctFromArcsec(-5)).toBeNull();
    expect(backlashPctFromArcsec(null)).toBeNull();
    expect(backlashPctFromArcsec(Number.NaN)).toBeNull();
  });
});

describe('parseLcdWithSelection — flèche de sélection :ED#', () => {
  it('détecte la ligne sélectionnée (octet de contrôle en tête de ligne)', () => {
    // Format RÉEL de la réponse :ED# vue par le parseur client ('#' retiré) :
    // marqueur d'écran + 2×16 caractères, flèche \u0089 en tête de la ligne
    // sélectionnée (ici ligne 2 = Configuration)
    const body = pad('Objet') + '\u0089' + pad('Configuration').slice(0, 15);
    const lcd = parseLcdWithSelection('\u0080' + body);
    expect(lcd).not.toBeNull();
    expect(lcd!.selected).toBe(2);
    expect(lcd!.line2).toContain('Configuration');
  });
  it('ligne 1 sélectionnée → selected = 1', () => {
    const body = '\u0089' + pad('Objet').slice(0, 15) + pad('Configuration');
    const lcd = parseLcdWithSelection('\u0080' + body);
    expect(lcd!.selected).toBe(1);
  });
  it('réponse trop courte → null', () => {
    expect(parseLcdWithSelection('courte')).toBeNull();
  });
});

/* ==================== parcours complet ==================== */

describe('pushCalibToHandbox — navigation des menus (raquette simulée)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    (autostar as any).transport = null;
  });

  it('parcours complet : horloge/site + rétro-jeu AD et DEC posés, retour accueil', async () => {
    const hb = new FakeHandbox();
    inject(hb);
    const phases: string[] = [];
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 100, decArcsec: 80}, // → 5 % / 4 %
      onPhase: (p) => phases.push(p),
    }));
    expect(rep.clock).toBe('ok');
    expect(rep.backlashRa).toBe('ok');
    expect(rep.backlashDec).toBe('ok');
    expect(rep.raPct).toBe(5);
    expect(rep.decPct).toBe(4);
    expect(hb.setValues).toEqual({ra: 5, dec: 4});
    // la raquette est rendue à son accueil dans TOUS les cas
    expect(hb.screen).toBe('idle');
    // les touches sont passées par :EK# (jamais d'écriture moteur ici)
    expect(hb.writes.some((w) => w.startsWith(':EK'))).toBe(true);
    expect(phases).toContain('ra');
    expect(phases).toContain('dec');
    expect(phases).toContain('done');
  });

  it('un seul axe mesuré → un seul réglage posé, l\'autre skipped', async () => {
    const hb = new FakeHandbox();
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 60, decArcsec: null},
    }));
    expect(rep.backlashRa).toBe('ok');
    expect(rep.backlashDec).toBe('skipped');
    expect(hb.setValues.ra).toBe(3);
    expect(hb.setValues.dec).toBeNull();
    expect(hb.screen).toBe('idle');
  });

  it('menu Configuration introuvable → fail SANS blocage, retour accueil', async () => {
    const hb = new FakeHandbox();
    hb.noSetupMenu = true;
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 100, decArcsec: 80},
    }));
    expect(rep.clock).toBe('ok');
    expect(rep.backlashRa).toBe('fail');
    expect(rep.note).toBe('menuNotFound');
    expect(hb.setValues.ra).toBeNull();
    expect(hb.screen).toBe('idle'); // escape de secours
  });

  it('miroir :ED# muet → rétro-jeu skipped, horloge quand même poussée', async () => {
    const hb = new FakeHandbox();
    // raquette muette sur :ED# uniquement
    const origWrite = hb.write.bind(hb);
    hb.write = async (data: string) => {
      if (data.startsWith(':ED#')) return; // silence
      await origWrite(data);
    };
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 100, decArcsec: 80},
    }));
    expect(rep.clock).toBe('ok');
    expect(rep.backlashRa).toBe('skipped');
    expect(rep.note).toBe('noMirror');
    expect(hb.setValues.ra).toBeNull();
  });

  it('aucune mesure de jeu → sortie immédiate (menus jamais ouverts)', async () => {
    const hb = new FakeHandbox();
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: null,
    }));
    expect(rep.clock).toBe('ok');
    expect(rep.note).toBe('noBacklash');
    expect(hb.writes.filter((w) => w.startsWith(':EK')).length).toBe(0);
    expect(hb.screen).toBe('idle');
  });

  it('transport démo → valeurs calculées, menus non pilotés', async () => {
    const hb = new FakeHandbox('demo');
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 100, decArcsec: 80},
    }));
    expect(rep.clock).toBe('ok');
    expect(rep.backlashRa).toBe('skipped');
    expect(rep.raPct).toBe(5);
    expect(hb.writes.filter((w) => w.startsWith(':EK')).length).toBe(0);
  });

  it('horloge muette → clock tolérant (ok), rétro-jeu quand même poussé', async () => {
    const hb = new FakeHandbox();
    const origWrite = hb.write.bind(hb);
    hb.write = async (data: string) => {
      if (data.startsWith(':SG') || data.startsWith(':SL') || data.startsWith(':SC')
        || data.startsWith(':St') || data.startsWith(':Sg')) return; // muette
      await origWrite(data);
    };
    inject(hb);
    const rep = await pump(pushCalibToHandbox({
      latDeg: 48.85, lonDeg: 2.35,
      backlash: {raArcsec: 100, decArcsec: null},
    }));
    // v2.1.2 : l'horloge muette n'est PAS une erreur (envoi non acquitté)
    expect(rep.clock).toBe('ok');
    expect(rep.backlashRa).toBe('ok');
    expect(hb.setValues.ra).toBe(5);
  });
});
