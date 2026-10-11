/**
 * Tests du recalage télémétrie (v1.9.0) — astro/telemetry.ts.
 * Scénarios : conventions quaternion/matrices Android, Kabsch exact et
 * bruité, recovery de (W, o) sur données synthétiques, parseurs RA/DEC.
 */
import {
  altAzToVec,
  angleBetweenDeg,
  applyFit,
  averageQuat,
  fitTelemetry,
  jacobiEigen3,
  kabsch3,
  matMul,
  matVec,
  matTranspose,
  parseDecDms,
  parseRaHms,
  quatToMat,
  vecToAltAz,
  normalizeVec,
  type Mat3,
  type Quat,
  type Vec3,
} from '../src/services/astro/telemetry';

const R2D = 180 / Math.PI;

/** Rotation active autour d'un axe (formule de Rodrigues, référence indépendante). */
function rodrigues(axis: Vec3, angleRad: number): Mat3 {
  const u = normalizeVec(axis)!;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const C = 1 - c;
  const [x, y, z] = u;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const u = normalizeVec(axis)!;
  const s = Math.sin(angleRad / 2);
  return {w: Math.cos(angleRad / 2), x: u[0] * s, y: u[1] * s, z: u[2] * s};
}

/** Angle (deg) entre deux rotations. */
function rotAngleDeg(A: Mat3, B: Mat3): number {
  const R = matMul(A, matTranspose(B));
  const tr = R[0] + R[4] + R[8];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * R2D;
}

function maxDiff(A: number[], B: number[]): number {
  let m = 0;
  for (let i = 0; i < A.length; i++) m = Math.max(m, Math.abs(A[i] - B[i]));
  return m;
}

/** Générateur pseudo-aléatoire déterministe. */
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

describe('conventions quaternions (Android rotation vector)', () => {
  test('identité : q = (0,0,0,1) → matrice identité', () => {
    const R = quatToMat({w: 1, x: 0, y: 0, z: 0});
    expect(maxDiff(R, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toBeLessThan(1e-12);
  });

  test('quatToMat ≡ Rodrigues (convention rotation active)', () => {
    for (const [axis, ang] of [
      [[1, 0, 0], 0.7],
      [[0, 1, 0], -1.2],
      [[0.3, 0.4, 0.866], 2.5],
      [[1, 1, 1], 3.0],
    ] as Array<[Vec3, number]>) {
      const Rq = quatToMat(quatFromAxisAngle(axis, ang));
      const Rr = rodrigues(axis, ang);
      expect(maxDiff(Rq, Rr)).toBeLessThan(1e-9);
    }
  });

  test('téléphone à plat tourné vers l’EST (az=90°) : le bord supérieur pointe l’est', () => {
    // rotation vector : axe −Z, 90° (doc Android « rotation about the -z axis »)
    const q: Quat = {w: Math.SQRT1_2, x: 0, y: 0, z: -Math.SQRT1_2};
    const R = quatToMat(q);
    const top = [R[1], R[4], R[7]] as Vec3; // colonne 1 : axe Y (bord supérieur)
    expect(Math.abs(top[0] - 1)).toBeLessThan(1e-9); // est
    expect(Math.abs(top[1])).toBeLessThan(1e-9); // nord ≈ 0
    expect(Math.abs(top[2])).toBeLessThan(1e-9); // vertical ≈ 0
  });
});

describe('alt/az ↔ vecteur ENU', () => {
  test('aller-retour', () => {
    for (const [alt, az] of [[10, 0], [45, 90], [80, 270], [-20, 45], [0, 359.5]]) {
      const back = vecToAltAz(altAzToVec(alt, az));
      expect(Math.abs(back.altDeg - alt)).toBeLessThan(1e-9);
      const daz = Math.abs(back.azDeg - az) % 360;
      expect(Math.min(daz, 360 - daz)).toBeLessThan(1e-9);
    }
  });

  test('45° au nord = (0, cos45, sin45)', () => {
    const v = altAzToVec(45, 0);
    expect(Math.abs(v[0])).toBeLessThan(1e-12);
    expect(Math.abs(v[1] - Math.SQRT1_2)).toBeLessThan(1e-12);
    expect(Math.abs(v[2] - Math.SQRT1_2)).toBeLessThan(1e-12);
  });
});

describe('jacobiEigen3', () => {
  test('valeurs/vecteurs propres d’une matrice symétrique connue', () => {
    // diag(3, 2, 1) tournée par une rotation quelconque → mêmes valeurs propres
    const R = rodrigues([0.2, 0.9, 0.4], 1.1);
    const D: Mat3 = [3, 0, 0, 0, 2, 0, 0, 0, 1];
    const M = matMul(matMul(R, D), matTranspose(R));
    const {values, vectors} = jacobiEigen3(M);
    expect(Math.abs(values[0] - 3)).toBeLessThan(1e-9);
    expect(Math.abs(values[1] - 2)).toBeLessThan(1e-9);
    expect(Math.abs(values[2] - 1)).toBeLessThan(1e-9);
    // base orthonormée
    for (let c = 0; c < 3; c++) {
      const col: Vec3 = [vectors[3 * c], vectors[3 * c + 1], vectors[3 * c + 2]];
      expect(Math.abs(Math.hypot(col[0], col[1], col[2]) - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('kabsch3', () => {
  test('rotation exacte retrouvée', () => {
    const W = rodrigues([0.3, 0.4, 0.866], 0.9);
    const src: Vec3[] = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
      [1, 1, 0], [0, 1, 1], [1, 0, 1],
    ].map((v) => normalizeVec(v as Vec3)!) as Vec3[];
    const dst = src.map((v) => matVec(W, v));
    const R = kabsch3(src, dst);
    expect(rotAngleDeg(R, W)).toBeLessThan(1e-6);
  });
});

describe('fitTelemetry — recovery de (W, o)', () => {
  // Vérité terrain : axe optique à 30° de haut, az 40° ; biais capteur fixe W*
  const oStar = altAzToVec(30, 40);
  const WStar = rodrigues([0.1, 0.2, 0.9747], 0.15);
  const orients = [
    quatFromAxisAngle([0, 0, 1], 0.3),
    quatFromAxisAngle([1, 0, 0], -0.5),
    quatFromAxisAngle([0, 1, 0], 0.9),
    quatFromAxisAngle([0.5, 0.5, 0.707], 1.8),
    quatFromAxisAngle([-0.3, 0.8, 0.5], 2.4),
  ];

  function synth(noiseDeg: number) {
    return orients.map((q) => {
      const R = quatToMat(q);
      const v = matVec(R, oStar);
      const sv = matVec(WStar, v);
      const aa = vecToAltAz(sv);
      // bruit angulaire déterministe sur la direction
      if (noiseDeg > 0) {
        const n = altAzToVec(aa.altDeg + rnd() * noiseDeg, aa.azDeg + (rnd() * noiseDeg) / Math.max(0.2, Math.cos(aa.altDeg * (Math.PI / 180))));
        const nb = vecToAltAz(n);
        return {quat: q, altDeg: nb.altDeg, azDeg: nb.azDeg};
      }
      return {quat: q, altDeg: aa.altDeg, azDeg: aa.azDeg};
    });
  }

  test('données exactes : W et o retrouvés, résidus nuls', () => {
    const fit = fitTelemetry(synth(0));
    expect(fit).not.toBeNull();
    expect(fit!.n).toBe(5);
    expect(rotAngleDeg(fit!.W, WStar)).toBeLessThan(1e-4);
    expect(angleBetweenDeg(fit!.o, oStar)).toBeLessThan(1e-4);
    expect(fit!.rmsDeg * 60).toBeLessThan(0.1); // < 0.1′
  });

  test('bruit ±0.3° : RMS ≈ bruit, W proche de la vérité', () => {
    seed = 42;
    const fit = fitTelemetry(synth(0.3));
    expect(fit).not.toBeNull();
    expect(fit!.rmsDeg * 60).toBeGreaterThan(2); // > 2′
    expect(fit!.rmsDeg * 60).toBeLessThan(45); // < 45′
    expect(rotAngleDeg(fit!.W, WStar)).toBeLessThan(1.5);
  });

  test('applyFit redonne la direction de chaque objet', () => {
    const pts = synth(0);
    const fit = fitTelemetry(pts)!;
    pts.forEach((p) => {
      const aa = applyFit(fit, p.quat);
      expect(Math.abs(aa.altDeg - p.altDeg)).toBeLessThan(1e-4);
      const daz = Math.abs(aa.azDeg - p.azDeg) % 360;
      expect(Math.min(daz, 360 - daz)).toBeLessThan(1e-4);
    });
  });

  test('1 point : résidu nul et pointage exact sur ce point', () => {
    const pts = synth(0);
    const fit = fitTelemetry([pts[0]])!;
    expect(fit.residualsDeg[0] * 60).toBeLessThan(0.1);
    const aa = applyFit(fit, pts[0].quat);
    expect(Math.abs(aa.altDeg - pts[0].altDeg)).toBeLessThan(1e-4);
  });

  test('aucun point → null', () => {
    expect(fitTelemetry([])).toBeNull();
  });
});

describe('averageQuat', () => {
  test('quaternions identiques', () => {
    const q = quatFromAxisAngle([0.2, 0.3, 0.93], 0.4);
    const m = averageQuat([q, q, q, q])!;
    expect(Math.abs(m.w - q.w)).toBeLessThan(1e-9);
    expect(Math.abs(m.x - q.x)).toBeLessThan(1e-9);
  });

  test('q et −q (même rotation) → moyenne stable', () => {
    const q = quatFromAxisAngle([0.2, 0.3, 0.93], 0.4);
    const neg: Quat = {w: -q.w, x: -q.x, y: -q.y, z: -q.z};
    const m = averageQuat([q, neg])!;
    expect(rotAngleDeg(quatToMat(m), quatToMat(q))).toBeLessThan(1e-9);
  });

  test('liste vide → null', () => {
    expect(averageQuat([])).toBeNull();
  });
});

describe('parseurs RA/DEC', () => {
  test('parseRaHms', () => {
    expect(parseRaHms('05:34:31.5')).toBeCloseTo((5 + 34 / 60 + 31.5 / 3600) * 15, 6);
    expect(parseRaHms('18h36m56s')).toBeCloseTo((18 + 36 / 60 + 56 / 3600) * 15, 5);
    expect(parseRaHms('10 08 22')).toBeCloseTo((10 + 8 / 60 + 22 / 3600) * 15, 6);
    expect(parseRaHms('24:00:00')).toBeCloseTo(0, 6); // 24h → 360 % 360
    expect(parseRaHms('abc')).toBeNull();
    expect(parseRaHms('25:00:00')).toBeNull();
    expect(parseRaHms('05:61:00')).toBeNull();
  });

  test('parseDecDms', () => {
    expect(parseDecDms('+22:00')).toBeCloseTo(22, 6);
    expect(parseDecDms('-16:42:58')).toBeCloseTo(-(16 + 42 / 60 + 58 / 3600), 5);
    expect(parseDecDms('+89°15\'51"')).toBeCloseTo(89 + 15 / 60 + 51 / 3600, 5);
    expect(parseDecDms('45')).toBeCloseTo(45, 6);
    expect(parseDecDms('90:00')).toBeNull();
    expect(parseDecDms('xx')).toBeNull();
  });
});
