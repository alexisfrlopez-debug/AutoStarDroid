/**
 * Test de régression — « l'onglet raquette fait crasher l'appli » (v1.7.0/v1.7.1).
 *
 * CAUSE (crash.log du Drive, Blackview XPLORE 1 / Android 15) :
 *   com.facebook.react.common.JavascriptException:
 *   Error: JS Functions are not convertible to dynamic, js engine: hermes
 * tts.ts passait des CALLBACKS JS à des méthodes natives déclarées avec un
 * paramètre Promise. Dans le bridge Hermes, TOUT le tableau d'arguments est
 * sérialisé côté C++ (ReactCommon/jsi/jsi/JSIDynamic.cpp) AVANT le filtrage
 * Java : une fonction, même à une position non consommée, lève une erreur
 * FATALE sur mqt_native_modules — non rattrapable par try/catch JS.
 * À l'ouverture de l'onglet Raquette, l'effet voix (speech=false par défaut)
 * appelait tts.stop() → crash immédiat.
 *
 * GARDE-FOU : le mock ci-dessous a la VRAIE signature native (Promise). Tout
 * argument de type function transmis à NativeTts = régression = test rouge.
 */
import React from 'react';
import {NativeModules} from 'react-native';
import {create as createRTR, act} from 'react-test-renderer';

// AsyncStorage : stub mémoire (le preset RN ne le fournit pas).
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

/** Espion natif — VRAIE signature de TtsModule.kt (Promise, zéro callback). */
const nativeTts = {
  isAvailable: jest.fn(async () => true),
  speak: jest.fn(async (_text: string, _locale: string) => true),
  stop: jest.fn(async () => true),
};

/** Aucune fonction ne doit JAMAIS atteindre le module natif (crash JSIDynamic). */
function assertNoFunctionArgs() {
  const mod = NativeModules.NativeTts as any;
  for (const name of ['isAvailable', 'speak', 'stop'] as const) {
    for (const call of mod[name].mock.calls) {
      for (const arg of call) {
        if (typeof arg === 'function') {
          throw new Error(
            `RÉGRESSION : une fonction a été passée à NativeTts.${name} ` +
              `→ crash « JS Functions are not convertible to dynamic » garanti ` +
              `sur appareil (voir JSIDynamic.cpp).`,
          );
        }
      }
    }
  }
}

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// react + react-native + react-test-renderer : imports statiques (même registre).
// Code APPLICATIF : chargé APRÈS le patch de NativeModules — tts.ts capture
// NativeModules.NativeTts à l'import, le patch doit donc précéder ce require.
(NativeModules as any).NativeTts = nativeTts;
const {tts} = require('../src/services/phone/tts');
const {HandboxScreen} = require('../src/screens/HandboxScreen');
const {useScopeStore} = require('../src/store/scopeStore');
const {useSettingsStore} = require('../src/store/settingsStore');

let tree: any;

afterEach(() => {
  if (tree) {tree.unmount(); tree = null;}
  try {useScopeStore.getState().disconnect();} catch (_) {}
  try {useSettingsStore.getState().setSpeech(false);} catch (_) {}
  try {useSettingsStore.getState().setLanguage('fr');} catch (_) {}
  nativeTts.isAvailable.mockClear();
  nativeTts.speak.mockClear();
  nativeTts.stop.mockClear();
});

describe('tts.ts — discipline d\u2019arguments natifs (régression crash raquette)', () => {
  test('tts.isAvailable() : appel Promise pur, aucune fonction au natif', async () => {
    let ok = false;
    await act(async () => {ok = await tts.isAvailable();});
    expect(ok).toBe(true);
    expect(nativeTts.isAvailable).toHaveBeenCalledTimes(1);
    assertNoFunctionArgs();
  });

  test('tts.speak() : (texte, locale) uniquement, aucune fonction au natif', async () => {
    await act(async () => {await tts.speak('MENU OBJET', 'fr');});
    expect(nativeTts.speak).toHaveBeenCalledWith('MENU OBJET', 'fr-FR');
    await act(async () => {await tts.speak('SPEED', 'en');});
    expect(nativeTts.speak).toHaveBeenLastCalledWith('SPEED', 'en-US');
    assertNoFunctionArgs();
  });

  test('tts.speak() : texte tronqué à 200 caractères (garde API)', async () => {
    const long = 'A'.repeat(300);
    await act(async () => {await tts.speak(long, 'fr');});
    const last = nativeTts.speak.mock.calls.at(-1) as any[];
    expect(String(last[0]).length).toBeLessThanOrEqual(200);
    expect(last[1]).toBe('fr-FR');
    assertNoFunctionArgs();
  });

  test('tts.stop() : aucun argument, aucune fonction au natif', async () => {
    await act(async () => {await tts.stop();});
    expect(nativeTts.stop).toHaveBeenCalledTimes(1);
    expect(nativeTts.stop.mock.calls[0].length).toBe(0);
    assertNoFunctionArgs();
  });

  test('MONTAGE onglet Raquette (speech off) — le chemin exact du crash v1.7.0', async () => {
    // Au montage, l'effet voix exécute tts.stop() (speech=false par défaut).
    // Avant correction : Tts.stop(() => res()) → fonction au natif → crash.
    await act(async () => {
      tree = createRTR(<HandboxScreen />);
      await flush(120);
    });
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
    expect(nativeTts.stop).toHaveBeenCalled();
    assertNoFunctionArgs();
  });

  test('Montage avec voix active — énoncé du LCD sans fonction au natif', async () => {
    act(() => useSettingsStore.getState().setSpeech(true));
    await act(async () => {
      tree = createRTR(<HandboxScreen />);
      await flush(800); // dépasse le délai anti-répétition de 500 ms
    });
    expect(tree.root.findByType(HandboxScreen)).toBeTruthy();
    // speak peut ne pas partir si l'écran par défaut est vide ; stop ne doit
    // PAS être appelé (voix active). Dans tous les cas : zéro fonction.
    assertNoFunctionArgs();
  });
});
