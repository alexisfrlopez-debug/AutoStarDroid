/**
 * Tests v2.5.0 — GOTO RELAIS (services/astro/gotorelay.ts) : plus court
 * chemin AD avec raccord de 0 h, paliers de vitesse, amortissement, plafond
 * d'impulsion, directions selon signes, tolérance d'arrivée, détection
 * d'inversion de sens et de stalle.
 */
import {
  RELAY_TOLERANCE_DEG,
  RELAY_SLOW_AT_DEG,
  raDeltaDeg,
  relayRemainders,
  relaySpeedFor,
  relayDecision,
  relaySignWasWrong,
  relayStalled,
  type RelayInput,
} from '../src/services/astro/gotorelay';

const RATES = {slew: 2.0, center: 0.08};
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

describe('relayRemainders / relaySpeedFor — paliers', () => {
  it('deadband : reste sous 0,02° → 0', () => {
    const r = relayRemainders(100, 20, 100.015, 20.01);
    expect(r.remainRaDeg).toBe(0);
    expect(r.remainDecDeg).toBe(0);
  });
  it('slew au-delà de 2,5°, center en dessous', () => {
    expect(relaySpeedFor(3)).toBe('slew');
    expect(relaySpeedFor(RELAY_SLOW_AT_DEG)).toBe('slew');
    expect(relaySpeedFor(2.4)).toBe('center');
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
  it('AD en raccord 0 h : 359° vers 4° → Est (+5°), pas Ouest', () => {
    const d = relayDecision(base({raDeg: 359, targetRaDeg: 4}));
    expect(d.dirs.raDir).toBe('e');
    expect(d.raS).toBeCloseTo((5 * 0.8) / RATES.slew, 6);
  });
  it('fin de course DEC : vitesse center et durée plafonnée par le taux', () => {
    const d = relayDecision(base({decDeg: 20, targetDecDeg: 20.4}));
    expect(d.speed).toBe('center');
    expect(d.dirs.decDir).toBe('n');
    // 0,4° × 0,8 / 0,08°/s = 4 s
    expect(d.decS).toBeCloseTo(4, 6);
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
    // AD 0,4° (4 s à 0,08°/s) + DEC 0,08° (0,8 s) — chacun sa durée
    const d = relayDecision(base({targetRaDeg: 100.4, targetDecDeg: 20.08}));
    expect(d.speed).toBe('center');
    expect(d.dirs.raDir).toBe('e');
    expect(d.dirs.decDir).toBe('n');
    expect(d.raS).toBeCloseTo(4, 6);
    expect(d.decS).toBeCloseTo(0.8, 6);
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
    const d = relayDecision(base({targetRaDeg: 100.121, rates: {slew: 50, center: 50}}));
    expect(d.done).toBe(false);
    expect(d.raS).toBeCloseTo(0.12, 6);
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
