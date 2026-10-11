/**
 * Tests de régression v2.1.1 — BOUTON « POSITION HOME » (alignement télémétrique).
 *
 * Demande utilisateur : « Pour l'alignement télémétrique, je veux un bouton
 * pour aligner la position home et enregistrer la télémétrie correspondante
 * afin d'améliorer la précision. »
 *
 * Contrats verrouillés ici :
 *   1. homeGeometry : polaire → pôle (hauteur = |latitude|, az 0° nord /
 *      180° sud) ; Alt-Az → tube horizontal vers le nord (austral : sud) ;
 *   2. setHomePoint : le point Home est enregistré UNE SEULE FOIS — un
 *      nouvel enregistrement REMPLACE l'ancien (revalidation à chaque
 *      session) sans toucher aux points « étoiles » ;
 *   3. le point Home participe au recalage (fitTelemetry) comme les autres.
 */
import {homeGeometry} from '../src/services/astro/telemetry';
import {fitTelemetry, type Quat} from '../src/services/astro/telemetry';
import {useTelemetryStore, telemetryFitOf, type TelemetryPoint} from '../src/store/telemetryStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

describe('v2.1.1 — géométrie de la position Home', () => {
  test('mode polaire, hémisphère nord : tube vers le pôle (alt = lat, az 0°)', () => {
    const g = homeGeometry('polar', 48.85);
    expect(g.polar).toBe(true);
    expect(g.altDeg).toBeCloseTo(48.85, 6);
    expect(g.azDeg).toBe(0);
  });

  test('mode polaire, hémisphère austral : pôle sud (az 180°)', () => {
    const g = homeGeometry('polar', -33.9);
    expect(g.polar).toBe(true);
    expect(g.altDeg).toBeCloseTo(33.9, 6);
    expect(g.azDeg).toBe(180);
  });

  test('mode Alt-Az : tube HORIZONTAL vers le nord (hémisphère nord)', () => {
    const g = homeGeometry('altaz', 48.85);
    expect(g.polar).toBe(false);
    expect(g.altDeg).toBe(0);
    expect(g.azDeg).toBe(0);
  });

  test('mode Alt-Az hémisphère austral : horizontal vers le sud', () => {
    const g = homeGeometry('altaz', -22.0);
    expect(g.polar).toBe(false);
    expect(g.altDeg).toBe(0);
    expect(g.azDeg).toBe(180);
  });

  test('modes « unknown » et « land » : comportement Alt-Az (position facile Meade)', () => {
    expect(homeGeometry('unknown', 48.85).polar).toBe(false);
    expect(homeGeometry('unknown', 48.85).altDeg).toBe(0);
    expect(homeGeometry('land', 48.85).polar).toBe(false);
  });
});

const Q: Quat = {w: 0.7071, x: 0, y: 0, z: 0.7071};

function fakePoint(name: string): Omit<TelemetryPoint, 'id' | 'ts'> {
  return {name, raDeg: 83.63, decDeg: 22.01, altDeg: 45, azDeg: 120, quat: Q};
}

describe('v2.1.1 — setHomePoint : une seule référence Home, toujours la plus récente', () => {
  beforeEach(() => {
    useTelemetryStore.getState().clearPoints();
  });
  afterEach(() => {
    useTelemetryStore.getState().clearPoints();
  });

  test('le point Home est marqué et isolated dans la liste', () => {
    useTelemetryStore.getState().addPoint(fakePoint('Vega'));
    useTelemetryStore.getState().setHomePoint({...fakePoint('Position Home'), altDeg: 0, azDeg: 0});
    const pts = useTelemetryStore.getState().points;
    expect(pts.length).toBe(2);
    const homes = pts.filter((p) => p.home);
    expect(homes.length).toBe(1);
    expect(homes[0].name).toBe('Position Home');
    expect(homes[0].altDeg).toBe(0);
    expect(homes[0].id.startsWith('H')).toBe(true);
  });

  test('revalider la Home REMPLACE l\u2019ancienne (jamais de doublon)', () => {
    useTelemetryStore.getState().setHomePoint({...fakePoint('Home 1'), altDeg: 0, azDeg: 0});
    const first = useTelemetryStore.getState().points.find((p) => p.home)!;
    useTelemetryStore.getState().setHomePoint({...fakePoint('Home 2'), altDeg: 48.85, azDeg: 0});
    const pts = useTelemetryStore.getState().points;
    const homes = pts.filter((p) => p.home);
    expect(homes.length).toBe(1);
    expect(homes[0].name).toBe('Home 2');
    expect(homes[0].id).not.toBe(first.id);
    expect(homes[0].altDeg).toBeCloseTo(48.85, 6);
  });

  test('les points « étoiles » survivent au remplacement de la Home', () => {
    useTelemetryStore.getState().addPoint(fakePoint('Vega'));
    useTelemetryStore.getState().addPoint(fakePoint('Arcturus'));
    useTelemetryStore.getState().setHomePoint(fakePoint('Home 1'));
    useTelemetryStore.getState().setHomePoint(fakePoint('Home 2'));
    const pts = useTelemetryStore.getState().points;
    expect(pts.length).toBe(3); // Vega + Arcturus + Home 2 (Home 1 remplacée)
    expect(pts.filter((p) => !p.home).map((p) => p.name).sort()).toEqual(['Arcturus', 'Vega']);
  });

  test('le point Home alimente le recalage comme un point ordinaire', () => {
    useTelemetryStore.getState().setHomePoint({...fakePoint('Position Home'), altDeg: 30, azDeg: 0});
    const pts = useTelemetryStore.getState().points;
    const fit = telemetryFitOf(pts);
    expect(fit).not.toBeNull();
    // 1 seul point : l'axe optique est résolu, RMS nul par construction
    expect(fit!.rmsDeg).toBeLessThan(1e-6);
  });

  test('fitTelemetry accepte un point Home + étoiles (formulaire inchangé)', () => {
    const fit = fitTelemetry([
      {quat: Q, altDeg: 0, azDeg: 0},
      {quat: {w: 0.5, x: 0.5, y: 0.5, z: 0.5}, altDeg: 45, azDeg: 90},
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.rmsDeg).toBeGreaterThanOrEqual(0);
  });
});
