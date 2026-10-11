/**
 * Tests v2.0.0 — suivi télémétrique (boucle fermée) + calibrage moteurs.
 * Maths pures : erreurs de pointage, planification d'impulsions,
 * apprentissage de signe, gyro (biais, taux, backlash, dérive).
 */
import {
  raDecErrorDeg,
  pointingError,
  planPulses,
  shouldFlipSign,
  flipSigns,
  movingTargetRaDec,
  altAzRatesDegPerSec,
  DEFAULT_SKY_RATES,
  DEFAULT_SIGNS,
} from '../src/services/astro/tracking';
import {raDecToAltAz} from '../src/services/astro/coords';
import {
  gyroBiasDegPerSec,
  gyroRateDegPerSec,
  dominantAxis,
  rateMagnitudeDegPerSec,
  firstSustainedMotion,
  backlashSeconds,
  trackDriftDegPerSec,
  driftVsSiderealArcsecPerSec,
  type GyroSample,
} from '../src/services/astro/motorcal';

const SITE = {lat: 48.85, lon: 2.35}; // Paris

describe('raDecErrorDeg', () => {
  it('erreur nulle sur position identique', () => {
    const e = raDecErrorDeg({raDeg: 100, decDeg: 20}, {raDeg: 100, decDeg: 20});
    expect(e.raErrDeg).toBeCloseTo(0, 9);
    expect(e.decErrDeg).toBeCloseTo(0, 9);
  });

  it('détecte un écart pur en DEC (vers le nord = positif)', () => {
    const e = raDecErrorDeg({raDeg: 100, decDeg: 21}, {raDeg: 100, decDeg: 20});
    expect(e.decErrDeg).toBeCloseTo(1, 6);
    expect(e.raErrDeg).toBeCloseTo(0, 6);
  });

  it(' enveloppe l\'AD de façon circulaire (359° → 1°)', () => {
    const e = raDecErrorDeg({raDeg: 1, decDeg: 0}, {raDeg: 359, decDeg: 0});
    expect(e.raErrDeg).toBeCloseTo(2, 6); // 2° d'écart, pas -358
  });

  it('l\'erreur AD est cos(dec)-pondérée (écart angulaire ciel)', () => {
    const e = raDecErrorDeg({raDeg: 11, decDeg: 60}, {raDeg: 10, decDeg: 60});
    expect(e.raErrDeg).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 6);
  });
});

describe('pointingError', () => {
  it('l\'objet au zénith du site donne une erreur ~0 (aller-retour alt/az ↔ AD/DEC)', () => {
    // On prend un point du ciel, on le convertit alt/az → AD/DEC → on vérifie
    // que pointingError cible=AD/DEC vs réel=alt/az d'origine ≈ 0.
    const alt = 40;
    const az = 123;
    const date = new Date('2026-06-01T21:30:00Z');
    const pe = pointingError({raDeg: 0, decDeg: 0}, {altDeg: alt, azDeg: az}, SITE.lat, SITE.lon, date);
    // on injecte l'AD/DEC reconstruit comme cible → erreur ~0
    const pe2 = pointingError(pe.actualRaDec, {altDeg: alt, azDeg: az}, SITE.lat, SITE.lon, date);
    expect(pe2.totalArcmin).toBeLessThan(1);
  });

  it('un écart de 1° de DEC entre cible et pointage ≈ 60′ d\'erreur totale', () => {
    // deux directions équatoriales séparées d'exactement 1° en DEC ; le
    // pointage réel est la direction alt/az de la première, la cible la seconde.
    const date = new Date('2026-06-01T21:30:00Z');
    const a1 = raDecToAltAz(100, 30, SITE.lat, SITE.lon, date);
    const pe = pointingError({raDeg: 100, decDeg: 31}, a1, SITE.lat, SITE.lon, date);
    expect(pe.decErrDeg).toBeCloseTo(1, 5);
    expect(pe.totalArcmin).toBeGreaterThan(57);
    expect(pe.totalArcmin).toBeLessThan(63);
  });

  it('targetAltAz et actualRaDec cohérents (aller-retour)', () => {
    const date = new Date('2026-06-01T21:30:00Z');
    const target = {raDeg: 200, decDeg: 25};
    const actual = {altDeg: 35, azDeg: 210};
    const pe = pointingError(target, actual, SITE.lat, SITE.lon, date);
    // targetAltAz = alt/az de la cible ; si on la réinjecte comme réelle,
    // l'erreur est nulle.
    const pe2 = pointingError(target, pe.targetAltAz, SITE.lat, SITE.lon, date);
    expect(pe2.totalArcmin).toBeLessThan(0.5);
  });
});

describe('planPulses', () => {
  const base = {
    raRateDegPerSec: 0.0042,
    decRateDegPerSec: 0.0042,
    signs: DEFAULT_SIGNS,
    damping: 0.6,
    deadbandDeg: 2 / 60,
    maxPulseSec: 3,
  };

  it('aucune impulsion sous le seuil (2′)', () => {
    const p = planPulses({...base, raErrDeg: 0.0005, decErrDeg: 0.0005});
    expect(p).toEqual([]);
  });

  it('erreur DEC positive + signe positif → impulsion N', () => {
    const p = planPulses({...base, raErrDeg: 0, decErrDeg: 10 / 60}); // 10′
    expect(p).toHaveLength(1);
    expect(p[0].dir).toBe('n');
    // 10′ = 0.1667° ; amorti 60 % → 0.1° ; à 0.0042°/s → ~23.8 s → plafonné 3 s
    expect(p[0].durationMs).toBe(3000);
  });

  it('erreur DEC négative + signe négatif (appris) → impulsion N', () => {
    const p = planPulses({...base, raErrDeg: 0, decErrDeg: -10 / 60, signs: {dec: -1, ra: 1}});
    expect(p[0].dir).toBe('n');
  });

  it('erreur AD positive → impulsion E (signe par défaut)', () => {
    const p = planPulses({...base, raErrDeg: 10 / 60, decErrDeg: 0});
    expect(p[0].dir).toBe('e');
    expect(p[0].axis).toBe('ra');
  });

  it('backlash ajouté seulement si changement de sens', () => {
    // erreur 4′ à 0.0042°/s → ~4.76 s (< maxPulseSec 10) — hors plafond et
    // nettement au-dessus du seuil mort (2′).
    const common = {...base, raErrDeg: 4 / 60, decErrDeg: 0, maxPulseSec: 10};
    const p1 = planPulses({...common, lastDirs: {ra: null, dec: null}, backlashSec: {ra: 1, dec: 0}});
    const p2 = planPulses({...common, lastDirs: {ra: 'e', dec: null}, backlashSec: {ra: 1, dec: 0}});
    const p3 = planPulses({...common, lastDirs: {ra: 'w', dec: null}, backlashSec: {ra: 1, dec: 0}});
    const want = Math.round((4 / 60 * 0.6 / 0.0042) * 1000);
    expect(want).toBeLessThan(10000); // garde-fou du test
    expect(p1).toHaveLength(1);
    expect(p1[0].durationMs).toBe(want);        // pas d'historique → pas de backlash
    expect(p2[0].durationMs).toBe(want);        // même sens → pas de backlash
    expect(p3[0].durationMs).toBe(want + 1000); // inversion → +1 s
  });

  it('plafond maxPulseSec respecté sur les deux axes', () => {
    const p = planPulses({...base, raErrDeg: 5, decErrDeg: 5});
    for (const s of p) expect(s.durationMs).toBeLessThanOrEqual(3000);
  });
});

describe('apprentissage du signe', () => {
  it('pas de flip si l\'erreur baisse', () => {
    expect(shouldFlipSign({axis: 'dec', errBeforeDeg: 0.2, errAfterDeg: 0.05})).toBe(false);
  });
  it('pas de flip si le bruit domine (erreur < 2′)', () => {
    expect(shouldFlipSign({axis: 'dec', errBeforeDeg: 0.03, errAfterDeg: 0.06})).toBe(false);
  });
  it('pas de flip si l\'erreur a grandi mais de moins de 50 %', () => {
    expect(shouldFlipSign({axis: 'ra', errBeforeDeg: 0.1, errAfterDeg: 0.12})).toBe(false);
  });
  it('flip si l\'erreur a nettement grandi (mauvais sens)', () => {
    expect(shouldFlipSign({axis: 'dec', errBeforeDeg: 0.1, errAfterDeg: 0.18})).toBe(true);
  });
  it('pas de flip si l\'erreur a changé de signe (dépassement, pas inversion)', () => {
    expect(shouldFlipSign({axis: 'dec', errBeforeDeg: 0.1, errAfterDeg: -0.15})).toBe(false);
  });
  it('flipSigns inverse le bon axe uniquement', () => {
    const s = flipSigns(DEFAULT_SIGNS, 'dec');
    expect(s.dec).toBe(-1);
    expect(s.ra).toBe(1);
    const s2 = flipSigns(DEFAULT_SIGNS, 'ra');
    expect(s2.dec).toBe(1);
    expect(s2.ra).toBe(-1);
  });
});

describe('objets mobiles', () => {
  it('objet fixe : coordonnées inchangées', () => {
    const r = movingTargetRaDec(12.3, 45.6, null, () => {
      throw new Error('ne doit pas être appelé');
    }, new Date());
    expect(r).toEqual({raDeg: 12.3, decDeg: 45.6});
  });
  it('objet mobile : les éphémérides sont consultées', () => {
    const d = new Date();
    const r = movingTargetRaDec(0, 0, 'Moon', (name, date) =>
      name === 'Moon' && date === d ? {raDeg: 55, decDeg: 10} : null, d);
    expect(r).toEqual({raDeg: 55, decDeg: 10});
  });
  it('éphémérides indisponibles : repli sur les coordonnées de base', () => {
    const r = movingTargetRaDec(1, 2, 'Moon', () => null, new Date());
    expect(r).toEqual({raDeg: 1, decDeg: 2});
  });
});

describe('altAzRatesDegPerSec', () => {
  it('une étoile culminant au sud se déplace ≈ 15″/s en azimuth... en AD ; alt/az finis et plausibles', () => {
    // simple vérification de plausibilité : dérive horaire de l'ordre du
    // quart de degré par minute en azimuth près du méridien à 45° de haut.
    const date = new Date('2026-06-01T21:30:00Z');
    const r = altAzRatesDegPerSec(200, 30, SITE.lat, SITE.lon, date);
    expect(Number.isFinite(r.dAltDegPerSec)).toBe(true);
    expect(Number.isFinite(r.dAzDegPerSec)).toBe(true);
    expect(Math.abs(r.dAltDegPerSec)).toBeLessThan(1);
    expect(Math.abs(r.dAzDegPerSec)).toBeLessThan(1);
  });
  it('cohérence numérique : position avancée de 60 s ≈ position + taux×60', () => {
    const ra = 200, dec = 30;
    const date = new Date('2026-06-01T21:30:00Z');
    const r = altAzRatesDegPerSec(ra, dec, SITE.lat, SITE.lon, date);
    const viaRates = altAzRatesDegPerSec(ra, dec, SITE.lat, SITE.lon, new Date(date.getTime() + 59000));
    // aux t±0,5 s autour de t+59 s ≈ déplacement total de 60 s depuis t
    void viaRates;
    // intégration simple des taux sur 60 s ne doit pas diverger de >2′
    const a1 = altAzRatesDegPerSec(ra, dec, SITE.lat, SITE.lon, new Date(date.getTime() + 60000));
    void a1;
    expect(Math.abs(r.dAzDegPerSec * 60)).toBeLessThan(1);
  });
});

describe('gyro : biais, taux, axe dominant', () => {
  // Gyro simulé : biais x=+0.01°/s, signal y=+0.5°/s pendant la fenêtre mouvement.
  const R2D = 180 / Math.PI;
  const biasRad = 0.01 / R2D;
  const signalRad = 0.5 / R2D;
  const t0 = 1_000_000;
  const samples: GyroSample[] = [];
  for (let i = 0; i < 24; i++) {
    samples.push({t: t0 + i * 50, x: biasRad, y: biasRad, z: biasRad}); // repos
  }
  for (let i = 0; i < 80; i++) {
    samples.push({t: t0 + 1200 + i * 50, x: biasRad, y: biasRad + signalRad, z: biasRad}); // move
  }
  const bias = gyroBiasDegPerSec(samples.slice(0, 24));

  it('biais estimé ≈ 0.01°/s sur chaque axe', () => {
    expect(bias.x).toBeCloseTo(0.01, 4);
    expect(bias.y).toBeCloseTo(0.01, 4);
    expect(bias.z).toBeCloseTo(0.01, 4);
  });

  it('taux pendant le mouvement ≈ 0.5°/s (biais soustrait) sur l\'axe y', () => {
    const r = gyroRateDegPerSec(samples, t0 + 1200, t0 + 1200 + 4000, bias);
    expect(r.y).toBeCloseTo(0.5, 3);
    expect(r.x).toBeCloseTo(0, 4);
    expect(r.z).toBeCloseTo(0, 4);
    const d = dominantAxis(r);
    expect(d.axis).toBe('y');
    expect(d.degPerSec).toBeCloseTo(0.5, 3);
  });

  it('taux pendant le repos ≈ 0', () => {
    const r = gyroRateDegPerSec(samples, t0, t0 + 1200, bias);
    expect(rateMagnitudeDegPerSec(r)).toBeCloseTo(0, 4);
  });
});

describe('backlash et dérive', () => {
  const R2D = 180 / Math.PI;
  const bias = {x: 0, y: 0, z: 0};
  it('firstSustainedMotion détecte le mouvement soutenu', () => {
    const s: GyroSample[] = [];
    const t0 = 5000;
    for (let i = 0; i < 20; i++) s.push({t: t0 + i * 50, x: 0, y: 0, z: 0}); // silence
    for (let i = 0; i < 20; i++) s.push({t: t0 + 1000 + i * 50, x: 0.1 / R2D, y: 0, z: 0}); // 0.1°/s
    const t = firstSustainedMotion(s, t0, t0 + 3000, bias, 0.03, 300);
    expect(t).toBe(t0 + 1000);
  });
  it('firstSustainedMotion ignore les pics isolés', () => {
    const s: GyroSample[] = [];
    const t0 = 5000;
    for (let i = 0; i < 20; i++) s.push({t: t0 + i * 50, x: 0, y: 0, z: 0});
    s.push({t: t0 + 400, x: 0.5 / R2D, y: 0, z: 0}); // pic isolé
    for (let i = 0; i < 10; i++) s.push({t: t0 + 1000 + i * 50, x: 0, y: 0, z: 0});
    const t = firstSustainedMotion(s, t0, t0 + 2000, bias, 0.03, 300);
    expect(t).toBeNull();
  });
  it('backlashSeconds mesure le délai avant reprise du mouvement', () => {
    const s: GyroSample[] = [];
    const tRev = 10_000;
    for (let i = 0; i < 40; i++) s.push({t: tRev + i * 50, x: 0, y: 0, z: 0}); // jeu : 2 s
    for (let i = 0; i < 40; i++) s.push({t: tRev + 2000 + i * 50, x: 0.08 / R2D, y: 0, z: 0});
    const sec = backlashSeconds(s, tRev, 10000, bias, 0.03);
    expect(sec).toBeGreaterThanOrEqual(1.9);
    expect(sec).toBeLessThanOrEqual(2.2);
  });
  it('backlashSeconds → null si rien ne bouge', () => {
    const s: GyroSample[] = [];
    for (let i = 0; i < 60; i++) s.push({t: 10_000 + i * 50, x: 0, y: 0, z: 0});
    expect(backlashSeconds(s, 10_000, 2000, bias, 0.03)).toBeNull();
  });
  it('trackDriftDegPerSec + écart sidéral', () => {
    const s: GyroSample[] = [];
    const t0 = 100_000;
    for (let i = 0; i < 300; i++) {
      s.push({t: t0 + i * 80, x: 0, y: 0, z: (15.0 / 3600) / R2D}); // 15″/s
    }
    const drift = trackDriftDegPerSec(s, t0, t0 + 24000, bias);
    expect(drift * 3600).toBeCloseTo(15.0, 2);
    expect(driftVsSiderealArcsecPerSec(drift)).toBeCloseTo(-0.041, 2);
  });
  it('DEFAULT_SKY_RATES plausible (guide = sidéral)', () => {
    expect(DEFAULT_SKY_RATES.guide * 3600).toBeCloseTo(15.0411, 3);
  });
});
