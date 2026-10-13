/**
 * Tests v2.2.0 — presets de monture (astro/mounts.ts).
 *
 * Contrats verrouillés :
 *  1. la suggestion déduit un preset cohérent de la RAQUETTE détectée ;
 *  2. resolvePreset respecte le choix manuel (monture mal détectée) ;
 *  3. la garde des jambes de butées est proportionnelle à la course
 *     restante et au taux — bornée (jamais infinie, jamais 0) ;
 *  4. altitude inconnue → garde sur la moitié de la course (prudente).
 */
import {
  MOUNT_PRESETS,
  limitLegGuardSec,
  resolvePreset,
  suggestPresetForModel,
} from '../src/services/astro/mounts';

describe('suggestPresetForModel — raquette → preset', () => {
  it('#49x → famille ETX (butées prudentes)', () => {
    expect(suggestPresetForModel('autostar497')).toBe('etx125');
    expect(suggestPresetForModel('autostar495')).toBe('etx125');
    expect(suggestPresetForModel('autostar494')).toBe('etx90');
  });
  it('Autostar II / LX200 → LX200', () => {
    expect(suggestPresetForModel('autostar2')).toBe('lx200');
    expect(suggestPresetForModel('lx200')).toBe('lx200');
  });
  it('raquette inconnue/null → générique (butées larges)', () => {
    expect(suggestPresetForModel(null)).toBe('generic');
  });
});

describe('resolvePreset — le choix manuel gagne', () => {
  it('manual ≠ auto → preset manuel même si la détection dit autre chose', () => {
    expect(resolvePreset('lx90', 'autostar497').id).toBe('lx90');
    expect(resolvePreset('etx90', 'autostar2').id).toBe('etx90');
  });
  it('auto → suggestion depuis la raquette détectée', () => {
    expect(resolvePreset('auto', 'autostar497').id).toBe('etx125');
    expect(resolvePreset('auto', null).id).toBe('generic');
  });
  it('les presets décrivent la mécanique : butées bornées et cohérentes', () => {
    for (const p of Object.values(MOUNT_PRESETS)) {
      expect(p.minAltDeg).toBeGreaterThanOrEqual(0);
      expect(p.maxAltDeg).toBeLessThanOrEqual(90);
      expect(p.minAltDeg).toBeLessThan(p.maxAltDeg);
      expect(p.expectedRates.slew).toBeGreaterThan(p.expectedRates.find);
      expect(p.expectedRates.find).toBeGreaterThan(p.expectedRates.center);
    }
  });
});

describe('limitLegGuardSec — garde des jambes de butées (v2.2.0)', () => {
  const generic = MOUNT_PRESETS.generic;
  it('course entière à la vitesse donnée + marge 1,4× + 10 s (v2.9.6 : plafond 150 s)', () => {
    // 45°→90° = 45° à 0,4°/s = 112,5 s ×1,4 +10 = 167,5 → plafond 150
    expect(limitLegGuardSec(45, true, generic, 0.4)).toBe(150);
  });
  it('descente : distance au minAlt', () => {
    // 45°→0° = 45° à 0,4°/s → 167,5 → plafond 150
    expect(limitLegGuardSec(45, false, generic, 0.4)).toBe(150);
  });
  it('proche de la butée → garde courte (mais ≥ 12 s)', () => {
    // 89°→90° = 1° (min 2° imposé) à 0,4°/s = 5 s ×1,4 +10 = 17
    expect(limitLegGuardSec(89, true, generic, 0.4)).toBe(17);
  });
  it('plafonné à 150 s (monture bloquée : on n\'insiste pas — v2.9.6 : 240 → 150)', () => {
    // 0°→90° à 0,05°/s = 1800 s ×1,4 → clamp 150
    expect(limitLegGuardSec(0, true, generic, 0.05)).toBe(150);
  });
  it('altitude inconnue → moitié de la course (prudent, plafond 150 v2.9.6)', () => {
    // maxAlt-minAlt = 90 → moitié = 45 → même garde que 45→90 (plafonnée)
    expect(limitLegGuardSec(null, true, generic, 0.4)).toBe(150);
  });
  it('taux absurde → garde de repli 90 s', () => {
    expect(limitLegGuardSec(45, true, generic, 0)).toBe(90);
    expect(limitLegGuardSec(45, true, generic, -1)).toBe(90);
  });
  it('preset ETX (butées étroites) → garde plus courte que générique', () => {
    const etx = MOUNT_PRESETS.etx125; // 10..87
    // 45°→87° = 42° à 2°/s = 21 s ×1,4 +10 = 39
    expect(limitLegGuardSec(45, true, etx, 2)).toBe(39);
  });
});
