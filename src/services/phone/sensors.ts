/**
 * Pont vers le module natif NativeSensors (capteurs d'attitude du téléphone).
 *
 * L'orientation provient du capteur fusionné « rotation vector » d'Android,
 * qui combine boussole (magnétomètre), accéléromètre et gyroscope.
 * Dégradation gracieuse si le module natif est absent (vieux build, iOS…).
 */
import {NativeModules, NativeEventEmitter} from 'react-native';

export interface Orientation {
  /** 0° = nord magnétique, 90° = est (cap du bord supérieur du téléphone). */
  azimuthDeg: number;
  /** Inclinaison du bord supérieur (positif = remonté vers le ciel). */
  pitchDeg: number;
  /** Roulis (positif = bord droit baissé). */
  rollDeg: number;
  /** Fiabilité magnétique (0..3, 3 = optimal). */
  accuracy: number;
  /** Quaternion brut du rotation vector (v1.9.0) — recalage télémétrie.
   *  Present depuis la v1.9.0 (module natif à jour) ; absent sinon. */
  qw?: number;
  qx?: number;
  qy?: number;
  qz?: number;
}

export interface SensorsAvailability {
  rotationVector: boolean;
  accelerometer: boolean;
  magnetometer: boolean;
  gyroscope: boolean;
}

const NONE: SensorsAvailability = {
  rotationVector: false,
  accelerometer: false,
  magnetometer: false,
  gyroscope: false,
};

const NativeSensors = NativeModules.NativeSensors as
  | {
      isAvailable(): Promise<SensorsAvailability>;
      startOrientation(intervalMs: number): Promise<boolean>;
      stopOrientation(): Promise<boolean>;
      /** v2.0.0 — gyroscope brut (rad/s), pour le calibrage moteurs. */
      startGyro(intervalMs: number): Promise<boolean>;
      stopGyro(): Promise<boolean>;
    }
  | undefined;

const emitter = NativeSensors ? new NativeEventEmitter(NativeSensors as any) : null;

/** Diagnostic des capteurs du téléphone. */
export async function sensorsAvailable(): Promise<SensorsAvailability> {
  if (!NativeSensors) return NONE;
  try {
    return await NativeSensors.isAvailable();
  } catch (_) {
    return NONE;
  }
}

/** Nombre de consommateurs JS du flux natif — le flux natif est unique
 *  (une seule inscription capteur côté Kotlin) : on ne coupe le flux natif
 *  que lorsque le DERNIER consommateur se retire (onglets qui restent
 *  montés simultanément sous les bottom-tabs). */
let consumers = 0;

/**
 * Démarre le flux d'orientation (10 Hz par défaut). Renvoie une fonction
 * d'arrêt à appeler au démontage de l'écran. Si le module natif est absent,
 * la fonction d'arrêt est un no-op et le callback n'est jamais appelé.
 * Plusieurs consommateurs simultanés sont pris en charge (référence comptée).
 */
export function startOrientation(cb: (o: Orientation) => void, intervalMs = 100): () => void {
  if (!NativeSensors || !emitter) return () => undefined;
  let stopped = false;
  const sub = emitter.addListener('sensorsOrientation', (o: Orientation) => {
    if (!stopped) cb(o);
  });
  consumers += 1;
  NativeSensors.startOrientation(intervalMs).catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    sub.remove();
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0) {
      NativeSensors.stopOrientation().catch(() => undefined);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Gyroscope brut (v2.0.0) — calibrage moteurs                         */
/* ------------------------------------------------------------------ */

export interface GyroEvent {
  /** rad/s, convention Android (axes téléphone). */
  x: number;
  y: number;
  z: number;
  accuracy: number;
  ts: number;
}

/** Consommateurs du flux gyro (indépendant du flux d'orientation). */
let gyroConsumers = 0;

/**
 * Démarre le flux gyroscope brut (20 Hz par défaut). Renvoie une fonction
 * d'arrêt à appeler au démontage. Plusieurs consommateurs simultanés
 * pris en charge (référence comptée, même mécanisme que l'orientation).
 * Aucune fonction JS ne traverse le pont (règle de survie v1.7.2) :
 * uniquement des nombres sérialisables dans l'événement natif.
 */
export function startGyro(cb: (g: GyroEvent) => void, intervalMs = 50): () => void {
  if (!NativeSensors || !emitter) return () => undefined;
  let stopped = false;
  const sub = emitter.addListener('sensorsGyro', (g: GyroEvent) => {
    if (!stopped) cb(g);
  });
  gyroConsumers += 1;
  NativeSensors.startGyro(intervalMs).catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    sub.remove();
    gyroConsumers = Math.max(0, gyroConsumers - 1);
    if (gyroConsumers === 0) {
      NativeSensors.stopGyro().catch(() => undefined);
    }
  };
}
