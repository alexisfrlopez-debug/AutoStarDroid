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

interface TrackingState {
  target: TrackTarget | null;
  phase: TrackPhase;
  tracking: boolean;
  /** Dernière erreur totale mesurée (minutes d'arc). */
  lastErrArcmin: number | null;
  lastErrAt: number;
  corrections: number;
  signs: PulseSigns;
  log: CorrectionLogLine[];
  setTarget: (t: TrackTarget | null) => void;
  setPhase: (p: TrackPhase) => void;
  setTracking: (v: boolean) => void;
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
  lastErrArcmin: null,
  lastErrAt: 0,
  corrections: 0,
  signs: {dec: 1, ra: 1},
  log: [],
  setTarget: (target) => set({target}),
  setPhase: (phase) => set({phase}),
  setTracking: (tracking) => set({tracking}),
  setErr: (lastErrArcmin) => set({lastErrArcmin, lastErrAt: Date.now()}),
  setSigns: (signs) => set({signs}),
  bumpCorrections: () => set((s) => ({corrections: s.corrections + 1})),
  pushLog: (l) => set((s) => ({log: [...s.log.slice(-39), {...l, ts: Date.now()}]})),
  reset: () => set({
    phase: 'idle', tracking: false, lastErrArcmin: null, lastErrAt: 0,
    corrections: 0, log: [],
  }),
}));
