import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  model: ScopeModelId;
  site: SiteInfo;
  lastWifi: {host: string; port: number};
  lastBtAddress: string;
  lastUsbDevice: string;
  onlyAboveHorizon: boolean;
  setLanguage: (l: Lang) => void;
  setNightVision: (v: boolean) => void;
  setKeySounds: (v: boolean) => void;
  setModel: (m: ScopeModelId) => void;
  setSite: (s: SiteInfo) => void;
  setLastWifi: (w: {host: string; port: number}) => void;
  setLastBtAddress: (a: string) => void;
  setLastUsbDevice: (d: string) => void;
  setOnlyAboveHorizon: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'fr',
      nightVision: false,
      keySounds: false,
      model: 'autostar2',
      site: {name: 'Paris', latDeg: 48.8566, lonDeg: 2.3522, elevM: 35},
      lastWifi: {host: '192.168.4.1', port: 4030},
      lastBtAddress: '',
      lastUsbDevice: '',
      onlyAboveHorizon: true,
      setLanguage: (language) => set({language}),
      setNightVision: (nightVision) => set({nightVision}),
      setKeySounds: (keySounds) => set({keySounds}),
      setModel: (model) => set({model}),
      setSite: (site) => set({site}),
      setLastWifi: (lastWifi) => set({lastWifi}),
      setLastBtAddress: (lastBtAddress) => set({lastBtAddress}),
      setLastUsbDevice: (lastUsbDevice) => set({lastUsbDevice}),
      setOnlyAboveHorizon: (onlyAboveHorizon) => set({onlyAboveHorizon}),
    }),
    {
      name: 'autostardroid-settings',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
