/**
 * Store CAMÉRA ASTRONOMIQUE (v2.5.0) — état ÉPHÉMÈRE (non persisté) :
 * flux, verrou d'autoguidage, progression d'acquisition, galerie.
 * v2.8.0 : trames de calibrage (noire/flat) capturées dans la session,
 * cadence d'affichage de l'aperçu, préférences de flux (résolution/fps
 * demandés au démarrage — sélecteurs « Résolution & cadence »).
 * Les réglages durables (axes d'autoguidage, échelle, filtres d'image)
 * vivent dans settingsStore pour survivre aux redémarrages.
 */
import {create} from 'zustand';
import type {CameraFrame} from '../services/phone/astroCamera';
import type {AcqProgress, AcqResult} from '../services/astro/acquisition';
import type {GuidingState} from '../services/astro/guiding';

interface CameraState {
  devices: Array<{
    id: string; label: string; external: boolean; manual: boolean;
    /** Rôle du capteur (v2.8.1) : wide | main | tele | depth | external. */
    role: string;
    /** Position : external / back / front (v2.8.1 — menu interne/externe). */
    facing: 'external' | 'back' | 'front';
  }>;
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
  /** TRAME NOIRE capturée (objectif couvert) — session. */
  darkFrame: Uint8Array | null;
  /** TRAME FLAT capturée (ciel uniforme) — session. */
  flatFrame: Uint8Array | null;
  /** Cadence d'AFFICHAGE de l'aperçu (fps) — throttle du composant. */
  displayFps: number;
  /** Flux demandé au démarrage (sélecteurs « Résolution & cadence »). */
  prefWidth: number;
  prefHeight: number;
  prefFps: number;
  /** Choix UVC explicites (format/frame/intervalle des listes matériel). */
  uvcFormatIndex: number | null;
  uvcFrameIndex: number | null;
  uvcInterval: number | null;
  setDevices: (d: CameraState['devices']) => void;
  setCameraId: (id: string | null) => void;
  setStreaming: (on: boolean) => void;
  setLastFrame: (f: CameraFrame | null) => void;
  setFps: (fps: number) => void;
  setLock: (l: {x: number; y: number} | null) => void;
  setGuiding: (g: GuidingState) => void;
  setAcq: (a: AcqProgress) => void;
  setResult: (r: AcqResult | null) => void;
  setDarkFrame: (f: Uint8Array | null) => void;
  setFlatFrame: (f: Uint8Array | null) => void;
  setDisplayFps: (fps: number) => void;
  setStreamPrefs: (p: {width?: number; height?: number; fps?: number}) => void;
  setUvcSelection: (formatIndex: number | null, frameIndex: number | null, interval: number | null) => void;
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
  darkFrame: null,
  flatFrame: null,
  displayFps: 8,
  prefWidth: 960,
  prefHeight: 720,
  prefFps: 12,
  uvcFormatIndex: null,
  uvcFrameIndex: null,
  uvcInterval: null,
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
  setDarkFrame: (darkFrame) => set({darkFrame}),
  setFlatFrame: (flatFrame) => set({flatFrame}),
  setDisplayFps: (displayFps) => set({displayFps}),
  setStreamPrefs: ({width, height, fps}) => set((s) => ({
    prefWidth: width ?? s.prefWidth,
    prefHeight: height ?? s.prefHeight,
    prefFps: fps ?? s.prefFps,
  })),
  setUvcSelection: (uvcFormatIndex, uvcFrameIndex, uvcInterval) =>
    set({uvcFormatIndex, uvcFrameIndex, uvcInterval}),
  reset: () => set({
    devices: [], cameraId: null, streaming: false, lastFrame: null, fps: 0,
    lock: null, guiding: {running: false, locked: false, lastDxPx: 0, lastDyPx: 0, corrections: 0, lostFrames: 0, note: null},
    acq: {state: 'idle', done: 0, total: 0, note: null}, result: null,
  }),
}));
