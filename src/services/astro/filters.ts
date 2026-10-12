/**
 * FILTRES DE LUMIÈRE / TRAITEMENT D'IMAGES (v2.8.0 — demande utilisateur :
 * « appliquer des filtres de lumière sur les acquisitions d'image,
 * sélection manuelle ou automatique afin d'améliorer les traitements
 * d'image, option intégrée dans les workflows de traitement automatique
 * lorsque c'est pertinent »).
 *
 * Tout est PUR et testé — opère sur les images grises de l'anneau natif
 * (192×144, même domaine que stacking.ts). Deux familles :
 *  - PRÉ-EMPILEMENT (par frame) : soustraction de la TRAME NOIRE (offset
 *    thermique + pixels chauds permanents), correction de TRAME FLAT
 *    (vignettage), retrait des PIXELS CHAUDS isolés — améliorent la
 *    qualité du signal AVANT la moyenne (l'empilement ne peut pas les
 *    corriger après coup) ;
 *  - POST-EMPILEMENT : réduction du FOND DE CIEL / pollution lumineuse
 *    (gradient par grille bilinéaire), débruitage doux (médiane 3×3),
 *    étirement gamma, netteté (masque flou) — appliqués à l'image finale.
 *
 * SÉLECTION AUTOMATIQUE (recommendFilters) : mesure les statistiques de la
 * première frame (bruit par MAD, densité de pixels chauds, niveau et
 * pente du fond) et n'active que les filtres PERTINENTS — le workflow
 * d'acquisition automatique l'appelle quand le mode auto est choisi.
 */

export interface FilterPlan {
  /** Sélection automatique d'après les statistiques de l'image. */
  auto: boolean;
  /** Soustraction de la trame noire (nécessite une trame capturée). */
  dark: boolean;
  /** Correction de trame flat (nécessite une trame capturée). */
  flat: boolean;
  /** Retrait des pixels chauds isolés (médiane des voisins). */
  hotPixels: boolean;
  /** Réduction du fond de ciel / pollution lumineuse (gradient). */
  gradient: boolean;
  /** Débruitage doux (médiane 3×3) après empilement. */
  denoise: boolean;
  /** Netteté (masque flou) après empilement. */
  sharpen: boolean;
  /** Gamma de l'étirement final (1 = linéaire). */
  gamma: number;
}

export const DEFAULT_FILTERS: FilterPlan = {
  auto: true, dark: true, flat: true, hotPixels: true,
  gradient: true, denoise: false, sharpen: false, gamma: 0.85,
};

/** Filtres désactivés (aucun traitement). */
export const NO_FILTERS: FilterPlan = {
  auto: false, dark: false, flat: false, hotPixels: false,
  gradient: false, denoise: false, sharpen: false, gamma: 1,
};

/* ------------------------------------------------------------ */
/* Trames de calibrage                                            */
/* ------------------------------------------------------------ */

/** Soustraction de la TRAME NOIRE (offset + signal thermique capturé
 *  objectif couvert) : pixel = max(0, frame − dark). Pré-empilement. */
export function subtractDark(frame: Uint8Array, dark: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] - dark[i];
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/** Correction de TRAME FLAT (vignettage + poussières) : la flat est
 *  normalisée par sa médiane puis la frame est divisée — les zones
 *  sombres du flat sont remontées. Pré-empilement. */
export function applyFlat(frame: Uint8Array, flat: Uint8Array): Uint8Array {
  const n = flat.length;
  if (n === 0) return new Uint8Array(frame);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) hist[flat[i]] += 1;
  let acc = 0;
  let med = 128;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n / 2) { med = v; break; }
  }
  if (med <= 0) med = 1;
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const g = flat[i] <= 8 ? med : flat[i]; // pixel bouché : neutre
    out[i] = Math.min(255, Math.round((frame[i] * med) / g));
  }
  return out;
}

/* ------------------------------------------------------------ */
/* Pixels chauds                                                  */
/* ------------------------------------------------------------ */

/** Médiane des 8 voisins (0 en bord — les bords ne comptent pas). */
function neighborMedian(f: Uint8Array, w: number, h: number, x: number, y: number): number {
  const vals: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      vals.push(f[yy * w + xx]);
    }
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

/**
 * Pixel CHAUD = pixel qui DOMINE TOUS ses voisins de plus de `threshold`
 * (règle conservatrice : les cœurs d'étoiles — entourés d'ailes brillantes —
 * et les bords des motifs étendus ne sont JAMAIS retirés ; seuls les spikes
 * thermiques isolés le sont — indispensable en astronomie).
 */
function isHotPixel(frame: Uint8Array, w: number, h: number, x: number, y: number, threshold: number): boolean {
  const v = frame[y * w + x];
  let maxN = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const nv = frame[yy * w + xx];
      if (nv > maxN) maxN = nv;
    }
  }
  return v - maxN > threshold;
}

/** Compte les PIXELS CHAUDS isolés (pixel ≫ TOUS ses voisins). */
export function countHotPixels(frame: Uint8Array, w: number, h: number, threshold = 80): number {
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (isHotPixel(frame, w, h, x, y, threshold)) count += 1;
    }
  }
  return count;
}

/** Retire les pixels chauds : remplacés par la médiane de leurs voisins. */
export function removeHotPixels(frame: Uint8Array, w: number, h: number, threshold = 80): Uint8Array {
  const out = new Uint8Array(frame);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (isHotPixel(frame, w, h, x, y, threshold)) {
        out[y * w + x] = neighborMedian(frame, w, h, x, y);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ */
/* Fond de ciel / pollution lumineuse                             */
/* ------------------------------------------------------------ */

export interface BackgroundStats {
  /** Niveau médian du fond (percentile 10 global). */
  level: number;
  /** Amplitude du gradient (max − min des cellules). */
  gradient: number;
}

/** Statistiques de fond : grille 4×3 de percentiles 10 — mesure le niveau
 *  ET la pente du ciel (pollution lumineuse = gradient spatial). */
export function backgroundStats(frame: Uint8Array, w: number, h: number): BackgroundStats {
  const GX = 4;
  const GY = 3;
  const cells: number[] = [];
  for (let gy = 0; gy < GY; gy++) {
    for (let gx = 0; gx < GX; gx++) {
      const x0 = Math.floor((gx * w) / GX);
      const x1 = Math.floor(((gx + 1) * w) / GX);
      const y0 = Math.floor((gy * h) / GY);
      const y1 = Math.floor(((gy + 1) * h) / GY);
      const vals: number[] = [];
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) vals.push(frame[y * w + x]);
      }
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      cells.push(vals[Math.floor(vals.length * 0.1)]);
    }
  }
  if (cells.length === 0) return {level: 0, gradient: 0};
  const sorted = [...cells].sort((a, b) => a - b);
  return {
    level: sorted[Math.floor(sorted.length / 2)],
    gradient: sorted[sorted.length - 1] - sorted[0],
  };
}

/** Retire le FOND DE CIEL (pollution lumineuse) : fond estimé par grille
 *  4×3 (percentile 10 par cellule) interpolé bilinéairement puis soustrait.
 *  Post-empilement (le gradient moyené est stable). */
export function removeGradient(frame: Uint8Array, w: number, h: number): Uint8Array {
  const GX = 4;
  const GY = 3;
  const grid: number[] = [];
  for (let gy = 0; gy < GY; gy++) {
    for (let gx = 0; gx < GX; gx++) {
      const x0 = Math.floor((gx * w) / GX);
      const x1 = Math.floor(((gx + 1) * w) / GX);
      const y0 = Math.floor((gy * h) / GY);
      const y1 = Math.floor(((gy + 1) * h) / GY);
      const vals: number[] = [];
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) vals.push(frame[y * w + x]);
      }
      if (vals.length === 0) { grid.push(0); continue; }
      vals.sort((a, b) => a - b);
      grid.push(vals[Math.floor(vals.length * 0.1)]);
    }
  }
  // minimum du grid soustrait aussi : on retire la pente + le niveau,
  // en gardant un peu de marge (le ciel n'est jamais à 0 exactement)
  const base = Math.min(...grid);
  const out = new Uint8Array(frame.length);
  for (let y = 0; y < h; y++) {
    // positions continues dans la grille
    const fy = ((y + 0.5) * GY) / h - 0.5;
    const gy0 = Math.max(0, Math.min(GY - 1, Math.floor(fy)));
    const gy1 = Math.min(GY - 1, gy0 + 1);
    const ty = Math.max(0, Math.min(1, fy - gy0));
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) * GX) / w - 0.5;
      const gx0 = Math.max(0, Math.min(GX - 1, Math.floor(fx)));
      const gx1 = Math.min(GX - 1, gx0 + 1);
      const tx = Math.max(0, Math.min(1, fx - gx0));
      const g00 = grid[gy0 * GX + gx0] - base;
      const g10 = grid[gy0 * GX + gx1] - base;
      const g01 = grid[gy1 * GX + gx0] - base;
      const g11 = grid[gy1 * GX + gx1] - base;
      const bg = (g00 * (1 - tx) + g10 * tx) * (1 - ty) + (g01 * (1 - tx) + g11 * tx) * ty;
      const v = frame[y * w + x] - bg;
      out[y * w + x] = v > 0 ? v : 0;
    }
  }
  return out;
}

/* ------------------------------------------------------------ */
/* Débruitage + netteté                                           */
/* ------------------------------------------------------------ */

/** Débruitage doux : médiane 3×3 (préserve les bords mieux qu'un lissage
 *  moyen). Post-empilement. */
export function medianDenoise(frame: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(frame.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vals: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          vals.push(frame[yy * w + xx]);
        }
      }
      vals.sort((a, b) => a - b);
      out[y * w + x] = vals[vals.length >> 1];
    }
  }
  return out;
}

/** Netteté par MASQUE FLOU : out = frame + amount · (frame − floue).
 *  Flou = boîte 3×3. Post-empilement. */
export function unsharpMask(frame: Uint8Array, w: number, h: number, amount = 0.6): Uint8Array {
  // boîte 3×3
  const blur = new Uint8Array(frame.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += frame[yy * w + xx];
          n += 1;
        }
      }
      blur[y * w + x] = n > 0 ? Math.round(sum / n) : frame[y * w + x];
    }
  }
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] + amount * (frame[i] - blur[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}

/* ------------------------------------------------------------ */
/* Sélection automatique + pipeline                               */
/* ------------------------------------------------------------ */

/** Estimation du bruit par MAD de l'écart à la médiane locale — robuste
 *  (un objet brillant ne gonfle pas l'estimation). */
function noiseEstimate(frame: Uint8Array, w: number, h: number): number {
  const devs: number[] = [];
  for (let y = 1; y < h; y += 3) {
    for (let x = 1; x < w; x += 3) {
      const med = neighborMedian(frame, w, h, x, y);
      devs.push(Math.abs(frame[y * w + x] - med));
    }
  }
  if (devs.length === 0) return 0;
  devs.sort((a, b) => a - b);
  return devs[devs.length >> 1] * 1.4826;
}

/**
 * SÉLECTION AUTOMATIQUE : renvoie le plan de filtres PERTINENT pour cette
 * image (et les trames disponibles). Règles :
 *  - trame noire / flat : actives si capturées (toujours pertinent) ;
 *  - pixels chauds : si densité > 0,05 % de l'image ;
 *  - gradient : si la PENTE du fond est marquée (> 12) OU le niveau de
 *    ciel très élevé (> 60 — le soustraction aide l'étirement) ;
 *  - débruitage : si bruit (MAD) > 14 ;
 *  - netteté : réservée au mode manuel (l'auto évite les artefacts) ;
 *  - gamma 0,85 par défaut (révélation des faibles signaux).
 */
export function recommendFilters(
  sample: Uint8Array, w: number, h: number,
  hasDark = false, hasFlat = false,
): FilterPlan {
  const stats = backgroundStats(sample, w, h);
  const noise = noiseEstimate(sample, w, h);
  const hot = countHotPixels(sample, w, h);
  const hotDensity = hot / (w * h);
  return {
    auto: true,
    dark: hasDark,
    flat: hasFlat,
    hotPixels: hotDensity > 0.0005,
    gradient: stats.gradient > 12 || stats.level > 60,
    denoise: noise > 14,
    sharpen: false,
    gamma: 0.85,
  };
}

/** Pipeline PRÉ-EMPILEMENT (par frame) : trame noire → trame flat →
 *  pixels chauds. Renvoie la frame corrigée (nouvelle allocation). */
export function applyFrameFilters(
  frame: Uint8Array, plan: FilterPlan,
  dark: Uint8Array | null, flat: Uint8Array | null,
  w: number, h: number,
): Uint8Array {
  let f = frame;
  if (plan.dark && dark && dark.length === f.length) f = subtractDark(f, dark);
  if (plan.flat && flat && flat.length === f.length) f = applyFlat(f, flat);
  if (plan.hotPixels) f = removeHotPixels(f, w, h);
  return f;
}

/** Pipeline POST-EMPILEMENT : gradient → débruitage → étirement gamma →
 *  netteté. Renvoie l'image finale prête pour l'encodage BMP. */
export function applyPostFilters(gray: Uint8Array, plan: FilterPlan, w: number, h: number): Uint8Array {
  let g = gray;
  if (plan.gradient) g = removeGradient(g, w, h);
  if (plan.denoise) g = medianDenoise(g, w, h);
  // étirement percentiles (comme stretchGray) avec gamma du plan
  g = stretchPct(g, plan.gamma);
  if (plan.sharpen) g = unsharpMask(g, w, h, 0.6);
  return g;
}

/** Étirement percentiles 0,5/99,5 % + gamma paramétrable. */
export function stretchPct(gray: Uint8Array, gamma = 0.85): Uint8Array {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v] += 1;
  const total = gray.length;
  const lowTarget = total * 0.005;
  const highTarget = total * 0.995;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowTarget) { lo = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highTarget) { hi = v; break; }
  }
  if (hi <= lo) hi = Math.min(255, lo + 1);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const x = Math.max(0, Math.min(1, (gray[i] - lo) / (hi - lo)));
    out[i] = Math.min(255, Math.max(0, Math.round(255 * Math.pow(x, gamma))));
  }
  return out;
}

/** Libellés (clés i18n cam.filter*) des filtres ACTIFS du plan — ordre
 *  d'exécution, pour l'affichage du résumé sous les réglages. */
export function activeFilterKeys(plan: FilterPlan): string[] {
  const keys: string[] = [];
  if (plan.dark) keys.push('filterDark');
  if (plan.flat) keys.push('filterFlat');
  if (plan.hotPixels) keys.push('filterHot');
  if (plan.gradient) keys.push('filterGradient');
  if (plan.denoise) keys.push('filterDenoise');
  if (plan.sharpen) keys.push('filterSharpen');
  return keys;
}
