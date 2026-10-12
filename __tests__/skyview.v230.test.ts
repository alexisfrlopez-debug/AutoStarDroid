/**
 * Tests v2.3.0 — CARTE DU CIEL (services/astro/skyview.ts) : projection
 * gnomonique, conventions d'orientation (est à gauche face au sud, comme
 * l'œil), réticule chercheur, pan manuel, miroir optique.
 */
import {
  projectView,
  fovCircleRadiusPx,
  panCenter,
  altAzToENU,
  type ViewGeometry,
} from '../src/services/astro/skyview';

const GEOM: ViewGeometry = {
  centerAltDeg: 30,
  centerAzDeg: 180, // face au sud
  fovDeg: 5,
  width: 320,
  height: 320,
  mirror: false,
};

describe('altAzToENU', () => {
  it('zénith → (0,0,1) ; horizon nord → (0,1,0) ; horizon est → (1,0,0)', () => {
    const z = altAzToENU(90, 0);
    expect(z[2]).toBeCloseTo(1, 9);
    const n = altAzToENU(0, 0);
    expect(n[1]).toBeCloseTo(1, 9);
    const e = altAzToENU(0, 90);
    expect(e[0]).toBeCloseTo(1, 9);
  });
});

describe('projectView — gnomonique', () => {
  it('le centre de vue tombe au centre de l\u2019écran', () => {
    const [p] = projectView([{altDeg: 30, azDeg: 180}], GEOM);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(160, 6);
    expect(p.y).toBeCloseTo(160, 6);
  });
  it('face au sud : l\u2019EST (az 90 < 180) est à GAUCHE, l\u2019OUEST à droite', () => {
    const east = projectView([{altDeg: 30, azDeg: 176}], GEOM)[0];  // az plus petit → est
    const west = projectView([{altDeg: 30, azDeg: 184}], GEOM)[0];  // az plus grand → ouest
    expect(east.x).toBeLessThan(160);
    expect(west.x).toBeGreaterThan(160);
  });
  it('le HAUT de l\u2019écran = plus haute altitude', () => {
    const up = projectView([{altDeg: 32, azDeg: 180}], GEOM)[0];
    expect(up.y).toBeLessThan(160);
  });
  it('échelle : 1° d’azimut à 30° de hauteur ≈ tan(1°·cos30°)/tan(2,5°) × demi-écran', () => {
    const [p] = projectView([{altDeg: 30, azDeg: 181}], GEOM);
    const expected = (Math.tan(1 * Math.PI / 180) * Math.cos(30 * Math.PI / 180)) / Math.tan(2.5 * Math.PI / 180) * 160;
    expect(p.x - 160).toBeCloseTo(expected, 2);
  });
  it('objet à 90° du centre (plan tangent dépassé) → invisible', () => {
    // (0°, 90°) est exactement à 90° de (30°, 180°) : cos sep = 0
    const p = projectView([{altDeg: 0, azDeg: 90}], GEOM)[0];
    expect(p.visible).toBe(false);
  });
  it('miroir chercheur : l\u2019image est inversée horizontalement', () => {
    const p = projectView([{altDeg: 30, azDeg: 176}], {...GEOM, mirror: true})[0];
    expect(p.x).toBeGreaterThan(160); // l'est passe à droite
  });
  it('champ large : le même objet reste à la même DIRECTION mais échelle différente', () => {
    const wide: ViewGeometry = {...GEOM, fovDeg: 45};
    const a = projectView([{altDeg: 32, azDeg: 180}], GEOM)[0];
    const b = projectView([{altDeg: 32, azDeg: 180}], wide)[0];
    expect(b.y).toBeLessThan(160);
    expect(Math.abs(b.y - 160)).toBeLessThan(Math.abs(a.y - 160)); // plus près du centre
  });
});

describe('fovCircleRadiusPx — réticule chercheur', () => {
  it('le cercle 5° remplit la vue quand fov = 5° (rayon ≈ demi-écran)', () => {
    expect(fovCircleRadiusPx(5, GEOM)).toBeCloseTo(160, 4);
  });
  it('dézoomé à 45°, le cercle 5° est petit', () => {
    const r = fovCircleRadiusPx(5, {...GEOM, fovDeg: 45});
    expect(r).toBeLessThan(30);
    expect(r).toBeGreaterThan(0);
  });
});

describe('panCenter — pan manuel', () => {
  it('glisser à droite déplace le centre vers l\u2019est (azimut décroissant face au sud)', () => {
    const nc = panCenter(30, 180, 40, 0, {fovDeg: 5, width: 320, height: 320});
    expect(nc.azDeg).toBeLessThan(180);
    expect(nc.azDeg).toBeGreaterThan(170); // pan raisonnable
  });
  it('glisser vers le bas monte le regard (altitude croissante)', () => {
    const nc = panCenter(30, 180, 0, 40, {fovDeg: 5, width: 320, height: 320});
    expect(nc.altDeg).toBeGreaterThan(30);
  });
  it('l\u2019altitude est bornée 1..89, l\u2019azimut modulo 360', () => {
    expect(panCenter(88.5, 359, 0, 400, {fovDeg: 5, width: 320, height: 320}).altDeg).toBe(89);
    expect(panCenter(2, 1, 400, 0, {fovDeg: 5, width: 320, height: 320}).azDeg).toBeGreaterThan(350);
  });
});
