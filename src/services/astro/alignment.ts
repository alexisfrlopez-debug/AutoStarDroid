/**
 * Aide à la mise en station : niveau à bulle, inclinaison de l'axe horaire,
 * visée de l'étoile polaire au boussole + GPS.
 *
 * Principe : le téléphone est calé le long de l'axe horaire de la monture
 * (bord supérieur pointé vers l'axe / l'étoile polaire). Alors :
 *  - le pitch du téléphone = altitude de l'axe -> doit égaler la latitude ;
 *  - l'azimuth du téléphone (corrigé de la déclinaison magnétique) = azimut
 *    de l'axe -> doit viser le nord (0°) au-dessus de l'équateur, le sud
 *    (180°) dans l'hémisphère austral.
 */
import {raDecToAltAz} from './coords';

/** Polaris J2000 — AD 2h31m49s, DEC +89°15'51". */
export const POLARIS = {name: 'Polaris', raDeg: 37.954, decDeg: 89.264};

/** Hauteur/azimut actuels de l'étoile polaire au site et à l'instant donnés. */
export function polarisAltAz(latDeg: number, lonDeg: number, date: Date) {
  return raDecToAltAz(POLARIS.raDeg, POLARIS.decDeg, latDeg, lonDeg, date);
}

/** Écart de niveau : position de la bulle (x droite, y haut, en degrés). */
export function bubbleOffset(pitchDeg: number, rollDeg: number) {
  return {x: rollDeg, y: pitchDeg, deg: Math.sqrt(pitchDeg * pitchDeg + rollDeg * rollDeg)};
}

/** Cap magnétique → cap vrai (déclinaison Est positive, ex. +2° en France). */
export function trueHeadingDeg(magneticHeadingDeg: number, declinationDeg: number): number {
  return (magneticHeadingDeg + declinationDeg + 360) % 360;
}

/** Normalise un écart angulaire dans [-180, +180]. */
export function shortestAngleDeg(d: number): number {
  return ((d + 540) % 360) - 180;
}

/**
 * Erreurs de mise en station quand le téléphone est calé le long de l'axe
 * horaire. `phonePitchDeg` peut être inversé au préalable si le téléphone
 * est monté bord inférieur vers le nord.
 */
export function polarAxisErrors(
  phoneAzTrueDeg: number,
  phonePitchDeg: number,
  siteLatDeg: number,
): {azErrorDeg: number; altErrorDeg: number} {
  const targetAz = siteLatDeg >= 0 ? 0 : 180;
  const targetAlt = Math.abs(siteLatDeg);
  return {
    azErrorDeg: shortestAngleDeg(phoneAzTrueDeg - targetAz),
    altErrorDeg: phonePitchDeg - targetAlt,
  };
}
