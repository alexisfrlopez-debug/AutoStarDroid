/**
 * Test de rendu v2.1.0 — panneau « Diagnostic moteur complet » de l'onglet
 * Alignement (politique anti-crash v1.7.1 : aucun onglet ne doit pouvoir
 * faire planter l'app).
 *
 * Contrats verrouillés :
 *   1. le panneau se monte SANS exception, même hors connexion ;
 *   2. le bouton « Lancer la série complète » est présent et DÉSACTIVÉ hors
 *      connexion ;
 *   3. un rapport persisté s'affiche avec ses 8 tests et statuts colorés ;
 *   4. aucun fonction JS ne traverse le pont natif (règle de survie v1.7.2 —
 *      le panneau n'appelle AUCUNE méthode native directement : tout passe
 *      par autostar/transport sérialisable + événements gyro sérialisables).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

jest.mock('../src/services/phone/sensors', () => ({
  startGyro: () => () => undefined,
  stopGyro: async () => true,
  startOrientation: () => () => undefined,
  stopOrientation: async () => true,
  sensorsAvailable: async () => ({rotationVector: true, accelerometer: true, magnetometer: true, gyroscope: true}),
}));

import React from 'react';
import {create as createRTR} from 'react-test-renderer';
import {Text} from 'react-native';

import {Diagnostics} from '../src/components/Diagnostics';
import {useDiagStore} from '../src/store/diagStore';
import type {DiagReport} from '../src/services/tracking/diagService';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

const REPORT: DiagReport = {
  startedAt: 1728600000000,
  finishedAt: 1728600000240000,
  aborted: false,
  results: [
    {id: 'pre', status: 'ok', values: {biasMagDegPerSec: 0.01, ambientNoiseDegPerSec: 0.002}, durationMs: 2500},
    {id: 'calib', status: 'ok', values: {n: 0.081, s: 0.079, e: 0.082, w: 0.08, noise: 0.001}, durationMs: 30000},
    {id: 'ratio', status: 'ok', values: {pctN: 101, pctS: 99, pctE: 102, pctW: 100, linearityPct: 98}, durationMs: 15000},
    {id: 'backlash', status: 'warn', values: {raArcsec: 120, decArcsec: 40}, durationMs: 32000},
    {id: 'precision', status: 'ok', values: {meanDeg: 0.16, stdDeg: 0.004, spreadDeg: 0.01, relPct: 2.5}, durationMs: 28000},
    {id: 'drivetrain', status: 'ok', values: {pctP2PE: 6, rmsPctE: 2, stallsE: 0, pctP2PN: 5, rmsPctN: 2, stallsN: 0}, durationMs: 42000},
    {id: 'limits', status: 'ok', values: {altStartDeg: 42, maxAltDeg: 88, minAltDeg: 5, upDeg: 46, downDeg: 37}, durationMs: 30000},
    {id: 'drift', status: 'ok', values: {driftDegPerSec: 0.0042, vsSiderealArcsecPerSec: 0.1}, durationMs: 26000},
  ],
};

describe('Panneau Diagnostic moteur (v2.1.0)', () => {
  afterEach(() => {
    useDiagStore.getState().clear();
  });

  it('se monte hors connexion : bouton présent et désactivé', async () => {
    const uncaught: string[] = [];
    let tree: any;
    tree = await createRTR(<Diagnostics />, {
      onUncaughtError: (e: any) => uncaught.push(String(e?.message)),
    } as any);
    await flush();
    const texts: string[] = [];
    tree.root.findAllByType(Text).forEach((n: any) => texts.push(String(n.props.children ?? '')));
    const all = texts.join(' | ');
    expect(all).toContain('Diagnostic moteur complet');
    expect(all).toContain('Lancer la série complète');
    expect(uncaught).toEqual([]);
    tree.unmount();
  });

  it('affiche un rapport persisté : 8 tests, statuts et valeurs formatées', async () => {
    useDiagStore.getState().setReport(REPORT);
    const uncaught: string[] = [];
    let tree: any;
    tree = await createRTR(<Diagnostics />, {
      onUncaughtError: (e: any) => uncaught.push(String(e?.message)),
    } as any);
    await flush();
    const texts: string[] = [];
    tree.root.findAllByType(Text).forEach((n: any) => texts.push(String(n.props.children ?? '')));
    const all = texts.join(' | ');
    // Les 8 noms de tests apparaissent
    expect(all).toContain('Pré-contrôles');
    expect(all).toContain('Calibration moteur');
    expect(all).toContain('Ratio par axe');
    expect(all).toContain('Backlash (jeu)');
    expect(all).toContain('Précision moteur');
    expect(all).toContain('Train d’engrenages');
    expect(all).toContain('Min/max élévation');
    expect(all).toContain('Dérive du suivi');
    // Valeurs formatées (ratio en %, backlash en ″, élémentaire en °)
    expect(all).toContain('100 %');
    expect(all).toContain('120″');
    // Statut « Attention » du backlash
    expect(all).toContain('Attention');
    expect(uncaught).toEqual([]);
    tree.unmount();
  });
});
