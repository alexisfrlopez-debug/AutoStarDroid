import {create} from 'zustand';
import type {ScopeModelId} from './settingsStore';
import type {TransportType} from '../services/connection/types';

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
/** État de la synchronisation temps réel raquette virtuelle ↔ physique. */
export type HbSyncStatus = 'off' | 'live' | 'error';
/** Sentinelle de diagnostic : liaison active mais raquette muette sur la
 *  position (monture non reliée/sous tension ou raquette non initialisée).
 *  L'UI la traduit (i18n) au lieu d'afficher une erreur transport brute. */
export const HB_ERR_NO_POS = 'NO_POSITION';

export interface LogLine {
  ts: number;
  dir: 'sent' | 'recv' | 'info' | 'error';
  text: string;
}

interface ScopeState {
  connStatus: ConnStatus;
  transportType: TransportType | null;
  model: ScopeModelId | null;
  /** Firmware détecté à la connexion (:GVP#/:GVN#) — pilote le mappage du clavier. */
  fwProduct: string | null;
  fwVersion: string | null;
  fwModel: ScopeModelId | null;
  raDeg: number; // position courante AD (deg)
  decDeg: number; // position courante DEC (deg)
  /** Une position a AU MOINS été lue une fois sur cette liaison (sinon les
   *  zéros initiaux ne doivent pas être affichés comme si c'étaient la
   *  position de la raquette). */
  hasPos: boolean;
  targetRaDeg: number | null;
  targetDecDeg: number | null;
  targetName: string;
  speed: 'guide' | 'center' | 'find' | 'slew';
  alignMode: 'altaz' | 'polar' | 'land' | 'unknown';
  hbSync: HbSyncStatus; // synchro temps réel du LCD (voir handboxSync.ts)
  hbError: string | null;
  hbMoving: boolean; // la raquette physique est en train de bouger
  /** Mouvement VENU de la raquette physique (l'app ne bougeait pas elle-même). */
  hbExternal: boolean;
  /** Directions déduites du mouvement physique (croix de la raquette virtuelle allumée). */
  hbDirs: {n: boolean; s: boolean; e: boolean; w: boolean} | null;
  altDeg: number | null; // lu en direct (:Ga) quand la synchro est active
  azDeg: number | null; // lu en direct (:Gz)
  scopeTime: string; // 'HH:MM:SS' lu sur la raquette
  scopeDate: string; // 'MM/JJ/AA'
  log: LogLine[];
  setConnStatus: (s: ConnStatus) => void;
  setTransportType: (t: TransportType | null) => void;
  setModel: (m: ScopeModelId | null) => void;
  setFirmware: (product: string | null, version: string | null, model: ScopeModelId | null) => void;
  setPosition: (raDeg: number, decDeg: number) => void;
  setHasPos: (v: boolean) => void;
  setTarget: (raDeg: number, decDeg: number, name: string) => void;
  setSpeed: (s: ScopeState['speed']) => void;
  setAlignMode: (m: ScopeState['alignMode']) => void;
  setHbSync: (s: HbSyncStatus) => void;
  setHbError: (e: string | null) => void;
  setHbMoving: (m: boolean) => void;
  setHbExternal: (x: boolean) => void;
  setHbDirs: (d: {n: boolean; s: boolean; e: boolean; w: boolean} | null) => void;
  setAltAz: (altDeg: number | null, azDeg: number | null) => void;
  setScopeTime: (t: string) => void;
  setScopeDate: (d: string) => void;
  pushLog: (dir: LogLine['dir'], text: string) => void;
  clearLog: () => void;
}

const initial = {
  connStatus: 'disconnected' as ConnStatus,
  transportType: null,
  model: null,
  fwProduct: null as string | null,
  fwVersion: null as string | null,
  fwModel: null as ScopeModelId | null,
  raDeg: 0,
  decDeg: 0,
  hasPos: false,
  targetRaDeg: null as number | null,
  targetDecDeg: null as number | null,
  targetName: '',
  speed: 'center' as ScopeState['speed'],
  alignMode: 'unknown' as ScopeState['alignMode'],
  hbSync: 'off' as HbSyncStatus,
  hbError: null as string | null,
  hbMoving: false,
  hbExternal: false,
  hbDirs: null as ScopeState['hbDirs'],
  altDeg: null as number | null,
  azDeg: null as number | null,
  scopeTime: '--:--:--',
  scopeDate: '--/--/--',
  log: [] as LogLine[],
};

export const useScopeStore = create<ScopeState>((set) => ({
  ...initial,
  setConnStatus: (connStatus) => set({connStatus}),
  setTransportType: (transportType) => set({transportType}),
  setModel: (model) => set({model}),
  setFirmware: (fwProduct, fwVersion, fwModel) => set({fwProduct, fwVersion, fwModel}),
  setPosition: (raDeg, decDeg) => set({raDeg, decDeg, hasPos: true}),
  setHasPos: (hasPos) => set({hasPos}),
  setTarget: (targetRaDeg, targetDecDeg, targetName) =>
    set({targetRaDeg, targetDecDeg, targetName}),
  setSpeed: (speed) => set({speed}),
  setAlignMode: (alignMode) => set({alignMode}),
  setHbSync: (hbSync) => set({hbSync}),
  setHbError: (hbError) => set({hbError}),
  setHbMoving: (hbMoving) => set({hbMoving}),
  setHbExternal: (hbExternal) => set({hbExternal}),
  setHbDirs: (hbDirs) => set({hbDirs}),
  setAltAz: (altDeg, azDeg) => set({altDeg, azDeg}),
  setScopeTime: (scopeTime) => set({scopeTime}),
  setScopeDate: (scopeDate) => set({scopeDate}),
  pushLog: (dir, text) =>
    set((s) => ({
      log: [...s.log.slice(-299), {ts: Date.now(), dir, text}],
    })),
  clearLog: () => set({log: []}),
}));
