import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {MountPresetId} from '../services/astro/mounts';

export type Lang = 'en' | 'fr';
export type ScopeModelId = 'autostar2' | 'autostar497' | 'autostar495' | 'autostar494' | 'lx200';

export interface SiteInfo {
  name: string;
  latDeg: number;
  lonDeg: number;
  elevM: number;
}

interface SettingsState {
  language: Lang;
  nightVision: boolean;
  keySounds: boolean;
  /** Lecture vocale du LCD de la raquette virtuelle (« Speech Enable »
   *  du Hand Control Panel d'AutostarSuite). */
  speech: boolean;
  model: ScopeModelId;
  site: SiteInfo;
  lastWifi: {host: string; port: number};
  lastBtAddress: string;
  lastUsbDevice: string;
  onlyAboveHorizon: boolean;
  /** Déclinaison magnétique du site (Est positif, ex. +2° en France). */
  declinationDeg: number;
  /** Mise à jour AUTOMATIQUE de la raquette physique à chaque connexion
   *  (date, heure, fuseau, site depuis les réglages du téléphone). */
  autoSyncScope: boolean;
  /** Preset de MONTURE (v2.2.0) : 'auto' = déduit de la raquette détectée,
   *  sinon le choix manuel de l'utilisateur (butées, taux attendus, jeu
   *  typique — utilisé par le diagnostic et les butées). */
  mountPreset: MountPresetId | 'auto';
  /** PRÉCISION TÉLÉMÉTRIQUE (v2.2.0) : quand ACTIVÉ, chaque pointage
   *  (GOTO app ou raquette) déclenche à l'arrivée un réglage fin automatique
   *  par la télémétrie du téléphone, puis la validation utilisateur et
   *  l'enregistrement des nouveaux paramètres. */
  telemetryPrecision: boolean;
  setLanguage: (l: Lang) => void;
  setNightVision: (v: boolean) => void;
  setKeySounds: (v: boolean) => void;
  setSpeech: (v: boolean) => void;
  setModel: (m: ScopeModelId) => void;
  setSite: (s: SiteInfo) => void;
  setLastWifi: (w: {host: string; port: number}) => void;
  setLastBtAddress: (a: string) => void;
  setLastUsbDevice: (d: string) => void;
  setOnlyAboveHorizon: (v: boolean) => void;
  setDeclinationDeg: (d: number) => void;
  setAutoSyncScope: (v: boolean) => void;
  setMountPreset: (p: MountPresetId | 'auto') => void;
  setTelemetryPrecision: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'fr',
      nightVision: false,
      keySounds: false,
      speech: false,
      model: 'autostar2',
      site: {name: 'Paris', latDeg: 48.8566, lonDeg: 2.3522, elevM: 35},
      lastWifi: {host: '192.168.4.1', port: 4030},
      lastBtAddress: '',
      lastUsbDevice: '',
      onlyAboveHorizon: true,
      declinationDeg: 0,
      autoSyncScope: true,
      mountPreset: 'auto',
      telemetryPrecision: true,
      setLanguage: (language) => set({language}),
      setNightVision: (nightVision) => set({nightVision}),
      setKeySounds: (keySounds) => set({keySounds}),
      setSpeech: (speech) => set({speech}),
      setModel: (model) => set({model}),
      setSite: (site) => set({site}),
      setLastWifi: (lastWifi) => set({lastWifi}),
      setLastBtAddress: (lastBtAddress) => set({lastBtAddress}),
      setLastUsbDevice: (lastUsbDevice) => set({lastUsbDevice}),
      setOnlyAboveHorizon: (onlyAboveHorizon) => set({onlyAboveHorizon}),
      setDeclinationDeg: (declinationDeg) => set({declinationDeg}),
      setAutoSyncScope: (autoSyncScope) => set({autoSyncScope}),
      setMountPreset: (mountPreset) => set({mountPreset}),
      setTelemetryPrecision: (telemetryPrecision) => set({telemetryPrecision}),
    }),
    {
      name: 'autostardroid-settings',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
