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

/**
 * Démarre le flux d'orientation (10 Hz par défaut). Renvoie une fonction
 * d'arrêt à appeler au démontage de l'écran. Si le module natif est absent,
 * la fonction d'arrêt est un no-op et le callback n'est jamais appelé.
 */
export function startOrientation(cb: (o: Orientation) => void, intervalMs = 100): () => void {
  if (!NativeSensors || !emitter) return () => undefined;
  let stopped = false;
  const sub = emitter.addListener('sensorsOrientation', (o: Orientation) => {
    if (!stopped) cb(o);
  });
  NativeSensors.startOrientation(intervalMs).catch(() => undefined);
  return () => {
    stopped = true;
    sub.remove();
    NativeSensors.stopOrientation().catch(() => undefined);
  };
}
