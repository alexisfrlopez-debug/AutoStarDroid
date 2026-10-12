/**
 * Tests v2.4.0 — ÉTIQUETTES HORIZONTALES de la carte du ciel
 * (astro/skyview.ts : layoutLabels + labelWidthPx).
 *
 * Demande utilisateur : « je veux les noms des objets horizontaux, et
 * qu'ils soient cliquables (option goto et sync telescope) ».
 *
 * Contrats verrouillés :
 *   1. le rect renvoyé est TOUJOURS un rectangle horizontal (h constant,
 *      pas de rotation — le Text est posé tel quel) ;
 *   2. priorité aux plus brillants : une étiquette qui chevauche une
 *      étiquette déjà posée est retirée (show = false) ;
 *   3. miroir près du bord droit (le nom ne sort pas du cadre) ;
 *   4. bornes verticales ;
 *   5. le rect sert de zone cliquable → il contient le texte + marge.
 */
import {layoutLabels, labelWidthPx, projectView, type PlacedItem} from '../src/services/astro/skyview';

interface TItem {
  id: string;
  name: string;
  mag: number;
  altDeg: number;
  azDeg: number;
}

function item(id: string, mag: number, altDeg: number, azDeg: number, name = id): TItem {
  return {id, name, mag, altDeg, azDeg};
}

function placedOf(items: TItem[], width = 320, height = 320): Array<PlacedItem<TItem>> {
  return projectView(items, {
    centerAltDeg: 45, centerAzDeg: 180, fovDeg: 15, width, height, mirror: false,
  });
}

describe('labelWidthPx', () => {
  it('croît avec la longueur du nom', () => {
    expect(labelWidthPx('Vega')).toBeGreaterThan(labelWidthPx('M31'));
    expect(labelWidthPx('M31')).toBe(Math.round(3 * 9 * 0.62) + 4);
  });
});

describe('layoutLabels', () => {
  it('étiquette posée à droite du point, verticalement centrée (rectangle horizontal)', () => {
    const items = [item('Vega', 0.0, 45, 180)];
    const placed = placedOf(items);
    const map = layoutLabels(placed, {
      width: 320, height: 320,
      dotSize: (it) => (it.mag < 1 ? 8 : 5),
      labelFor: (it) => it.name,
    });
    const lay = map.get(items[0])!;
    expect(lay.show).toBe(true);
    const p = placed[0];
    expect(lay.x).toBeCloseTo(p.x + 8 / 2 + 3, 6);
    expect(lay.y).toBeCloseTo(p.y - lay.h / 2, 6);
    expect(lay.w).toBe(labelWidthPx('Vega'));
    expect(lay.h).toBe(Math.round(9 * 1.25));
  });

  it('anti-chevauchement : le plus brillant garde le nom, le pâle le perd', () => {
    // Deux objets quasi superposés (0,1° d'écart)
    const items = [item('Bright', 0.5, 45.0, 180.0), item('Faint', 6.5, 45.05, 180.0)];
    const placed = placedOf(items);
    // Priorité : brillants d'abord (ordre du tableau)
    const map = layoutLabels(placed, {
      width: 320, height: 320,
      dotSize: () => 6,
      labelFor: (it) => it.name,
    });
    expect(map.get(items[0])!.show).toBe(true);
    expect(map.get(items[1])!.show).toBe(false);
  });

  it('miroir près du bord droit : l\'étiquette passe à gauche du point', () => {
    const items = [item('Aldebaran', 1.0, 45, 180)];
    const placed = placedOf(items, 200, 200);
    // Force l'objet près du bord droit : centre az calé pour l'amener au bord
    const near = placed.map((p) => ({...p, x: 190, y: 100}));
    const map = layoutLabels(near, {
      width: 200, height: 200,
      dotSize: () => 6,
      labelFor: (it) => it.name,
    });
    const lay = map.get(items[0])!;
    expect(lay.show).toBe(true);
    // à droite ça déborderait : x = 190 + 3 + 3 + w > 198 → miroir
    expect(lay.x + lay.w).toBeLessThanOrEqual(200);
    expect(lay.x).toBeLessThan(190);
  });

  it('bornes verticales : jamais au-dessus de 2 px ni sous le bas du cadre', () => {
    const items = [item('Haut', 1.0, 45, 180), item('Bas', 1.2, 45, 180)];
    const placed = placedOf(items);
    const moved = placed.map((p, i) => ({...p, y: i === 0 ? 1 : 318}));
    const map = layoutLabels(moved, {
      width: 320, height: 320,
      dotSize: () => 6,
      labelFor: (it) => it.name,
    });
    const l0 = map.get(items[0])!;
    const l1 = map.get(items[1])!;
    expect(l0.y).toBeGreaterThanOrEqual(2);
    expect(l1.y + l1.h).toBeLessThanOrEqual(320);
  });

  it('labelFor = null → pas d\'étiquette (mais entrée présente)', () => {
    const items = [item('Invisible', 9.9, 45, 180)];
    const map = layoutLabels(placedOf(items), {
      width: 320, height: 320,
      dotSize: () => 5,
      labelFor: () => null,
    });
    expect(map.get(items[0])!.show).toBe(false);
  });

  it('le rect est assez grand pour servir de zone cliquable au nom entier', () => {
    const items = [item('Alcor&Mizar', 3.9, 45, 180)];
    const map = layoutLabels(placedOf(items), {
      width: 320, height: 320,
      dotSize: () => 6,
      labelFor: (it) => it.name,
    });
    const lay = map.get(items[0])!;
    expect(lay.w).toBeGreaterThanOrEqual(labelWidthPx('Alcor&Mizar') - 1);
  });

  it('deux objets éloignés gardent tous deux leur nom', () => {
    const items = [item('Est', 1.0, 45, 178.0), item('Ouest', 1.1, 45, 182.0)];
    const map = layoutLabels(placedOf(items), {
      width: 320, height: 320,
      dotSize: () => 6,
      labelFor: (it) => it.name,
    });
    expect(map.get(items[0])!.show).toBe(true);
    expect(map.get(items[1])!.show).toBe(true);
  });
});
