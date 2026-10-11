/**
 * Store « diagnostic moteur » (v2.1.0) — rapport de la suite autonome,
 * PERSISTÉ (AsyncStorage) : l'utilisateur peut consulter le dernier rapport
 * complet (8 tests télémétriques) même après redémarrage de l'app.
 */
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {DiagReport} from '../services/tracking/diagService';

export interface DiagState {
  report: DiagReport | null;
  /** Suite en cours (éphémère — jamais persisté comme true). */
  running: boolean;
  setReport: (r: DiagReport) => void;
  setRunning: (v: boolean) => void;
  clear: () => void;
}

export const useDiagStore = create<DiagState>()(
  persist(
    (set) => ({
      report: null,
      running: false,
      setReport: (report) => set({report, running: false}),
      setRunning: (running) => set({running}),
      clear: () => set({report: null}),
    }),
    {
      name: 'autostardroid-diag',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
