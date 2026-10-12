/**
 * Tests v2.8.0 — FILTRES DE LUMIÈRE sur les acquisitions
 * (src/services/astro/filters.ts — 100 % pur) :
 *  - trame noire (soustraction bornée à 0) + trame flat (division normalisée) ;
 *  - pixels chauds : comptage + remplacement par la médiane des voisins ;
 *  - fond de ciel : statistiques (niveau/pente) + retrait du gradient ;
 *  - débruitage médian, netteté (masque flou), étirement percentiles+gamma ;
 *  - SÉLECTION AUTOMATIQUE (recommendFilters) : règles de pertinence ;
 *  - pipeline applyFrameFilters / applyPostFilters + activeFilterKeys.
 */
import {
  subtractDark, applyFlat, countHotPixels, removeHotPixels,
  backgroundStats, removeGradient, medianDenoise, unsharpMask,
  recommendFilters, applyFrameFilters, applyPostFilters, activeFilterKeys,
  stretchPct, DEFAULT_FILTERS, NO_FILTERS,
} from '../src/services/astro/filters';

const W = 192; const H = 144;
const size = W * H;

const flat = (v: number) => new Uint8Array(size).fill(v);

/** Image synthétique : fond + gradient horizontal + étoile brillante. */
function synthImage(bg: number, grad: number, starVal = 0): Uint8Array {
  const g = new Uint8Array(size);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      g[y * W + x] = Math.min(255, bg + Math.round((grad * x) / W));
    }
  }
  if (starVal > 0) g[(H >> 1) * W + (W >> 1)] = starVal;
  return g;
}

describe('trames de calibrage — noire et flat', () => {
  it('trame noire : soustraction pixel à pixel, bornée à 0', () => {
    const frame = flat(120);
    const dark = flat(50);
    const out = subtractDark(frame, dark);
    expect(out[0]).toBe(70);
    // zone où la dark dépasse la frame → 0 (jamais négatif, Uint8)
    const out2 = subtractDark(flat(30), flat(80));
    expect(out2[0]).toBe(0);
  });

  it('trame flat : division par la flat normalisée (vignettage corrigé)', () => {
    // frame uniforme 100 ; flat = 80 au bord, 160 au centre (médiane 80..160 → disons 120)
    const frame = flat(100);
    const flatFrame = synthImage(120, 80); // 120..200, médiane ~160
    const out = applyFlat(frame, flatFrame);
    // les zones plus sombres de la flat (120) remontent plus que les claires
    expect(out[0]).toBeGreaterThan(out[size - 1]);
    // pixel bouché (≤ 8) : remplacé par la médiane → neutre
    const flatBlocked = flat(4);
    const out3 = applyFlat(flat(100), flatBlocked);
    expect(out3[0]).toBe(100);
  });
});

describe('pixels chauds — comptage + retrait', () => {
  it('détecte les pixels isolés ≫ voisins, pas les étoiles larges', () => {
    const img = flat(50);
    img[72 * W + 96] = 200; // pixel chaud isolé (écart 150 > 60)
    expect(countHotPixels(img, W, H)).toBe(1);
  });

  it('removeHotPixels remplace par la médiane des 8 voisins', () => {
    const img = flat(50);
    const i = 72 * W + 96;
    img[i] = 220;
    const out = removeHotPixels(img, W, H);
    expect(out[i]).toBe(50);
    // les autres pixels inchangés
    expect(out[0]).toBe(50);
  });

  it('un pixel entouré de voisins élevés (cœur d\'étoile, motif) n\'est PAS retiré', () => {
    const img = flat(50);
    const i = 72 * W + 96;
    img[i] = 200;
    img[i - 1] = 190;
    img[i + 1] = 195; // le pixel ne domine plus TOUS ses voisins de > 80
    expect(countHotPixels(img, W, H)).toBe(0);
  });
});

describe('fond de ciel — stats + gradient', () => {
  it('backgroundStats mesure le niveau ET la pente', () => {
    const s = backgroundStats(synthImage(40, 60), W, H);
    expect(s.level).toBeGreaterThanOrEqual(40);
    expect(s.gradient).toBeGreaterThan(20);
    const s2 = backgroundStats(flat(40), W, H);
    expect(s2.gradient).toBe(0);
  });

  it('removeGradient aplatit un fond dégradé en préservant l\'étoile', () => {
    const img = synthImage(60, 120, 250);
    const before = backgroundStats(img, W, H);
    const out = removeGradient(img, W, H);
    const s = backgroundStats(out, W, H);
    // la PENTE du fond est fortement résorbée (90 → ~11 : résidu
    // d\'interpolation bilinéaire) — la pente est le critère pertinent
    expect(s.gradient).toBeLessThan(20);
    // le niveau retenu ≈ ciel minimal (base) : jamais sous 0, le signal
    // faible n\'est pas écrasé — mais DESCENDU par rapport à l\'entrée
    expect(s.level).toBeLessThan(before.level);
    // l'étoile survit (signal positif préservé)
    const star = out[(H >> 1) * W + (W >> 1)];
    expect(star).toBeGreaterThan(100);
  });
});

describe('débruitage + netteté + étirement', () => {
  it('medianDenoise gomme les outliers isolés, garde les uniformes', () => {
    const img = flat(80);
    img[10 * W + 10] = 255;
    const out = medianDenoise(img, W, H);
    expect(out[10 * W + 10]).toBe(80);
    expect(out[50 * W + 50]).toBe(80);
  });

  it('unsharpMask accentue le contraste local (netteté)', () => {
    const img = synthImage(80, 0); // uniforme
    img[72 * W + 96] = 200; // point contrasté
    const out = unsharpMask(img, W, H, 0.8);
    expect(out[72 * W + 96]).toBeGreaterThanOrEqual(200);
    // un pixel voisin (flou < original) est légèrement assombri
    expect(out[72 * W + 95]).toBeLessThan(80);
  });

  it('stretchPct : percentiles plein débattement, gamma < 1 éclaircit', () => {
    const g = synthImage(60, 40);
    const out = stretchPct(g, 1);
    expect(Math.max(...out)).toBeGreaterThan(200);
    const soft = stretchPct(g, 0.85);
    // gamma < 1 : les faibles valeurs montent plus
    let sumSoft = 0; let sumLin = 0;
    for (let i = 0; i < size; i++) { sumSoft += soft[i]; sumLin += out[i]; }
    expect(sumSoft).toBeGreaterThan(sumLin);
  });
});

describe('sélection automatique (recommendFilters)', () => {
  it('ciel propre : ni pixels chauds, ni gradient, ni débruitage', () => {
    const plan = recommendFilters(flat(30), W, H);
    expect(plan.hotPixels).toBe(false);
    expect(plan.gradient).toBe(false);
    expect(plan.denoise).toBe(false);
    expect(plan.auto).toBe(true);
  });

  it('fond élevé + gradient → anti-pollution activé', () => {
    const plan = recommendFilters(synthImage(70, 120), W, H);
    expect(plan.gradient).toBe(true);
  });

  it('pixels chauds denses → filtre activé', () => {
    const img = flat(40);
    for (let k = 0; k < 400; k++) img[(k * 61) % size] = 200; // densité ~1,4 %
    const plan = recommendFilters(img, W, H);
    expect(plan.hotPixels).toBe(true);
  });

  it('trames capturées → dark/flat actifs ; sinon désactivés', () => {
    const withBoth = recommendFilters(flat(30), W, H, true, true);
    expect(withBoth.dark).toBe(true);
    expect(withBoth.flat).toBe(true);
    const none = recommendFilters(flat(30), W, H, false, false);
    expect(none.dark).toBe(false);
    expect(none.flat).toBe(false);
  });

  it('bruit fort → débruitage ; netteté jamais en auto', () => {
    // bruit haute fréquence : damier ±40
    const noisy = new Uint8Array(size);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        noisy[y * W + x] = 80 + ((x + y) % 2 === 0 ? 40 : 0);
      }
    }
    const plan = recommendFilters(noisy, W, H);
    expect(plan.denoise).toBe(true);
    expect(plan.sharpen).toBe(false);
  });
});

describe('pipeline complet (pré + post empilement)', () => {
  it('applyFrameFilters : noire puis flat puis pixels chauds (ordre)', () => {
    const frame = flat(150);
    frame[72 * W + 96] = 250; // pixel chaud
    const dark = flat(100);
    const out = applyFrameFilters(
      frame, {...DEFAULT_FILTERS, auto: false, hotPixels: true},
      dark, null, W, H,
    );
    expect(out[0]).toBe(50); // 150 - 100
    expect(out[72 * W + 96]).toBeLessThanOrEqual(60); // chaud écrêté puis soustrait
  });

  it('trames absentes → applyFrameFilters no-op sur dark/flat', () => {
    const frame = flat(150);
    const out = applyFrameFilters(frame, DEFAULT_FILTERS, null, null, W, H);
    expect(out[0]).toBe(150);
  });

  it('applyPostFilters : la pente du fond reste réduite APRÈS étirement', () => {
    const stacked = synthImage(70, 100, 250);
    // sans filtre : l\'étirement passe la PENTE complète à l\'échelle
    const raw = stretchPct(stacked, 0.85);
    const gRaw = backgroundStats(raw, W, H).gradient;
    // avec filtre : le résidu (≈11 niveaux pré-étirement) est amplifié par
    // l\'auto-étirement mais reste NETTEMENT plus faible que sans filtre
    const out = applyPostFilters(stacked, {...DEFAULT_FILTERS, denoise: false}, W, H);
    const gOut = backgroundStats(out, W, H).gradient;
    expect(gOut).toBeLessThan(gRaw * 0.6);
    // l'image finale utilise tout le débattement (étirement)
    expect(Math.max(...out)).toBeGreaterThan(180);
  });

  it('activeFilterKeys liste les filtres actifs dans l\'ordre d\'exécution', () => {
    const keys = activeFilterKeys(DEFAULT_FILTERS);
    expect(keys).toEqual(['filterDark', 'filterFlat', 'filterHot', 'filterGradient']);
    expect(activeFilterKeys(NO_FILTERS)).toEqual([]);
  });
});
