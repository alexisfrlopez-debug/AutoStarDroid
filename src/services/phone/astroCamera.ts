/**
 * Service CAMÉRA ASTRONOMIQUE (v2.5.0) — pont JS vers le module natif
 * NativeUsbCamera (Camera2 / UVC). Toutes les méthodes natives sont basées
 * sur Promise (règle de survie Hermes v1.7.2 : AUCUN callback JS ne traverse
 * le pont) ; le flux arrive par événements 'cameraFrame'.
 */
import {NativeEventEmitter, NativeModules} from 'react-native';

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

const CAM = NativeModules.NativeUsbCamera as
  | {
      listCameras(): Promise<CameraDeviceInfo[]>;
      openStream(cameraId: string, width: number, height: number, fpsMax: number, quality: number): Promise<boolean>;
      setParams(exposureComp: number, iso: number, exposureNs: number): Promise<boolean>;
      captureStill(): Promise<string>;
      getLumaHistory(): Promise<string[]>;
      setLock(x: number, y: number, halfWindow: number): Promise<boolean>;
      clearLock(): Promise<boolean>;
      closeStream(): Promise<boolean>;
      isStreaming(): Promise<boolean>;
    }
  | undefined;

interface CamEvents {
  addListener(event: string, cb: (e?: CameraFrame & {ts?: number}) => void): {remove(): void};
}

export const astroCamera = {
  /** Caméras disponibles ([] si module absent). */
  async listCameras(): Promise<CameraDeviceInfo[]> {
    if (!CAM) return [];
    try {return (await CAM.listCameras()) ?? [];} catch (_) {return [];}
  },

  /** Ouvre le flux (après permission CAMÉRA accordée côté écran). */
  async open(cameraId: string, width = 960, height = 720, fpsMax = 12, quality = 75): Promise<void> {
    if (!CAM) throw new Error('Module caméra absent');
    await CAM.openStream(cameraId, width, height, fpsMax, quality);
  },

  /** Réglages d'exposition : compensation AE (pas), ISO (0 = auto) et
   *  temps de pose en ms (mode manuel si iso > 0). Tolérant : un capteur
   *  sans mode manuel rejette — l'appelant affiche l'erreur. */
  async setParams(exposureComp: number, iso: number, exposureMs: number): Promise<void> {
    if (!CAM) throw new Error('Module caméra absent');
    await CAM.setParams(exposureComp, iso, Math.round(exposureMs * 1e6));
  },

  /** UNE pose pleine qualité (base64 JPEG). */
  async captureStill(): Promise<string> {
    if (!CAM) throw new Error('Module caméra absent');
    return await CAM.captureStill();
  },

  /** Anneau de luminance réduite (8 frames 192×144, base64) pour l'empilement. */
  async lumaHistory(): Promise<string[]> {
    if (!CAM) return [];
    try {return (await CAM.getLumaHistory()) ?? [];} catch (_) {return [];}
  },

  /** Verrouille le point de suivi (coordonnées normalisées 0..1). */
  async setLock(x: number, y: number, halfWindow = 0.13): Promise<void> {
    if (!CAM) return;
    await CAM.setLock(x, y, halfWindow);
  },

  async clearLock(): Promise<void> {
    if (!CAM) return;
    await CAM.clearLock();
  },

  async close(): Promise<void> {
    if (!CAM) return;
    try {await CAM.closeStream();} catch (_) {}
  },

  async isStreaming(): Promise<boolean> {
    if (!CAM) return false;
    try {return await CAM.isStreaming();} catch (_) {return false;}
  },

  /**
   * Abonnement au flux — consommation À RÉFÉRENCE COMPTÉE (même philosophie
   * que sensors.ts) : plusieurs consommateurs (aperçu, autoguidage,
   * acquisition) partagent un seul canal d'événements natif.
   */
  onFrame(cb: (f: CameraFrame) => void): () => void {
    if (!CAM) return () => undefined;
    const emitter = new NativeEventEmitter(NativeModules.NativeUsbCamera) as unknown as CamEvents;
    const sub = emitter.addListener('cameraFrame', (e) => {
      if (e?.data) cb(e as CameraFrame);
    });
    return () => sub.remove();
  },
};
