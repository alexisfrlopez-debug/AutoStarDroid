/** Conversion de coordonnées célestes. */
import {hourAngleDeg, lstDeg} from './time';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * RA/DEC (deg, date, site) -> hauteur/azimut (deg).
 * Azimut : 0 = nord, 90 = est (convention astronomique).
 */
export function raDecToAltAz(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lonDeg: number,
  date: Date,
): {altDeg: number; azDeg: number} {
  const ha = hourAngleDeg(date, lonDeg, raDeg) * D2R;
  const dec = decDeg * D2R;
  const lat = latDeg * D2R;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
  return {altDeg: alt * R2D, azDeg: (az * R2D + 360) % 360};
}

/** Alt/Az -> RA/Dec (utile pour la démo et la visserie altaz). */
export function altAzToRaDec(
  altDeg: number,
  azDeg: number,
  latDeg: number,
  lonDeg: number,
  date: Date,
): {raDeg: number; decDeg: number} {
  const alt = altDeg * D2R;
  const az = azDeg * D2R;
  const lat = latDeg * D2R;
  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const cosHa = (Math.sin(alt) - Math.sin(dec) * Math.sin(lat)) / (Math.cos(dec) * Math.cos(lat));
  let ha = Math.acos(Math.max(-1, Math.min(1, cosHa)));
  if (Math.sin(az) > 0) ha = 2 * Math.PI - ha;
  const ra = (((lstDeg(date, lonDeg) - ha * R2D) % 360) + 360) % 360;
  return {raDeg: ra, decDeg: dec * R2D};
}

/** Séparation angulaire entre deux positions (deg). */
export function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * D2R;
  const d2 = dec2 * D2R;
  const dra = ((ra2 - ra1) * D2R);
  const c =
    Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dra);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}
