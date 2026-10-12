/**
 * EMPILEMENT D'IMAGES astronomiques côté téléphone (v2.5.0 — demande
 * utilisateur : « traitements/empilement d'images »). Tout est PUR et testé :
 *  - décodage de l'anneau de luminance réduite (base64 → octets 192×144) ;
 *  - ALIGNEMENT par translation (minimisation SAD — les turbulence/dérives
 *    lentes du suivi sidéral sont des translations au premier ordre) ;
 *  - EMPILEMENT moyenne / médiane / sigma-clap (kappa-sigma 2,5) ;
 *  - ÉTIREMENT doux (écrêtage aux percentiles + gamma) ;
 *  - ENCODAGE BMP 24 bits (sans dépendance) → base64 → data URI affichable.
 *
 * Les pixels restent en 192×144 : c'est la résolution de l'anneau natif
 * (l'aperçu haute résolution reste le JPEG du flux) — l'empilement sert à
 * RÉVÉLER le signal (objet + bruit moyen) et non à produire un poster.
 */

/** Décode un fragment base64 (anneau natif) en octets gris w×h. */
export function decodeGrayB64(b64: string, w = 192, h = 144): Uint8Array | null {
  try {
    const bin = typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) {
      out[i] = bin.charCodeAt(i) & 0xFF;
    }
    return out;
  } catch (_) {
    return null;
  }
}

/** Somme des différences absolues entre deux images grises. */
function sad(a: Uint8Array, b: Uint8Array, w: number, h: number, dx: number, dy: number, step: number): number {
  let s = 0;
  let n = 0;
  for (let y = 2; y < h - 2; y += step) {
    const yy = y + dy;
    if (yy < 0 || yy >= h) continue;
    for (let x = 2; x < w - 2; x += step) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      s += Math.abs(a[y * w + x] - b[yy * w + xx]);
      n += 1;
    }
  }
  return n > 0 ? s / n : 1e9;
}

/**
 * Alignement par translation d'une image MOVEMENT sur une RÉFÉRENCE : cherche
 * le décalage entier minimisant le SAD dans une fenêtre ±search px.
 * Renvoie {dx, dy} (décalage à APPLIQUER à mov pour la recaler sur ref).
 */
export function alignGray(
  ref: Uint8Array, mov: Uint8Array, w = 192, h = 144, search = 7,
): {dx: number; dy: number} {
  let best = {dx: 0, dy: 0};
  let bestSad = Infinity;
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const s = sad(ref, mov, w, h, dx, dy, 2); // pas 2 : coût divisé par 4
      if (s < bestSad) {
        bestSad = s;
        best = {dx, dy};
      }
    }
  }
  return best;
}

/** Empilement aligné d'images grises (moyenne / médiane / kappa-sigma). */
export type StackMode = 'mean' | 'median' | 'kappa';

export function stackFrames(
  frames: Uint8Array[], w = 192, h = 144, mode: StackMode = 'kappa',
): {gray: Uint8Array; used: number} {
  const n = frames.length;
  if (n === 0) return {gray: new Uint8Array(w * h), used: 0};
  if (n === 1) return {gray: new Uint8Array(frames[0]), used: 1};
  // alignement : frame 0 = référence, les autres sont recalées (translation)
  const aligned: Uint8Array[] = [frames[0]];
  for (let i = 1; i < n; i++) {
    const {dx, dy} = alignGray(frames[0], frames[i], w, h);
    if (dx === 0 && dy === 0) {
      aligned.push(frames[i]);
      continue;
    }
    const shifted = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        if (sx < 0 || sx >= w) continue;
        shifted[y * w + x] = frames[i][sy * w + sx];
      }
    }
    aligned.push(shifted);
  }
  const out = new Uint8Array(w * h);
  const col: number[] = [];
  for (let i = 0; i < w * h; i++) {
    let acc = 0;
    if (mode === 'mean') {
      for (const f of aligned) acc += f[i];
      out[i] = Math.min(255, Math.round(acc / aligned.length));
    } else if (mode === 'median') {
      col.length = 0;
      for (const f of aligned) col.push(f[i]);
      col.sort((a, b) => a - b);
      out[i] = col[col.length >> 1];
    } else {
      // kappa-sigma avec statistiques ROBUSTES (médiane ± 2,5 × 1,4826·MAD) :
      // la moyenne est contaminée par l'outlier lui-même — avec 3 frames,
      // mean±2,5σ laisse passer un satellite éclair. Le couple médiane/MAD
      // rejette l'aberrant quelle que soit la taille du lot.
      col.length = 0;
      for (const f of aligned) col.push(f[i]);
      col.sort((a, b) => a - b);
      const med = col[col.length >> 1];
      const absDev = col.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
      const mad = absDev[absDev.length >> 1] * 1.4826;
      const lo = med - 2.5 * (mad || 1);
      const hi = med + 2.5 * (mad || 1);
      let sum = 0;
      let cnt = 0;
      for (const v of col) {
        if (v >= lo && v <= hi) {sum += v; cnt += 1;}
      }
      out[i] = cnt > 0 ? Math.min(255, Math.round(sum / cnt)) : med;
    }
  }
  return {gray: out, used: aligned.length};
}

/** Étirement doux : écrêtage percentiles 0,5 %/99,5 % + gamma. */
export function stretchGray(gray: Uint8Array, gamma = 0.85): Uint8Array {
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
    if (acc >= lowTarget) {lo = v; break;}
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highTarget) {hi = v; break;}
  }
  if (hi <= lo) hi = Math.min(255, lo + 1);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const x = Math.max(0, Math.min(1, (gray[i] - lo) / (hi - lo)));
    out[i] = Math.min(255, Math.max(0, Math.round(255 * Math.pow(x, gamma))));
  }
  return out;
}

/** Encode une image grise en BMP 24 bits (entêtes 54 octets, lignes
 *  bottom-up, pixels BGR) puis en base64 — affichable en data URI. */
export function encodeBmpGray(gray: Uint8Array, w: number, h: number): string {
  const rowSize = Math.ceil((w * 3) / 4) * 4; // lignes paddées à 4 octets
  const dataSize = rowSize * h;
  const fileSize = 54 + dataSize;
  const buf = new Uint8Array(fileSize);
  const wr = (off: number, v: number, len: number) => {
    for (let i = 0; i < len; i++) buf[off + i] = (v >>> (8 * i)) & 0xFF;
  };
  // BITMAPFILEHEADER
  wr(0, 0x4D42, 2);          // 'BM'
  wr(2, fileSize, 4);
  wr(10, 54, 4);
  // BITMAPINFOHEADER
  wr(14, 40, 4);             // taille header
  wr(18, w, 4);
  wr(22, h, 4);
  wr(26, 1, 2);              // planes
  wr(28, 24, 2);             // bpp
  wr(30, 0, 4);              // BI_RGB
  wr(34, dataSize, 4);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w; // bottom-up
    let off = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const v = gray[srcRow + x];
      buf[off++] = v; // B
      buf[off++] = v; // G
      buf[off++] = v; // R
    }
  }
  // base64 (sans dépendance : Buffer ou atob/btoa)
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/** URI affichable par <Image> : 'data:image/bmp;base64,…'. */
export function grayToDataUri(gray: Uint8Array, w: number, h: number): string {
  return `data:image/bmp;base64,${encodeBmpGray(gray, w, h)}`;
}
