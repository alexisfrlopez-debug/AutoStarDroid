/**
 * Tests v2.3.0 — APPROCHE À VITESSE MAXIMALE adaptée à la MONTURE CHOISIE
 * (services/astro/mounts.ts) : marge d'arrêt, course restante, décisions
 * d'approche rapide (slew quand la course le permet, find sinon).
 */
import {
  MOUNT_PRESETS,
  remainingToLimitDeg,
  fastApproachPossible,
  fastApproachGuardSec,
  STOP_APPROACH_MARGIN_DEG,
} from '../src/services/astro/mounts';

const ETX = MOUNT_PRESETS.etx90;      // butées 8..88, slew 5°/s
const DS = MOUNT_PRESETS.ds114;       // butées 0..88, slew 3,5°/s
const GENERIC = MOUNT_PRESETS.generic;

describe('remainingToLimitDeg', () => {
  it('course restante = |limite − alt| − déjà parcouru', () => {
    expect(remainingToLimitDeg(45, 0, true, ETX)).toBeCloseTo(43, 6);   // 88 − 45
    expect(remainingToLimitDeg(45, 10, true, ETX)).toBeCloseTo(33, 6);
    expect(remainingToLimitDeg(45, 0, false, ETX)).toBeCloseTo(37, 6);  // 45 − 8
  });
  it('jamais négatif (la butée borne)', () => {
    expect(remainingToLimitDeg(45, 500, true, ETX)).toBe(0);
  });
  it('altitude inconnue → null (pas d\u2019approche rapide)', () => {
    expect(remainingToLimitDeg(null, 0, true, ETX)).toBeNull();
  });
  it('descente : la limite est le minimum du preset (DS-114 : 0°)', () => {
    expect(remainingToLimitDeg(30, 5, false, DS)).toBeCloseTo(25, 6);
  });
});

describe('fastApproachPossible — vitesse maximale QUAND C\u2019EST POSSIBLE', () => {
  it('large course au-dessus de l\u2019horizon → slew autorisé', () => {
    expect(fastApproachPossible(43, ETX)).toBe(true);   // 88−45, ETX slew 5°/s
    expect(fastApproachPossible(60, DS)).toBe(true);
  });
  it('proche de la butée → on repasse à find (marge + réaction)', () => {
    // réaction ETX = 2×5 = 10 → seuil 18°
    expect(fastApproachPossible(10, ETX)).toBe(false);
    expect(fastApproachPossible(18, ETX)).toBe(true);
    expect(fastApproachPossible(17.9, ETX)).toBe(false);
  });
  it('altitude inconnue → jamais de slew (prudence)', () => {
    expect(fastApproachPossible(null, ETX)).toBe(false);
  });
  it('monture LENTE : l\u2019arc de réaction plus court laisse slew plus près de la butée', () => {
    // DS-114 slew 3,5°/s → réaction 7 → seuil 15° < seuil ETX 18°
    expect(fastApproachPossible(16, DS)).toBe(true);
    expect(fastApproachPossible(16, ETX)).toBe(false);
  });
  it('preset générique sans altitude → garde slew nulle', () => {
    expect(fastApproachGuardSec(null, GENERIC)).toBe(0);
  });
  it('gardes slew cohérentes (distance / taux × 1,5 + 5 s, plafond 120 s)', () => {
    // ETX : 43° restants → dist = 43−8 = 35 → 35/5×1,5 = 10,5 → 11+5 = 16 s
    expect(fastApproachGuardSec(43, ETX)).toBe(16);
    // très longue course → plafond 120
    expect(fastApproachGuardSec(500, ETX)).toBe(120);
  });
});

describe('marge d\u2019arrêt', () => {
  it('constante documentée : 8°', () => {
    expect(STOP_APPROACH_MARGIN_DEG).toBe(8);
  });
});
