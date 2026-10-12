/**
 * Tests v2.8.1 — sélection caméra par TYPE (interne / externe) + libellés
 * par rôle (« caméra interne ou externe, menu déroulant : front/rear/
 * grand angle/IR etc. selon les options du téléphone »).
 */
import {
  splitByType, deviceLabel, defaultType, coerceType, selectionValid,
} from '../src/services/astro/cameraPicker';
import type {CameraDeviceInfo} from '../src/services/phone/astroCamera';

const L = {
  rear: 'Arrière', front: 'Frontale', main: 'principale', wide: 'grand-angle',
  tele: 'téléobjectif', depth: 'profondeur / IR', external: 'Caméra externe (UVC)',
};

function dev(p: Partial<CameraDeviceInfo>): CameraDeviceInfo {
  return {
    id: p.id ?? '0', facing: p.facing ?? 'back', external: p.external ?? false,
    manual: p.manual ?? true, sizes: [], maxIso: 0, minExposureComp: 0,
    maxExposureComp: 0, label: p.label ?? '', role: p.role ?? 'main',
    focal: p.focal, source: p.source ?? 'camera2', deviceName: p.deviceName,
  };
}

describe('splitByType', () => {
  it('sépare UVC (source uvc) et HAL externe des caméras internes', () => {
    const {internal, external} = splitByType([
      dev({id: 'uvc1', source: 'uvc', external: true, facing: 'external', label: 'UVC — cam'}),
      dev({id: '1', facing: 'back'}),
      dev({id: '2', facing: 'front'}),
      dev({id: '3', facing: 'external', external: true}), // UVC via HAL
    ]);
    expect(external.map((d) => d.id)).toEqual(['uvc1', '3']);
    expect(internal.map((d) => d.id)).toEqual(['1', '2']);
  });

  it('liste vide → deux listes vides', () => {
    expect(splitByType([])).toEqual({internal: [], external: []});
  });
});

describe('deviceLabel', () => {
  it('UVC : libellé matériel tel quel', () => {
    const d = dev({source: 'uvc', external: true, facing: 'external', label: 'UVC — SVBONY (0A12:4001)'});
    expect(deviceLabel(d, L)).toBe('UVC — SVBONY (0A12:4001)');
  });

  it('arrière principale unique', () => {
    expect(deviceLabel(dev({facing: 'back', role: 'main'}), L)).toBe('Arrière — principale');
  });

  it('arrière grand-angle et téléobjectif', () => {
    expect(deviceLabel(dev({facing: 'back', role: 'wide'}), L)).toBe('Arrière — grand-angle');
    expect(deviceLabel(dev({facing: 'back', role: 'tele'}), L)).toBe('Arrière — téléobjectif');
  });

  it('frontale principale : libellé court', () => {
    expect(deviceLabel(dev({facing: 'front', role: 'main'}), L)).toBe('Frontale');
  });

  it('profondeur / IR', () => {
    expect(deviceLabel(dev({facing: 'back', role: 'depth'}), L)).toBe('Arrière — profondeur / IR');
  });
});

describe('defaultType / coerceType', () => {
  it('externe par défaut dès qu\'une UVC existe', () => {
    expect(defaultType([dev({id: '1'}), dev({id: 'u', source: 'uvc', external: true})])).toBe('external');
    expect(defaultType([dev({id: '1'})])).toBe('internal');
    expect(defaultType([])).toBe('internal');
  });

  it('coerceType bascule sur le type disponible', () => {
    expect(coerceType('external', [dev({id: '1'})])).toBe('internal');
    expect(coerceType('internal', [dev({id: 'u', source: 'uvc', external: true})])).toBe('external');
    expect(coerceType('external', [dev({id: 'u', source: 'uvc', external: true})])).toBe('external');
  });
});

describe('selectionValid', () => {
  it('refuse un choix hors liste du type affiché', () => {
    const list = [dev({id: '1'})];
    expect(selectionValid('1', list)).toBe(true);
    expect(selectionValid('uvc:x', list)).toBe(false);
    expect(selectionValid(null, list)).toBe(false);
  });
});
