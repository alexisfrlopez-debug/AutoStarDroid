/**
 * Rendu VISUEL de la carte du ciel (v2.5.0 — « j'aimerais une carte du ciel
 * un peu plus jolie ») — fonctions PURES : tailles/halos/couleurs d'étoiles,
 * couleurs des planètes, segments d'astérismes. Le tracé SVG vit dans
 * SkyScreen ; tout ce qui se calcule est ici, testé.
 */

/** Une étoile : noyau + halo. Couleur selon la magnitude (chaud ← → bleuté). */
export interface StarVisual {
  /** Rayon du NOYAU (px). */
  coreR: number;
  /** Rayon du HALO (px) — cercle translucide derrière le noyau. */
  glowR: number;
  /** Opacité du halo. */
  glowOpacity: number;
  /** Teinte : bleuté pour les brillantes, blanc chaud pour les faibles. */
  color: string;
}

export function starVisual(mag: number): StarVisual {
  if (mag < 0) return {coreR: 4.4, glowR: 12, glowOpacity: 0.30, color: '#C9D8FF'};
  if (mag < 1) return {coreR: 3.8, glowR: 10, glowOpacity: 0.26, color: '#D3DEFF'};
  if (mag < 2) return {coreR: 3.1, glowR: 8, glowOpacity: 0.22, color: '#E2E8FF'};
  if (mag < 3) return {coreR: 2.5, glowR: 6.2, glowOpacity: 0.18, color: '#EFF1E9'};
  if (mag < 4.5) return {coreR: 1.9, glowR: 4.6, glowOpacity: 0.14, color: '#F2EFE2'};
  return {coreR: 1.4, glowR: 3.2, glowOpacity: 0.10, color: '#E8E4D6'};
}

/** Couleurs distinctives des planètes/Lune/Soleil (id d'objet catalogue). */
export function planetColor(id: string): string {
  switch (id) {
    case 'PLANET_MERCURY': return '#C9C4B8';
    case 'PLANET_VENUS': return '#F5F2E4';
    case 'PLANET_MARS': return '#EF8A62';
    case 'PLANET_JUPITER': return '#EED9A4';
    case 'PLANET_SATURN': return '#E9D59A';
    case 'PLANET_URANUS': return '#BFE3E8';
    case 'PLANET_NEPTUNE': return '#9FC2E8';
    case 'MOON': return '#E9E6D8';
    case 'SUN': return '#FFE9AE';
    default: return '#8FD6A8';
  }
}

/** Rayon (px) du disque lunaire/planétaire selon le diamètre apparent. */
export function discRadiusPx(diameterArcmin: number, pxPerDeg: number): number {
  const r = (diameterArcmin / 60 / 2) * pxPerDeg;
  return Math.max(3.5, Math.min(r, 90));
}

/**
 * Astérismes tracés — uniquement des étoiles PRÉSENTES dans BRIGHT_STARS
 * (ids stables du catalogue généré). Orion et Cassiopée complets ; Ourse
 * partielle (4 étoiles du timon), Croix du Cygne sur son grand axe,
 * Croix du Sud sur son grand axe.
 */
export const ASTERISMS: Array<{id: string; label: string; pairs: Array<[string, string]>}> = [
  {
    id: 'ORI', label: 'Orion',
    pairs: [
      ['STAR_Meissa', 'STAR_Betelgeuse'], ['STAR_Meissa', 'STAR_Bellatrix'],
      ['STAR_Betelgeuse', 'STAR_Alnitak'], ['STAR_Bellatrix', 'STAR_Mintaka'],
      ['STAR_Alnitak', 'STAR_Alnilam'], ['STAR_Alnilam', 'STAR_Mintaka'],
      ['STAR_Alnitak', 'STAR_Saiph'], ['STAR_Mintaka', 'STAR_Rigel'],
      ['STAR_Saiph', 'STAR_Rigel'],
    ],
  },
  {
    id: 'UMA', label: 'Grande Ourse',
    pairs: [
      ['STAR_Alkaid', 'STAR_Mizar'], ['STAR_Mizar', 'STAR_Alioth'],
      ['STAR_Alioth', 'STAR_Dubhe'],
    ],
  },
  {
    id: 'CAS', label: 'Cassiopée',
    pairs: [
      ['STAR_Caph', 'STAR_Schedar'], ['STAR_Schedar', 'STAR_Navi'],
      ['STAR_Navi', 'STAR_Ruchbah'], ['STAR_Ruchbah', 'STAR_Segin'],
    ],
  },
  {
    id: 'CYG', label: 'Croix du Nord',
    pairs: [['STAR_Deneb', 'STAR_Sadr'], ['STAR_Sadr', 'STAR_Albireo']],
  },
  {
    id: 'CRU', label: 'Croix du Sud',
    pairs: [['STAR_Acrux', 'STAR_Gacrux'], ['STAR_Mimosa', 'STAR_Gacrux']],
  },
];

/** Segment projeté d'une paire d'étoiles (null si une étoile est hors champ). */
export interface Segment {x1: number; y1: number; x2: number; y2: number}

export function asterismSegments<P extends {item: {id: string}; x: number; y: number}>(
  placed: P[],
): Segment[] {
  const byId = new Map(placed.map((p) => [p.item.id, p]));
  const segs: Segment[] = [];
  for (const ast of ASTERISMS) {
    for (const [a, b] of ast.pairs) {
      const pa = byId.get(a);
      const pb = byId.get(b);
      if (pa && pb) segs.push({x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y});
    }
  }
  return segs;
}

/**
 * Points de l'HORIZON (alt 0°) pour l'arc d'horizon de la carte — azimuts
 * réguliers ; la projection est faite par projectView côté écran.
 */
export function horizonAzSamples(count = 48): Array<{altDeg: number; azDeg: number}> {
  const out: Array<{altDeg: number; azDeg: number}> = [];
  for (let i = 0; i < count; i++) {
    out.push({altDeg: 0, azDeg: (i * 360) / count});
  }
  return out;
}
