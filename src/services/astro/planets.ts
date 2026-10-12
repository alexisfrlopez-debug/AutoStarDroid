/**
 * Éphémérides planétaires basse précision (formules de Paul Schlyter, 1992).
 * Précision typique : quelques minutes d'arc — largement suffisante pour
 * centrer une planète dans l'oculaire via GOTO.
 */
import {raDecToAltAz} from './coords';
import {D2R, R2D} from './telemetry';



export const PLANET_NAMES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;
export type PlanetName = typeof PLANET_NAMES[number] | 'Sun' | 'Moon';

interface OrbElem {
  N: number; i: number; w: number; // noeud, inclinaison, périhélie (deg)
  a: number; e: number;            // demi-grand axe (UA), excentricité
  M: number;                       // anomalie moyenne à l'époque (deg)
  n: number;                       // mouvement moyen (deg/jour)
}

// Éléments d'orbite, époque J2000 (Schlyter)
const ELEM: Record<string, OrbElem> = {
  Mercury: {N: 48.3313, i: 7.0047, w: 29.1241, a: 0.387098, e: 0.205635, M: 168.6562, n: 4.09233445},
  Venus:   {N: 76.6799, i: 3.3946, w: 54.8510, a: 0.723330, e: 0.006773, M: 48.0052,  n: 1.60213034},
  Mars:    {N: 49.5574, i: 1.8497, w: 286.5016, a: 1.523688, e: 0.093405, M: 18.6021,  n: 0.52402068},
  Jupiter: {N: 100.4542, i: 1.3030, w: 273.8777, a: 5.20256, e: 0.048498, M: 19.8950,  n: 0.08308530},
  Saturn:  {N: 113.6634, i: 2.4886, w: 339.3939, a: 9.55475, e: 0.055546, M: 316.9670, n: 0.03344423},
  Uranus:  {N: 74.0005, i: 0.7733, w: 96.6612, a: 19.18171, e: 0.047318, M: 142.2386, n: 0.01172580},
  Neptune: {N: 131.7805, i: 1.7700, w: 272.8461, a: 30.05826, e: 0.008606, M: 256.2280, n: 0.00595310},
};

const rev = (x: number) => ((x % 360) + 360) % 360;
const sind = (x: number) => Math.sin(x * D2R);
const cosd = (x: number) => Math.cos(x * D2R);

function solveKepler(Mdeg: number, e: number): number {
  let E = Mdeg + (180 / Math.PI) * e * sind(Mdeg) * (1 + e * cosd(Mdeg));
  for (let k = 0; k < 8; k++) {
    const dE = (E - (180 / Math.PI) * e * sind(E) - Mdeg) / (1 - e * cosd(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

function eclipticToEquatorial(x: number, y: number, z: number, d: number) {
  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = x;
  const ye = y * cosd(ecl) - z * sind(ecl);
  const ze = y * sind(ecl) + z * cosd(ecl);
  const ra = rev(Math.atan2(ye, xe) * R2D);
  const dec = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * R2D;
  return {ra, dec};
}

/** Position géocentrique apparente (deg) d'une planète. */
export function planetRaDec(name: PlanetName, date: Date): {raDeg: number; decDeg: number; mag: number} {
  const d = date.getTime() / 86400000 - 10957.5; // jours depuis 2000-01-00 (JD 2451543.5)
  if (name === 'Sun') {
    const w = rev(282.9404 + 4.70935e-5 * d);
    const e = 0.016709 - 1.151e-9 * d;
    const M = rev(356.0470 + 0.9856002585 * d);
    const E = M + (180 / Math.PI) * e * sind(M) * (1 + e * cosd(M));
    const xv = cosd(E) - e;
    const yv = Math.sqrt(1 - e * e) * sind(E);
    const v = rev(Math.atan2(yv, xv) * R2D);
    const r = Math.sqrt(xv * xv + yv * yv);
    const lon = rev(v + w);
    const xs = r * cosd(lon);
    const ys = r * sind(lon);
    const eq = eclipticToEquatorial(xs, ys, 0, d);
    return {raDeg: eq.ra, decDeg: eq.dec, mag: -26.7};
  }
  if (name === 'Moon') {
    const N = rev(125.1228 - 0.0529538083 * d);
    const i = 5.1454;
    const w = rev(318.0634 + 0.1643573223 * d);
    const a = 60.2666; // rayons terrestres
    const e = 0.054900;
    const M = rev(115.3654 + 13.0649929509 * d);
    const E = solveKepler(M, e);
    const xv = a * (cosd(E) - e);
    const yv = a * (Math.sqrt(1 - e * e) * sind(E));
    const v = rev(Math.atan2(yv, xv) * R2D);
    const r = Math.sqrt(xv * xv + yv * yv);
    const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
    const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
    const zh = r * (sind(v + w) * sind(i));
    // géocentrique écliptique (Soleil à ~1 UA)
    const ws = rev(282.9404 + 4.70935e-5 * d);
    const Ms = rev(356.0470 + 0.9856002585 * d);
    const ls = rev(Ms + ws);
    const lonsun = ls;
    const xs = cosd(lonsun);
    const ys = sind(lonsun);
    const xg = xh + xs;
    const yg = yh + ys;
    const zg = zh;
    const eq = eclipticToEquatorial(xg, yg, zg, d);
    const dist = Math.sqrt(xg * xg + yg * yg + zg * zg);
    const mag = -12.7 + 5 * Math.log10(384400 / (dist * 6371 * 1.0)); // approx
    return {raDeg: eq.ra, decDeg: eq.dec, mag: Math.round(mag * 10) / 10};
  }
  const el = ELEM[name];
  const N = el.N + 0; // dérive négligeable sur des décennies pour notre usage
  const M = rev(el.M + el.n * d);
  const w = el.w;
  const E = solveKepler(M, el.e);
  const xv = el.a * (cosd(E) - el.e);
  const yv = el.a * (Math.sqrt(1 - el.e * el.e) * sind(E));
  const v = rev(Math.atan2(yv, xv) * R2D);
  const r = Math.sqrt(xv * xv + yv * yv);
  // héliocentrique écliptique
  const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(el.i));
  const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(el.i));
  const zh = r * (sind(v + w) * sind(el.i));
  // géocentrique : position de la Terre = position héliocentrique du Soleil opposée
  const ws = rev(282.9404 + 4.70935e-5 * d);
  const Ms = rev(356.0470 + 0.9856002585 * d);
  const es = 0.016709 - 1.151e-9 * d;
  const Esol = Ms + (180 / Math.PI) * es * sind(Ms) * (1 + es * cosd(Ms));
  const xvs = cosd(Esol) - es;
  const yvs = Math.sqrt(1 - es * es) * sind(Esol);
  const vs = rev(Math.atan2(yvs, xvs) * R2D);
  const rs = Math.sqrt(xvs * xvs + yvs * yvs);
  const lonsun = rev(vs + ws);
  const xs = rs * cosd(lonsun);
  const ys = rs * sind(lonsun);
  const xg = xh + xs;
  const yg = yh + ys;
  const zg = zh;
  const eq = eclipticToEquatorial(xg, yg, zg, d);
  // magnitude approximative
  const dist = Math.sqrt(xg * xg + yg * yg + zg * zg);
  const magApprox: Record<string, number> = {
    Mercury: -0.4, Venus: -4.2, Mars: -1.5, Jupiter: -2.5, Saturn: 0.7, Uranus: 5.7, Neptune: 7.8,
  };
  void dist;
  return {raDeg: eq.ra, decDeg: eq.dec, mag: magApprox[name] ?? 0};
}

/** Liste des planètes visibles avec leur altitude actuelle au site donné. */
export function planetsWithAlt(
  latDeg: number,
  lonDeg: number,
  date: Date,
): Array<{name: PlanetName; raDeg: number; decDeg: number; mag: number; altDeg: number; azDeg: number}> {
  const names: PlanetName[] = ['Sun', 'Moon', ...PLANET_NAMES];
  return names
    .map((name) => {
      const p = planetRaDec(name, date);
      const aa = raDecToAltAz(p.raDeg, p.decDeg, latDeg, lonDeg, date);
      return {name, ...p, altDeg: aa.altDeg, azDeg: aa.azDeg};
    })
    .sort((a, b) => b.altDeg - a.altDeg);
}
