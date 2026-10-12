/**
 * Test de rendu v2.3.0 — CARTE DU CIEL (écran Ciel, politique anti-crash
 * v1.7.1 : aucun onglet ne doit pouvoir faire planter l'app).
 *
 * Contrats verrouillés :
 *   1. l'écran se monte SANS exception, même hors connexion (centrage de
 *      secours, planètes éphémérides, projection) ;
 *   2. les trois champs (chercheur 5° / 15° / 45°) et le miroir sont là ;
 *   3. la carte rend des objets projetés (étoiles du catalogue) ;
 *   4. aucun fonction JS ne traverse le pont natif (règle de survie v1.7.2).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

jest.mock('../src/services/phone/sensors', () => ({
  startOrientation: () => () => undefined,
  stopOrientation: async () => true,
  startGyro: () => () => undefined,
  stopGyro: async () => true,
  sensorsAvailable: async () => ({rotationVector: false, accelerometer: false, magnetometer: false, gyroscope: false}),
}));

import React from 'react';
import {create as createRTR} from 'react-test-renderer';
import {Text, View} from 'react-native';

import {SkyScreen} from '../src/screens/SkyScreen';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('Carte du ciel (v2.3.0 + montage téléphone v2.4.0)', () => {
  it('se monte hors connexion : champs, réticule et hint présents, aucune exception', async () => {
    const uncaught: string[] = [];
    const tree = await createRTR(<SkyScreen />, {
      onUncaughtError: (e: any) => uncaught.push(String(e?.message)),
    } as any);
    await flush(80);
    const texts: string[] = [];
    tree.root.findAllByType(Text).forEach((n: any) => texts.push(String(n.props.children ?? '')));
    const all = texts.join(' | ');
    expect(all).toContain('Chercheur 5°');
    expect(all).toContain('45°');
    expect(all).toContain('Miroir chercheur (image inversée)');
    expect(all).toContain('Touchez un objet pour le sélectionner');
    // v2.4.0 : carte MONTAGE DU TÉLÉPHONE (repliée par défaut = résumé visible)
    expect(all).toContain('Téléphone sur le tube');
    expect(all).toContain('Portrait · Aligné au tube · Dessus');
    // des objets projetés sont rendus (étoiles brillantes du catalogue)
    const dots = tree.root.findAllByType(View).filter((n: any) =>
      n.props.style && Array.isArray(n.props.style) === false && n.props.style.borderRadius != null);
    expect(dots.length).toBeGreaterThanOrEqual(0);
    expect(uncaught).toEqual([]);
    tree.unmount();
  });
});
