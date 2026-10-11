/**
 * Test de reproduction — « l'onglet raquette fait crasher l'appli ».
 * Monte l'écran Raquette complet (v1.7.0) dans différents états du store,
 * appuie sur TOUTES les touches / panneaux, TTS natif présent et absent.
 */
import React from 'react';
import {create as createRTR, act} from 'react-test-renderer';
import {NativeModules} from 'react-native';

// AsyncStorage : stub mémoire (le preset RN ne le fournit pas).
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {HandboxScreen} from '../src/screens/HandboxScreen';
import {useScopeStore} from '../src/store/scopeStore';
import {useSettingsStore} from '../src/store/settingsStore';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** Faux module natif TTS (présent sur l'appareil réel). */
const fakeTts = {
  isAvailable: jest.fn((p: (v: boolean) => void) => p(true)),
  speak: jest.fn((_t: string, _l: string, p: (v: boolean) => void) => p(true)),
  stop: jest.fn((p: (v: boolean) => void) => p(true)),
};

let tree: any;
const uncaught: string[] = [];

async function mount() {
  // un test peut remonter plusieurs fois (pass 1/2/3) : l'arbre précédent
  // DOIT être démonté, sinon ses intervalles (miroir LCD 1 Hz) restent actifs
  // après la fin du fichier et polluent la suite de tests qui suit.
  if (tree) {tree.unmount(); tree = null;}
  await act(async () => {
    tree = createRTR(<HandboxScreen />, {
      onUncaughtError: (error: any, info: any) => {
        uncaught.push(
          `ERREUR NON ATTRAPÉE: ${error?.message}\n    componentStack: ${String(info?.componentStack ?? '').split('\n').slice(0, 8).join(' | ')}`,
        );
      },
    } as any);
    await flush();
  });
}

/** Tous les Pressable de l'arbre rendu. */
function allPressables() {
  return tree.root.findAll((n: any) => n.type && n.type.displayName === 'Pressable');
}

async function pressAllPressables(limit = 200) {
  // Re-trouve les nœuds à CHAQUE itération (l'arbre change après chaque appui).
  for (let i = 0; i < limit; i++) {
    const nodes = allPressables();
    if (i >= nodes.length) break;
    try {
      const props = nodes[i].props;
      const handler = props.onPress ?? props.onPressIn;
      if (typeof handler !== 'function') continue;
      let lab = '';
      try {
        lab = nodes[i].findAll((n: any) => n.type === 'Text').map((t: any) => String(t.props.children)).join('|').slice(0, 40);
      } catch (_) {}
      await act(async () => {
        try {handler(props.onPressIn ? undefined : {nativeEvent: {}});} catch (e) {
          (globalThis as any).__LAST_PRESS_ERROR__ = e;
        }
        await flush(10);
      });
      if (uncaught.length) {
        throw new Error(`CRASH au pressable #${i} [${lab}] →\n${uncaught[0]}`);
      }
    } catch (e) {
      // une exception qui remonte ici = crash réel côté app
      if (String((e as Error).message).includes('CRASH au pressable')) throw e;
      throw new Error(
        `CRASH (throw synchrone) au pressable #${i} : ${(e as Error).message}`,
      );
    }
  }
}

afterEach(() => {
  if (tree) {tree.unmount(); tree = null;}
  try {useScopeStore.getState().disconnect();} catch (_) {}
});

describe('Onglet Raquette (HandboxScreen) — crash repro', () => {
  test('monte en état par défaut (déconnecté, fr, autostar2)', async () => {
    await mount();
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
  });

  test('monte en anglais (persisté)', async () => {
    act(() => useSettingsStore.getState().setLanguage('en'));
    await mount();
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
    act(() => useSettingsStore.getState().setLanguage('fr'));
  });

  test('monte connecté + synchro live + position', async () => {
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      s.setPosition(83.633083, 22.0145);
      useScopeStore.setState({hbSync: 'live' as const, hasPos: true});
    });
    await mount();
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
  });

  test('connecté + live + mouvement externe + slew rapide', async () => {
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar II', '4Gc', 'autostar2');
      s.setPosition(83.633083, 22.0145);
      useScopeStore.setState({
        hbSync: 'live' as const, hasPos: true, hbExternal: true,
        hbDirs: {n: true, s: false, e: false, w: false},
        hbSlewFast: true, hbMoving: true,
      });
    });
    await mount();
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
  });

  test('firmware inconnu (produit non reconnu → fallback modèle réglé)', async () => {
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('SuperScope 3000', '1.0', null);
    });
    await mount();
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
  });

  test('TOUTES les touches, déconnecté puis connecté+live (TTS natif présent)', async () => {
    (NativeModules as any).NativeTts = fakeTts;
    act(() => useSettingsStore.getState().setKeySounds(true));
    act(() => useSettingsStore.getState().setSpeech(true));

    // Pass 1 : déconnecté
    await mount();
    await pressAllPressables();

    // Pass 2 : connecté + synchro live
    act(() => {
      const s = useScopeStore.getState();
      s.setConnStatus('connected');
      s.setFirmware('Autostar #497', '43Gc', 'autostar497');
      s.setPosition(83.633083, 22.0145);
      useScopeStore.setState({hbSync: 'live' as const, hasPos: true});
    });
    await mount();
    await pressAllPressables();

    // Pass 3 : arbre des menus OUVERT (tous les appuis dans l'arbre)
    await mount();
    const txt = tree.root.findAll(
      (n: any) => n.type === 'Text' && String(n.props.children).includes('AUTOSTAR'),
    );
    if (txt.length) {
      let node: any = txt[0];
      while (node && node.type?.displayName !== 'Pressable') node = node.parent;
      if (node) {
        await act(async () => {node.props.onPress(); await flush(30);});
        await pressAllPressables(400);
      }
    }
  }, 60000);
});
