/**
 * Store « calibrage moteurs » (v2.0.0) — résultats du calibrage par
 * télémétrie gyroscope, PERSISTÉS (AsyncStorage). Ils alimentent :
 *  - la boucle de suivi (durées d'impulsion exactes, anti-backlash) ;
 *  - le centrage fin télémétrique ;
 *  - le statut affiché dans la raquette (mise à jour de la raquette).
 *
 * Les signes appris (sens :Me#/:Mw#/:Mn#/:Ms# → sens réel sur le ciel) sont
 * ici aussi : la boucle fermée les inverse automatiquement si une impulsion
 * aggrave l'erreur — la raquette « apprend » la convention du matériel.
 */
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {PulseSigns} from '../services/astro/tracking';

export type MotorSpeed = 'guide' | 'center' | 'find' | 'slew';

/** Taux mesurés (deg/s sur le ciel) par direction, pour une vitesse donnée. */
export interface MeasuredRates {
  /** Vitesse calibrée. */
  speed: MotorSpeed;
  n: number | null;
  s: number | null;
  e: number | null;
  w: number | null;
  /** Bruit gyro moyen de la session de mesure (deg/s). */
  noise: number;
  measuredAt: number;
}

export interface MotorCalibState {
  rates: MeasuredRates | null;
  /** Backlash mesuré en SECONDES D'ARC par paire d'axes (angle de jeu).
   *  Converti en durée au moment de l'emploi : t = angle / taux(vitesse). */
  backlash: {raArcsec: number | null; decArcsec: number | null} | null;
  backlashAt: number;
  /** Dérive de suivi mesurée (deg/s, norme) + écart vs sidéral (″/s). */
  drift: {degPerSec: number; vsSiderealArcsecPerSec: number} | null;
  driftAt: number;
  /** Signes appris par la boucle fermée (sens réel des commandes). */
  signs: PulseSigns;
  /** Appliquer le calibrage aux impulsions (suivi + centrage fin). */
  apply: boolean;
  setRates: (r: MeasuredRates) => void;
  setBacklash: (raArcsec: number | null, decArcsec: number | null) => void;
  setDrift: (degPerSec: number, vsSidereal: number) => void;
  setSigns: (s: PulseSigns) => void;
  setApply: (v: boolean) => void;
  resetAll: () => void;
}

export const useMotorCalibStore = create<MotorCalibState>()(
  persist(
    (set) => ({
      rates: null,
      backlash: null,
      backlashAt: 0,
      drift: null,
      driftAt: 0,
      signs: {dec: 1, ra: 1},
      apply: true,
      setRates: (rates) => set({rates}),
      setBacklash: (raArcsec, decArcsec) => set({backlash: {raArcsec, decArcsec}, backlashAt: Date.now()}),
      setDrift: (degPerSec, vsSiderealArcsecPerSec) =>
        set({drift: {degPerSec, vsSiderealArcsecPerSec}, driftAt: Date.now()}),
      setSigns: (signs) => set({signs}),
      setApply: (apply) => set({apply}),
      resetAll: () => set({rates: null, backlash: null, backlashAt: 0, drift: null, driftAt: 0, signs: {dec: 1, ra: 1}}),
    }),
    {
      name: 'autostardroid-motorcalib',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
