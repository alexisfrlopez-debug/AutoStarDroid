/**
 * Tests v2.5.0 — GOTO RELAIS (services/astro/gotorelay.ts) : plus court
 * chemin AD avec raccord de 0 h, paliers de vitesse, amortissement, plafond
 * d'impulsion, directions selon signes, tolérance d'arrivée, détection
 * d'inversion de sens et de stalle.
 * v2.9.3 : TROIS paliers (slew → find → center — fin de la fin de course
 * rampante à 0,05°/s sur les 2,5 derniers degrés) + apprentissage du taux
 * réel (relayLearnRate).
 */
import {
  RELAY_TOLERANCE_DEG,
  RELAY_FIND_AT_DEG,
  RELAY_CENTER_AT_DEG,
  raDeltaDeg,
  relayRemainders,
  relaySpeedFor,
  relayDecision,
  relaySignWasWrong,
  relayStalled,
  relayLearnRate,
  type RelayInput,
} from '../src/services/astro/gotorelay';

const RATES = {slew: 2.0, find: 1.0, center: 0.08};
const SIGNS = {ra: 1, dec: 1};

const base = (over: Partial<RelayInput>): RelayInput => ({
  raDeg: 100, decDeg: 20,
  targetRaDeg: 100, targetDecDeg: 20,
  signs: SIGNS,
  rates: RATES,
  maxPulseS: 6,
  ...over,
});

describe('raDeltaDeg — plus court chemin, raccord de 0 h', () => {
  it('delta simple', () => {
    expect(raDeltaDeg(10, 15)).toBe(5);
    expect(raDeltaDeg(15, 10)).toBe(-5);
  });
  it('raccord 0 h : 359° → 1° = +2° (pas -358°)', () => {
    expect(raDeltaDeg(359, 1)).toBeCloseTo(2, 9);
    expect(raDeltaDeg(1, 359)).toBeCloseTo(-2, 9);
  });
  it('180° pile : borne positive', () => {
    expect(raDeltaDeg(0, 180)).toBe(180);
  });
});

describe('relayRemainders / relaySpeedFor — paliers (3 vitesses v2.9.3)', () => {
  it('deadband : reste sous 0,02° → 0', () => {
    const r = relayRemainders(100, 20, 100.015, 20.01);
    expect(r.remainRaDeg).toBe(0);
    expect(r.remainDecDeg).toBe(0);
  });
  it('slew au-delà de 2°, find entre 0,4° et 2°, center en dessous', () => {
    expect(relaySpeedFor(10)).toBe('slew');
    expect(relaySpeedFor(RELAY_FIND_AT_DEG)).toBe('slew');  // borne incluse
    expect(relaySpeedFor(1.9)).toBe('find');
    expect(relaySpeedFor(RELAY_CENTER_AT_DEG * (1 + 1e-9))).toBe('find'); // borne incluse (FP-safe)
    expect(relaySpeedFor(0.39)).toBe('center');
    expect(relaySpeedFor(0.1)).toBe('center');
  });
});

describe('relayDecision', () => {
  it('cible atteinte sous la tolérance → done sans impulsion', () => {
    const d = relayDecision(base({targetRaDeg: 100 + RELAY_TOLERANCE_DEG / 2}));
    expect(d.done).toBe(true);
    expect(d.raS).toBe(0);
    expect(d.decS).toBe(0);
    expect(d.dirs.raDir).toBeNull();
  });
  it('long déplacement AD+ : direction Est, vitesse slew, durée amortie', () => {
    const d = relayDecision(base({targetRaDeg: 110})); // 10° d'AD
    expect(d.done).toBe(false);
    expect(d.speed).toBe('slew');
    expect(d.dirs.raDir).toBe('e');
    expect(d.dirs.decDir).toBeNull();
    // durée = 10° × 0,8 / 2°/s = 4 s (sous le plafond 6 s)
    expect(d.raS).toBeCloseTo(4, 6);
  });
  it('palier FIND : reste 1° → vitesse find, durée au taux find', () => {
    const d = relayDecision(base({targetRaDeg: 101})); // 1° d'AD
    expect(d.speed).toBe('find');
    expect(d.dirs.raDir).toBe('e');
    // 1° × 0,8 / 1°/s = 0,8 s
    expect(d.raS).toBeCloseTo(0.8, 6);
  });
  it('AD en raccord 0 h : 359° vers 4° → Est (+5°), pas Ouest', () => {
    const d = relayDecision(base({raDeg: 359, targetRaDeg: 4}));
    expect(d.dirs.raDir).toBe('e');
    expect(d.raS).toBeCloseTo((5 * 0.8) / RATES.slew, 6);
  });
  it('fin de course DEC : vitesse center et durée plafonnée par le taux', () => {
    // reste 0,2° < 0,4° → center ; 0,2° × 0,8 / 0,08°/s = 2 s
    const d = relayDecision(base({decDeg: 20, targetDecDeg: 20.2}));
    expect(d.speed).toBe('center');
    expect(d.dirs.decDir).toBe('n');
    expect(d.decS).toBeCloseTo(2, 6);
  });
  it('fin de course DEC au palier find : durée au taux find (0,5° → 0,4 s)', () => {
    const d = relayDecision(base({decDeg: 20, targetDecDeg: 20.5}));
    expect(d.speed).toBe('find');
    expect(d.dirs.decDir).toBe('n');
    expect(d.decS).toBeCloseTo(0.4, 6);
  });
  it('axe trop court à vitesse slew REPORTÉ (il serait dépassé de loin)', () => {
    // AD 10° (slew) + DEC 0,08° : à 2°/s l'impulsion DEC durerait 32 ms
    // (< 120 ms) → DEC reporté, AD avance seul
    const d = relayDecision(base({targetRaDeg: 110, targetDecDeg: 20.08}));
    expect(d.dirs.raDir).toBe('e');
    expect(d.dirs.decDir).toBeNull();
    expect(d.raS).toBeCloseTo(4, 6);
    expect(d.decS).toBe(0);
  });
  it('deux axes conjoints à vitesse center : durées INDIVIDUELLES', () => {
    // AD 0,15° (1,5 s à 0,08°/s) + DEC 0,03° (0,3 s) — chacun sa durée
    const d = relayDecision(base({targetRaDeg: 100.15, targetDecDeg: 20.03}));
    expect(d.speed).toBe('center');
    expect(d.dirs.raDir).toBe('e');
    expect(d.dirs.decDir).toBe('n');
    expect(d.raS).toBeCloseTo(1.5, 6);
    expect(d.decS).toBeCloseTo(0.3, 6);
  });
  it('plafond maxPulseS respecté (reste énorme + taux faible)', () => {
    const d = relayDecision(base({decDeg: 20, targetDecDeg: 80, maxPulseS: 6}));
    expect(d.decS).toBeLessThanOrEqual(6);
  });
  it('signe inversé : cible AD plus grande mais signe.ra = -1 → Ouest', () => {
    const d = relayDecision(base({targetRaDeg: 110, signs: {ra: -1, dec: 1}}));
    expect(d.dirs.raDir).toBe('w');
  });
  it('impulsion minimale 0,12 s quand le reste est minuscule mais hors tolérance', () => {
    const d = relayDecision(base({targetRaDeg: 100.121, rates: {slew: 50, find: 50, center: 50}}));
    expect(d.done).toBe(false);
    expect(d.speed).toBe('center'); // repli : la vitesse SIGNALÉE est celle des durées
    expect(d.raS).toBeCloseTo(0.12, 6);
  });
});

describe('relayLearnRate — apprentissage du taux réel (v2.9.3)', () => {
  it('arc trop petit pour conclure (stalle/bruit) → valeur précédente', () => {
    expect(relayLearnRate(null, 0.01, 1.5, 3.5)).toBeCloseTo(3.5, 9);
    expect(relayLearnRate(2.8, 0.005, 1.5, 3.5)).toBeCloseTo(2.8, 9);
  });
  it('impulsion trop courte (< 0,12 s) → valeur précédente', () => {
    expect(relayLearnRate(null, 0.5, 0.05, 3.5)).toBeCloseTo(3.5, 9);
  });
  it('première observation : arc/durée, borné à ±4× l\'hypothèse', () => {
    // 6° en 1,6 s = 3,75°/s (hypothèse 5 → bornes 1,25..20) → 3,75
    expect(relayLearnRate(null, 6, 1.6, 5)).toBeCloseTo(3.75, 9);
    // 0,05° en 2 s = 0,025°/s → borné BAS à 5/4 = 1,25
    expect(relayLearnRate(null, 0.05, 2, 5)).toBeCloseTo(1.25, 9);
    // 40° en 1 s = 40°/s → borné HAUT à 20 puis clamp final 15
    expect(relayLearnRate(null, 40, 1, 5)).toBeCloseTo(15, 9);
  });
  it('EMA 50 % entre la valeur précédente et l\'observation bornée', () => {
    const prev = relayLearnRate(null, 6, 1.6, 5); // 3,75
    const next = relayLearnRate(prev, 4, 0.85, 5); // obs 4,7
    expect(next).toBeCloseTo(3.75 * 0.5 + 4.70588 * 0.5, 3);
  });
  it('final clamp 0,01..15', () => {
    expect(relayLearnRate(null, 100, 0.2, 0.5)).toBeLessThanOrEqual(15);
    expect(relayLearnRate(0.005, 0.1, 10, 0.02)).toBeGreaterThanOrEqual(0.01);
  });
});

describe('relaySignWasWrong — apprentissage de sens', () => {
  it('erreur réduite → pas d\u2019inversion', () => {
    expect(relaySignWasWrong(1.0, 0.9, 0.2)).toBe(false);
  });
  it('erreur agrandie après une impulsion franche → inversion', () => {
    expect(relaySignWasWrong(1.0, 1.3, 0.2)).toBe(true);
  });
  it('impulsion trop courte pour conclure → pas d\u2019inversion', () => {
    expect(relaySignWasWrong(1.0, 1.3, 0.04)).toBe(false);
  });
});

describe('relayStalled — butée / moteur sans effet', () => {
  it('position figée ×3 avec impulsion → stalle', () => {
    expect(relayStalled(true, 0.001, 3)).toBe(true);
  });
  it('position qui bouge → pas de stalle', () => {
    expect(relayStalled(true, 0.5, 3)).toBe(false);
  });
  it('figée mais seulement 2 fois → pas de stalle', () => {
    expect(relayStalled(true, 0.001, 2)).toBe(false);
  });
  it('aucune impulsion commandée → jamais stalle', () => {
    expect(relayStalled(false, 0.001, 5)).toBe(false);
  });
});
