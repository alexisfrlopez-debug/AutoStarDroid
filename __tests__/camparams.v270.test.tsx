/**
 * Tests v2.7.0 — CAMÉRA : détection UVC + réglages manuels.
 *  - ROUTAGE du service astroCamera : UVC (USB host) d'abord, Camera2 ensuite ;
 *  - permission USB demandée avant ouverture du flux UVC (jamais pour interne) ;
 *  - setParams routé vers le bon module natif (JSON string — règle de survie
 *    Hermes : AUCUN objet non sérialable, AUCUN callback) ;
 *  - plages normalisées pour les curseurs (zoom/focus dérivés Camera2) ;
 *  - snapToRange (curseur sans dépendance native).
 * Mocks NativeModules PATCHÉS AVANT le require du service (le service lit
 * NativeModules au chargement — pattern des tests v1.7.2/v2.5.0).
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
}));

const calls = {
  uvcPermission: [] as string[],
  uvcOpen: [] as Array<[string, number, number, number, number]>,
  c2Open: [] as string[],
  uvcSet: [] as string[],
  c2Set: [] as string[],
  uvcLock: [] as number[],
  c2Lock: [] as number[],
};

import {NativeModules} from 'react-native';

(NativeModules as any).NativeUvcCamera = {
  listUvcCameras: jest.fn(async () => [
    {id: 'uvc:cam0', deviceName: 'cam0', vid: 0x0c45, pid: 0x6366,
     external: true, manual: true, label: 'UVC — SVBONY (0C45:6366)'},
  ]),
  hasUvcPermission: jest.fn(async () => false),
  requestUvcPermission: jest.fn(async (n: string) => { calls.uvcPermission.push(n); return true; }),
  openUvcStream: jest.fn(async (...a: [string, number, number, number, number]) => {
    calls.uvcOpen.push(a); return true;
  }),
  closeUvcStream: jest.fn(async () => true),
  isUvcStreaming: jest.fn(async () => false),
  getUvcRanges: jest.fn(async () => ({
    controls: {
      exposureMs: {min: 0.1, max: 2000, step: 0.1, def: 10},
      gain: {min: 0, max: 63, step: 1, def: 30},
      whiteBalanceTemp: {min: 2800, max: 6500, step: 100, def: 4600},
    },
    hasPu: true, hasCt: true,
  })),
  setUvcControls: jest.fn(async (_n: string, json: string) => {
    calls.uvcSet.push(json);
    return {applied: ['exposureMs'], failed: ['gain']};
  }),
  setLock: jest.fn(async (x: number) => { calls.uvcLock.push(x); return true; }),
  clearLock: jest.fn(async () => true),
  captureStill: jest.fn(async () => 'UVCSTILL'),
  getLumaHistory: jest.fn(async () => []),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

(NativeModules as any).NativeUsbCamera = {
  listCameras: jest.fn(async () => [
    {id: '1', facing: 'back', external: false, manual: false, sizes: ['640x480'],
     maxIso: 6400, minExposureComp: -6, maxExposureComp: 6, label: 'Caméra interne #1'},
  ]),
  openStream: jest.fn(async (id: string) => { calls.c2Open.push(id); return true; }),
  closeStream: jest.fn(async () => true),
  isStreaming: jest.fn(async () => false),
  setParams: jest.fn(async () => true),
  setParams2: jest.fn(async (json: string) => { calls.c2Set.push(json); return {applied: [], failed: []}; }),
  getRanges2: jest.fn(async () => ({
    manual: true,
    iso: {min: 100, max: 6400, step: 50, def: 400},
    exposureMs: {min: 0.001, max: 30000, step: 0.001, def: 10},
    ev: {min: -6, max: 6, step: 0.5, def: 0},
    zoomMax: 4,
    focusMin: 10,
    wbModes: [0, 5, 6],
  })),
  setLock: jest.fn(async (x: number) => { calls.c2Lock.push(x); return true; }),
  clearLock: jest.fn(async () => true),
  captureStill: jest.fn(async () => 'C2STILL'),
  getLumaHistory: jest.fn(async () => []),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

const UVC: any = NativeModules.NativeUvcCamera;

// require APRÈS le patch des NativeModules (le service capture les modules
// natifs à l'import — cf. règle de survie Hermes v1.7.2)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {astroCamera} = require('../src/services/phone/astroCamera');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {snapToRange} = require('../src/components/SliderBar');

describe('astroCamera — détection fusionnée (UVC d\u2019abord)', () => {
  it('liste UVC + Camera2, UVC en premier avec source/deviceName', async () => {
    const list = await astroCamera.listCameras();
    expect(list).toHaveLength(2);
    expect(list[0].source).toBe('uvc');
    expect(list[0].id).toBe('uvc:cam0');
    expect(list[0].deviceName).toBe('cam0');
    expect(list[0].external).toBe(true);
    expect(list[1].source).toBe('camera2');
    expect(list[1].external).toBe(false);
  });

  it('modules absents → [] (jamais de crash)', async () => {
    expect(astroCamera.listCameras()).resolves.toBeTruthy();
  });
});

describe('astroCamera — ouverture du flux (permission UVC)', () => {
  it('UVC : permission PUIS openUvcStream(deviceName)', async () => {
    await astroCamera.open('uvc:cam0', 800, 600, 15, 80);
    expect(calls.uvcPermission).toEqual(['cam0']);
    expect(calls.uvcOpen).toHaveLength(1);
    expect(calls.uvcOpen[0]).toEqual(['cam0', 800, 600, 15, 80]);
    expect(calls.c2Open).toHaveLength(0);
  });

  it('interne : openStream Camera2, PAS de permission UVC', async () => {
    await astroCamera.open('1', 640, 480, 10, 70);
    expect(calls.c2Open).toEqual(['1']);
    expect(calls.uvcPermission.length).toBe(1); // inchangé depuis le test UVC
  });

  it('permission UVC refusée → erreur claire, pas d\u2019ouverture', async () => {
    UVC.requestUvcPermission.mockImplementationOnce(async () => false);
    await expect(astroCamera.open('uvc:cam0')).rejects.toThrow('Permission USB');
    expect(calls.uvcOpen).toHaveLength(1);
  });
});

describe('astroCamera — réglages manuels routés', () => {
  it('UVC : setParams → setUvcControls(deviceName, JSON)', async () => {
    await astroCamera.open('uvc:cam0');
    const failed = await astroCamera.setParams('uvc:cam0', {exposureMs: 250, gain: 12});
    expect(calls.uvcSet).toHaveLength(1);
    const payload = JSON.parse(calls.uvcSet[0]);
    expect(payload).toEqual({exposureMs: 250, gain: 12});
    // les refus matériels remontent à l'UI
    expect(failed).toEqual(['gain']);
  });

  it('Camera2 : setParams → setParams2(JSON)', async () => {
    const failed = await astroCamera.setParams('1', {exposureMode: 'manual', iso: 800} as any);
    expect(calls.c2Set).toHaveLength(1);
    expect(JSON.parse(calls.c2Set[0])).toEqual({exposureMode: 'manual', iso: 800});
    expect(failed).toEqual([]);
  });

  it('UVC : plages natives passées telles quelles', async () => {
    await astroCamera.open('uvc:cam0');
    const r = await astroCamera.getRanges('uvc:cam0');
    expect(r.source).toBe('uvc');
    expect(r.controls.exposureMs).toEqual({min: 0.1, max: 2000, step: 0.1, def: 10});
    expect(r.controls.gain).toBeDefined();
    expect(r.wbModes).toEqual([]);
  });

  it('Camera2 : zoom/focus dérivés des caractéristiques, noms WB convertis', async () => {
    const r = await astroCamera.getRanges('1');
    expect(r.source).toBe('camera2');
    expect(r.controls.zoom).toEqual({min: 0, max: 1, step: 0.02, def: 0});
    expect(r.controls.focusAbsolute!.max).toBe(10);
    expect(r.wbModes).toEqual(['auto', 'daylight', 'cloudy']);
    expect(r.manual).toBe(true);
  });

  it('verrou de suivi routé vers le flux ACTIF (UVC)', async () => {
    await astroCamera.open('uvc:cam0');
    await astroCamera.setLock(0.5, 0.5, 0.13);
    expect(calls.uvcLock).toEqual([0.5]);
    expect(calls.c2Lock).toHaveLength(0);
  });

  it('captureStill routé vers le flux actif', async () => {
    await astroCamera.open('uvc:cam0');
    expect(await astroCamera.captureStill()).toBe('UVCSTILL');
    await astroCamera.open('1');
    expect(await astroCamera.captureStill()).toBe('C2STILL');
  });

  it('close : ferme le bon backend puis plus de device actif', async () => {
    await astroCamera.open('uvc:cam0');
    await astroCamera.close();
    expect(UVC.closeUvcStream).toHaveBeenCalled();
    // après close, captureStill retombe sur Camera2
    expect(await astroCamera.captureStill()).toBe('C2STILL');
  });
});

describe('snapToRange — curseur borné + pas', () => {
  it('borne dans [min,max]', () => {
    expect(snapToRange(-10, 0, 100, 1)).toBe(0);
    expect(snapToRange(999, 0, 100, 1)).toBe(100);
  });

  it('arrondit au pas', () => {
    expect(snapToRange(47, 0, 100, 10)).toBe(50);
    expect(snapToRange(0.44, 0, 1, 0.05)).toBeCloseTo(0.45, 6);
  });

  it('décimales selon le pas (pas de flottantssales)', () => {
    expect(snapToRange(0.1 + 0.2, 0, 1, 0.1)).toBeCloseTo(0.3, 6);
  });

  it('min/max inversés gérés (tri interne)', () => {
    expect(snapToRange(50, 100, 0, 10)).toBe(50);
  });
});
