import {create} from 'zustand';
import type {ScopeModelId} from './settingsStore';
import type {TransportType} from '../services/connection/types';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LogLine {
  ts: number;
  dir: 'sent' | 'recv' | 'info' | 'error';
  text: string;
}

interface ScopeState {
  connStatus: ConnStatus;
  transportType: TransportType | null;
  model: ScopeModelId | null;
  raDeg: number; // position courante AD (deg)
  decDeg: number; // position courante DEC (deg)
  targetRaDeg: number | null;
  targetDecDeg: number | null;
  targetName: string;
  speed: 'guide' | 'center' | 'find' | 'slew';
  alignMode: 'altaz' | 'polar' | 'land' | 'unknown';
  scopeTime: string; // 'HH:MM:SS' lu sur la raquette
  scopeDate: string; // 'MM/JJ/AA'
  log: LogLine[];
  setConnStatus: (s: ConnStatus) => void;
  setTransportType: (t: TransportType | null) => void;
  setModel: (m: ScopeModelId | null) => void;
  setPosition: (raDeg: number, decDeg: number) => void;
  setTarget: (raDeg: number, decDeg: number, name: string) => void;
  setSpeed: (s: ScopeState['speed']) => void;
  setAlignMode: (m: ScopeState['alignMode']) => void;
  setScopeTime: (t: string) => void;
  setScopeDate: (d: string) => void;
  pushLog: (dir: LogLine['dir'], text: string) => void;
  clearLog: () => void;
}

const initial = {
  connStatus: 'disconnected' as ConnStatus,
  transportType: null,
  model: null,
  raDeg: 0,
  decDeg: 0,
  targetRaDeg: null as number | null,
  targetDecDeg: null as number | null,
  targetName: '',
  speed: 'center' as ScopeState['speed'],
  alignMode: 'unknown' as ScopeState['alignMode'],
  scopeTime: '--:--:--',
  scopeDate: '--/--/--',
  log: [] as LogLine[],
};

export const useScopeStore = create<ScopeState>((set) => ({
  ...initial,
  setConnStatus: (connStatus) => set({connStatus}),
  setTransportType: (transportType) => set({transportType}),
  setModel: (model) => set({model}),
  setPosition: (raDeg, decDeg) => set({raDeg, decDeg}),
  setTarget: (targetRaDeg, targetDecDeg, targetName) =>
    set({targetRaDeg, targetDecDeg, targetName}),
  setSpeed: (speed) => set({speed}),
  setAlignMode: (alignMode) => set({alignMode}),
  setScopeTime: (scopeTime) => set({scopeTime}),
  setScopeDate: (scopeDate) => set({scopeDate}),
  pushLog: (dir, text) =>
    set((s) => ({
      log: [...s.log.slice(-299), {ts: Date.now(), dir, text}],
    })),
  clearLog: () => set({log: []}),
}));
