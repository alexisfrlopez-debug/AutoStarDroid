/**
 * Tests v2.5.0 — RENDU EMBELLI de la carte du ciel (services/astro/skyrender.ts) :
 * visuels d'étoiles par magnitude, couleurs des planètes, rayons de disques,
 * segments d'astérismes (paires complètes/hors champ), échantillons d'horizon.
 */
import {
  starVisual, planetColor, discRadiusPx, asterismSegments, horizonAzSamples, ASTERISMS,
} from '../src/services/astro/skyrender';

describe('starVisual — noyau/halo/couleur par magnitude', () => {
  it('les brillantes sont plus grosses et bleutées', () => {
    const sirius = starVisual(-1.44);
    const faint = starVisual(5.5);
    expect(sirius.coreR).toBeGreaterThan(faint.coreR);
    expect(sirius.glowR).toBeGreaterThan(faint.glowR);
    expect(sirius.glowOpacity).toBeGreaterThan(faint.glowOpacity);
    expect(sirius.color).not.toBe(faint.color);
  });
  it('décroissance monotone par paliers de magnitude', () => {
    const mags = [-1, 0.5, 1.5, 2.5, 4, 6];
    const cores = mags.map((m) => starVisual(m).coreR);
    for (let i = 1; i < cores.length; i++) {
      expect(cores[i]).toBeLessThanOrEqual(cores[i - 1]);
    }
  });
});

describe('planetColor — identités visuelles', () => {
  it('chaque planète a SA teinte, distincte des voisines', () => {
    const cols = ['PLANET_MARS', 'PLANET_JUPITER', 'PLANET_SATURN', 'PLANET_VENUS', 'MOON', 'SUN']
      .map((id) => planetColor(id));
    expect(new Set(cols).size).toBe(cols.length);
    expect(planetColor('PLANET_MARS')).toBe('#EF8A62');
    expect(planetColor('MOON')).toBe('#E9E6D8');
  });
  it('inconnu → vert générique', () => {
    expect(planetColor('PLANET_X')).toBe('#8FD6A8');
  });
});

describe('discRadiusPx — diamètres apparents', () => {
  it('Lune 31′ à 10 px/deg → rayon ~2,6 px mais plafonné au minimum 3,5', () => {
    expect(discRadiusPx(31, 10)).toBeCloseTo(3.5, 6);
  });
  it('grossit avec l\u2019échelle et plafonne à 90 px', () => {
    expect(discRadiusPx(31, 200)).toBeGreaterThan(3.5);
    expect(discRadiusPx(2000, 400)).toBeLessThanOrEqual(90);
  });
});

describe('asterismSegments — lignes entre étoiles projetées', () => {
  const P = (id: string, x: number, y: number) => ({item: {id}, x, y});
  it('Orion : les 9 paires tracées quand toutes les étoiles sont posées', () => {
    const ori = ASTERISMS.find((a) => a.id === 'ORI')!;
    const placed = ori.pairs.flatMap(([a, b]) => [P(a, 10, 10), P(b, 20, 20)]);
    const segs = asterismSegments(placed);
    expect(segs.length).toBe(ori.pairs.length);
  });
  it('étoile manquante → paire sautée, pas de demi-segment', () => {
    const cas = ASTERISMS.find((a) => a.id === 'CAS')!;
    const placed = [P('STAR_Caph', 1, 1), P('STAR_Schedar', 2, 2)]; // Navi absente
    const segs = asterismSegments(placed);
    expect(segs.length).toBe(1); // Caph–Schedar seulement
  });
  it('coordonnées reportées à l\u2019identique', () => {
    const segs = asterismSegments([P('STAR_Deneb', 3, 4), P('STAR_Sadr', 8, 9)]);
    expect(segs[0]).toEqual({x1: 3, y1: 4, x2: 8, y2: 9});
  });
});

describe('horizonAzSamples — échantillons alt 0', () => {
  it('48 points, alt 0, azimuts croissants de 0 à 360', () => {
    const s = horizonAzSamples();
    expect(s.length).toBe(48);
    expect(s[0].altDeg).toBe(0);
    expect(s[0].azDeg).toBe(0);
    expect(s[s.length - 1].azDeg).toBeCloseTo(360 - 360 / 48, 6);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].azDeg).toBeGreaterThan(s[i - 1].azDeg);
    }
  });
});
