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
      // FIX v2.3.0 : ne persister QUE le rapport. `running` était inclus dans
      // la sauvegarde par défaut : une app tuée PENDANT la suite (ou un
      // crash) relançait l'UI avec running=true SANS suite active — l'écran
      // restait bloqué sur « diagnostic en cours » et le bouton Arrêter
      // n'avait rien à arrêter (le runner, lui, repart à zéro).
      partialize: (st) => ({report: st.report}) as unknown as DiagState,
      // Ceinture et bretelles : la réhydratation n'a lieu qu'au démarrage de
      // l'app, quand le runner est nécessairement au repos — toute trace
      // « en cours » est un résidu d'exécution tuée : on l'efface.
      onRehydrateStorage: () => (st) => {
        if (st && st.running) st.setRunning(false);
      },
    },
  ),
);
