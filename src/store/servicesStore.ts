/**
 * État de l'onglet Services distants (v2.9.0) : identifiants par service
 * (persistés dans AsyncStorage, comme les autres réglages) et session
 * WebView courante.
 */
import {create} from 'zustand';
import {createJSONStorage, persist} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ServiceCred {
  login: string;
  password: string;
  /** Tenter le remplissage automatique du formulaire à l'ouverture. */
  autoLogin: boolean;
}

export type SessionPhase = 'login' | 'signup' | 'session';

export interface RemoteSession {
  serviceId: string;
  /** URL affichée par la WebView (login, signup ou lien rapide). */
  url: string;
  phase: SessionPhase;
}

interface ServicesState {
  creds: Record<string, ServiceCred>;
  session: RemoteSession | null;
  lastServiceId: string | null;
  setCreds(serviceId: string, cred: ServiceCred): void;
  clearCreds(serviceId: string): void;
  openSession(serviceId: string, url: string, phase: SessionPhase): void;
  /** Navigation interne à la session (liens rapides, redirections). */
  setSessionUrl(url: string, phase?: SessionPhase): void;
  closeSession(): void;
  selectService(serviceId: string): void;
}

export const useServicesStore = create<ServicesState>()(
  persist(
    (set, get) => ({
      creds: {},
      session: null,
      lastServiceId: null,
      setCreds: (serviceId, cred) =>
        set((st) => ({creds: {...st.creds, [serviceId]: cred}})),
      clearCreds: (serviceId) =>
        set((st) => {
          const next = {...st.creds};
          delete next[serviceId];
          return {creds: next};
        }),
      openSession: (serviceId, url, phase) =>
        set({session: {serviceId, url, phase}, lastServiceId: serviceId}),
      setSessionUrl: (url, phase) => {
        const s = get().session;
        if (!s) return;
        set({session: {...s, url, phase: phase ?? s.phase}});
      },
      closeSession: () => set({session: null}),
      selectService: (serviceId) => set({lastServiceId: serviceId}),
    }),
    {
      name: 'autostardroid-services-v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
