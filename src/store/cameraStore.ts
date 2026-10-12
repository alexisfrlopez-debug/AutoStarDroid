/**
 * Store CAMÉRA ASTRONOMIQUE (v2.5.0) — état ÉPHÉMÈRE (non persisté) :
 * flux, verrou d'autoguidage, progression d'acquisition, galerie.
 * Les réglages durables (axes d'autoguidage, échelle) vivent dans
 * settingsStore pour survivre aux redémarrages.
 */
import {create} from 'zustand';
import type {CameraFrame} from '../services/phone/astroCamera';
import type {AcqProgress, AcqResult} from '../services/astro/acquisition';
import type {GuidingState} from '../services/astro/guiding';

interface CameraState {
  devices: Array<{id: string; label: string; external: boolean; manual: boolean}>;
  cameraId: string | null;
  streaming: boolean;
  /** Dernier frame (aperçu — rafraîchi par le composant, pas stocké en gros). */
  lastFrame: CameraFrame | null;
  fps: number;
  /** Verrou d'autoguidage (coordonnées normalisées 0..1). */
  lock: {x: number; y: number} | null;
  guiding: GuidingState;
  acq: AcqProgress;
  /** Dernier résultat d'acquisition + galerie (max 6). */
  result: AcqResult | null;
  gallery: AcqResult[];
  setDevices: (d: CameraState['devices']) => void;
  setCameraId: (id: string | null) => void;
  setStreaming: (on: boolean) => void;
  setLastFrame: (f: CameraFrame | null) => void;
  setFps: (fps: number) => void;
  setLock: (l: {x: number; y: number} | null) => void;
  setGuiding: (g: GuidingState) => void;
  setAcq: (a: AcqProgress) => void;
  setResult: (r: AcqResult | null) => void;
  reset: () => void;
}

export const useCameraStore = create<CameraState>((set) => ({
  devices: [],
  cameraId: null,
  streaming: false,
  lastFrame: null,
  fps: 0,
  lock: null,
  guiding: {running: false, locked: false, lastDxPx: 0, lastDyPx: 0, corrections: 0, lostFrames: 0, note: null},
  acq: {state: 'idle', done: 0, total: 0, note: null},
  result: null,
  gallery: [],
  setDevices: (devices) => set({devices}),
  setCameraId: (cameraId) => set({cameraId}),
  setStreaming: (streaming) => set({streaming}),
  setLastFrame: (lastFrame) => set({lastFrame}),
  setFps: (fps) => set({fps}),
  setLock: (lock) => set({lock}),
  setGuiding: (guiding) => set({guiding}),
  setAcq: (acq) => set({acq}),
  setResult: (result) => set((s) => ({
    result,
    gallery: result ? [result, ...s.gallery].slice(0, 6) : s.gallery,
  })),
  reset: () => set({
    devices: [], cameraId: null, streaming: false, lastFrame: null, fps: 0,
    lock: null, guiding: {running: false, locked: false, lastDxPx: 0, lastDyPx: 0, corrections: 0, lostFrames: 0, note: null},
    acq: {state: 'idle', done: 0, total: 0, note: null}, result: null,
  }),
}));
