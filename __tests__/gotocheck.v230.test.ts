/**
 * Tests v2.3.0 — CONTRÔLE CROISÉ GOTO (services/astro/gotocheck.ts).
 *
 * Le contrat utilisateur : « comparer l'évolution de la télémétrie du
 * téléphone et le mouvement des moteurs, en gardant en tête que la
 * télémétrie peut être faussée ou avoir des problèmes de sensibilité —
 * vérifier si l'évolution de la télémétrie est suffisamment fluide pour
 * se caler dessus. »
 *
 * Cas couverts : arcs gyro et télémétrie cohérents (verdict good),
 * télémétrie bruitée / trouée / sautée / figée / divergente (verdict poor),
 * pas assez d'échantillons (verdict unknown).
 */
import {
  quatAngleDeg,
  gyroPathDeg,
  telePathDeg,
  smoothnessOf,
  crossCheck,
  type TeleSample,
  type GyroLite,
} from '../src/services/astro/gotocheck';

const T0 = 1_000_000;
const BIAS: GyroLite = {t: 0, x: 0, y: 0, z: 0};

/** Slew simulé : rotation à ω deg/s autour de l'axe z (gyro) + quaternions
 *  correspondants (télémétrie) à intervalle régulier. */
function slewSlew(t0: number, ms: number, degPerSec: number, stepMs: number) {
  const gyro: GyroLite[] = [];
  const tele: TeleSample[] = [];
  const D2R = Math.PI / 180;
  for (let t = t0; t <= t0 + ms; t += stepMs) {
    gyro.push({t, x: 0, y: 0, z: degPerSec * D2R});
    const ang = (degPerSec * (t - t0) / 1000) * D2R / 2; // demi-angle
    tele.push({t, qw: Math.cos(ang), qx: 0, qy: 0, qz: Math.sin(ang)});
  }
  return {gyro, tele};
}

describe('quatAngleDeg', () => {
  it('même quaternion → 0°', () => {
    const q = {qw: 0.5, qx: 0.5, qy: 0.5, qz: 0.5};
    expect(quatAngleDeg(q, q)).toBeCloseTo(0, 6);
  });
  it('rotation de 90° autour de z → 90°', () => {
    const a = {qw: 1, qx: 0, qy: 0, qz: 0};
    const b = {qw: Math.cos(Math.PI / 4), qx: 0, qy: 0, qz: Math.sin(Math.PI / 4)};
    expect(quatAngleDeg(a, b)).toBeCloseTo(90, 3);
  });
  it('signe inverse (q et −q) → même rotation', () => {
    const a = {qw: Math.cos(0.2), qx: 0, qy: 0, qz: Math.sin(0.2)};
    expect(quatAngleDeg(a, {qw: -a.qw, qx: -0, qy: -0, qz: -a.qz})).toBeCloseTo(0, 6);
  });
});

describe('gyroPathDeg / telePathDeg — les deux vérités du même slew', () => {
  it('slew 5°/s pendant 4 s → gyro ≈ 20°, télé ≈ 20°, ratio ≈ 1', () => {
    const {gyro, tele} = slewSlew(T0, 4000, 5, 100);
    const g = gyroPathDeg(gyro, T0, T0 + 4000, BIAS);
    const tl = telePathDeg(tele, T0, T0 + 4000);
    expect(g).toBeGreaterThan(18);
    expect(g).toBeLessThan(22);
    expect(tl / g).toBeCloseTo(1, 1);
  });
  it('biais gyro soustrait : gyro immobile + biais → chemin ≈ 0', () => {
    const gyro: GyroLite[] = [];
    for (let t = T0; t <= T0 + 2000; t += 100) {
      gyro.push({t, x: 0, y: 0, z: 0.01}); // 0,01 rad/s de biais
    }
    expect(gyroPathDeg(gyro, T0, T0 + 2000, {t: 0, x: 0, y: 0, z: 0.01})).toBeCloseTo(0, 3);
  });
  it('trou dans le gyro → pas intégré sur le trou', () => {
    const {gyro} = slewSlew(T0, 1000, 5, 100);
    // échantillons à plus de 2 s d'écart : ignorés par l'intégration
    expect(gyroPathDeg(gyro, T0 + 3000, T0 + 4000, BIAS)).toBe(0);
  });
});

describe('smoothnessOf — garde de fluidité de la télémétrie', () => {
  const SLEW = slewSlew(T0, 4000, 5, 200); // 5 Hz nominal → 20 échantillons
  it('flux régulier de slew → fluide', () => {
    const s = smoothnessOf(SLEW.tele, T0, T0 + 4000, 200);
    expect(s.ok).toBe(true);
    expect(s.gapMaxMs!).toBeLessThanOrEqual(500);
    expect(s.jitterPct!).toBeLessThan(80);
  });
  it('trou d\u2019échantillonnage (> 2,5× intervalle) → non fluide', () => {
    const tele = SLEW.tele.filter((s) => !(s.t > T0 + 1500 && s.t < T0 + 3200));
    const s = smoothnessOf(tele, T0, T0 + 4000, 200);
    expect(s.gapMaxMs!).toBeGreaterThan(1200);
    expect(s.ok).toBe(false);
  });
  it('bruit magnétique : pas erratiques → jitter > 80 % → non fluide', () => {
    const tele: TeleSample[] = [];
    let ang = 0;
    for (let i = 0; i <= 30; i++) {
      const noise = (i % 2 === 0 ? 3.5 : 0.02) * (Math.PI / 180); // ±3,5° d'errance
      ang += noise;
      tele.push({t: T0 + i * 200, qw: Math.cos(ang / 2), qx: 0, qy: 0, qz: Math.sin(ang / 2)});
    }
    const s = smoothnessOf(tele, T0, T0 + 6000, 200);
    expect(s.jitterPct!).toBeGreaterThan(80);
    expect(s.ok).toBe(false);
  });
  it('sauts aberrants (boussole qui saute) → spikes comptés → non fluide', () => {
    const tele: TeleSample[] = [];
    for (let i = 0; i <= 25; i++) {
      const jump = i === 10 || i === 11 || i === 17 ? 12 : 0.5; // sauts de 12°
      const ang = i * jump * (Math.PI / 180);
      tele.push({t: T0 + i * 200, qw: Math.cos(ang / 2), qx: 0, qy: 0, qz: Math.sin(ang / 2)});
    }
    const s = smoothnessOf(tele, T0, T0 + 5000, 200);
    expect(s.spikeCount).toBeGreaterThanOrEqual(3);
    expect(s.ok).toBe(false);
  });
  it('flux figé (étalon perdu) → frozenPct > 40 % → non fluide', () => {
    const q = {qw: 1, qx: 0, qy: 0, qz: 0};
    const tele: TeleSample[] = [];
    for (let i = 0; i < 30; i++) tele.push({t: T0 + i * 200, ...q});
    const s = smoothnessOf(tele, T0, T0 + 6000, 200);
    expect(s.frozenPct!).toBeGreaterThan(40);
    expect(s.ok).toBe(false);
  });
  it('< 6 échantillons → non fiable (mais verdict global unknown)', () => {
    const s = smoothnessOf(SLEW.tele.slice(0, 4), T0, T0 + 800, 200);
    expect(s.ok).toBe(false);
    expect(s.n).toBe(4);
  });
});

describe('crossCheck — verdict global', () => {
  const OPTS = {expectedTeleMs: 200, bias: BIAS};
  it('slew sain : arcs concordants + flux fluide → GOOD', () => {
    const {gyro, tele} = slewSlew(T0, 4000, 5, 200);
    const r = crossCheck(gyro, tele, T0, T0 + 4000, OPTS);
    expect(r.verdict).toBe('good');
    expect(r.reasons).toHaveLength(0);
    expect(r.ratio!).toBeGreaterThan(0.8);
    expect(r.ratio!).toBeLessThan(1.2);
  });
  it('télémétrie trouée pendant que le tube tourne → POOR (raisons explicites)', () => {
    const {gyro, tele} = slewSlew(T0, 4000, 5, 200);
    const holey = tele.filter((s) => !(s.t > T0 + 1200 && s.t < T0 + 3400));
    const r = crossCheck(gyro, holey, T0, T0 + 4000, OPTS);
    expect(r.verdict).toBe('poor');
    expect(r.reasons).toContain('sky.reasonGaps');
    // le grand pas qui comble le trou est répéré comme bruit excessif
    expect(r.reasons).toContain('sky.reasonJitter');
  });
  it('télémétrie muette (< 6 échantillons) → UNKNOWN (pas de conclusion)', () => {
    const {gyro, tele} = slewSlew(T0, 4000, 5, 200);
    const r = crossCheck(gyro, tele.slice(0, 3), T0, T0 + 4000, OPTS);
    expect(r.verdict).toBe('unknown');
  });
  it('tube immobile + télé figée : pas de mouvement → POOR (reasonStatic)', () => {
    const tele: TeleSample[] = [];
    for (let i = 0; i < 20; i++) tele.push({t: T0 + i * 200, qw: 1, qx: 0, qy: 0, qz: 0});
    const r = crossCheck([], tele, T0, T0 + 4000, OPTS);
    expect(r.verdict).toBe('poor');
    expect(r.reasons).toContain('sky.reasonStatic');
  });
  it('ratio légèrement hors bande (0,55..1,8 tolérées par la fluidité seule) — flux fluide + ratio 1,3 → GOOD', () => {
    const {gyro, tele} = slewSlew(T0, 4000, 5, 200);
    // télémétrie légèrement survitaminée (×1,3) : reste dans la bande 0,5..2
    const boosted = tele.map((s, i) => {
      const ang = 5 * 1.3 * ((s.t - T0) / 1000) * (Math.PI / 180) / 2;
      return {t: s.t, qw: Math.cos(ang), qx: 0, qy: 0, qz: Math.sin(ang)};
    });
    const r = crossCheck(gyro, boosted, T0, T0 + 4000, OPTS);
    expect(r.verdict).toBe('good');
    expect(r.ratio!).toBeCloseTo(1.3, 1);
  });
});
