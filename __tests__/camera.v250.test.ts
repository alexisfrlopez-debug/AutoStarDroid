/**
 * Tests v2.5.0 — CAMÉRA ASTRONOMIQUE côté pur :
 *  - EMPILEMENT (stacking.ts) : décodage, alignement translation, moyenne/
 *    médiane/κσ, étirement, encodage BMP (entête + pixels) ;
 *  - AUTOGUIDAGE (guiding.ts) : plan d'impulsions selon axes/flip/échelle,
 *    calibrage d'échelle, fiabilité du centroïde ;
 *  - ACQUISITION (acquisition.ts) : presets et plans par qualité.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

import {
  decodeGrayB64, alignGray, stackFrames, stretchGray, encodeBmpGray,
} from '../src/services/astro/stacking';
import {
  guidePlan, calibrateScale, centroidReliable,
} from '../src/services/astro/guiding';
import {
  ACQ_PRESETS, buildPlan,
} from '../src/services/astro/acquisition';

const W = 192; const H = 144;

describe('stacking — décodage de l\u2019anneau', () => {
  it('base64 → octets gris (taille exacte)', () => {
    const src = Buffer.alloc(W * H, 42).toString('base64');
    const g = decodeGrayB64(src, W, H);
    expect(g).not.toBeNull();
    expect(g!.length).toBe(W * H);
    expect(g![0]).toBe(42);
  });
  it('base64 invalide → null (jamais de crash)', () => {
    expect(decodeGrayB64('@@@invalide@@@', W, H)).toBeNull();
  });
});

describe('stacking — alignement par translation', () => {
  const ref = new Uint8Array(W * H);
  // point brillant au centre
  ref[72 * W + 96] = 200;
  const mov = new Uint8Array(W * H);
  mov[70 * W + 92] = 200; // même motif décalé de (-4, -2)
  it('trouve le décalage (dx=-4, dy=-2)', () => {
    const {dx, dy} = alignGray(ref, mov, W, H, 7);
    expect(dx).toBe(-4);
    expect(dy).toBe(-2);
  });
});

describe('stacking — modes d\u2019empilement', () => {
  const flat = (v: number) => new Uint8Array(W * H).fill(v);
  it('moyenne de deux niveaux', () => {
    const {gray} = stackFrames([flat(100), flat(200)], W, H, 'mean');
    expect(gray[0]).toBe(150);
  });
  it('médiane ignore le pixel aberrant', () => {
    const a = flat(100); const b = flat(100); const c = flat(250);
    const {gray} = stackFrames([a, b, c], W, H, 'median');
    expect(gray[0]).toBe(100);
  });
  it('kappa-sigma rejette la trame éclair (satellite)', () => {
    const a = flat(90); const b = flat(95); const sat = flat(240);
    const {gray} = stackFrames([a, b, sat], W, H, 'kappa');
    expect(gray[0]).toBeLessThan(120);
  });
  it('une seule frame → copie', () => {
    const {gray, used} = stackFrames([flat(77)], W, H, 'mean');
    expect(used).toBe(1);
    expect(gray[5]).toBe(77);
  });
});

describe('stacking — étirement + BMP', () => {
  it('étirement : percentiles → plein débattement, gamma éclaircit les faibles', () => {
    const g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = Math.min(255, 60 + (i % 40)); // 60..99
    const s = stretchGray(g, 0.85);
    expect(Math.max(...s)).toBeGreaterThan(200);
  });
  it('BMP 24 bits : signature BM, entête 54 octets, taille cohérente', () => {
    const g = new Uint8Array(W * H).fill(128);
    const b64 = encodeBmpGray(g, W, H);
    const bin = Buffer.from(b64, 'base64');
    expect(bin[0]).toBe(0x42); // 'B'
    expect(bin[1]).toBe(0x4D); // 'M'
    const rowSize = Math.ceil((W * 3) / 4) * 4;
    expect(bin.readUInt32LE(2)).toBe(54 + rowSize * H);
    expect(bin.readInt32LE(18)).toBe(W);
    expect(bin.readInt32LE(22)).toBe(H);
    expect(bin.readUInt16LE(28)).toBe(24);
    // premier pixel (bottom-up → dernière ligne de l'image source)
    expect(bin[54]).toBe(128); expect(bin[55]).toBe(128); expect(bin[56]).toBe(128);
  });
});

describe('autoguidage — plan d\u2019impulsions', () => {
  const base = {
    scaleArcsecPerPx: 2,
    axes: {xAxis: 'ra' as const, flipX: false, flipY: false},
    rates: {guide: 0.02, center: 0.08},
    deadbandArcsec: 6,
    maxPulseS: 2,
  };
  it('dérive AD : X+ → Est (AD+), durée = arc/taux', () => {
    const [step] = guidePlan({...base, dxPx: 10, dyPx: 0}); // 20″ = 0,0056°
    expect(step.dir).toBe('e');
    expect(step.durationS).toBeCloseTo((20 / 3600) / 0.02, 4);
  });
  it('dérive DEC : Y+ (bas) → Sud (DEC−)', () => {
    const [step] = guidePlan({...base, dxPx: 0, dyPx: 10});
    expect(step.dir).toBe('s');
  });
  it('sous la zone morte : aucune impulsion', () => {
    expect(guidePlan({...base, dxPx: 1, dyPx: 1}).length).toBe(0);
  });
  it('flipX inverse la direction de l\u2019axe X', () => {
    const [step] = guidePlan({...base, dxPx: 10, dyPx: 0, axes: {xAxis: 'ra', flipX: true, flipY: false}});
    expect(step.dir).toBe('w');
  });
  it('axes permutés : X image commande la DEC', () => {
    const [step] = guidePlan({...base, dxPx: 10, dyPx: 0, axes: {xAxis: 'dec', flipX: false, flipY: false}});
    expect(step.dir).toBe('n');
  });
  it('gros écart → vitesse center et plafond d\u2019impulsion', () => {
    const [step] = guidePlan({...base, dxPx: 60, dyPx: 0}); // 120″ = 0,033° > 30″
    expect(step.durationS).toBeLessThanOrEqual(2);
  });
});

describe('autoguidage — calibrage et fiabilité', () => {
  it('échelle = arc commandé / décalage mesuré', () => {
    // 2,5 s × 0,02°/s = 0,05° = 180″ sur 30 px → 6″/px
    const r = calibrateScale(30, 0, 2.5, 0.02);
    expect(r.scaleArcsecPerPx).toBeCloseTo(6, 3);
    expect(r.xAxisSuggests).toBe('ra');
  });
  it('décalage vertical → axe X = DEC suggéré', () => {
    const r = calibrateScale(0, 25, 2.5, 0.02);
    expect(r.xAxisSuggests).toBe('dec');
  });
  it('aucun décalage → échelle neutre', () => {
    const r = calibrateScale(0.1, 0.1, 2.5, 0.02);
    expect(r.scaleArcsecPerPx).toBe(1);
  });
  it('centroïde fiable : crête et flux minimaux, position présente', () => {
    expect(centroidReliable(0.5, 0.5, 120, 5000)).toBe(true);
    expect(centroidReliable(0.5, 0.5, 20, 5000)).toBe(false); // trop faible
    expect(centroidReliable(undefined, undefined, 120, 5000)).toBe(false);
  });
});

describe('acquisition — presets et plans', () => {
  it('presets couvrent les objets courants avec plages cohérentes', () => {
    const kinds = Object.keys(ACQ_PRESETS);
    expect(kinds).toContain('moon');
    expect(kinds).toContain('planets');
    expect(kinds).toContain('sun');
    expect(kinds).toContain('nebulaFaint');
    for (const p of Object.values(ACQ_PRESETS)) {
      expect(p.byQuality.rapide).toBeLessThan(p.byQuality.haute);
      expect(p.count.rapide).toBeLessThan(p.count.haute);
      expect(p.exposureMs[0]).toBeLessThan(p.exposureMs[1]);
    }
  });
  it('plan par qualité : plus haute = pose plus longue + plus d\u2019images', () => {
    const fast = buildPlan('moon', 'rapide');
    const high = buildPlan('moon', 'haute');
    expect(high.exposureMs).toBeGreaterThan(fast.exposureMs);
    expect(high.count).toBeGreaterThan(fast.count);
    expect(high.note).toBe('camAcq.noteMoon');
  });
  it('pose longue sur capteur sans manuel → avertissement capteur', () => {
    const p = buildPlan('nebulaFaint', 'haute', {manual: false});
    expect(p.exposureMs).toBeGreaterThan(1500);
    expect(p.needsManualSensor).toBe(true);
  });
  it('capteur manuel : pas d\u2019avertissement', () => {
    const p = buildPlan('nebulaFaint', 'haute', {manual: true});
    expect(p.needsManualSensor).toBe(false);
  });
  it('intervalle ≥ pose + marge', () => {
    const p = buildPlan('planets', 'standard');
    expect(p.intervalMs).toBeGreaterThanOrEqual(p.exposureMs + 300);
  });
});
