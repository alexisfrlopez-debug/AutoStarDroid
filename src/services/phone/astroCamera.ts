/**
 * Service CAMÉRA ASTRONOMIQUE — pont JS vers les modules natifs
 * NativeUsbCamera (Camera2, caméras internes) et NativeUvcCamera (v2.7.0,
 * caméras UVC USB-host directes). Toutes les méthodes natives sont basées
 * sur Promise (règle de survie Hermes v1.7.2 : AUCUN callback JS ne
 * traverse le pont) ; le flux arrive par événements 'cameraFrame'.
 *
 * v2.7.0 — « l'application détecte les caméras internes du téléphone mais
 * pas la caméra UVC » : énumération UVC par USB host (indépendante du HAL
 * Camera2 du constructeur, absent sur la plupart des téléphones) + réglages
 * manuels complets (exposition, gain, balance des blancs, zoom, focus…)
 * avec plages lues du matériel.
 */
import {NativeEventEmitter, NativeModules} from 'react-native';
export interface ParamRange {
  min: number;
  max: number;
  step: number;
  def: number;
}

/** Cadence annoncée par la caméra UVC (fps + intervalle UVC exact). */
export interface UvcFpsOption {
  fps: number;
  /** Intervalle de frame UVC en unités 100 ns (10 000 000 / fps). */
  interval: number;
}

/** Frame (résolution) annoncée par un format UVC. */
export interface UvcFrameInfo {
  index: number;
  w: number;
  h: number;
  fpsOptions: UvcFpsOption[];
}

/** Format UVC (MJPEG / YUV) — contient ses résolutions. */
export interface UvcFormatInfo {
  index: number;
  mjpeg: boolean;
  label: string;
  frames: UvcFrameInfo[];
}

/** Taille de flux Camera2 (sélecteur de résolution). */
export interface C2SizeInfo {
  w: number;
  h: number;
}

export interface CameraRanges {
  source: 'uvc' | 'camera2';
  manual: boolean;
  /** Plages par contrôle : exposureMs, iso, ev, gain, brightness,
   *  contrast, saturation, sharpness, whiteBalanceTemp, zoom, focusAbsolute. */
  controls: Record<string, ParamRange>;
  /** Modes de balance des blancs (Camera2) — [] si n/a. */
  wbModes: string[];
  /** UVC — formats + résolutions + cadences annoncées par la caméra. */
  formats?: UvcFormatInfo[];
  /** Camera2 — tailles de flux disponibles. */
  sizes?: C2SizeInfo[];
  /** Camera2 — plages AE cibles (fps capteur). */
  fpsRanges?: Array<{min: number; max: number}>;
}

export interface ManualParams {
  exposureMode?: 'auto' | 'manual';
  /** Temps de pose en millisecondes (mode manuel). */
  exposureMs?: number;
  iso?: number;
  /** Compensation d'exposition (pas EV, mode auto). */
  exposureComp?: number;
  gain?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  whiteBalanceAuto?: boolean;
  whiteBalanceTemp?: number;
  /** Camera2 : preset de balance des blancs. */
  wbMode?: 'auto' | 'incandescent' | 'fluorescent' | 'warmFluorescent'
    | 'daylight' | 'cloudy' | 'twilight' | 'shade';
  /** Zoom normalisé 0..1. */
  zoom?: number;
  focusMode?: 'auto' | 'manual';
  /** Dioptries (Camera2) ou valeur brute (UVC focusAbsolute). */
  focusDistance?: number;
  /** Camera2 — cadence capteur (plage AE cible). */
  fpsMin?: number;
  fpsMax?: number;
}

export interface CameraDeviceInfo {
  id: string;
  facing: 'external' | 'back';
  external: boolean;
  /** Capteur avec mode manuel (ISO + temps de pose) — idéal planétaire. */
  manual: boolean;
  sizes: string[];
  maxIso: number;
  minExposureComp: number;
  maxExposureComp: number;
  label: string;
  /** Backend : USB-host UVC direct ou Camera2 (interne/externe-HAL). */
  source: 'uvc' | 'camera2';
  /** deviceName UsbManager (UVC) — requis pour permission + contrôles. */
  deviceName?: string;
}

export interface CameraFrame {
  /** JPEG encodé base64. */
  data: string;
  w: number;
  h: number;
  ts: number;
  /** Centroïde d'autoguidage (0..1) si un verrou est posé — sinon absent. */
  cx?: number;
  cy?: number;
  peak?: number;
  flux?: number;
}

/** Options d'ouverture du flux (v2.8.0). */
export interface OpenOpts {
  width?: number;
  height?: number;
  fpsMax?: number;
  quality?: number;
  /** UVC : format + frame + intervalle EXACTS de getRanges().formats. */
  formatIndex?: number;
  frameIndex?: number;
  interval?: number;
}

const CAM = NativeModules.NativeUsbCamera as
  | {
      listCameras(): Promise<Array<Partial<CameraDeviceInfo>>>;
      openStream(cameraId: string, width: number, height: number, fpsMax: number, quality: number): Promise<boolean>;
      setParams(exposureComp: number, iso: number, exposureNs: number): Promise<boolean>;
      setParams2(json: string): Promise<{applied: string[]; failed: string[]}>;
      getRanges2(cameraId: string): Promise<{
        manual: boolean;
        iso?: ParamRange; exposureMs?: ParamRange; ev?: ParamRange;
        zoomMax?: number; focusMin?: number; wbModes?: number[];
        sizes?: C2SizeInfo[]; fpsRanges?: Array<{min: number; max: number}>;
      }>;
      captureStill(): Promise<string>;
      getLumaHistory(): Promise<string[]>;
      setLock(x: number, y: number, halfWindow: number): Promise<boolean>;
      clearLock(): Promise<boolean>;
      closeStream(): Promise<boolean>;
      isStreaming(): Promise<boolean>;
    }
  | undefined;

const UVC = NativeModules.NativeUvcCamera as
  | {
      listUvcCameras(): Promise<Array<{
        id: string; deviceName: string; vid: number; pid: number;
        external: boolean; manual: boolean; label: string;
      }>>;
      hasUvcPermission(deviceName: string): Promise<boolean>;
      requestUvcPermission(deviceName: string): Promise<boolean>;
      openUvcStream(deviceName: string, width: number, height: number, fpsMax: number, quality: number): Promise<boolean>;
      openUvcStreamEx(deviceName: string, formatIndex: number, frameIndex: number, interval: number, quality: number): Promise<boolean>;
      closeUvcStream(): Promise<boolean>;
      isUvcStreaming(): Promise<boolean>;
      getUvcRanges(deviceName: string): Promise<{
        controls: Record<string, ParamRange>;
        formats?: UvcFormatInfo[];
      }>;
      setUvcControls(deviceName: string, json: string): Promise<{applied: string[]; failed: string[]}>;
      setLock(x: number, y: number, halfWindow: number): Promise<boolean>;
      clearLock(): Promise<boolean>;
      captureStill(): Promise<string>;
      getLumaHistory(): Promise<string[]>;
    }
  | undefined;

/** Le périphérique UVC actif (deviceName) — requis pour les contrôles. */
let activeDeviceName: string | null = null;

function emitter(): NativeEventEmitter | null {
  const mod = CAM ?? UVC;
  if (!mod) return null;
  return new NativeEventEmitter(mod as never);
}

export const astroCamera = {
  /** Caméras disponibles ([] si modules absents) : UVC d'abord (la cible
   *  principale — caméra astro), Camera2 ensuite (interne en secours). */
  async listCameras(): Promise<CameraDeviceInfo[]> {
    const out: CameraDeviceInfo[] = [];
    if (UVC) {
      try {
        const uvcList = (await UVC.listUvcCameras()) ?? [];
        for (const d of uvcList) {
          out.push({
            id: d.id,
            facing: 'external',
            external: true,
            manual: d.manual,
            sizes: [],
            maxIso: 0,
            minExposureComp: 0,
            maxExposureComp: 0,
            label: d.label,
            source: 'uvc',
            deviceName: d.deviceName,
          });
        }
      } catch (_) { /* module absent : Camera2 seul */ }
    }
    if (CAM) {
      try {
        const c2 = (await CAM.listCameras()) ?? [];
        for (const d of c2) {
          out.push({
            id: d.id ?? '',
            facing: d.facing === 'external' ? 'external' : 'back',
            external: d.external === true,
            manual: d.manual === true,
            sizes: d.sizes ?? [],
            maxIso: d.maxIso ?? 0,
            minExposureComp: d.minExposureComp ?? 0,
            maxExposureComp: d.maxExposureComp ?? 0,
            label: d.label ?? 'Caméra',
            source: 'camera2',
          });
        }
      } catch (_) { /* aucun Camera2 */ }
    }
    return out;
  },

  /** Ouvre le flux (UVC : permission USB demandée d'abord — CAMÉRA
   *  runtime requise seulement pour Camera2).
   *  opts (v2.8.0) : taille/fps demandés ; pour l'UVC, formatIndex +
   *  frameIndex + interval sélectionnés EXPLICITEMENT dans getRanges().formats
   *  (choix exact de la caméra) — sinon la meilleure frame est choisie
   *  automatiquement pour width×height. */
  async open(cameraId: string, opts: OpenOpts = {}): Promise<void> {
    const {width = 960, height = 720, fpsMax = 12, quality = 75,
      formatIndex, frameIndex, interval} = opts;
    if (cameraId.startsWith('uvc:')) {
      if (!UVC) throw new Error('Module UVC absent');
      const deviceName = cameraId.slice(4);
      const granted = await UVC.requestUvcPermission(deviceName).catch(() => false);
      if (!granted) throw new Error('Permission USB refusée');
      activeDeviceName = deviceName;
      if (formatIndex != null && frameIndex != null && interval != null) {
        await UVC.openUvcStreamEx(deviceName, formatIndex, frameIndex, interval, quality);
      } else {
        await UVC.openUvcStream(deviceName, width, height, fpsMax, quality);
      }
      return;
    }
    if (!CAM) throw new Error('Module caméra absent');
    activeDeviceName = null;
    await CAM.openStream(cameraId, width, height, fpsMax, quality);
  },

  /** Plages de réglages de la caméra donnée (curseurs manuels v2.7.0).
   *  Normalisées : UVC expose directement ses contrôles ; Camera2 fournit
   *  iso/exposureMs/ev + zoom/focus dérivés des caractéristiques.
   *  v2.8.0 : formats UVC (résolutions + cadences) et tailles/plages FPS
   *  Camera2 — alimentent les sélecteurs « Résolution & cadence ». */
  async getRanges(cameraId: string): Promise<CameraRanges> {
    if (cameraId.startsWith('uvc:')) {
      if (!UVC || !activeDeviceName) {
        return {source: 'uvc', manual: true, controls: {}, wbModes: [], formats: []};
      }
      try {
        const r = await UVC.getUvcRanges(activeDeviceName);
        return {
          source: 'uvc', manual: true, controls: r?.controls ?? {}, wbModes: [],
          formats: r?.formats ?? [],
        };
      } catch (_) {
        return {source: 'uvc', manual: true, controls: {}, wbModes: [], formats: []};
      }
    }
    if (!CAM) return {source: 'camera2', manual: false, controls: {}, wbModes: [], sizes: [], fpsRanges: []};
    try {
      const r = await CAM.getRanges2(cameraId);
      const controls: Record<string, ParamRange> = {};
      if (r.iso) controls.iso = r.iso;
      if (r.exposureMs) controls.exposureMs = r.exposureMs;
      if (r.ev) controls.ev = r.ev;
      if ((r.zoomMax ?? 1) > 1) {
        controls.zoom = {min: 0, max: 1, step: 0.02, def: 0};
      }
      const focusMin = r.focusMin ?? 0;
      if (focusMin > 0) {
        controls.focusAbsolute = {min: 0, max: focusMin, step: 0.1, def: 0};
      }
      const WB_NAMES: Record<number, string> = {
        0: 'auto', 1: 'incandescent', 2: 'fluorescent', 3: 'warmFluorescent',
        5: 'daylight', 6: 'cloudy', 7: 'twilight', 8: 'shade',
      };
      const wb = (r.wbModes ?? []).map((m) => WB_NAMES[m]).filter(Boolean);
      return {
        source: 'camera2', manual: r.manual, controls, wbModes: wb,
        sizes: (r as {sizes?: C2SizeInfo[]}).sizes ?? [],
        fpsRanges: (r as {fpsRanges?: Array<{min: number; max: number}>}).fpsRanges ?? [],
      };
    } catch (_) {
      return {source: 'camera2', manual: false, controls: {}, wbModes: [], sizes: [], fpsRanges: []};
    }
  },

  /** Applique des réglages manuels — tolérant : renvoie la liste des
   *  contrôles refusés (le panneau affiche l'erreur). */
  async setParams(cameraId: string, p: ManualParams): Promise<string[]> {
    if (cameraId.startsWith('uvc:')) {
      if (!UVC || !activeDeviceName) throw new Error('Module UVC absent');
      const r = await UVC.setUvcControls(activeDeviceName, JSON.stringify(p));
      return r?.failed ?? [];
    }
    if (!CAM) throw new Error('Module caméra absent');
    const r = await CAM.setParams2(JSON.stringify(p));
    return r?.failed ?? [];
  },

  /** UNE pose pleine qualité (base64 JPEG). */
  async captureStill(): Promise<string> {
    if (UVC && activeDeviceName) {
      return await UVC.captureStill();
    }
    if (!CAM) throw new Error('Module caméra absent');
    return await CAM.captureStill();
  },

  /** Anneau de luminance réduite (8 frames 192×144, base64) pour l'empilement. */
  async lumaHistory(): Promise<string[]> {
    try {
      if (UVC && activeDeviceName) return (await UVC.getLumaHistory()) ?? [];
      if (!CAM) return [];
      return (await CAM.getLumaHistory()) ?? [];
    } catch (_) { return []; }
  },

  /** Verrouille le point de suivi (coordonnées normalisées 0..1). */
  async setLock(x: number, y: number, halfWindow = 0.13): Promise<void> {
    if (UVC && activeDeviceName) { await UVC.setLock(x, y, halfWindow); return; }
    if (!CAM) return;
    await CAM.setLock(x, y, halfWindow);
  },

  async clearLock(): Promise<void> {
    if (UVC && activeDeviceName) { await UVC.clearLock(); return; }
    if (!CAM) return;
    await CAM.clearLock();
  },

  async close(): Promise<void> {
    try {
      if (UVC && activeDeviceName) await UVC.closeUvcStream();
      else if (CAM) await CAM.closeStream();
    } catch (_) {}
    activeDeviceName = null;
  },

  async isStreaming(): Promise<boolean> {
    try {
      if (UVC && activeDeviceName) return await UVC.isUvcStreaming();
      if (!CAM) return false;
      return await CAM.isStreaming();
    } catch (_) { return false; }
  },

  /**
   * Abonnement au flux — consommation À RÉFÉRENCE COMPTÉE (même philosophie
   * que sensors.ts) : plusieurs consommateurs (aperçu, autoguidage,
   * acquisition) partagent un seul canal d'événements natif.
   * `onLost` : coupure matérielle du flux UVC (débranchement).
   */
  onFrame(cb: (f: CameraFrame) => void): () => void {
    const em = emitter();
    if (!em) return () => undefined;
    const sub = em.addListener('cameraFrame', (e) => {
      if (e?.data) cb(e as CameraFrame);
    });
    return () => sub.remove();
  },

  onStreamLost(cb: () => void): () => void {
    const em = emitter();
    if (!em) return () => undefined;
    const sub = em.addListener('uvcStreamLost', () => {
      activeDeviceName = null;
      cb();
    });
    return () => sub.remove();
  },
};
