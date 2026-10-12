/**
 * MONTAGE DU TÉLÉPHONE SUR LE TUBE (v2.4.0 — demande utilisateur : « les
 * options d'installation du téléphone sur le tube : portrait/paysage,
 * téléphone aligné au tube, à 45° du tube (sur oculaire avec prisme) ou 90°
 * (sur oculaire en bout de tube) et position du téléphone sur le tube (au
 * dessus ou côté gauche/droit) »).
 *
 * POURQUOI : les capteurs mesurent l'orientation du TÉLÉPHONE, pas celle du
 * TUBE. Quand le téléphone est fixé sur le tube (ou sur l'oculaire), la
 * direction de visée du télescope est une direction FIXE du repère
 * téléphone — différente du « bord supérieur » selon le montage. Cette
 * direction, exprimée dans le repère téléphone, est tout ce qu'il faut :
 * le quaternion du rotation vector (disponible depuis la v1.9.0) fait le
 * reste, quelle que soit la position du tube dans l'espace.
 *
 * REPÈRE TÉLÉPHONE (convention Android) :
 *   X = bord droit, Y = bord supérieur, Z = normale de l'écran (vers
 *   l'observateur qui lit l'écran). Le dos du téléphone est du côté −Z.
 *
 * CONVENTIONS DE MONTAGE (affichées à l'utilisateur dans la carte du ciel) :
 *  - l'écran regarde toujours À L'OPPOSÉ de la surface sur laquelle le
 *    téléphone est fixé (tube ou oculaire) ;
 *  - ANGLE 0° (aligné au tube) : le téléphone est fixé LE LONG du tube ;
 *      · dessus : à plat sur le tube, écran vers le ciel, bord supérieur
 *        vers l'avant (objectif) — visée = bord supérieur (portrait) ;
 *        paysage = téléphone tourné d'un quart de tour (bord supérieur
 *        vers la gauche vu de derrière) ;
 *      · côté gauche/droit : téléphone fixé sur la tranche ; portrait =
 *        debout (bord supérieur vers le haut, écran vers l'extérieur) ;
 *        paysage = couché (bord supérieur vers l'avant, écran vers
 *        l'extérieur). Gauche et droite DONNENT DES VISÉES DIFFÉRENTES
 *        car le repère téléphone est mirrored entre les deux côtés.
 *  - ANGLE 45° (oculaire + prisme renvoi 45°) et 90° (oculaire en bout de
 *    tube : coudé/newton) : le téléphone est dos contre l'oculaire, écran
 *    vers l'extérieur ; portrait = bord supérieur vers l'avant du tube,
 *    paysage = tourné d'un quart de tour dans son support. Dans ces deux
 *    cas le téléphone SUIT l'oculaire : la position sur le tube ne change
 *    pas la visée (elle tourne rigidement avec lui).
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */

import type {Orientation} from '../phone/sensors';
import {quatToMat} from './telemetry';

export type PhonePose = 'portrait' | 'landscape';
export type PhoneAngle = 0 | 45 | 90;
export type PhonePosition = 'top' | 'left' | 'right';

export interface PhoneMountConfig {
  pose: PhonePose;
  angle: PhoneAngle;
  position: PhonePosition;
}

/** Configuration par défaut = visée par le bord supérieur (tenu à la main
 *  ou à plat sur le tube, comportement historique v2.3.0). */
export const DEFAULT_MOUNT: PhoneMountConfig = {
  pose: 'portrait',
  angle: 0,
  position: 'top',
};

export function isDefaultMount(c: PhoneMountConfig): boolean {
  return c.pose === 'portrait' && c.angle === 0 && c.position === 'top';
}

export type Vec3 = [number, number, number];

const SQ = Math.SQRT1_2; // sin 45° = cos 45°

/**
 * Direction de visée du TUBE, exprimée dans le repère TÉLÉPHONE.
 * Vecteur unitaire : la direction dans laquelle « regarde » le télescope.
 */
export function mountViewVector(cfg: PhoneMountConfig): Vec3 {
  if (cfg.angle === 45) {
    // Dos contre l'oculaire du prisme 45°, écran vers l'extérieur : la
    // visée est à 45° entre la normale de l'écran (−Z… vers l'oculaire) et
    // l'axe du tube (vers l'avant = +Y en portrait).
    return cfg.pose === 'portrait' ? [0, SQ, SQ] : [SQ, 0, SQ];
  }
  if (cfg.angle === 90) {
    // Oculaire en bout de tube (coudé 90° / newton) : la visée est ⊥ à la
    // normale d'écran, le long du tube (bord supérieur en portrait).
    return cfg.pose === 'portrait' ? [0, 1, 0] : [1, 0, 0];
  }
  // Aligné au tube : la pose physique dépend de la position sur le tube.
  if (cfg.position === 'top') {
    return cfg.pose === 'portrait' ? [0, 1, 0] : [1, 0, 0];
  }
  if (cfg.pose === 'landscape') {
    // Couché sur une tranche : bord supérieur vers l'avant (objectif),
    // écran vers l'extérieur — même visée des deux côtés.
    return [0, 1, 0];
  }
  // Debout sur une tranche : bord supérieur vers le haut, écran vers
  // l'extérieur — la visée longe le tube par l'arête droite ou gauche.
  return cfg.position === 'left' ? [-1, 0, 0] : [1, 0, 0];
}

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

/**
 * HAUTEUR/AZIMUT VRAIS du tube à partir de l'orientation du téléphone et
 * de la configuration de montage.
 *
 *  - quaternion présent (module capteurs v1.9.0+) : v_monde = R(q)·v_tube
 *    (convention Android rotation vector, cf. telemetry.quatToMat) puis
 *    alt = asin(up), az = atan2(est, nord) — cadre magnétique ENU, la
 *    déclinaison magnétique du site est ajoutée pour passer au vrai nord ;
 *  - sinon : repli Euler UNIQUEMENT pour la configuration par défaut
 *    (visée = bord supérieur : azimut/cap + pitch, comportement v2.3.0) ;
 *  - sinon : null (pose avancée non mesurable sans quaternion).
 */
export function tubeAltAzFromOrientation(
  o: Orientation,
  cfg: PhoneMountConfig,
  declinationDeg: number,
): {altDeg: number; azDeg: number} | null {
  const v = mountViewVector(cfg);
  if (
    typeof o.qw === 'number' &&
    typeof o.qx === 'number' &&
    typeof o.qy === 'number' &&
    typeof o.qz === 'number'
  ) {
    const R = quatToMat({w: o.qw, x: o.qx, y: o.qy, z: o.qz});
    const wx = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
    const wy = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
    const wz = R[6] * v[0] + R[7] * v[1] + R[8] * v[2];
    const altDeg =
      Math.asin(Math.max(-1, Math.min(1, wz))) * (180 / Math.PI);
    const azMag = Math.atan2(wx, wy) * (180 / Math.PI);
    return {altDeg, azDeg: norm360(azMag + declinationDeg)};
  }
  if (isDefaultMount(cfg)) {
    return {
      altDeg: o.pitchDeg,
      azDeg: norm360(o.azimuthDeg + declinationDeg),
    };
  }
  return null;
}
