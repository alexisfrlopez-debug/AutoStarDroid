/**
 * Test de rendu v2.5.0 — ÉCRAN CAMÉRA (politique anti-crash v1.7.1 : aucun
 * onglet ne doit pouvoir planter). Sans module natif caméra (jest), tout
 * doit être gracieux : liste vide, message, boutons présents, aucune
 * exception. Vérifie aussi le contrat de survie : AUCUNE fonction JS ne
 * traverse le pont natif (le service astroCamera est 100 % Promise).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import React from 'react';
import {create as createRTR} from 'react-test-renderer';
import {Text} from 'react-native';

import {CameraScreen} from '../src/screens/CameraScreen';
import {astroCamera} from '../src/services/phone/astroCamera';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('Écran Caméra (v2.5.0)', () => {
  it('se monte sans module natif : message + boutons, aucune exception', async () => {
    const uncaught: string[] = [];
    const tree = await createRTR(<CameraScreen />, {
      onUncaughtError: (e: any) => uncaught.push(String(e?.message)),
    } as any);
    await flush(120);
    const texts: string[] = [];
    tree.root.findAllByType(Text).forEach((n: any) => texts.push(String(n.props.children ?? '')));
    const all = texts.join(' | ');
    expect(all).toContain('Caméra astronomique');
    expect(all).toContain('Rafraîchir');
    expect(all).toContain('Suivi par l\'image (autoguidage)');
    expect(all).toContain('Acquisition automatique');
    expect(all).toContain('Lune');
    expect(all).toContain('Soleil ☀︎');
    expect(uncaught).toEqual([]);
    tree.unmount();
  });

  it('contrat de survie Hermes : toutes les méthodes natives sont Promise (pas de callback)', () => {
    // Sans module natif, le service doit se replier silencieusement
    expect(astroCamera.listCameras()).resolves.toEqual([]);
    expect(astroCamera.lumaHistory()).resolves.toEqual([]);
    expect(astroCamera.isStreaming()).resolves.toBe(false);
    // onFrame sans module : retrait inoffensif
    const rel = astroCamera.onFrame(() => undefined);
    expect(typeof rel).toBe('function');
    rel();
  });
});
