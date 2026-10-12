import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {MountPresetId} from '../services/astro/mounts';
import type {PhoneAngle, PhonePose, PhonePosition} from '../services/astro/phonemount';
import type {GuidingAxes} from '../services/astro/guiding';
import type {DriverPref} from '../services/protocol/driver';
import type {CustomMount} from '../services/mounts/catalog';

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
  /** MONTAGE DU TÉLÉPHONE SUR LE TUBE (v2.4.0) : convertit l'orientation
   *  des capteurs en direction de visée du télescope pour la carte du ciel
   *  (pose, angle au tube 0/45/90°, position dessus/gauche/droite). */
  skyMountPose: PhonePose;
  skyMountAngle: PhoneAngle;
  skyMountPosition: PhonePosition;
  /** AUTOGUIDAGE IMAGE (v2.5.0) : table d'axes image→moteurs + échelle
   *  ″/px apprise au calibrage — persistés pour ne pas recalibrer chaque nuit. */
  guideAxes: GuidingAxes;
  guideScaleArcsecPerPx: number;
  /** PROTOCOLE (v2.6.0) : 'auto' = sondes de détection à la connexion,
   *  sinon la marque imposée (Meade, Celestron NexStar, SynScan, iOptron). */
  prefDriver: DriverPref;
  /** MONTURES (v2.7.0) : sélection catalogue (marque + modèle, onglet
   *  « Montures ») et saisie manuelle (caractéristiques libres). */
  mountBrandId: string | null;
  mountModelId: string | null;
  customMount: CustomMount | null;
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
  setSkyMountPose: (p: PhonePose) => void;
  setSkyMountAngle: (a: PhoneAngle) => void;
  setSkyMountPosition: (p: PhonePosition) => void;
  setGuideAxes: (a: GuidingAxes) => void;
  setGuideScale: (s: number) => void;
  setPrefDriver: (d: DriverPref) => void;
  setMountSelection: (brandId: string | null, modelId: string | null) => void;
  setCustomMount: (c: CustomMount | null) => void;
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
      skyMountPose: 'portrait',
      skyMountAngle: 0,
      skyMountPosition: 'top',
      guideAxes: {xAxis: 'ra', flipX: false, flipY: false},
      guideScaleArcsecPerPx: 2,
      prefDriver: 'auto',
      mountBrandId: null,
      mountModelId: null,
      customMount: null,
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
      setSkyMountPose: (skyMountPose) => set({skyMountPose}),
      setSkyMountAngle: (skyMountAngle) => set({skyMountAngle}),
      setSkyMountPosition: (skyMountPosition) => set({skyMountPosition}),
      setGuideAxes: (guideAxes) => set({guideAxes}),
      setGuideScale: (guideScaleArcsecPerPx) => set({guideScaleArcsecPerPx}),
      setPrefDriver: (prefDriver) => set({prefDriver}),
      setMountSelection: (mountBrandId, mountModelId) =>
        set({mountBrandId, mountModelId, customMount: null}),
      setCustomMount: (customMount) => set({customMount}),
    }),
    {
      name: 'autostardroid-settings',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
