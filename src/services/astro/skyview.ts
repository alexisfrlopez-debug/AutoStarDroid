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

import {D2R, R2D} from './telemetry';

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
 * Disposition des ÉTIQUETTES HORIZONTALES des objets (v2.4.0 — « je veux
 * les noms des objets horizontaux, et qu'ils soient cliquables »).
 *
 * RÈGLES :
 *  - le texte reste TOUJOURS horizontal (indépendant de la projection) ;
 *  - priorité aux objets les PLUS BRILLANTS : le tableau reçu doit être
 *    trié du plus prioritaire au moins prioritaire (la carte du ciel passe
 *    une copie « brillants d'abord ») — une étiquette qui chevauche une
 *    étiquette déjà posée est RETIRÉE (pas de cumul illisible) ;
 *  - l'étiquette se place à droite du point, sinon à gauche si elle
 *    débordait du cadre, bornée verticalement ;
 *  - le rectangle renvoyé sert aussi de ZONE CLIQUABLE (tap sur le nom).
 *
 * Largeur estimée : police système ~0,62 · fontSize par caractère.
 * 100 % pur — testable sous Jest.
 */

export interface LabelLayout {
  show: boolean;
  /** Coin gauche du texte (px). */
  x: number;
  /** Haut du texte (px). */
  y: number;
  /** Largeur estimée du texte (px). */
  w: number;
  /** Hauteur du texte (px). */
  h: number;
}

export function labelWidthPx(name: string, fontSize = 9): number {
  return Math.round(name.length * fontSize * 0.62) + 4;
}

export function layoutLabels<T extends ViewItem & {id: string}>(
  placed: Array<PlacedItem<T>>,
  opts: {
    width: number;
    height: number;
    dotSize: (item: T) => number;
    labelFor: (item: T, p: PlacedItem<T>) => string | null;
    fontSize?: number;
  },
): Map<T, LabelLayout> {
  const fs = opts.fontSize ?? 9;
  const h = Math.round(fs * 1.25);
  const out = new Map<T, LabelLayout>();
  const taken: Array<{x: number; y: number; w: number; h: number}> = [];
  for (const p of placed) {
    const name = opts.labelFor(p.item, p);
    if (!name) {
      out.set(p.item, {show: false, x: 0, y: 0, w: 0, h});
      continue;
    }
    const w = labelWidthPx(name, fs);
    const dot = opts.dotSize(p.item);
    let x = p.x + dot / 2 + 3;
    if (x + w > opts.width - 2) x = p.x - dot / 2 - 3 - w; // miroir si débordement
    let y = p.y - h / 2;
    // Bornes : reste dans le cadre, sans cacher le bord.
    if (x < 2) x = Math.min(opts.width - w - 2, p.x + dot / 2 + 3);
    if (x < 2) x = 2;
    y = Math.max(2, Math.min(opts.height - h - 2, y));
    // Anti-chevauchement : rectangles légèrement aérés.
    const r = {x: x - 3, y: y - 2, w: w + 6, h: h + 4};
    const hit = taken.some(
      (q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y,
    );
    if (hit) {
      out.set(p.item, {show: false, x, y, w, h});
      continue;
    }
    taken.push(r);
    out.set(p.item, {show: true, x, y, w, h});
  }
  return out;
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

/* ------------------------------------------------------------------ */
/* CENTRAGE DE LA CARTE (v2.9.5) — décision PURE, testée               */
/* ------------------------------------------------------------------ */

/** Fraîcheur d'une position télescope : au-delà, la position n'est plus
 *  « en direct » (raquette muette pendant un slew direct, liaison faible) —
 *  recentrer la carte dessus la ferait SAUTER en arrière. */
export const SKY_SCOPE_FRESH_MS = 8000;
/** Une cible récemment choisie reste le centre de secours 3 min : c'est
 *  elle que la monture rejoint (slew direct muet = position périmée). */
export const SKY_TARGET_HOLD_MS = 180000;

export type SkyCenterSrc = 'manual' | 'target' | 'scope' | 'phone';

export interface SkyCenterInput {
  /** Suivi actif (défaut) : la carte colle au télescope. Le glisser le
   *  désactive (exploration), un GOTO ou « Recentrer » le réarme. */
  follow: boolean;
  /** Centre posé à la main (pan). */
  manual: {altDeg: number; azDeg: number} | null;
  gotoRunning: boolean;
  /** Cible courante projetée en alt/az (null si aucune). */
  target: {altDeg: number; azDeg: number} | null;
  /** Cible choisie il y a moins de SKY_TARGET_HOLD_MS. */
  targetRecent: boolean;
  /** Télescope projeté en alt/az (null si non connecté/sans position). */
  scope: {altDeg: number; azDeg: number} | null;
  /** Télescope lu depuis moins de SKY_SCOPE_FRESH_MS. */
  scopeFresh: boolean;
  /** Visée du tube déduite des capteurs du téléphone (repli). */
  phone: {altDeg: number; azDeg: number} | null;
  /** Défaut quand rien n'est disponible. */
  fallback: {altDeg: number; azDeg: number};
}

export interface SkyCenter {
  altDeg: number;
  azDeg: number;
  src: SkyCenterSrc;
}

/**
 * Décision de centrage de la carte du ciel (v2.9.5 — remplace la priorité
 * v2.9.4 « le pan manuel gagne jusqu'au GOTO suivant », qui figeait la carte :
 * « elle revient ensuite dans sa position initiale et ne suit pas le
 * chercheur »).
 *
 * Priorité :
 *  1. EXPLORATION (suivi coupé par le glisser) : la carte reste où posée ;
 *     le télescope reste visible via son marqueur ✛ cyan.
 *  2. GOTO EN COURS : la carte va sur la CIBLE — pas de saut vers la
 *     position périmée du télescope (« revient dans sa position initiale »).
 *  3. TÉLESCOPE FRAÎS : suivi live (dérive de suivi incluse, 1 Hz).
 *  4. CIBLE RÉCENTE si le télescope est muet (slew direct : :MS parti, la
 *     raquette ne répond plus :Gr#/:Gd# avant l'arrivée) — la carte attend
 *     sur la destination au lieu de repartir vers la vieille position.
 *  5. TÉLESCOPE périmé (mieux que rien), puis téléphone, puis défaut.
 */
export function skyCenter(inp: SkyCenterInput): SkyCenter {
  if (!inp.follow && inp.manual) return {...inp.manual, src: 'manual'};
  if (inp.gotoRunning && inp.target) return {...inp.target, src: 'target'};
  if (inp.scope && inp.scopeFresh) return {...inp.scope, src: 'scope'};
  if (inp.target && inp.targetRecent) return {...inp.target, src: 'target'};
  if (inp.scope) return {...inp.scope, src: 'scope'};
  if (inp.phone && !inp.manual) return {...inp.phone, src: 'phone'};
  if (inp.manual) return {...inp.manual, src: 'manual'};
  return {...inp.fallback, src: 'phone'};
}
