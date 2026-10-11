/**
 * Store « suivi télémétrique » (v2.0.0) — état ÉPHÉMÈRE de la boucle
 * fermée : cible visée (partagée entre le sélecteur d'objets et le panneau
 * de suivi), statut live, journal des corrections. Non persisté : le
 * suivi repart de zéro à chaque session (la cible planète est recalculée,
 * le fit vient du store télémétrie).
 */
import {create} from 'zustand';
import type {PulseSigns} from '../services/astro/tracking';

/** Cible de suivi : objet fixe (AD/DEC constants) ou mobile (planète/Lune/
 *  Soleil — AD/DEC recalculés à chaque tick via les éphémérides). */
export interface TrackTarget {
  name: string;
  raDeg: number;
  decDeg: number;
  /** Nom d'éphéméride ('Moon' | 'Sun' | planète) si objet mobile. */
  moving: string | null;
  /** Source de la sélection (pour l'affichage). */
  from: 'catalog' | 'manual' | 'scope';
}

export interface CorrectionLogLine {
  ts: number;
  axis: 'ra' | 'dec';
  dir: 'n' | 's' | 'e' | 'w';
  durationMs: number;
  /** Erreur totale avant/après (minutes d'arc). */
  beforeArcmin: number;
  afterArcmin: number | null;
}

export type TrackPhase = 'idle' | 'running' | 'centering' | 'pulsing';

/** Réglage fin télémétrique après GOTO (v2.2.0) — machine à états affichée
 *  dans le panneau de suivi : mesure avant correction, correction
 *  automatique, ATTENTE DE VALIDATION utilisateur, applied/dismissed. */
export interface FineTuneInfo {
  state: 'idle' | 'running' | 'awaitValidation' | 'applied' | 'dismissed';
  /** Erreur de pointage AVANT correction (min d'arc). */
  beforeArcmin: number | null;
  /** Erreur APRÈS correction (min d'arc). */
  afterArcmin: number | null;
  iterations: number;
  /** Objet concerné (affichage). */
  name: string | null;
}

export const FINE_TUNNE_IDLE: FineTuneInfo = {
  state: 'idle', beforeArcmin: null, afterArcmin: null, iterations: 0, name: null,
};

interface TrackingState {
  target: TrackTarget | null;
  phase: TrackPhase;
  tracking: boolean;
  /** Réglage fin télémétrique (v2.2.0). */
  fineTune: FineTuneInfo;
  /** Dernière erreur totale mesurée (minutes d'arc). */
  lastErrArcmin: number | null;
  lastErrAt: number;
  corrections: number;
  signs: PulseSigns;
  log: CorrectionLogLine[];
  setTarget: (t: TrackTarget | null) => void;
  setPhase: (p: TrackPhase) => void;
  setTracking: (v: boolean) => void;
  setFineTune: (f: Partial<FineTuneInfo>) => void;
  setErr: (arcmin: number | null) => void;
  setSigns: (s: PulseSigns) => void;
  bumpCorrections: () => void;
  pushLog: (l: Omit<CorrectionLogLine, 'ts'>) => void;
  reset: () => void;
}

export const useTrackingStore = create<TrackingState>((set) => ({
  target: null,
  phase: 'idle',
  tracking: false,
  fineTune: FINE_TUNNE_IDLE,
  lastErrArcmin: null,
  lastErrAt: 0,
  corrections: 0,
  signs: {dec: 1, ra: 1},
  log: [],
  setTarget: (target) => set({target}),
  setPhase: (phase) => set({phase}),
  setTracking: (tracking) => set({tracking}),
  setFineTune: (f) => set((s) => ({fineTune: {...s.fineTune, ...f}})),
  setErr: (lastErrArcmin) => set({lastErrArcmin, lastErrAt: Date.now()}),
  setSigns: (signs) => set({signs}),
  bumpCorrections: () => set((s) => ({corrections: s.corrections + 1})),
  pushLog: (l) => set((s) => ({log: [...s.log.slice(-39), {...l, ts: Date.now()}]})),
  reset: () => set({
    phase: 'idle', tracking: false, lastErrArcmin: null, lastErrAt: 0,
    corrections: 0, log: [], fineTune: FINE_TUNNE_IDLE,
  }),
}));
