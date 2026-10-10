/**
 * AutoStar Droid — types partagés des catalogues du ciel.
 * Définis par le contrat d'architecture (services/catalog). NE PAS ÉDITER.
 */

export type ObjType = 'GALAXY' | 'GLOBULAR' | 'OPEN_CLUSTER' | 'NEBULA' | 'PLANETARY_NEBULA' | 'STAR' | 'DOUBLE_STAR' | 'ASTERISM' | 'OTHER' | 'PLANET' | 'MOON' | 'SUN';

export interface SkyObject {
  id: string;        // 'M31', 'NGC5139', 'STAR_Sirius' etc.
  name: string;      // nom courant ou désignation
  type: ObjType;
  raDeg: number;     // ascension droite en DEGRÉS décimaux (0-360, époque J2000)
  decDeg: number;    // déclinaison en DEGRÉS décimaux (négatif sud, époque J2000)
  mag: number;       // magnitude (0 si inconnue -> mettre 99)
  sizeMin?: number;  // taille apparente en minutes d'arc
  constel?: string;  // abbr. constellation 3 lettres IAU (AND, ORI...)
}
