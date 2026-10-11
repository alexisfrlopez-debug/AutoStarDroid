/**
 * Alignement du télescope par télémétrie du téléphone (v1.9.0).
 *
 * Principe : le téléphone est solidaire du tube (porte-téléphone sur le tube
 * ou la chercheuse). L'axe optique est alors un vecteur FIXE `o` dans le
 * repère téléphone. Le capteur « rotation vector » Android (fusion gyro +
 * accéléromètre + magnétomètre, filtre de Kalman) fournit à chaque instant
 * la rotation `q` du téléphone vers le repère monde Est-Nord-Up (nord
 * magnétique). En validant un objet centré dans l'oculaire, on enregistre
 * le couple (q_i, s_i) où s_i est la direction de l'objet dans le repère
 * horizontal (alt/az calculés au site du réglage, à la date de validation).
 *
 * Modèle :          s_i = W · R(q_i) · o
 *   - o : axe optique dans le repère téléphone (2 DOF, constante rigide) ;
 *   - W : correction fixe dans le monde — biais magnétique (rotation
 *     constante du nord capteur), flexion du support, … (3 DOF).
 *
 * 5 DOF résolus par minimisation alternée (Procrustes orthogonal) :
 *   1. init    : W = I, o = normalise(moyenne_i R_iᵀ s_i) ;
 *   2. Kabsch  : W ← argmin Σ‖s_i − W·R_i·o‖²  (SVD via Jacobi 3×3) ;
 *   3. update  : o ← normalise(moyenne_i R_iᵀ Wᵀ s_i) ; répéter 2-3.
 *
 * Résidu_i = angle(W·R_i·o, s_i). Le RMS (minutes d'arc) mesure la qualité
 * du recalage. Un seul point suffit pour connaître l'axe optique ; deux
 * points ou plus répartis du ciel identifient W (biais magnétique) et
 * donnent une précision réelle. Chaque point fige q_i : les points restent
 * valables après coup (refit = mêmes données), même si le télescope bouge.
 *
 * 100 % pur TypeScript, aucune dépendance — testable sous Jest sans RN.
 */

export type Vec3 = [number, number, number];
/** Matrice 3×3 row-major : élément (r,c) = M[3*r + c]. */
export type Mat3 = number[];
export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/* ------------------------------------------------------------------ */
/* Vecteurs                                                            */
/* ------------------------------------------------------------------ */

export function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vlen(v: Vec3): number {
  return Math.sqrt(dotVec(v, v));
}

export function normalizeVec(v: Vec3): Vec3 | null {
  const n = vlen(v);
  if (n < 1e-12) return null;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Angle (deg) entre deux directions. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dotVec(a, b) / (vlen(a) * vlen(b))));
  return Math.acos(c) * R2D;
}

/* ------------------------------------------------------------------ */
/* Quaternions (convention Android rotation vector : v_monde = R·v_tel) */
/* ------------------------------------------------------------------ */

export function quatNormalize(q: Quat): Quat {
  const n = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (n < 1e-12) return {w: 1, x: 0, y: 0, z: 0};
  return {w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n};
}

/**
 * Matrice de rotation R telle que v_monde = R · v_téléphone.
 * Convention Android : rotation vector q = rotation active appliquée au
 * téléphone depuis son alignement de référence (à plat, bord supérieur
 * vers le nord magnétique) ; R = getRotationMatrixFromVector.
 */
export function quatToMat(q: Quat): Mat3 {
  const {w, x, y, z} = quatNormalize(q);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Moyenne de quaternions proches (échantillons d'une même pose) :
 *  moyenne naïve puis normalisation — valide pour des poses quasi identiques. */
export function averageQuat(qs: Quat[]): Quat | null {
  if (!qs.length) return null;
  let w = 0, x = 0, y = 0, z = 0;
  for (const q of qs) {
    const nq = quatNormalize(q);
    // garantie de continuité de signe (q et −q représentent la même rotation)
    const s = nq.w * qs[0].w + nq.x * qs[0].x + nq.y * qs[0].y + nq.z * qs[0].z >= 0 ? 1 : -1;
    w += s * nq.w; x += s * nq.x; y += s * nq.y; z += s * nq.z;
  }
  return quatNormalize({w, x, y, z});
}

/* ------------------------------------------------------------------ */
/* Matrices 3×3                                                        */
/* ------------------------------------------------------------------ */

export function matVec(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
}

/** Mᵀ·v (rotation inverse). */
export function matTMulVec(M: Mat3, v: Vec3): Vec3 {
  return [
    M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
    M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
    M[2] * v[0] + M[5] * v[1] + M[8] * v[2],
  ];
}

export function matMul(A: Mat3, B: Mat3): Mat3 {
  const R: number[] = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      R[3 * r + c] =
        A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c];
    }
  }
  return R;
}

export function matTranspose(M: Mat3): Mat3 {
  return [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
}

export function matDet(M: Mat3): number {
  return (
    M[0] * (M[4] * M[8] - M[5] * M[7]) -
    M[1] * (M[3] * M[8] - M[5] * M[6]) +
    M[2] * (M[3] * M[7] - M[4] * M[6])
  );
}

/* ------------------------------------------------------------------ */
/* Alt/Az ↔ vecteur ENU (x = est, y = nord, z = zénith)                */
/* ------------------------------------------------------------------ */

export function altAzToVec(altDeg: number, azDeg: number): Vec3 {
  const alt = altDeg * D2R;
  const az = azDeg * D2R;
  return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
}

export function vecToAltAz(v: Vec3): {altDeg: number; azDeg: number} {
  const n = normalizeVec(v) ?? [0, 0, 1];
  const alt = Math.asin(Math.max(-1, Math.min(1, n[2]))) * R2D;
  let az = Math.atan2(n[0], n[1]) * R2D; // 0 = nord, 90 = est
  if (az < 0) az += 360;
  return {altDeg: alt, azDeg: az};
}

/* ------------------------------------------------------------------ */
/* Jacobi 3×3 symétrique (valeurs/vecteurs propres)                    */
/* ------------------------------------------------------------------ */

/**
 * Diagonalisation d'une matrice 3×3 SYMÉTRIQUE par rotations de Jacobi.
 * Renvoie les valeurs propres triées par ordre DÉCROISSANT et les vecteurs
 * propres unitaires correspondants (colonnes d'une base orthonormée).
 */
export function jacobiEigen3(M: Mat3): {values: number[]; vectors: Mat3} {
  const a = M.slice();
  let v: Mat3 = IDENTITY.slice();
  for (let sweep = 0; sweep < 32; sweep++) {
    const off =
      Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]); // a01 a02 a12
    if (off < 1e-13 * (Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8]) + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) {
      const e = elementAt(a, p, q);
      if (Math.abs(e) < 1e-15 * (Math.abs(a[3 * p + p]) + Math.abs(a[3 * q + q]) + 1e-30)) continue;
      const theta = (a[3 * q + q] - a[3 * p + p]) / (2 * e);
      const t =
        Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // rotation J dans le plan (p,q) : a ← JᵀAJ, v ← v·J
      for (let k = 0; k < 3; k++) {
        const akp = a[3 * k + p];
        const akq = a[3 * k + q];
        a[3 * k + p] = c * akp - s * akq;
        a[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[3 * p + k];
        const aqk = a[3 * q + k];
        a[3 * p + k] = c * apk - s * aqk;
        a[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[3 * k + p];
        const vkq = v[3 * k + q];
        v[3 * k + p] = c * vkp - s * vkq;
        v[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  // tri décroissant
  const idx = [0, 1, 2].sort((i, j) => a[3 * j + j] - a[3 * i + i]);
  const values = idx.map((i) => a[3 * i + i]);
  const vectors: Mat3 = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) vectors[3 * r + c] = v[3 * r + idx[c]];
  }
  return {values, vectors};
}

function elementAt(a: Mat3, p: number, q: number): number {
  return a[3 * Math.min(p, q) + Math.max(p, q)];
}

/* ------------------------------------------------------------------ */
/* Kabsch 3D : rotation optimale (SO(3)) entre deux jeux de vecteurs   */
/* ------------------------------------------------------------------ */

/**
 * R = argmin_{R∈SO(3)} Σ‖dst_i − R·src_i‖².
 * H = Σ dst·srcᵀ ; décomposition en valeurs singulières via Jacobi de HᵀH ;
 * correction de détermination (det = +1 obligatoire).
 */
export function kabsch3(src: Vec3[], dst: Vec3[]): Mat3 {
  const H: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) H[3 * r + c] += dst[i][r] * src[i][c];
    }
  }
  // HᵀH (symétrique PSD)
  const Ht = matTranspose(H);
  const M = matMul(Ht, H);
  const {values, vectors: V} = jacobiEigen3(M);
  // U = H·V·Σ⁻¹ (colonnes) ; singularités (rang < 3) → complétion par produits
  // vectoriels. Seuil RELATIF (σ_c < 1e-6·σ_max → rang déficient) : un seuil
  // absolu laisserait passer des colonnes numériquement parasites (presque
  // colinéaires → cross ≈ 0 → U invalide).
  const sigmaMax = Math.sqrt(Math.max(0, values[0] ?? 0));
  const Ucols: Array<Vec3 | null> = [];
  for (let c = 0; c < 3; c++) {
    const sigma = Math.sqrt(Math.max(0, values[c]));
    if (sigma > Math.max(1e-12, 1e-6 * sigmaMax)) {
      // colonne c de V (row-major) = vecteur propre associé à values[c]
      const col: Vec3 = [V[c], V[3 + c], V[6 + c]];
      const u = matVec(H, col).map((x) => x / sigma) as Vec3;
      Ucols.push(normalizeVec(u));
    } else {
      Ucols.push(null);
    }
  }
  // complétion : u_c = croiser(u_i, u_j) ; rang 1 → reconstruire la paire
  for (let c = 0; c < 3; c++) {
    if (Ucols[c]) continue;
    const [i, j] = [0, 1, 2].filter((k) => k !== c);
    if (Ucols[i] && Ucols[j]) {
      Ucols[c] = normalizeVec(crossVec(Ucols[i] as Vec3, Ucols[j] as Vec3));
    } else if (Ucols[i]) {
      const ui = Ucols[i] as Vec3;
      // colonne j de V (row-major)
      const vc: Vec3 = [V[j], V[3 + j], V[6 + j]];
      const uj =
        normalizeVec(crossVec(ui, vc)) ??
        normalizeVec(crossVec(ui, [0, 0, 1])) ??
        [0, 1, 0];
      Ucols[j] = uj;
      Ucols[c] = normalizeVec(crossVec(ui, uj));
    } else {
      Ucols[i] = i === 0 ? [1, 0, 0] : i === 1 ? [0, 1, 0] : [0, 0, 1];
      Ucols[c] = c === 0 ? [1, 0, 0] : c === 1 ? [0, 1, 0] : [0, 0, 1];
    }
  }
  const U: Mat3 = [
    Ucols[0]![0], Ucols[1]![0], Ucols[2]![0],
    Ucols[0]![1], Ucols[1]![1], Ucols[2]![1],
    Ucols[0]![2], Ucols[1]![2], Ucols[2]![2],
  ];
  // R0 = U·Vᵀ puis correction de détermination (det = +1 : annule la plus
  // petite valeur singulière en retournant la 3ᵉ colonne de U)
  const Vt = matTranspose(V);
  let R = matMul(U, Vt);
  if (matDet(R) < 0) {
    const Ufix = U.slice();
    for (let k = 0; k < 3; k++) Ufix[3 * k + 2] = -Ufix[3 * k + 2];
    R = matMul(Ufix, Vt);
  }
  return R;
}

/* ------------------------------------------------------------------ */
/* Recalage télémétrie : modèle s = W · R(q) · o                        */
/* ------------------------------------------------------------------ */

export interface FitPoint {
  /** Orientation du téléphone (rotation vector Android) au moment de la validation. */
  quat: Quat;
  /** Hauteur de l'objet validé (deg), au site et à la date de la validation. */
  altDeg: number;
  /** Azimut de l'objet validé (deg, 0 = nord). */
  azDeg: number;
}

export interface TelemetryFit {
  /** Axe optique dans le repère téléphone (vecteur unitaire). */
  o: Vec3;
  /** Correction fixe monde (capteur → vrai). */
  W: Mat3;
  /** Résidu par point (deg). */
  residualsDeg: number[];
  /** Racine carrée de l'erreur quadratique moyenne (deg). */
  rmsDeg: number;
  n: number;
}

/**
 * Ajuste (W, o) sur les points de validation. Renvoie null si aucun point.
 * - 1 point   : résidu 0 (o absorbé), W reste ≈ identité (biais non observable) ;
 * - 2+ points : W identifie le biais magnétique/fixe (géométrie variée requise).
 */
export function fitTelemetry(points: FitPoint[]): TelemetryFit | null {
  if (!points.length) return null;
  const Rs = points.map((p) => quatToMat(p.quat));
  const ss = points.map((p) => altAzToVec(p.altDeg, p.azDeg));
  // init : o = normalise(moyenne R_iᵀ s_i)
  let o: Vec3 | null = null;
  {
    const acc: Vec3 = [0, 0, 0];
    for (let i = 0; i < Rs.length; i++) {
      const r = matTMulVec(Rs[i], ss[i]);
      acc[0] += r[0]; acc[1] += r[1]; acc[2] += r[2];
    }
    o = normalizeVec(acc);
  }
  if (!o) return null;
  let W: Mat3 = IDENTITY.slice();
  // Alternation ALS (Kabsch ↔ mise à jour de o) : convergence géométrique.
  // 40 itérations coûtent des microsecondes (≤ 24 points) et garantissent
  // un résidu ≪ 1″ sur données exactes ; sortie anticipée si o stagne.
  for (let iter = 0; iter < 40; iter++) {
    const as = Rs.map((R) => matVec(R, o as Vec3));
    W = kabsch3(as, ss);
    const acc: Vec3 = [0, 0, 0];
    for (let i = 0; i < Rs.length; i++) {
      const r = matTMulVec(Rs[i], matTMulVec(W, ss[i]));
      acc[0] += r[0]; acc[1] += r[1]; acc[2] += r[2];
    }
    const cand = normalizeVec(acc);
    if (!cand) break;
    const moved = angleBetweenDeg(cand, o);
    o = cand;
    if (moved < 1e-12) break;
  }
  const residuals = Rs.map((R, i) =>
    angleBetweenDeg(matVec(W, matVec(R, o as Vec3)), ss[i]),
  );
  const rmsDeg = Math.sqrt(
    residuals.reduce((s, r) => s + r * r, 0) / residuals.length,
  );
  return {o, W, residualsDeg: residuals, rmsDeg, n: points.length};
}

/** Pointage ciel prédit par la télémétrie pour l'orientation courante du téléphone. */
export function applyFit(fit: TelemetryFit, quat: Quat): {altDeg: number; azDeg: number} {
  const R = quatToMat(quat);
  const dir = matVec(fit.W, matVec(R, fit.o));
  return vecToAltAz(dir);
}

/* ------------------------------------------------------------------ */
/* Saisie manuelle RA/DEC                                              */
/* ------------------------------------------------------------------ */

/** "05:34:31.5" | "5h34m31s" | "5 34 31" → degrés (0..360). null si invalide. */
export function parseRaHms(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\s*[:h ]\s*(\d{1,2})(?:\s*[:m ]\s*(\d{1,2}(?:\.\d+)?))?\s*[ms]?$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  if (h > 24 || mi > 59 || sec >= 60) return null;
  const deg = ((h + mi / 60 + sec / 3600) * 15) % 360;
  return deg;
}

/** "+22:00:22" | "-16*42" | "+22°00'" → degrés signés. null si invalide. */
export function parseDecDms(s: string): number | null {
  const t = s.trim().replace(/[°*d]/gi, ':').replace(/['m]/gi, ':').replace(/["s]/gi, '');
  // signe, degrés, minutes optionnelles, secondes optionnelles
  const m = t.match(/^([+-]?)\s*(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const d = Number(m[2]);
  const mi = m[3] ? Number(m[3]) : 0;
  const sec = m[4] ? Number(m[4]) : 0;
  if (d > 89 || mi > 59 || sec >= 60) return null;
  return sign * (d + mi / 60 + sec / 3600);
}
