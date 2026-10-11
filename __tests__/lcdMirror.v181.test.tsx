/**
 * Tests de régression v1.8.1 — MIROIR LCD :ED# + touches :EK# + GO TO robuste.
 *
 * Contexte : « l'affichage LCD n'est toujours pas synchro avec la raquette,
 * les boutons de la raquette physique ne sont pas mappés, le GO TO ne
 * fonctionne pas ». Correctif : mécanisme du Remote Handbox d'AutostarSuite
 * (prouvé par le repo LX200emulator / log astropad) :
 *   :ED# → lit le littéral de l'écran 2×16 de la raquette physique ;
 *   :EK<ascii># → simule les touches PHYSIQUES (Mode=9, Enter=13,
 *   N=85, S=68, W=87, E=69, GO TO=71, ?=63, chiffres 48-57) ;
 *   GO TO → :Sr/:Sd retentés dans l'autre précision si refusés, :MS, puis
 *   suivi de fin de slew par :D#.
 */
import React from 'react';
import {create as createRTR, act} from 'react-test-renderer';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {HandboxScreen} from '../src/screens/HandboxScreen';
import {
  AutostarClient,
  parseLcdReply,
  HB_KEYS,
  hbDigitKey,
  LCD_STALE_MS,
} from '../src/services/protocol/client';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';
import type {ConnectOptions, Transport, TransportType} from '../src/services/connection/types';
import {TransportError} from '../src/services/connection/types';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/* ================= Partie 1 — parser :ED# ================= */

describe('v1.8.1 — parseLcdReply (miroir LCD :ED#)', () => {
  test('écran menu réel du log astropad (marqueur 0x97)', () => {
    // Capture réelle : \x97Select Item:    Object          #  (2×16)
    const reply = '\u0097' + 'Select Item:    ' + 'Object          ';
    const lcd = parseLcdReply(reply);
    expect(lcd).not.toBeNull();
    expect(lcd!.line1).toBe('Select Item:    ');
    expect(lcd!.line2).toBe('Object          ');
  });

  test('écran de boot (marqueur 0x9F) + glyphe 0xDF converti en °', () => {
    // « Set Slew Speed Rate = 1.5°/sec » — le LCD matériel envoie 0xDF pour °
    const line = '1.5\u00DF/sec        '; // glyphe brut du matériel (8+8=16 chars)
    const reply = '\u009F' + 'Slew Speed Rate ' + line;
    const lcd = parseLcdReply(reply);
    expect(lcd).not.toBeNull();
    expect(lcd!.line2).toContain('1.5\u00B0/sec'); // converti en degré « ° »
  });

  test('marqueur de saisie numérique 0xD0 accepté', () => {
    const reply = '\u00D0' + 'Messier Object: ' + '0               ';
    const lcd = parseLcdReply(reply);
    expect(lcd).not.toBeNull();
    expect(lcd!.line1).toBe('Messier Object: ');
    expect(lcd!.line2).toBe('0               ');
  });

  test('réponse trop courte → null (repli télémétrie)', () => {
    expect(parseLcdReply('\u0097trop court')).toBeNull();
    expect(parseLcdReply('')).toBeNull();
  });

  test('réponse longue : les 32 derniers caractères font foi', () => {
    const body = 'AAAAAAAAAAAAAAAA' + 'BBBBBBBBBBBBBBBB';
    const lcd = parseLcdReply('\u0097\u0097xxx' + body);
    expect(lcd!.line1).toBe('AAAAAAAAAAAAAAAA');
    expect(lcd!.line2).toBe('BBBBBBBBBBBBBBBB');
  });
});

/* ================= Partie 2 — client :ED# / :EK# / GOTO ================= */

/** Transport série factice : réponses programmables, écritures enregistrées. */
class FakeTransport implements Transport {
  readonly type: TransportType = 'usb';
  connected = true;
  writes: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
  /** Réponses à chaque commande (première correspondance regex gagnante). */
  replies: Array<{match: RegExp; reply: string; delay?: number}> = [];

  onData(cb: (chunk: string) => void) {this.dataCb = cb;}
  onError() {}
  onClosed() {}
  isConnected() {return this.connected;}

  async connect(_opts: ConnectOptions) {this.connected = true;}
  async disconnect() {this.connected = false;}

  async write(data: string): Promise<void> {
    this.writes.push(data);
    const rule = this.replies.find((r) => r.match.test(data));
    if (rule) {
      const push = () => this.dataCb?.(rule.reply);
      if (rule.delay) setTimeout(push, rule.delay);
      else push();
    }
  }
}

async function connectedClient(_model: 'autostar497' = 'autostar497'): Promise<{client: AutostarClient; tp: FakeTransport}> {
  // Assemblage manuel (plus unitaire que connect() qui exige un module natif) :
  // le client ne dépend que de this.transport + onData pour cmd()/getLcd()/etc.
  const client = new AutostarClient();
  const tp = new FakeTransport();
  jest.spyOn(client as any, 'log').mockImplementation(() => undefined);
  (client as any).transport = tp;
  tp.onData((chunk) => (client as any).onData(chunk));
  return {client, tp};
}

describe('v1.8.1 — AutostarClient : :ED#, :EK#, GO TO robuste', () => {
  let client: AutostarClient;
  let tp: FakeTransport;

  beforeEach(() => {client = null as any; tp = null as any;});
  afterEach(async () => {
    if (client) await client.disconnect().catch(() => undefined);
    jest.restoreAllMocks();
  });

  test('getLcd() envoie :ED# et parse le dump 2×16', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push({
      match: /:ED#/,
      reply: '\u0097Select Item:    Object          #',
    });
    const lcd = await client.getLcd();
    expect(tp.writes).toContain(':ED#');
    expect(lcd).not.toBeNull();
    expect(lcd!.line1).toBe('Select Item:    ');
    expect(lcd!.line2).toBe('Object          ');
  });

  test('getLcd() renvoie null sur raquette muette (sans lever)', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.length = 0; // aucune réponse
    const lcd = await client.getLcd();
    expect(lcd).toBeNull();
  });

  test('keyPress() écrit :EK<ascii># (codes du log ScopeBoss)', async () => {
    ({client, tp} = await connectedClient());
    await client.keyPress(HB_KEYS.mode);
    await client.keyPress(HB_KEYS.enter);
    await client.keyPress(HB_KEYS.goto);
    await client.keyPress(HB_KEYS.up);
    await client.keyPress(HB_KEYS.down);
    await client.keyPress(HB_KEYS.west);
    await client.keyPress(HB_KEYS.east);
    await client.keyPress(hbDigitKey(5));
    expect(tp.writes).toEqual([':EK9#', ':EK13#', ':EK71#', ':EK85#', ':EK68#', ':EK87#', ':EK69#', ':EK53#']);
  });

  test('gotoRaDec : :Sr haute précision refusé → retenté en basse précision', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push(
      // :SrHH:MM:SS → refus (« 0 ») ; :SrHH:MM.T → accepté
      {match: /^:Sr\d{2}:\d{2}:\d{2}#/, reply: '0#'},
      {match: /^:Sr\d{2}:\d{2}\.\d#/, reply: '1#'},
      {match: /^:Sd/, reply: '1#'},
      {match: /^:MS#/, reply: '0#'},
    );
    const r = await client.gotoRaDec(82.75, 22.0147);
    expect(r).toBe('ok');
    // la tentative basse précision a bien eu lieu (repli format)
    expect(tp.writes.some((w) => /^:Sr\d{2}:\d{2}\.\d#$/.test(w))).toBe(true);
  });

  test('gotoRaDec : les deux formats refusés → refused (pas de :MS)', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push({match: /^:Sr/, reply: '0#'});
    const r = await client.gotoRaDec(82.75, 22.0147);
    expect(r).toBe('refused');
    expect(tp.writes.some((w) => w === ':MS#')).toBe(false);
  });

  test('gotoRaDec : :MS répond 1 → belowHorizon, 2 → noObject', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push(
      {match: /^:Sr/, reply: '1#'},
      {match: /^:Sd/, reply: '1#'},
      {match: /^:MS#/, reply: '1#'},
    );
    expect(await client.gotoRaDec(10, -30)).toBe('belowHorizon');
    tp.replies[2] = {match: /^:MS#/, reply: '2#'};
    expect(await client.gotoRaDec(10, -30)).toBe('noObject');
  });

  test('gotoRaDec : :Sd haute précision refusé → retenté en basse précision', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push(
      {match: /^:Sr/, reply: '1#'},
      // :SdsDD*MM:SS → refus ; :SdsDD*MM → accepté
      {match: /^:Sd[+-]\d{1,3}\*\d{2}:\d{2}#/, reply: '0#'},
      {match: /^:Sd[+-]\d{1,3}\*\d{2}#/, reply: '1#'},
      {match: /^:MS#/, reply: '0#'},
    );
    expect(await client.gotoRaDec(10, -30.5)).toBe('ok');
    expect(tp.writes.some((w) => /^:Sd-30\*30#$/.test(w))).toBe(true);
  });

  test('poll :ED# met le LCD à jour dans le store (miroir)', async () => {
    ({client, tp} = await connectedClient());
    tp.replies.push({match: /:ED#/, reply: '\u0097Select Item:    Object          #'});
    useScopeStore.getState().setHbSync('live');
    // appelle le même chemin que le poll (getLcd → setLcdMirror)
    const lcd = await client.getLcd();
    expect(lcd).not.toBeNull();
    const s = useScopeStore.getState();
    s.setLcdMirror(lcd!.line1, lcd!.line2);
    expect(useScopeStore.getState().lcdLine1).toBe('Select Item:    ');
    expect(useScopeStore.getState().lcdAt).toBeGreaterThan(0);
    useScopeStore.getState().clearLcdMirror();
    expect(useScopeStore.getState().lcdLine1).toBeNull();
  });

  test('LCD_STALE_MS : écran périmé = repli télémétrie (constante cohérente)', () => {
    // le tick du poll fait 500 ms : le miroir doit survivre à quelques ticks
    expect(LCD_STALE_MS).toBeGreaterThanOrEqual(1500);
    expect(LCD_STALE_MS).toBeLessThanOrEqual(5000);
  });
});

/* ================= Partie 3 — UI : touches mappées en miroir ================= */

let tree: any;
async function mount() {
  await act(async () => {
    tree = createRTR(<HandboxScreen />);
    await flush();
  });
}
function pressableWithLabel(label: string) {
  const nodes = tree.root.findAll((n: any) => n.type && n.type.displayName === 'Pressable');
  return nodes.find((n: any) => {
    try {
      return n.findAll((t: any) => t.type === 'Text')
        .some((t: any) => String(t.props.children).trim() === label);
    } catch (_) {return false;}
  });
}

/** Toutes les touches portant ce libellé (v1.8.2 : la nav ▲▼ du cadre LCD
 *  précède la croix directionnelle dans l'arbre — il faut les distinguer). */
function pressablesWithLabel(label: string) {
  const nodes = tree.root.findAll((n: any) => n.type && n.type.displayName === 'Pressable');
  return nodes.filter((n: any) => {
    try {
      return n.findAll((t: any) => t.type === 'Text')
        .some((t: any) => String(t.props.children).trim() === label);
    } catch (_) {return false;}
  });
}

describe('v1.8.1 — VirtualHandbox : touches → :EK# en miroir', () => {
  afterEach(async () => {
    if (tree) {tree.unmount(); tree = null;}
    jest.restoreAllMocks();
    const s = useScopeStore.getState();
    s.setConnStatus('disconnected');
    s.setHbSync('off');
    s.clearLcdMirror();
    useSettingsStore.getState().setLanguage('fr');
  });

  test('LCD affiche le LITTÉRAL de la raquette physique ; ENTER/GO TO/N envoient :EK#', async () => {
    await mount();
    const s = useScopeStore.getState();
    act(() => {
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      useScopeStore.setState({hbSync: 'live' as const});
      s.setLcdMirror('Select Item:      ', 'Object         ');
    });
    await flush();

    // 1) le LCD montre le dump :ED# au caractère près
    const texts = tree.root.findAll((n: any) => n.type === 'Text');
    const joined = texts.map((t: any) => String(t.props.children ?? '')).join('\n');
    expect(joined).toContain('Select Item:');

    // 2) appui ENTER → :EK13# (pas de navigation menu locale)
    const spy = jest.spyOn(autostarSingleton(), 'keyPress').mockResolvedValue(undefined);
    await act(async () => {
      pressableWithLabel('ENTER')!.props.onPress();
      await flush(10);
    });
    expect(spy).toHaveBeenCalledWith(HB_KEYS.enter);

    // 3) GO TO → :EK71#
    spy.mockClear();
    await act(async () => {
      pressableWithLabel('GO TO')!.props.onPress();
      await flush(10);
    });
    expect(spy).toHaveBeenCalledWith(HB_KEYS.goto);

    // 4) flèche N de la CROIX (maintien : onPressIn) → :EK85# — la nav ▲ du
    //    cadre LCD porte le même libellé mais déclenche via onPress
    spy.mockClear();
    await act(async () => {
      const arrows = pressablesWithLabel('▲');
      const cross = arrows.find((n: any) => typeof n.props.onPressIn === 'function');
      cross!.props.onPressIn();
      await flush(10);
    });
    expect(spy).toHaveBeenCalledWith(HB_KEYS.up);

    // 4bis) bouton ▲ de NAVIGATION (cadre LCD, onPress) → :EK85# aussi
    //    (le défilement miroir envoie la touche HAUT physique, comme le #497)
    spy.mockClear();
    await act(async () => {
      const nav = pressablesWithLabel('▲').find((n: any) => typeof n.props.onPress === 'function');
      nav!.props.onPress();
      await flush(10);
    });
    expect(spy).toHaveBeenCalledWith(HB_KEYS.up);

    // 5) chiffre 5 → :EK53#
    spy.mockClear();
    await act(async () => {
      pressableWithLabel('5')!.props.onPress();
      await flush(10);
    });
    expect(spy).toHaveBeenCalledWith(hbDigitKey(5));
  });

  test('hors miroir (lcd périmé) : ENTER navigue le menu LOCAL (pas de :EK#)', async () => {
    await mount();
    const s = useScopeStore.getState();
    act(() => {
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      useScopeStore.setState({hbSync: 'live' as const});
      // LCD présent mais PÉRIMÉ (lcdAt ancien)
      useScopeStore.setState({lcdLine1: 'vieux', lcdLine2: 'écran', lcdAt: Date.now() - LCD_STALE_MS - 1000});
    });
    await flush();
    const spy = jest.spyOn(autostarSingleton(), 'keyPress').mockResolvedValue(undefined);
    await act(async () => {
      pressableWithLabel('ENTER')!.props.onPress();
      await flush(10);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

/** Le singleton autostar est importé en bout de module client (évite le cycle). */
function autostarSingleton() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {autostar} = require('../src/services/protocol/client');
  return autostar as AutostarClient;
}
