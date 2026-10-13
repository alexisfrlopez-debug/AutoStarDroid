/**
 * Tests v2.9.8 — UVC « aperçu figé en ouverture explicite ».
 *
 * CAUSE RACINE (côté natif, corrigée dans UvcCameraModule.kt) : l'ouverture
 * EXPLICITE (openUvcStreamEx — résolution/cadence choisies dans l'app,
 * sélecteurs « Résolution & cadence ») arrivait dans openStreamInternal avec
 * fpsMax = 0 → frameSkip = 30/maxOf(1,0) = 30 → UNE frame sur 30 atteignait
 * l'aperçu (≈ 1 fps à 30 fps caméra, pire en dessous) quelle que soit la
 * cadence choisie. Correctif : frameSkip calculé depuis la cadence NÉGOCIÉE
 * (intervalle UVC) — cible fpsMax en mode auto, cadence choisie elle-même en
 * mode explicite. Garde bornes au passage : réponse probe COURTE (< 26 octets,
 * acceptée depuis la v2.9.6) ne doit plus lire dwMaxVideoFrameSize/
 * dwMaxPayloadTransferSize hors bornes (rejet « OPEN » cryptique).
 *
 * CÔTÉ JS, CE QUE CES TESTS VERROUILLENT (le contrat que le natif consomme) :
 *  - sélection UVC explicite COMPLÈTE (format+frame+intervalle) → openUvcStreamEx
 *    avec les arguments EXACTS — le chemin réparé ne doit jamais retomber en auto ;
 *  - sélection PARTIELLE (intervalle manquant) → repli openUvcStream auto avec
 *    width/height/fpsMax transmis TELS QUELS (le frameSkip natif en dépend) ;
 *  - ouverture auto par défaut : préférences 960×720 @ 12 fps ;
 *  - fermeture puis ré-ouverture : la sélection explicite re-passe par EX
 *    (redémarrage du flux après changement de résolution — v2.8.0) ;
 *  - close() remet le device actif à null (les contrôles retombent sur Camera2).
 * Mocks NativeModules PATCHÉS AVANT le require du service (le service lit
 * NativeModules au chargement — pattern des tests v1.7.2/v2.7.0).
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
  uvcOpenEx: [] as Array<[string, number, number, number, number]>,
  uvcClose: 0,
  c2Open: [] as string[],
};

import {NativeModules} from 'react-native';

(NativeModules as any).NativeUvcCamera = {
  listUvcCameras: jest.fn(async () => []),
  hasUvcPermission: jest.fn(async () => false),
  requestUvcPermission: jest.fn(async (n: string) => {
    calls.uvcPermission.push(n);
    return true;
  }),
  openUvcStream: jest.fn(async (...a: [string, number, number, number, number]) => {
    calls.uvcOpen.push(a);
    return true;
  }),
  openUvcStreamEx: jest.fn(async (...a: [string, number, number, number, number]) => {
    calls.uvcOpenEx.push(a);
    return true;
  }),
  closeUvcStream: jest.fn(async () => {
    calls.uvcClose += 1;
    return true;
  }),
  isUvcStreaming: jest.fn(async () => false),
  getUvcRanges: jest.fn(async () => ({controls: {}, hasPu: true, hasCt: true, formats: []})),
  setUvcControls: jest.fn(async () => ({applied: [], failed: []})),
  setLock: jest.fn(async () => true),
  clearLock: jest.fn(async () => true),
  captureStill: jest.fn(async () => 'UVCSTILL'),
  getLumaHistory: jest.fn(async () => []),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

(NativeModules as any).NativeUsbCamera = {
  listCameras: jest.fn(async () => []),
  openStream: jest.fn(async (id: string) => {
    calls.c2Open.push(id);
    return true;
  }),
  closeStream: jest.fn(async () => true),
  isStreaming: jest.fn(async () => false),
  setParams: jest.fn(async () => true),
  setParams2: jest.fn(async () => ({applied: [], failed: []})),
  getRanges2: jest.fn(async () => ({manual: false})),
  setLock: jest.fn(async () => true),
  clearLock: jest.fn(async () => true),
  captureStill: jest.fn(async () => 'C2STILL'),
  getLumaHistory: jest.fn(async () => []),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

const UVC: any = NativeModules.NativeUvcCamera;

// require APRÈS le patch des NativeModules (le service capture les modules
// natifs à l'import — règle de survie Hermes v1.7.2)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {astroCamera} = require('../src/services/phone/astroCamera');

// Sélecteurs « Résolution & cadence » (v2.8.0) — les listes que getUvcRanges
// expose à l'écran et que l'écran re-passe à open() au redémarrage.
const EX_SELECTION = {formatIndex: 1, frameIndex: 2, interval: 333333}; // MJPEG 1280×720 @ 30 fps

describe('uvcPreview v2.9.8 — chemin EXPLICITE (le chemin réparé)', () => {
  beforeEach(() => {
    calls.uvcOpen.length = 0;
    calls.uvcOpenEx.length = 0;
    calls.uvcPermission.length = 0;
    calls.c2Open.length = 0;
    calls.uvcClose = 0;
    UVC.openUvcStream.mockClear();
    UVC.openUvcStreamEx.mockClear();
    UVC.closeUvcStream.mockClear();
  });

  it('sélection complète format+frame+intervalle → openUvcStreamEx, JAMAIS auto', async () => {
    await astroCamera.open('uvc:cam0', {...EX_SELECTION, quality: 80});
    expect(calls.uvcPermission).toEqual(['cam0']);
    expect(calls.uvcOpenEx).toEqual([['cam0', 1, 2, 333333, 80]]);
    expect(calls.uvcOpen).toHaveLength(0);
  });

  it('toutes les frames choisies atteignent le pont : interval exact retransmis', async () => {
    // 30 fps = interval 333333 (unités 100 ns) — le frameSkip natif est
    // désormais calculé sur CETTE cadence (v2.9.8), l'aperçu suit le choix.
    await astroCamera.open('uvc:cam0', {formatIndex: 2, frameIndex: 1, interval: 666667, quality: 75});
    expect(calls.uvcOpenEx[0]).toEqual(['cam0', 2, 1, 666667, 75]);
  });

  it('fermeture puis ré-ouverture (changement de résolution) → EX à nouveau', async () => {
    await astroCamera.open('uvc:cam0', {...EX_SELECTION, quality: 80});
    await astroCamera.close();
    expect(calls.uvcClose).toBe(1);
    // l'écran re-passe la même sélection après close() (restartStream v2.8.0)
    await astroCamera.open('uvc:cam0', {...EX_SELECTION, quality: 80});
    expect(calls.uvcOpenEx).toHaveLength(2);
    expect(calls.uvcOpen).toHaveLength(0);
  });

  it('sélection PARTIELLE (intervalle manquant) → repli auto avec width/height/fpsMax', async () => {
    // cam.setUvcSelection(fi, fri, best ? best.interval : null) — une frame
    // sans fpsOptions laisse l'intervalle null : le JS ne doit PAS appeler
    // openUvcStreamEx avec un intervalle indéfini (garde v2.8.0).
    await astroCamera.open('uvc:cam0', {
      width: 1280, height: 720, fpsMax: 15, quality: 80,
      formatIndex: 1, frameIndex: 2, interval: undefined,
    });
    expect(calls.uvcOpen).toEqual([['cam0', 1280, 720, 15, 80]]);
    expect(calls.uvcOpenEx).toHaveLength(0);
  });
});

describe('uvcPreview v2.9.8 — chemin AUTO (fpsMax consommé par le frameSkip natif)', () => {
  beforeEach(() => {
    calls.uvcOpen.length = 0;
    calls.uvcOpenEx.length = 0;
    UVC.openUvcStream.mockClear();
    UVC.openUvcStreamEx.mockClear();
  });

  it('ouvertures par défaut : 960×720 @ 12 fps, qualité 75', async () => {
    await astroCamera.open('uvc:cam0');
    expect(calls.uvcOpen).toEqual([['cam0', 960, 720, 12, 75]]);
  });

  it('fpsMax transmis SANS transformation (5 fps → skip natif ≈ cadence/5)', async () => {
    await astroCamera.open('uvc:cam0', {width: 640, height: 480, fpsMax: 5, quality: 70});
    expect(calls.uvcOpen).toEqual([['cam0', 640, 480, 5, 70]]);
  });

  it('fpsMax élevé (60) retransmis tel quel (plafond natif 119)', async () => {
    await astroCamera.open('uvc:cam0', {fpsMax: 60});
    expect(calls.uvcOpen[0][3]).toBe(60);
  });
});

describe('uvcPreview v2.9.8 — après close(), état cohérent', () => {
  it('close remet le device actif à null (contrôles → Camera2, pas d\u2019UVC fantôme)', async () => {
    await astroCamera.open('uvc:cam0');
    await astroCamera.close();
    // plus de device actif : captureStill retombe sur Camera2
    expect(await astroCamera.captureStill()).toBe('C2STILL');
  });

  it('permission refusée au ré-ouverture → erreur claire, flux inchangé', async () => {
    UVC.requestUvcPermission.mockImplementationOnce(async () => false);
    await expect(
      astroCamera.open('uvc:cam0', {...EX_SELECTION, quality: 80}),
    ).rejects.toThrow('Permission USB');
    expect(calls.uvcOpenEx).toHaveLength(0);
  });
});
