/**
 * Tests de régression v1.8.0 — miroir renforcé + GO TO toujours actif.
 *
 * 1. GO TO hors des menus (mode miroir, curseur vide) : re-pointe la
 *    dernière cible définie dans l'app (comportement de la touche GO TO
 *    de la raquette physique). Avant v1.8.0 : simple message, rien.
 * 2. Miroir ALT/AZ : raquette muette en AD/DEC mais bavarde en :Ga#/:Gz#
 *    → l'écran miroir affiche l'horizontale au lieu d'attendre.
 */
import React from 'react';
import {create as createRTR, act} from 'react-test-renderer';

// AsyncStorage : stub mémoire (le preset RN ne le fournit pas).
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {HandboxScreen} from '../src/screens/HandboxScreen';
import {autostar} from '../src/services/protocol/client';
import {LcdPanel} from '../src/components/LcdPanel';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let tree: any;
const uncaught: string[] = [];

async function mount() {
  await act(async () => {
    tree = createRTR(<HandboxScreen />, {
      onUncaughtError: (error: any) => {uncaught.push(String(error?.message));},
    } as any);
    await flush();
  });
}

function pressableWithLabel(label: string) {
  const nodes = tree.root.findAll(
    (n: any) => n.type && n.type.displayName === 'Pressable',
  );
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
  // purge la cible (le store vit sur toute la suite de tests)
  try {useScopeStore.setState({targetRaDeg: null, targetDecDeg: null, targetName: ''});} catch (_) {}
  try {useSettingsStore.getState().setLanguage('fr');} catch (_) {}
});

describe('v1.8.0 — GO TO toujours actif + miroir ALT/AZ', () => {
  test('GO TO en mode miroir re-pointe la dernière cible (autostar.gotoRaDec)', async () => {
    const spy = jest.spyOn(autostar, 'gotoRaDec').mockResolvedValue('ok');
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      useScopeStore.setState({hbSync: 'live' as const});
      // cible définie depuis l'écran Objets ou l'arbre de menus
      s.setTarget(83.633083, -22.0145, 'M42');
    });
    await mount();

    const gotoKey = pressableWithLabel('GO TO');
    expect(gotoKey).toBeTruthy();
    await act(async () => {gotoKey!.props.onPress(); await flush(80);});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(83.633083, -22.0145);
    expect(uncaught).toEqual([]);
  });

  test('GO TO sans cible ni sélection : message, pas d\'appel protocole', async () => {
    const spy = jest.spyOn(autostar, 'gotoRaDec').mockResolvedValue('ok');
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'live' as const});
    });
    await mount();
    const gotoKey = pressableWithLabel('GO TO');
    await act(async () => {gotoKey!.props.onPress(); await flush(80);});
    expect(spy).not.toHaveBeenCalled();
    expect(uncaught).toEqual([]);
  });

  test('Miroir : AD/DEC muettes mais alt/az lues → LCD ALT/AZ (pas d\'attente)', async () => {
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar II', '4Gc', 'autostar2');
      useScopeStore.setState({hbSync: 'live' as const, hasPos: false});
      // :Ga#/:Gz# ont répondu (repli v1.8.0), pas :Gr#/:Gd#
      s.setAltAz(37.2583, 200.5);
    });
    await mount();
    const lcd = tree.root.findByType(LcdPanel);
    expect(String(lcd.props.line1).startsWith('ALT')).toBe(true);
    expect(String(lcd.props.line2).startsWith('AZ')).toBe(true);
    expect(uncaught).toEqual([]);
  });

  test('Miroir : rien lu du tout → écran d\'attente (inchangé)', async () => {
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      useScopeStore.setState({hbSync: 'live' as const, hasPos: false});
      s.setAltAz(null, null);
    });
    await mount();
    const lcd = tree.root.findByType(LcdPanel);
    expect(lcd.props.line1).toBe('SYNCHRO LIVE');
    expect(uncaught).toEqual([]);
  });
});
