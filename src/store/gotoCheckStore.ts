/**
 * Store « contrôle croisé GOTO » (v2.3.0) — ÉTAT ÉPHÉMÈRE du moniteur qui
 * compare, pendant chaque GOTO de l'app, l'arc parcouru selon la télémétrie
 * du téléphone et selon les moteurs (gyro intégré). Non persisté : chaque
 * GOTO repart d'une page blanche, le verdict sert à l'instant.
 */
import {create} from 'zustand';
import type {GotoCross, GotoCheckVerdict} from '../services/astro/gotocheck';

export interface GotoCheckState {
  /** idle : rien ; monitoring : slew en cours ; done : verdict rendu. */
  state: 'idle' | 'monitoring' | 'done';
  /** Pas de capteurs exploitables (moniteur passif sur ce GOTO). */
  noSensors: boolean;
  targetName: string | null;
  startedAt: number;
  /** Arcs LIVE (deg) pendant le slew — rafraîchis ~1 Hz pour l'UI. */
  liveGyroDeg: number;
  liveTeleDeg: number;
  /** Rapport final (verdict + chiffres + raisons i18n). */
  report: GotoCross | null;
  setMonitoring: (targetName: string | null) => void;
  setNoSensors: () => void;
  setLive: (gyroDeg: number, teleDeg: number) => void;
  setReport: (r: GotoCross) => void;
  reset: () => void;
}

export const useGotoCheckStore = create<GotoCheckState>((set) => ({
  state: 'idle',
  noSensors: false,
  targetName: null,
  startedAt: 0,
  liveGyroDeg: 0,
  liveTeleDeg: 0,
  report: null,
  setMonitoring: (targetName) =>
    set({state: 'monitoring', noSensors: false, targetName, startedAt: Date.now(), liveGyroDeg: 0, liveTeleDeg: 0, report: null}),
  setNoSensors: () => set({state: 'monitoring', noSensors: true, report: null}),
  setLive: (liveGyroDeg, liveTeleDeg) => set({liveGyroDeg, liveTeleDeg}),
  setReport: (report) => set({state: 'done', report}),
  reset: () => set({state: 'idle', noSensors: false, targetName: null, startedAt: 0, liveGyroDeg: 0, liveTeleDeg: 0, report: null}),
}));

/** Verdict abrégé (pour les gardes de service — fineTune). */
export function lastGotoVerdict(): GotoCheckVerdict | null {
  const st = useGotoCheckStore.getState();
  return st.state === 'done' && st.report ? st.report.verdict : null;
}
