/**
 * Store « télémétrie » — points d'alignement enregistrés sur le télescope
 * avec l'orientation du téléphone au moment de la validation (v1.9.0).
 *
 * Chaque point fige : l'objet validé (AD/DEC J2000), sa direction horizontale
 * au site et à la date de validation (alt/az — vérité terrain), et la
 * rotation vector du téléphone (quaternion). Le recalage (fitTelemetry)
 * est recalculé à la volée depuis ces points : ils restent valables après
 * redémarrage de l'app, sans re-calcul dépendant de l'heure courante.
 *
 * Persisté en AsyncStorage (zustand persist, même mécanisme que settings).
 */
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {fitTelemetry, type Quat, type TelemetryFit} from '../services/astro/telemetry';

export interface TelemetryPoint {
  id: string;
  /** Nom de l'objet validé (ex. « Vega », « Manuel 20:59:30 +38°47' »). */
  name: string;
  /** Coordonnées J2000 de l'objet validé (deg). */
  raDeg: number;
  decDeg: number;
  /** Direction horizontale de l'objet au moment de la validation (deg). */
  altDeg: number;
  azDeg: number;
  /** Orientation du téléphone (rotation vector Android) à la validation. */
  quat: Quat;
  /** Horodatage (ms epoch). */
  ts: number;
}

interface TelemetryState {
  points: TelemetryPoint[];
  addPoint: (p: Omit<TelemetryPoint, 'id' | 'ts'>) => void;
  removePoint: (id: string) => void;
  clearPoints: () => void;
}

const MAX_POINTS = 24;

export const useTelemetryStore = create<TelemetryState>()(
  persist(
    (set) => ({
      points: [],
      addPoint: (p) =>
        set((s) => ({
          points: [
            ...s.points.slice(-(MAX_POINTS - 1)),
            {...p, id: `T${Date.now()}${Math.floor(Math.random() * 1e4)}`, ts: Date.now()},
          ],
        })),
      removePoint: (id) => set((s) => ({points: s.points.filter((p) => p.id !== id)})),
      clearPoints: () => set({points: []}),
    }),
    {
      name: 'autostardroid-telemetry',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** Recalage courant (null si aucun point). Recalcul léger (≤ 24 points). */
export function telemetryFitOf(points: TelemetryPoint[]): TelemetryFit | null {
  return fitTelemetry(points.map((p) => ({quat: p.quat, altDeg: p.altDeg, azDeg: p.azDeg})));
}
