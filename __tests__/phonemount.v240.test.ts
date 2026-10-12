/**
 * Tests v2.4.0 — MONTAGE DU TÉLÉPHONE SUR LE TUBE (astro/phonemount.ts).
 *
 * Demande utilisateur : « les options d'installation du téléphone sur le
 * tube : Portrait/paysage, téléphone aligné au tube, à 45° du tube (sur
 * oculaire avec prisme) ou 90° (sur oculaire en bout de tube) et position
 * du téléphone sur le tube (au dessus ou côté gauche/droit) ».
 *
 * Méthode : chaque configuration de montage correspond à une POSE physique
 * du téléphone (axes X/Y/Z du téléphone exprimés dans le monde ENU) pour
 * un télescope pointant le SUD à l'horizon. Le test construit le
 * quaternion Android équivalent (rotation vector : v_monde = R(q)·v_tel)
 * puis vérifie que tubeAltAzFromOrientation RESTAURE alt = 0° / az = 180°
 * — c'est-à-dire que la visée du tube est correctement retrouvée quel que
 * soit le montage déclaré.
 */
import {
  mountViewVector, tubeAltAzFromOrientation, DEFAULT_MOUNT, isDefaultMount,
  type PhoneMountConfig,
} from '../src/services/astro/phonemount';
import {quatToMat} from '../src/services/astro/telemetry';
import type {Orientation} from '../src/services/phone/sensors';

const SQ = Math.SQRT1_2;

/** Rotation matrix (row-major) dont les COLONNES sont les axes du
 *  téléphone exprimés dans le monde (convention Android getRotationMatrix). */
function matFromAxes(
  X: [number, number, number],
  Y: [number, number, number],
  Z: [number, number, number],
): number[] {
  return [X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]];
}

/** Quaternion (w,x,y,z) d'une matrice de rotation (Shepperd, avec branche
 *  ~180° stable — les poses de test incluent des rotations à 180°). */
function quatFromMat(m: number[]): {w: number; x: number; y: number; z: number} {
  const tr = m[0] + m[4] + m[8];
  let w = 0, x = 0, y = 0, z = 0;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    w = S / 4;
    x = (m[7] - m[5]) / S;
    y = (m[2] - m[6]) / S;
    z = (m[3] - m[1]) / S;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const S = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / S; x = S / 4; y = (m[1] + m[3]) / S; z = (m[2] + m[6]) / S;
  } else if (m[4] > m[8]) {
    const S = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / S; x = (m[1] + m[3]) / S; y = S / 4; z = (m[5] + m[7]) / S;
  } else {
    const S = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / S; x = (m[2] + m[6]) / S; y = (m[5] + m[7]) / S; z = S / 4;
  }
  return {w, x, y, z};
}

/** Orientation synthétique : pose = axes du téléphone dans le monde (télé-
 *  scope visant le SUD à l'horizon), avec ou sans quaternion (repli Euler). */
function makeOrientation(
  axes: {X: [number, number, number]; Y: [number, number, number]; Z: [number, number, number]} | null,
  euler?: {azimuthDeg: number; pitchDeg: number},
): Orientation {
  if (!axes) {
    return {
      azimuthDeg: euler?.azimuthDeg ?? 0,
      pitchDeg: euler?.pitchDeg ?? 0,
      rollDeg: 0,
      accuracy: 3,
    };
  }
  const q = quatFromMat(matFromAxes(axes.X, axes.Y, axes.Z));
  return {
    azimuthDeg: 0, pitchDeg: 0, rollDeg: 0, accuracy: 3,
    qw: q.w, qx: q.x, qy: q.y, qz: q.z,
  };
}

// Axes usuels (monde ENU) pour un télescope visant le SUD à l'horizon.
const E: [number, number, number] = [1, 0, 0];
const W: [number, number, number] = [-1, 0, 0];
const N: [number, number, number] = [0, 1, 0];
const S: [number, number, number] = [0, -1, 0];
const U: [number, number, number] = [0, 0, 1];
const D: [number, number, number] = [0, 0, -1];

/** La visée restaurée doit être le sud à l'horizon (alt≈0, az≈180). */
function expectSouth(o: Orientation, cfg: PhoneMountConfig, declDeg = 0) {
  const r = tubeAltAzFromOrientation(o, cfg, declDeg);
  expect(r).not.toBeNull();
  expect(r!.altDeg).toBeCloseTo(0, 1);
  expect(r!.azDeg).toBeCloseTo(180, 1);
}

describe('Vecteur de visée du tube (table complète des 12 combinaisons)', () => {
  it('angle 0° (aligné au tube) — la position change la visée', () => {
    expect(mountViewVector({pose: 'portrait', angle: 0, position: 'top'})).toEqual([0, 1, 0]);
    expect(mountViewVector({pose: 'landscape', angle: 0, position: 'top'})).toEqual([1, 0, 0]);
    // Sur une tranche : debout (portrait) = bord supérieur en haut
    expect(mountViewVector({pose: 'portrait', angle: 0, position: 'left'})).toEqual([-1, 0, 0]);
    expect(mountViewVector({pose: 'portrait', angle: 0, position: 'right'})).toEqual([1, 0, 0]);
    // Couché (paysage) = bord supérieur vers l'avant, des deux côtés
    expect(mountViewVector({pose: 'landscape', angle: 0, position: 'left'})).toEqual([0, 1, 0]);
    expect(mountViewVector({pose: 'landscape', angle: 0, position: 'right'})).toEqual([0, 1, 0]);
  });

  it('angle 45° (oculaire + prisme) — dos du téléphone contre l\'oculaire', () => {
    expect(mountViewVector({pose: 'portrait', angle: 45, position: 'top'})).toEqual([0, SQ, SQ]);
    expect(mountViewVector({pose: 'landscape', angle: 45, position: 'top'})).toEqual([SQ, 0, SQ]);
  });

  it('angle 90° (oculaire en bout de tube) — visée le long du tube', () => {
    expect(mountViewVector({pose: 'portrait', angle: 90, position: 'top'})).toEqual([0, 1, 0]);
    expect(mountViewVector({pose: 'landscape', angle: 90, position: 'top'})).toEqual([1, 0, 0]);
  });

  it('tous les vecteurs sont unitaires', () => {
    const poses = ['portrait', 'landscape'] as const;
    const positions = ['top', 'left', 'right'] as const;
    for (const pose of poses) {
      for (const angle of [0, 45, 90] as const) {
        for (const position of positions) {
          const v = mountViewVector({pose, angle, position});
          const n = Math.hypot(v[0], v[1], v[2]);
          expect(n).toBeCloseTo(1, 9);
        }
      }
    }
  });
});

describe('Restauration de la visée du tube (sud à l\'horizon) par configuration', () => {
  it('défaut (portrait, 0°, dessus) : téléphone à plat sur le tube, bord supérieur vers l\'avant', () => {
    // X = ouest, Y (bord sup.) = sud, Z (écran) = haut
    expectSouth(makeOrientation({X: W, Y: S, Z: U}), DEFAULT_MOUNT);
  });

  it('défaut à 45° de hauteur : alt 45°, az 180°', () => {
    const r = tubeAltAzFromOrientation(
      makeOrientation({X: W, Y: [0, -SQ, SQ], Z: [0, SQ, SQ]}),
      DEFAULT_MOUNT, 0,
    );
    expect(r!.altDeg).toBeCloseTo(45, 1);
    expect(r!.azDeg).toBeCloseTo(180, 1);
  });

  it('défaut au zénith : alt 90°', () => {
    // Tube vertical, téléphone à plat dessus : Y = haut, Z = sud
    const r = tubeAltAzFromOrientation(makeOrientation({X: E, Y: U, Z: S}), DEFAULT_MOUNT, 0);
    expect(r!.altDeg).toBeCloseTo(90, 5);
  });

  it('paysage, 0°, dessus : bord droit vers l\'avant', () => {
    // X (bord droit) = sud, Y = est (bord sup. vers la gauche vu de derrière), Z = haut
    expectSouth(makeOrientation({X: S, Y: E, Z: U}), {pose: 'landscape', angle: 0, position: 'top'});
  });

  it('portrait, 0°, côté GAUCHE : debout, bord supérieur en haut, écran vers l\'extérieur', () => {
    // Côté gauche du tube (est) : X = nord, Y = haut, Z (écran) = est
    expectSouth(makeOrientation({X: N, Y: U, Z: E}), {pose: 'portrait', angle: 0, position: 'left'});
  });

  it('portrait, 0°, côté DROIT : debout, bord supérieur en haut, écran vers l\'extérieur', () => {
    // Côté droit (ouest) : X = sud, Y = haut, Z = ouest
    expectSouth(makeOrientation({X: S, Y: U, Z: W}), {pose: 'portrait', angle: 0, position: 'right'});
  });

  it('paysage, 0°, côté gauche : couché, bord supérieur vers l\'avant', () => {
    // X = haut, Y = sud, Z = est
    expectSouth(makeOrientation({X: U, Y: S, Z: E}), {pose: 'landscape', angle: 0, position: 'left'});
  });

  it('45° (prisme) portrait : prisme relevé à 45°, téléphone dos contre l\'oculaire', () => {
    // Oculaire à 45° sud-haut : Z (écran) = (0, -√½, +√½), bord sup. vers l'avant-bas,
    // X = ouest. La visée du TUBE (sud) doit être restaurée.
    expectSouth(
      makeOrientation({X: W, Y: [0, -SQ, -SQ], Z: [0, -SQ, SQ]}),
      {pose: 'portrait', angle: 45, position: 'top'},
    );
  });

  it('45° (prisme) paysage : quart de tour dans le support', () => {
    // Même prisme (écran = oculaire à 45° sud-haut), téléphone tourné d'un
    // quart de tour : X = (0,−√½,−√½), Z = (0,−√½,+√½), Y = Z×X = est.
    // Visée attendue v = (√½, 0, √½) → v_monde = √½·X + √½·Z = sud.
    const Z: [number, number, number] = [0, -SQ, SQ];
    const X: [number, number, number] = [0, -SQ, -SQ];
    const Y: [number, number, number] = [
      Z[1] * X[2] - Z[2] * X[1],
      Z[2] * X[0] - Z[0] * X[2],
      Z[0] * X[1] - Z[1] * X[0],
    ];
    // Droiterie : X × Y = Z
    const cr: [number, number, number] = [
      X[1] * Y[2] - X[2] * Y[1],
      X[2] * Y[0] - X[0] * Y[2],
      X[0] * Y[1] - X[1] * Y[0],
    ];
    expect(cr[0]).toBeCloseTo(Z[0], 9);
    expect(cr[1]).toBeCloseTo(Z[1], 9);
    expect(cr[2]).toBeCloseTo(Z[2], 9);
    expectSouth(makeOrientation({X, Y, Z}), {pose: 'landscape', angle: 45, position: 'left'});
  });

  it('90° (bout de tube) portrait : newton/coudé, oculaire vers le haut', () => {
    // X = ouest, Y = sud, Z = haut (même repère que le défaut : coïncidence physique)
    expectSouth(makeOrientation({X: W, Y: S, Z: U}), {pose: 'portrait', angle: 90, position: 'top'});
  });

  it('90° paysage : quart de tour dans le support', () => {
    // X = sud (bord droit vers l'avant), Y = est, Z = haut
    expectSouth(makeOrientation({X: S, Y: E, Z: U}), {pose: 'landscape', angle: 90, position: 'top'});
  });

  it('angle 45/90 : la position sur le tube ne change pas la visée (le téléphone suit l\'oculaire)', () => {
    for (const angle of [45, 90] as const) {
      for (const position of ['top', 'left', 'right'] as const) {
        // la POSE est identique (téléphone solidaire de l'oculaire) ; seul le
        // vecteur de visée compte — et la table ne dépend pas de la position
        const vTop = mountViewVector({pose: 'portrait', angle, position: 'top'});
        const vSide = mountViewVector({pose: 'portrait', angle, position});
        expect(vSide).toEqual(vTop);
      }
    }
  });
});

describe('Conversions et replis', () => {
  it('déclinaison magnétique ajoutée à l\'azimut', () => {
    const o = makeOrientation({X: W, Y: S, Z: U});
    const r = tubeAltAzFromOrientation(o, DEFAULT_MOUNT, 2);
    expect(r!.azDeg).toBeCloseTo(182, 1);
    const r2 = tubeAltAzFromOrientation(o, DEFAULT_MOUNT, -10);
    expect(r2!.azDeg).toBeCloseTo(170, 1);
  });

  it('repli Euler (sans quaternion) : config par défaut = comportement v2.3.0', () => {
    const r = tubeAltAzFromOrientation(
      makeOrientation(null, {azimuthDeg: 95, pitchDeg: 23}),
      DEFAULT_MOUNT, 2,
    );
    expect(r!.altDeg).toBeCloseTo(23, 6);
    expect(r!.azDeg).toBeCloseTo(97, 6);
  });

  it('repli Euler refusé pour une pose avancée (null) — pas de valeur fausse', () => {
    const r = tubeAltAzFromOrientation(
      makeOrientation(null, {azimuthDeg: 95, pitchDeg: 23}),
      {pose: 'portrait', angle: 45, position: 'top'},
      0,
    );
    expect(r).toBeNull();
  });

  it('isDefaultMount', () => {
    expect(isDefaultMount(DEFAULT_MOUNT)).toBe(true);
    expect(isDefaultMount({pose: 'portrait', angle: 0, position: 'left'})).toBe(false);
    expect(isDefaultMount({pose: 'landscape', angle: 0, position: 'top'})).toBe(false);
    expect(isDefaultMount({pose: 'portrait', angle: 90, position: 'top'})).toBe(false);
  });

  it('cohérence quatToMat : v_monde = R(q)·v_tel sur la pose de base', () => {
    // Pose base (sud horizon) = rotation 180° autour de Z : q = (0,0,0,1)
    const R = quatToMat({w: 0, x: 0, y: 0, z: 1});
    const v = [0, 1, 0]; // bord supérieur du téléphone
    const wx = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
    const wy = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
    const wz = R[6] * v[0] + R[7] * v[1] + R[8] * v[2];
    expect(wx).toBeCloseTo(0, 9);
    expect(wy).toBeCloseTo(-1, 9); // sud
    expect(wz).toBeCloseTo(0, 9);
  });
});
