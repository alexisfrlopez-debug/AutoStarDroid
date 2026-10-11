/**
 * Tests de régression v2.1.1 — LCD MIROIR : FIN du menu simulé.
 *
 * Demande utilisateur : « quand "miroir lcd" n'est pas activé, l'affichage
 * lcd affiche un menu simulé qui n'est pas synchro avec la raquette. je ne
 * veux pas de ce menu simulé qui porte à confusion. »
 *
 * Contrats verrouillés ici :
 *   1. hors connexion, au repos → écran NEUTRE « MIROIR LCD OFF / HORS
 *      LIGNE » — jamais le faux « Select Item » (menu simulé) ;
 *   2. connecté + synchro coupée, au repos → « MIROIR LCD OFF / SYNCHRO
 *      OFF » — pas de menu simulé non plus ;
 *   3. connecté + synchro live sans données → « SYNCHRO LIVE » (inchangé) ;
 *   4. la navigation locale reste possible : pendant l'appui (< 5 s) un
 *      APERÇU temporaire des menus s'affiche, puis retour à l'écran neutre.
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

function mirrorLcd() {
  return tree.root.findAllByType(LcdPanel)[0];
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

afterEach(() => {
  if (tree) {tree.unmount(); tree = null;}
  jest.restoreAllMocks();
  try {useScopeStore.getState().disconnect();} catch (_) {}
  try {useScopeStore.getState().clearLcdMirror();} catch (_) {}
  try {useSettingsStore.getState().setLanguage('fr');} catch (_) {}
});

describe('v2.1.1 — plus de menu simulé sur le LCD miroir', () => {
  test('hors connexion, au repos : « MIROIR LCD OFF / HORS LIGNE » (pas de menu simulé)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('disconnected');
      useScopeStore.setState({hbSync: 'off' as const});
    });
    await flush();

    const lcd = mirrorLcd();
    expect(String(lcd.props.line1)).toBe('MIROIR LCD OFF');
    expect(String(lcd.props.line2)).toBe('HORS LIGNE');
    expect(String(lcd.props.line1) + String(lcd.props.line2)).not.toContain('Select Item');
    expect(uncaught).toEqual([]);
  });

  test('connecté + synchro coupée, au repos : « MIROIR LCD OFF / SYNCHRO OFF »', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'off' as const});
    });
    await flush();

    const lcd = mirrorLcd();
    expect(String(lcd.props.line1)).toBe('MIROIR LCD OFF');
    expect(String(lcd.props.line2)).toBe('SYNCHRO OFF');
    expect(String(lcd.props.line1) + String(lcd.props.line2)).not.toContain('Select Item');
    expect(uncaught).toEqual([]);
  });

  test('synchro live sans données : écran d\u2019attente « SYNCHRO LIVE » (inchangé)', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'live' as const, hasPos: false});
      s.setAltAz(null, null);
    });
    await flush();

    const lcd = mirrorLcd();
    expect(lcd.props.line1).toBe('SYNCHRO LIVE');
    expect(uncaught).toEqual([]);
  });

  test('navigation locale : aperçu PENDANT l\u2019appui, retour à l\u2019écran neutre après 5 s', async () => {
    await mount();
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'off' as const});
    });
    await flush();

    // avant tout appui : écran neutre
    expect(String(mirrorLcd().props.line1)).toBe('MIROIR LCD OFF');

    // appui ENTER (hors miroir : navigation locale) → aperçu temporaire
    const enter = pressableWithLabel('ENTER');
    expect(enter).toBeTruthy();
    await act(async () => {enter.props.onPress(); await flush(30);});
    expect(String(mirrorLcd().props.line1)).toContain('Select Item');

    // 5 s sans touche (MIRROR_RETURN_MS) → écran neutre de nouveau
    await act(async () => {await flush(5300);});
    expect(String(mirrorLcd().props.line1)).toBe('MIROIR LCD OFF');
    expect(String(mirrorLcd().props.line2)).toBe('SYNCHRO OFF');
    expect(uncaught).toEqual([]);
  }, 15000);
});
