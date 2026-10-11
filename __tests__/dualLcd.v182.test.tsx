/**
 * Tests de régression v1.8.2 — DOUBLE AFFICHAGE LCD de l'onglet Raquette.
 *
 * Demande utilisateur : « plutôt que d'avoir en alternance l'affichage
 * miroir LCD et RA/DEC, je veux 2 affichages LCD : un miroir LCD et un
 * RA/DEC permanent. Les boutons de navigation dans les menus doivent
 * apparaître dans le même cadre que les affichages LCD, et tous les menus
 * situés entre le LCD et le bouton voix passent en bas de la fenêtre. »
 *
 * Contrats verrouillés ici :
 *   1. DEUX LcdPanel rendus simultanément (miroir + AD/DEC permanent) ;
 *   2. pendant que le miroir affiche le :ED# de la raquette physique,
 *      l'affichage AD/DEC montre QUAND MÊME les coordonnées (fin de
 *      l'alternance miroir ↔ AD/DEC) ;
 *   3. l'AD/DEC reste affiché même hors connexion, et des tirets honnêtes
 *      tant qu'aucune position n'a été lue ;
 *   4. les boutons de navigation des menus (MODE/ENTER/▲▼/?) pilotent la
 *      raquette physique en mode miroir (:EK#) ;
 *   5. GO TO reste sur le clavier principal ;
 *   6. ordre vertical : voix juste sous les affichages, aide clavier avant
 *      les panneaux déplacés (arbre des menus → vitesse → mise au point).
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
import {autostar, HB_KEYS} from '../src/services/protocol/client';
import {LcdPanel} from '../src/components/LcdPanel';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let tree: any;
const uncaught: string[] = [];

async function mount() {
  if (tree) {tree.unmount(); tree = null;}
  await act(async () => {
    tree = createRTR(<HandboxScreen />, {
      onUncaughtError: (error: any) => {uncaught.push(String(error?.message));},
    } as any);
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

function allTexts(): string[] {
  return tree.root.findAll((n: any) => n.type === 'Text')
    .map((n: any) => String(n.props.children ?? ''));
}

afterEach(() => {
  if (tree) {tree.unmount(); tree = null;}
  jest.restoreAllMocks();
  try {useScopeStore.getState().disconnect();} catch (_) {}
  try {useScopeStore.getState().clearLcdMirror();} catch (_) {}
  try {useSettingsStore.getState().setLanguage('fr');} catch (_) {}
});

describe('v1.8.2 — double affichage LCD (miroir + AD/DEC permanent)', () => {
  test('miroir :ED# ET coordonnées affichés SIMULTANÉMENT (fin de l\u2019alternance)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      s.setPosition(83.633083, -22.0145);
      useScopeStore.setState({hbSync: 'live' as const});
      s.setLcdMirror('Select Item:      ', 'Object          ');
    });
    await flush();

    const lcds = tree.root.findAllByType(LcdPanel);
    expect(lcds.length).toBe(2);
    // gauche = miroir littéral de la raquette physique
    expect(String(lcds[0].props.line1)).toContain('Select Item');
    expect(String(lcds[0].props.line2)).toContain('Object');
    // droite = AD/DEC PERMANENT (pas l'écran miroir, pas un écran d'attente)
    expect(String(lcds[1].props.line1)).toMatch(/^RA \d/);
    expect(String(lcds[1].props.line2)).toMatch(/^DEC/);
    expect(uncaught).toEqual([]);
  });

  test('AD/DEC permanent même hors connexion (miroir = accueil menu local)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('disconnected');
      useScopeStore.setState({
        hbSync: 'off' as const, hasPos: true,
        raDeg: 83.633083, decDeg: -22.0145,
      });
    });
    await flush();

    const lcds = tree.root.findAllByType(LcdPanel);
    expect(lcds.length).toBe(2);
    expect(String(lcds[1].props.line1)).toMatch(/^RA \d/);
    expect(String(lcds[1].props.line2)).toMatch(/^DEC/);
    // hors ligne : le miroir montre l'accueil des menus locaux
    expect(String(lcds[0].props.line1)).toContain('Select Item');
    expect(uncaught).toEqual([]);
  });

  test('aucune position → tirets honnêtes sur l\u2019AD/DEC (jamais de faux 00:00:00)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'live' as const, hasPos: false});
      s.setAltAz(null, null);
    });
    await flush();

    const lcds = tree.root.findAllByType(LcdPanel);
    expect(String(lcds[1].props.line1)).toBe('RA --:--:--');
    expect(String(lcds[1].props.line2)).toBe('DEC --°--');
    expect(uncaught).toEqual([]);
  });
});

describe('v1.8.2 — navigation des menus dans le cadre LCD + ordre des panneaux', () => {
  test('MODE/ENTER du cadre : appuis miroir → touches PHYSIQUES (:EK#)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      useScopeStore.setState({hbSync: 'live' as const});
      s.setLcdMirror('Select Item:      ', 'Object          ');
    });
    await flush();

    const spy = jest.spyOn(autostar, 'keyPress').mockResolvedValue(undefined);
    await act(async () => {pressableWithLabel('MODE')!.props.onPress(); await flush(10);});
    expect(spy).toHaveBeenCalledWith(HB_KEYS.mode);

    spy.mockClear();
    await act(async () => {pressableWithLabel('ENTER')!.props.onPress(); await flush(10);});
    expect(spy).toHaveBeenCalledWith(HB_KEYS.enter);

    spy.mockClear();
    await act(async () => {pressableWithLabel('?')!.props.onPress(); await flush(10);});
    expect(spy).toHaveBeenCalledWith(HB_KEYS.help);
  });

  test('GO TO reste sur le clavier principal (une seule occurrence)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
    });
    await flush();
    // RTR double chaque touche (Pressable interne de RN) : ne compter que
    // les nœuds dont le parent n'est PAS lui-même un Pressable.
    const gos = tree.root.findAll((n: any) => n.type && n.type.displayName === 'Pressable')
      .filter((n: any) => n.parent?.type?.displayName !== 'Pressable')
      .filter((n: any) => {
        try {
          return n.findAll((t: any) => t.type === 'Text')
            .some((t: any) => String(t.props.children).trim() === 'GO TO');
        } catch (_) {return false;}
      });
    expect(gos.length).toBe(1);
  });

  test('ordre vertical : voix sous les écrans → aide clavier → arbre → vitesse → focus', async () => {
    await mount();
    const texts = allTexts();
    const idx = (probe: string) => texts.findIndex((s) => s.includes(probe));
    const idxSpeech = idx('Voix');
    const idxHelp = idx('Flèches');
    const idxTree = idx('MENU AUTOSTAR');
    const idxSlew = idx('VITESSE');
    const idxFocus = idx('MISE AU POINT');
    expect(idxSpeech).toBeGreaterThan(-1);
    expect(idxHelp).toBeGreaterThan(idxSpeech);
    expect(idxTree).toBeGreaterThan(idxHelp);
    expect(idxSlew).toBeGreaterThan(idxTree);
    expect(idxFocus).toBeGreaterThan(idxSlew);
  });
});
