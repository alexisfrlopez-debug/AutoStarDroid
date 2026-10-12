/**
 * Projection de la voûte céleste pour la CARTE DU CIEL (v2.3.0 — « une
 * carte du ciel interactive qui affiche ce que voit le chercheur »).
 *
 * PROJECTION GNOMONIQUE : la sphère céleste est projetée depuis son centre
 * sur le plan tangent à la direction visée (centre de la carte). C'est la
 * projection « à l'œil nu » : les grands cercles restent droits, le champ
 * couvert reste fidèle jusqu'à ~60-70° (au-delà : déformation assumée).
 *
 * CONVENTIONS :
 *  - la vue simule l'ŒIL qui regarde le ciel : l'axe horizontal de l'écran
 *    suit l'azimut CROISSANT vers la droite (face au sud, l'ouest est à
 *    droite et l'est à gauche — comme dans un chercheur tenu debout) ;
 *  - l'axe vertical suit la hauteur (haut = zénith) ;
 *  - `mirror` retourne l'horizontale : image INVERSÉE par l'optique d'un
 *    chercheur à lentille de Barlow (configuration la plus courante sur
 *    les DS/ETX) — l'utilisateur compare ce qu'il VOIT dans l'oculaire.
 *
 * 100 % pur TypeScript, aucune dépendance RN — testable sous Jest.
 */

export interface ViewItem {
  /** Hauteur/azimut de l'objet (deg) — azimut 0=N, 90=E. */
  altDeg: number;
  azDeg: number;
}

export interface PlacedItem<T extends ViewItem> {
  item: T;
  /** Coordonnées écran (px, origine coin haut-gauche). */
  x: number;
  y: number;
  /** Visibles dans le cadre projeté (derrière le plan tangent = exclu). */
  visible: boolean;
  /** Distance angulaire au centre (deg). */
  sepDeg: number;
}

export interface ViewGeometry {
  centerAltDeg: number;
  centerAzDeg: number;
  /** Champ total de la vue (deg) — diameter couvert par la DEMI-largeur. */
  fovDeg: number;
  width: number;
  height: number;
  mirror: boolean;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Vecteur unitaire (Est, Nord, Up) depuis alt/az (deg). */
export function altAzToENU(altDeg: number, azDeg: number): [number, number, number] {
  const alt = altDeg * D2R;
  const az = azDeg * D2R;
  return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
}

/**
 * Projette des objets sur la vue. La carte couvre un champ carré de
 * `fovDeg` de côté (le repère : tan(fov/2) correspond à la demi-largeur).
 * Les objets DERRIÈRE le plan tangent (sep ≥ 90°) sont renvoyés invisibles.
 */
export function projectView<T extends ViewItem>(
  items: T[],
  g: ViewGeometry,
): Array<PlacedItem<T>> {
  const c = altAzToENU(g.centerAltDeg, g.centerAzDeg);
  // Tangente EST : dérivée de la direction par rapport à l'azimut,
  // normalisée — pointe vers l'azimut croissant.
  const e: [number, number, number] = [Math.cos(g.centerAzDeg * D2R), -Math.sin(g.centerAzDeg * D2R), 0];
  // Tangente « haut » : direction de hauteur croissante à azimut fixe.
  const a = g.centerAltDeg * D2R;
  const z = g.centerAzDeg * D2R;
  const n: [number, number, number] = [-Math.sin(a) * Math.sin(z), -Math.sin(a) * Math.cos(z), Math.cos(a)];
  const scale = Math.min(g.width, g.height) / 2 / Math.tan((g.fovDeg / 2) * D2R);

  return items.map((item) => {
    const p = altAzToENU(item.altDeg, item.azDeg);
    const depth = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
    let dx = p[0] * e[0] + p[1] * e[1] + p[2] * e[2];
    const dy = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    const sepDeg = Math.acos(Math.max(-1, Math.min(1, depth))) * R2D;
    if (depth <= 0.02 || !isFinite(depth)) {
      return {item, x: 0, y: 0, visible: false, sepDeg};
    }
    const sx = (dx / depth) * scale;
    const sy = (dy / depth) * scale;
    return {
      item,
      x: g.width / 2 + (g.mirror ? -sx : sx),
      y: g.height / 2 - sy,
      visible: true,
      sepDeg,
    };
  });
}

/** Rayon écran (px) du cercle de champ `circleFovDeg` (réticule chercheur). */
export function fovCircleRadiusPx(circleFovDeg: number, g: ViewGeometry): number {
  return Math.tan((circleFovDeg / 2) * D2R) * (Math.min(g.width, g.height) / 2 / Math.tan((g.fovDeg / 2) * D2R));
}

/**
 * Déplacement du CENTRE après un glissement de doigt (deg) : l'utilisateur
 * panne la carte à la main quand aucune position télémétrique n'est
 * disponible. Le facteur suit la projection (fov / pixels).
 */
export function panCenter(
  centerAltDeg: number,
  centerAzDeg: number,
  dxPx: number,
  dyPx: number,
  g: Pick<ViewGeometry, 'fovDeg' | 'width' | 'height'>,
): {altDeg: number; azDeg: number} {
  const scale = Math.min(g.width, g.height) / 2 / Math.tan((g.fovDeg / 2) * D2R);
  // Le doigt tire la carte : le centre se déplace EN SENS INVERSE du doigt.
  const dAz = (-dxPx / scale) * R2D / Math.max(0.2, Math.cos(centerAltDeg * D2R));
  const dAlt = (dyPx / scale) * R2D;
  const alt = Math.max(1, Math.min(89, centerAltDeg + dAlt));
  const az = ((centerAzDeg + dAz) % 360 + 360) % 360;
  return {altDeg: alt, azDeg: az};
}
